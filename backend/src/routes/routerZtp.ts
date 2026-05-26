import { Router, Request, Response } from 'express';
import { promises as dns } from 'dns';
import prisma from '../utils/prisma';
import { sendError } from '../utils/response';
import { enqueueCommand, dequeueAll } from '../utils/commandQueue';

const router = Router();

async function findRouter(apiKey: string) {
  return prisma.mikrotikRouter.findUnique({
    where: { apiKey },
    include: { tenant: true, provConfig: true },
  });
}

// Resolve backend hostname to IPs so we can whitelist them in walled garden.
// Short cache because Railway/edge IPs can rotate — stale IPs break the walled garden.
let backendIpCache: { ips: string[]; at: number } | null = null;
async function resolveBackendIps(hostname: string): Promise<string[]> {
  if (backendIpCache && Date.now() - backendIpCache.at < 60 * 1000) {
    return backendIpCache.ips;
  }
  const ips = new Set<string>();
  try {
    const v4 = await dns.resolve4(hostname);
    v4.forEach(ip => ips.add(ip));
  } catch { /* ignore */ }
  // Some hosts only answer via the default resolver's lookup
  try {
    const looked = await dns.lookup(hostname, { all: true });
    looked.filter(a => a.family === 4).forEach(a => ips.add(a.address));
  } catch { /* ignore */ }
  const list = [...ips];
  if (list.length > 0) backendIpCache = { ips: list, at: Date.now() };
  return list;
}

// Generates the full ZTP provisioning script for a router (the same content the
// /ztp-script endpoint serves). Extracted so reprovision can deliver it directly
// through the command queue without the router needing a second fetch.
async function generateZtpScript(apiKey: string): Promise<string> {
    const r = await findRouter(apiKey);
    if (!r) throw new Error('Router not found');

    let backendUrl = process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app';
    // Normalize: strip any protocol, then force https. The backend is always HTTPS on
    // Railway, and RouterOS /tool fetch REQUIRES mode=https (or it errors "Mode not
    // specified"). Previously, if BACKEND_URL had no protocol or used http, fetchFlags
    // came out empty and every fetch in the ZTP failed. Now we always emit mode=https.
    backendUrl = backendUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (backendUrl.includes('localhost') || backendUrl.includes('127.0.0.1')) {
      backendUrl = 'dartbit-production.up.railway.app';
    }
    backendUrl = 'https://' + backendUrl;
    const fetchFlags = ' mode=https check-certificate=no';

    const cfg = r.provConfig;
    const wan        = cfg?.wanInterface     ?? 'ether1';
    const lan        = cfg?.lanInterface     ?? 'ether2';
    const bridge     = cfg?.bridgeName       ?? 'bridge-lan';
    const lanGw      = cfg?.lanGateway       ?? '40.40.88.1';
    const dhcpStart  = cfg?.dhcpPoolStart    ?? '40.40.88.10';
    const dhcpEnd    = cfg?.dhcpPoolEnd      ?? '40.40.88.254';
    const lanSubnet  = cfg?.lanSubnet        ?? '40.40.88.0/24';
    const dns        = cfg?.dnsServers       ?? '8.8.8.8,8.8.4.4';
    const pppoeLocal = cfg?.pppoeLocalAddress ?? '10.10.10.1';
    const pppoePool  = cfg?.pppoeRemotePool  ?? 'pppoe-pool';
    const pppoeStart = cfg?.pppoePoolStart   ?? '10.10.10.10';
    const pppoeEnd   = cfg?.pppoePoolEnd     ?? '10.10.10.200';

    const lanInterfaces = lan.split(',').map(s => s.trim()).filter(Boolean);

    const lines: string[] = [];
    const add = (s: string) => lines.push(s);

    add('# Dartbit ZTP Script v1.5.7');
    add(`# Router  : ${r.name}`);
    add(`# Tenant  : ${r.tenant.name}`);
    add('');
    add(':log info "Dartbit: Starting provisioning"');
    add('');

    // 1. Bridge
    add('# 1. Bridge');
    add(`:if ([:len [/interface bridge find name="${bridge}"]] = 0) do={ /interface bridge add name=${bridge} comment="Dartbit LAN" }`);
    for (const port of lanInterfaces) {
      // First remove the port from ANY other bridge it might be on (this is the fix —
      // RouterOS silently rejects adding a port that's already on another bridge).
      add(`:foreach p in=[/interface bridge port find interface="${port}"] do={ :local b [/interface bridge port get $p bridge]; :if ($b != "${bridge}") do={ /interface bridge port remove $p; :log info ("Dartbit: moved ${port} from " . $b . " to ${bridge}") } }`);
      add(`:if ([:len [/interface bridge port find interface="${port}" bridge="${bridge}"]] = 0) do={ /interface bridge port add bridge=${bridge} interface=${port} comment="Dartbit LAN port" }`);
    }
    add('');

    // 2. LAN gateway IP
    add('# 2. LAN gateway IP');
    // CRITICAL: remove duplicate IP from any OTHER bridge first.
    // The defconf has 192.168.88.1/24 on the default 'bridge' which causes routing chaos.
    add(`:foreach a in=[/ip address find address="${lanGw}/24"] do={ :local iface [/ip address get $a interface]; :if ($iface != "${bridge}") do={ /ip address remove $a; :log info ("Dartbit: removed duplicate ${lanGw}/24 from " . $iface) } }`);
    add(`:if ([:len [/ip address find interface="${bridge}" address="${lanGw}/24"]] = 0) do={ /ip address add address=${lanGw}/24 interface=${bridge} comment="Dartbit LAN Gateway" }`);
    // CRITICAL: add the bridge to the LAN interface list so the default firewall
    // (chain=input action=drop in-interface-list=!LAN) doesn't block DNS/DHCP/portal traffic from clients
    add(`:if ([:len [/interface list find name="LAN"]] = 0) do={ /interface list add name=LAN }`);
    add(`:if ([:len [/interface list member find list="LAN" interface="${bridge}"]] = 0) do={ /interface list member add list=LAN interface=${bridge} comment="Dartbit LAN" }`);
    // Also disable the defconf DHCP server on the original bridge — it was serving the same subnet
    add(`:foreach d in=[/ip dhcp-server find name="defconf"] do={ /ip dhcp-server disable $d; :log info "Dartbit: disabled defconf DHCP (subnet conflict)" }`);
    add('');

    // 3. DHCP pool + DHCP server on the bridge (hotspot doesn't auto-create one in all RouterOS versions)
    add('# 3. DHCP pool + server');
    add(`:if ([:len [/ip pool find name="dhcp-pool"]] = 0) do={ /ip pool add name=dhcp-pool ranges=${dhcpStart}-${dhcpEnd} }`);
    // Always update the pool range in case it changed
    add(`/ip pool set [find name="dhcp-pool"] ranges=${dhcpStart}-${dhcpEnd}`);
    // DHCP network entry — tells DHCP clients their gateway/DNS
    // CRITICAL: dns-server is the ROUTER's bridge IP, not 8.8.8.8. This way clients
    // send DNS queries to the router, which can hijack them and return the gateway IP
    // for unauthenticated users (this drives the captive portal redirect).
    add(`:if ([:len [/ip dhcp-server network find address="${lanSubnet}"]] = 0) do={ /ip dhcp-server network add address=${lanSubnet} gateway=${lanGw} dns-server=${lanGw} comment="Dartbit LAN" }`);
    add(`/ip dhcp-server network set [find address="${lanSubnet}"] gateway=${lanGw} dns-server=${lanGw}`);
    // The DHCP server bound to the bridge — this is what actually hands out IPs
    add(`:if ([:len [/ip dhcp-server find name="dartbit-dhcp"]] = 0) do={ /ip dhcp-server add name=dartbit-dhcp interface=${bridge} address-pool=dhcp-pool lease-time=1d disabled=no }`);
    add(`/ip dhcp-server set [find name="dartbit-dhcp"] interface=${bridge} address-pool=dhcp-pool disabled=no`);
    // CRITICAL: remove any OTHER DHCP server on this bridge that would conflict
    add(`:foreach d in=[/ip dhcp-server find interface="${bridge}"] do={ :if ([/ip dhcp-server get $d name] != "dartbit-dhcp") do={ /ip dhcp-server disable $d; :log info ("Dartbit: disabled conflicting DHCP server " . [/ip dhcp-server get $d name] . " on ${bridge}") } }`);
    // Enable router's DNS server so it can answer queries from clients
    add(`/ip dns set servers=${dns} allow-remote-requests=yes`);
    add('');

    // 4. NAT
    add('# 4. NAT for WAN');
    add(`:if ([:len [/interface find name="${wan}"]] > 0 && [:len [/ip firewall nat find comment="Dartbit WAN NAT"]] = 0) do={ /ip firewall nat add chain=srcnat out-interface=${wan} action=masquerade comment="Dartbit WAN NAT" }`);
    add('');

    // 5. PPPoE server
    add('# 5. PPPoE server');
    add(`:if ([:len [/ip pool find name="${pppoePool}"]] = 0) do={ /ip pool add name=${pppoePool} ranges=${pppoeStart}-${pppoeEnd} }`);
    add(`:if ([:len [/ppp profile find name="dartbit-pppoe"]] = 0) do={ /ppp profile add name=dartbit-pppoe local-address=${pppoeLocal} remote-address=${pppoePool} comment="Dartbit PPPoE" }`);
    add(`:if ([:len [/interface pppoe-server server find service-name="dartbit"]] = 0) do={ /interface pppoe-server server add service-name=dartbit interface=${bridge} authentication=chap,pap default-profile=dartbit-pppoe disabled=no comment="Dartbit PPPoE Server" }`);
    add('');

    // 6. Hotspot — captive portal with DHCP managed by the hotspot itself
    add('# 6. Hotspot — captive portal');
    // login-by includes "cookie" so a returning client (same MAC, within cookie lifetime)
    // is auto-authenticated without re-entering their voucher. http-cookie-lifetime sets
    // how long the MAC binding survives a disconnect (1 day here). On reconnect within
    // that window, RouterOS auto-logs them back in; after it expires, the portal voucher
    // form is the fallback.
    add(`:if ([:len [/ip hotspot profile find name="hsprof-dartbit"]] = 0) do={ /ip hotspot profile add name=hsprof-dartbit hotspot-address=${lanGw} dns-name=dartbit.login login-by=cookie,http-chap,http-pap http-cookie-lifetime=1d use-radius=no }`);
    // Always sync the profile settings (idempotent — no disruption)
    add(`/ip hotspot profile set [find name="hsprof-dartbit"] hotspot-address=${lanGw} dns-name=dartbit.login login-by=cookie,http-chap,http-pap http-cookie-lifetime=1d use-radius=no`);
    // User profile — one device per credential, with MAC cookie so reconnects auto-login
    add(`:if ([:len [/ip hotspot user profile find name="dartbit-default"]] = 0) do={ /ip hotspot user profile add name=dartbit-default rate-limit="10M/10M" shared-users=1 address-pool=dhcp-pool }`);
    add(`:do { /ip hotspot user profile set [find name="dartbit-default"] add-mac-cookie=yes } on-error={}`);
    // Hotspot itself on the bridge
    add(`:if ([:len [/ip hotspot find name="dartbit-hotspot"]] = 0) do={ /ip hotspot add name=dartbit-hotspot interface=${bridge} address-pool=dhcp-pool profile=hsprof-dartbit disabled=no }`);
    // Sync hotspot settings — idempotent, RouterOS handles no-op gracefully
    add(`/ip hotspot set [find name="dartbit-hotspot"] interface=${bridge} address-pool=dhcp-pool profile=hsprof-dartbit disabled=no`);
    // Remove any other hotspots on this interface (e.g. from other tools)
    add(`:foreach h in=[/ip hotspot find interface="${bridge}"] do={ :if ([/ip hotspot get $h name] != "dartbit-hotspot") do={ /ip hotspot remove $h } }`);
    // Diagnostic logging
    add(`:log info ("Dartbit hotspot: " . [/ip hotspot get [find name="dartbit-hotspot"] disabled] . "; DHCP: " . [/ip dhcp-server get [find name="dartbit-dhcp"] disabled])`);
    add('');

    // 6a. Replace MikroTik's default login.html with one that redirects to Dartbit's portal
    //     RouterOS hotspot serves files from /hotspot/ directory (created automatically).
    //     We download our redirect HTML and overwrite the default login page.
    add('# 6a. Install Dartbit captive portal HTML');
    // Make sure the hotspot/ directory exists by triggering hotspot to create defaults
    add(`:do { /ip hotspot profile set [find name="hsprof-dartbit"] html-directory=hotspot } on-error={}`);
    // Download our login.html — it's a tiny redirect page to the Dartbit-hosted portal
    add(`/tool fetch url="${backendUrl}/hotspot-html/login?apiKey=${apiKey}" dst-path=hotspot/login.html${fetchFlags}`);
    add(`:delay 1s`);
    // Also overwrite alogin.html which is shown on successful login
    add(`/tool fetch url="${backendUrl}/hotspot-html/login?apiKey=${apiKey}" dst-path=hotspot/alogin.html${fetchFlags}`);
    add(`:delay 1s`);
    add(`:log info "Dartbit: portal HTML installed"`);
    add('');

    // 6b. CRITICAL: disable fasttrack-connection. RouterOS's default firewall has a
    //     fasttrack rule that bypasses the entire forward chain on established connections.
    //     This breaks hotspot interception — only the first packet goes through the
    //     hotspot, subsequent HTTP requests are fast-tracked straight to the internet.
    //     This is the #1 reason hotspots "give DHCP but no captive portal".
    add('# 6b. Disable fasttrack — required for hotspot interception to work');
    add(`:foreach f in=[/ip firewall filter find action=fasttrack-connection] do={ /ip firewall filter disable $f; :log info "Dartbit: disabled fasttrack-connection rule" }`);
    add('');

    // 6b. CRITICAL fix for MikroTik hotspot DNS-hijack bypass:
    //     MikroTik's auto-generated hotspot rules only redirect HTTP/HTTPS where
    //     hotspot=local-dst (destination is the router itself). This works IF the
    //     router's DNS server lies to unauth clients and returns the gateway IP.
    //     BUT, RouterOS 7 doesn't do that DNS hijack reliably — clients get the
    //     real IP and try connecting directly, which gets rejected by hs-unauth.
    //
    //     We add a NAT redirect that catches ALL outbound HTTP/HTTPS from unauth
    //     hotspot clients (regardless of destination IP) and sends them to the
    //     captive portal. This forces the redirect to work universally.
    // Resolve backend hostname to IPs now — we use them both for walled garden AND
    // to exclude from the force-redirect rules below.
    const backendHost = backendUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const backendIps = await resolveBackendIps(backendHost);

    // 6c. CRITICAL: pre-seed DNS static and walled garden by IP FIRST so AJAX from
    //     captive portal can reach Dartbit without being caught by the force-redirect.
    add('# 6c. Backend whitelisting (must come before force-redirect rules)');
    // Add backend IPs to a firewall address list — used by the force-redirect rules below
    add(`:foreach a in=[/ip firewall address-list find list="dartbit-backend"] do={ /ip firewall address-list remove $a }`);
    for (const ip of backendIps) {
      add(`/ip firewall address-list add list=dartbit-backend address=${ip} comment="Dartbit backend"`);
    }
    add('');

    add('# 6d. (Dartbit redirect rules removed — relying on MikroTik native hotspot interception)');
    add(`:foreach n in=[/ip firewall nat find comment~"Dartbit redirect"] do={ /ip firewall nat remove $n }`);
    add('');

    // 7. Walled garden — allow Dartbit backend AND the portal page so unauth users can reach it
    add('# 7. Walled garden — allow Dartbit portal & backend');
    add(`:foreach w in=[/ip hotspot walled-garden find comment~"Dartbit" !dynamic] do={ /ip hotspot walled-garden remove $w }`);
    add(`/ip hotspot walled-garden add dst-host=${backendHost} comment="Dartbit backend"`);
    add(`/ip hotspot walled-garden add dst-host=*.${backendHost} comment="Dartbit backend wildcard"`);
    add(`:foreach w in=[/ip hotspot walled-garden ip find comment~"Dartbit" !dynamic] do={ /ip hotspot walled-garden ip remove $w }`);
    // Walled-garden IP list lets unauthenticated traffic to these IPs pass through MikroTik's hotspot rejection
    for (const ip of backendIps) {
      add(`/ip hotspot walled-garden ip add dst-address=${ip} comment="Dartbit backend IP"`);
    }
    // Pre-seed the router's DNS cache so it resolves the backend hostname for clients
    add(`:foreach s in=[/ip dns static find name="${backendHost}" comment~"Dartbit"] do={ /ip dns static remove $s }`);
    for (const ip of backendIps) {
      add(`/ip dns static add name=${backendHost} address=${ip} ttl=5m comment="Dartbit backend"`);
    }
    add('');
    add('');

    // 7b. The login page rewrite is NOT done from the script (RouterOS file edits
    //     via script are brittle). Users will see the default MikroTik login form.
    //     For voucher use: print the voucher code on physical tickets, user enters it
    //     as both username AND password on the MikroTik login form.
    add('# 7b. Default hotspot login form used (vouchers redeemed via username+password)');
    add('');

    // 8. Cleanup any old custom filter rules from previous versions that might conflict
    add('# 8. Clean up legacy filter rules');
    add(`:foreach f in=[/ip firewall filter find comment~"Dartbit allow router"] do={ /ip firewall filter remove $f }`);
    add(`:foreach f in=[/ip firewall filter find comment~"Dartbit allow auth"] do={ /ip firewall filter remove $f }`);
    add(`:foreach f in=[/ip firewall filter find comment~"Dartbit block unauth"] do={ /ip firewall filter remove $f }`);
    // Also clean up the bad TTL drop rules — they cause legitimate traffic loss in some setups
    add(`:foreach f in=[/ip firewall filter find comment~"Dartbit no-tether"] do={ /ip firewall filter remove $f }`);
    add(`:foreach m in=[/ip firewall mangle find comment~"Dartbit no-tether"] do={ /ip firewall mangle remove $m }`);
    add('');

    // 8b. Optional TTL anti-tether — DISABLED by default because it breaks
    //     traffic from devices behind an AP in bridge mode (legitimate traffic
    //     can have non-64 TTL on some hardware).
    //     If you specifically want phone-tethering blocking, uncomment in a future revision.
    add('# 8b. Anti-tethering disabled (re-enable carefully if needed)');
    add('');

    // 8c. Force hotspot to re-bind to bridge (picks up newly added ports).
    //     MAC cookie is intentionally ENABLED (see profile above) so returning
    //     clients auto-reconnect within the cookie lifetime without re-entering vouchers.
    add('# 8c. Force hotspot to re-bind to bridge (picks up newly added ports)');
    add(`:foreach h in=[/ip hotspot find name="dartbit-hotspot"] do={ /ip hotspot set $h address-pool=dhcp-pool profile=hsprof-dartbit; /ip hotspot disable $h; :delay 500ms; /ip hotspot enable $h }`);
    add('');

    // === Heartbeat ===
    add('# 9. Heartbeat');
    add(`:foreach s in=[/system scheduler find comment="Dartbit heartbeat"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-heartbeat"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-heartbeat policy=read,write,test source={/tool fetch url="${backendUrl}/router/heartbeat?apiKey=${apiKey}"${fetchFlags} keep-result=no}`);
    add(`/system scheduler add name=dartbit-heartbeat interval=15s on-event="/system script run dartbit-heartbeat" comment="Dartbit heartbeat"`);
    add('');

    // === Stats reporter ===
    add('# 9b. Stats reporter');
    add(`:foreach s in=[/system scheduler find comment="Dartbit stats"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-stats"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-stats policy=read,write,test source={:local cpu [/system resource get cpu-load]; :local upt [/system resource get uptime]; :local mem [/system resource get free-memory]; :local id [/system identity get name]; :local url ("${backendUrl}/router/stats?apiKey=${apiKey}&cpu=" . \$cpu . "&uptime=" . \$upt . "&memFree=" . \$mem . "&identity=" . \$id); /tool fetch url=\$url${fetchFlags} keep-result=no}`);
    add(`/system scheduler add name=dartbit-stats interval=5s on-event="/system script run dartbit-stats" comment="Dartbit stats"`);
    add('');

    // === Interfaces reporter — reports interface list to backend so UI can list ports ===
    add('# 9c. Interfaces reporter');
    add(`:foreach s in=[/system scheduler find comment="Dartbit interfaces"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-interfaces"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-interfaces policy=read,write,test source={:local data ""; :foreach i in=[/interface find where !disabled && (type=ether || type=wlan || type=vlan || type=bridge)] do={ :local n [/interface get \$i name]; :local t [/interface get \$i type]; :set data (\$data . \$n . ":" . \$t . ","); }; :local url ("${backendUrl}/router/interfaces?apiKey=${apiKey}&data=" . \$data); /tool fetch url=\$url${fetchFlags} keep-result=no}`);
    add(`/system scheduler add name=dartbit-interfaces interval=60s on-event="/system script run dartbit-interfaces" comment="Dartbit interfaces"`);
    add('');

    // === Subscriber sync ===
    add('# 10. Subscriber sync');
    add(`:foreach s in=[/system scheduler find comment="Dartbit sub sync"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-sync"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-sync policy=read,write,test source={/tool fetch url="${backendUrl}/router/sync-script?apiKey=${apiKey}"${fetchFlags} dst-path=dartbit-sync.rsc; :delay 1s; /import file-name=dartbit-sync.rsc}`);
    add(`/system scheduler add name=dartbit-sync interval=60s on-event="/system script run dartbit-sync" comment="Dartbit sub sync"`);
    add('');

    // === Remote commands ===
    add('# 11. Remote commands');
    add(`:foreach s in=[/system scheduler find comment="Dartbit cmd"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-cmd"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-cmd policy=read,write,test,reboot source={/tool fetch url="${backendUrl}/router/commands?apiKey=${apiKey}"${fetchFlags} dst-path=dartbit-cmd.rsc; :delay 1s; :if ([:len [/file find name="dartbit-cmd.rsc"]] > 0) do={ /import file-name=dartbit-cmd.rsc; :delay 1s; /file remove [find name="dartbit-cmd.rsc"] }}`);
    add(`/system scheduler add name=dartbit-cmd interval=5s on-event="/system script run dartbit-cmd" comment="Dartbit cmd"`);
    add('');

    // === Active session reporter ===
    add('# 12. Active session reporter');
    add(`:foreach s in=[/system scheduler find comment="Dartbit session sync"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-sessions"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-sessions policy=read,write,test source={:local data ""; :foreach a in=[/ppp active find] do={ :local u [/ppp active get \$a name]; :local ip [/ppp active get \$a address]; :local up [/ppp active get \$a uptime]; :local iface ("<pppoe-" . \$u . ">"); :local rxr 0; :local txr 0; :do { :set rxr [/interface get \$iface rx-byte]; :set txr [/interface get \$iface tx-byte]; } on-error={}; :set data (\$data . \$u . "|" . \$ip . "|" . \$up . "|" . \$rxr . "|" . \$txr . ","); }; :foreach a in=[/ip hotspot active find] do={ :local u [/ip hotspot active get \$a user]; :local ip [/ip hotspot active get \$a address]; :local up [/ip hotspot active get \$a uptime]; :local bi 0; :local bo 0; :do { :set bi [/ip hotspot active get \$a bytes-in]; :set bo [/ip hotspot active get \$a bytes-out]; } on-error={}; :set data (\$data . \$u . "|" . \$ip . "|" . \$up . "|" . \$bi . "|" . \$bo . ","); }; :local url ("${backendUrl}/router/sessions?apiKey=${apiKey}&pppoe=" . \$data); /tool fetch url=\$url${fetchFlags} keep-result=no}`);
    add(`/system scheduler add name=dartbit-sessions interval=5s on-event="/system script run dartbit-sessions" comment="Dartbit session sync"`);
    add('');

    add(':log info "Dartbit: Provisioning complete"');

    return lines.join('\n');
}

// GET /router/ztp-script?apiKey=xxx — serves the provisioning script for the router to fetch.
router.get('/ztp-script', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || '');
    if (!apiKey) return res.status(400).type('text/plain').send('# Error: apiKey required');
    const r = await findRouter(apiKey);
    if (!r) return res.status(404).type('text/plain').send('# Error: Router not found');
    const script = await generateZtpScript(apiKey);
    res.type('text/plain').send(script);
  } catch (err) {
    console.error('ZTP error:', err);
    res.status(500).type('text/plain').send(`# Error: ${err instanceof Error ? err.message : 'Unknown'}`);
  }
});

// Heartbeat
router.all('/heartbeat', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || req.body?.apiKey || '');
    if (!apiKey) return sendError(res, 'apiKey required', 400);
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);
    await prisma.mikrotikRouter.update({
      where: { id: r.id },
      data: { status: 'ONLINE', lastSeenAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Heartbeat error:', err);
    sendError(res, 'Heartbeat failed', 500);
  }
});

// Stats reporter
router.all('/stats', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || req.body?.apiKey || '');
    if (!apiKey) return sendError(res, 'apiKey required', 400);
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);

    const identity = String(req.query.identity || '').replace(/[^\w\-\.]/g, '').substring(0, 50);
    const cpu = parseFloat(String(req.query.cpu || ''));
    const uptime = String(req.query.uptime || '').substring(0, 50);

    await prisma.mikrotikRouter.update({
      where: { id: r.id },
      data: {
        status: 'ONLINE',
        lastSeenAt: new Date(),
        identity: identity || r.identity,
        cpuLoad: !isNaN(cpu) ? cpu : r.cpuLoad,
        uptime: uptime || r.uptime,
      },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Stats error:', err);
    sendError(res, 'Stats failed', 500);
  }
});

// Interface reporter — receives a list of router interfaces
router.all('/interfaces', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || req.body?.apiKey || '');
    if (!apiKey) return sendError(res, 'apiKey required', 400);
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);

    // Parse "name:type,name:type,"
    const raw = String(req.query.data || req.body?.data || '').replace(/[^a-zA-Z0-9_\-\.,:]/g, '');
    const entries = raw.split(',').filter(Boolean);

    // Wipe and rewrite — interfaces change rarely so this is fine
    await prisma.routerInterface.deleteMany({ where: { routerId: r.id } });

    const ifaces: Array<{ name: string; type: string; routerId: string }> = [];
    for (const e of entries) {
      const [name, type] = e.split(':');
      if (name) ifaces.push({ name, type: type || 'unknown', routerId: r.id });
    }
    if (ifaces.length > 0) {
      await prisma.routerInterface.createMany({ data: ifaces });
    }
    res.json({ ok: true, count: ifaces.length });
  } catch (err) {
    console.error('Interfaces error:', err);
    sendError(res, 'Failed', 500);
  }
});

// In-memory traffic baseline for bandwidth deltas
const lastTrafficReading: Record<string, { rx: number; tx: number; at: number }> = {};

// In-memory map of currently active sessions, keyed by `${routerId}:${username}`.
// Tracks the SessionRecord id, latest byte counters, and last-seen time.
// Used to detect session start (new key) and end (key missing from a poll).
interface ActiveSession {
  recordId: string;
  service: 'PPPOE' | 'HOTSPOT' | 'STATIC';
  startRx: number;
  startTx: number;
  lastRx: number;
  lastTx: number;
  lastSeen: number;
  ipAddress: string;
  subscriberId?: string;
}
const activeSessions: Record<string, Record<string, ActiveSession>> = {}; // routerId -> username -> session

router.all('/sessions', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || req.body?.apiKey || '');
    if (!apiKey) return sendError(res, 'apiKey required', 400);
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);

    const pppoeStr = String(req.query.pppoe || '').replace(/[^a-zA-Z0-9_\-\.,:|\/]/g, '');

    await prisma.onlineSession.deleteMany({ where: { routerId: r.id } });

    if (pppoeStr) {
      const entries = pppoeStr.split(',').filter(Boolean);
      const sessions: Array<{
        username: string; ipAddress: string; uptime?: string;
        uploadSpeed?: number; downloadSpeed?: number;
        routerId: string; tenantId: string;
      }> = [];

      const now = Date.now();

      for (const e of entries) {
        const parts = e.split('|');
        let username = '', ipAddress = '', uptime = '', rxBytes = 0, txBytes = 0;

        if (parts.length >= 2) {
          username = parts[0] || '';
          ipAddress = parts[1] || '';
          uptime = parts[2] || '';
          rxBytes = parseInt(parts[3] || '0', 10) || 0;
          txBytes = parseInt(parts[4] || '0', 10) || 0;
        } else {
          const [u, ip] = e.split(':');
          username = u || '';
          ipAddress = ip || '';
        }

        if (!username) continue;

        let uploadKbps = 0, downloadKbps = 0;
        const key = `${r.id}:${username}`;
        const prev = lastTrafficReading[key];

        // Compute speed from deltas. Update if we have a previous reading and ANY
        // counter is present (don't require both > 0 — hotspot users may have one
        // direction momentarily idle, which previously blocked all updates).
        if (prev && (rxBytes > 0 || txBytes > 0)) {
          const dt = (now - prev.at) / 1000;
          if (dt > 0 && dt < 120) {
            const rxDelta = Math.max(0, rxBytes - prev.rx);
            const txDelta = Math.max(0, txBytes - prev.tx);
            uploadKbps = Math.round((rxDelta * 8) / 1024 / dt);
            downloadKbps = Math.round((txDelta * 8) / 1024 / dt);
          }
        }

        // Always record the latest counter reading (even if one side is 0) so the
        // next poll can compute a delta. This is what makes voucher/hotspot users
        // update live every 5s like PPPoE.
        lastTrafficReading[key] = { rx: rxBytes, tx: txBytes, at: now };

        sessions.push({
          username, ipAddress, uptime,
          uploadSpeed: uploadKbps,
          downloadSpeed: downloadKbps,
          routerId: r.id, tenantId: r.tenantId,
        });
      }

      // Link to subscribers by username
      const usernames = sessions.map(s => s.username);
      const subs = await prisma.subscriber.findMany({
        where: { tenantId: r.tenantId, username: { in: usernames } },
        select: { id: true, username: true, service: true },
      });
      const subByUsername: Record<string, { id: string; service: string }> = {};
      for (const s of subs) subByUsername[s.username] = { id: s.id, service: s.service };

      const sessionsWithIds = sessions.map(s => ({
        ...s,
        subscriberId: subByUsername[s.username]?.id || undefined,
      }));

      if (sessionsWithIds.length > 0) {
        await prisma.onlineSession.createMany({ data: sessionsWithIds });

        for (const s of sessionsWithIds) {
          await prisma.subscriber.updateMany({
            where: { tenantId: r.tenantId, username: s.username },
            data: { lastOnlineAt: new Date(), ipAddress: s.ipAddress || undefined, routerId: r.id },
          });
        }
      }

      // === Persistent session history (SessionRecord) ===
      await recordSessionHistory(r.id, r.tenantId, sessions, subByUsername, now);
    } else {
      // Empty poll = no active sessions. End all currently-tracked sessions for this router.
      await recordSessionHistory(r.id, r.tenantId, [], {}, Date.now());
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Sessions error:', err);
    sendError(res, 'Failed', 500);
  }
});

// Detects session starts (username newly present) and ends (username gone),
// maintaining persistent SessionRecord rows with byte totals.
async function recordSessionHistory(
  routerId: string,
  tenantId: string,
  sessions: Array<{ username: string; ipAddress: string; uptime?: string }>,
  subByUsername: Record<string, { id: string; service: string }>,
  now: number,
) {
  if (!activeSessions[routerId]) activeSessions[routerId] = {};
  const tracked = activeSessions[routerId];
  const seenNow = new Set<string>();

  for (const s of sessions) {
    if (!s.username) continue;
    seenNow.add(s.username);
    const key = `${routerId}:${s.username}`;
    const reading = lastTrafficReading[key]; // { rx, tx, at } — cumulative counters
    const rx = reading?.rx ?? 0;
    const tx = reading?.tx ?? 0;
    const sub = subByUsername[s.username];
    const service = (sub?.service as 'PPPOE' | 'HOTSPOT' | 'STATIC') || 'HOTSPOT';

    const existing = tracked[s.username];
    if (!existing) {
      // New session — create a SessionRecord
      try {
        const rec = await prisma.sessionRecord.create({
          data: {
            username: s.username,
            service,
            ipAddress: s.ipAddress || null,
            startedAt: new Date(now),
            lastSeenAt: new Date(now),
            startRx: BigInt(rx),
            startTx: BigInt(tx),
            rxBytes: BigInt(0),
            txBytes: BigInt(0),
            subscriberId: sub?.id || null,
            routerId,
            tenantId,
          },
        });
        tracked[s.username] = {
          recordId: rec.id, service,
          startRx: rx, startTx: tx, lastRx: rx, lastTx: tx,
          lastSeen: now, ipAddress: s.ipAddress || '', subscriberId: sub?.id,
        };
      } catch (e) {
        console.error('Failed to create SessionRecord:', e);
      }
    } else {
      // Ongoing session — update byte totals + lastSeen.
      // Counters may reset (e.g. reconnect) — if current < start, treat as a fresh baseline.
      let totalRx = rx - existing.startRx;
      let totalTx = tx - existing.startTx;
      if (totalRx < 0 || totalTx < 0) {
        existing.startRx = rx; existing.startTx = tx;
        totalRx = 0; totalTx = 0;
      }
      existing.lastRx = rx; existing.lastTx = tx; existing.lastSeen = now;
      try {
        await prisma.sessionRecord.update({
          where: { id: existing.recordId },
          data: {
            lastSeenAt: new Date(now),
            rxBytes: BigInt(Math.max(0, totalRx)),
            txBytes: BigInt(Math.max(0, totalTx)),
            ipAddress: s.ipAddress || existing.ipAddress || null,
          },
        });
      } catch (e) {
        console.error('Failed to update SessionRecord:', e);
      }
    }
  }

  // Any tracked session NOT seen in this poll has ended — finalize it.
  for (const username of Object.keys(tracked)) {
    if (!seenNow.has(username)) {
      const sess = tracked[username];
      try {
        await prisma.sessionRecord.update({
          where: { id: sess.recordId },
          data: { endedAt: new Date(sess.lastSeen), lastSeenAt: new Date(sess.lastSeen) },
        });
      } catch (e) {
        console.error('Failed to finalize SessionRecord:', e);
      }
      delete tracked[username];
      // Clean the traffic reading cache for the ended session
      delete lastTrafficReading[`${routerId}:${username}`];
    }
  }
}

router.get('/sync-script', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || '');
    if (!apiKey) return res.status(400).type('text/plain').send('# Error: apiKey required');

    const r = await prisma.mikrotikRouter.findUnique({
      where: { apiKey },
      include: { tenant: true },
    });
    if (!r) return res.status(404).type('text/plain').send('# Error: Router not found');

    const subscribers = await prisma.subscriber.findMany({
      where: { tenantId: r.tenantId },
      include: { package: true },
    });

    const now = new Date();
    const lines: string[] = [];
    const add = (s: string) => lines.push(s);

    add(`:log info "Dartbit: Syncing ${subscribers.length} subscribers"`);
    add('');

    function rosDate(d: Date): { date: string; time: string } {
      const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = months[d.getMonth()];
      const yyyy = d.getFullYear();
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return { date: `${mm}/${dd}/${yyyy}`, time: `${hh}:${mi}:${ss}` };
    }

    add(`:foreach s in=[/system scheduler find comment~"Dartbit-expiry:"] do={ /system scheduler remove \$s }`);
    add(`:foreach s in=[/system script find name~"^dartbit-exp-script-"] do={ /system script remove \$s }`);
    add('');

    const pppoeUsers = subscribers.filter(s => s.service === 'PPPOE');
    for (const sub of pppoeUsers) {
      const speed = sub.package ? `${sub.package.speedUpKbps}k/${sub.package.speedDownKbps}k` : '10M/10M';
      const profileName = sub.package ? `db-p-${sub.package.id.substring(0, 8)}` : 'dartbit-pppoe';
      const expired = sub.expiresAt && sub.expiresAt <= now;
      const disabled = !sub.isActive || expired;

      // Each line stays short — uses inline strings, no shared state needed.
      // Profile line: ~150 chars
      add(`:if ([:len [/ppp profile find name="${profileName}"]] = 0) do={ /ppp profile add name=${profileName} local-address=10.10.10.1 remote-address=pppoe-pool rate-limit="${speed}" comment="Dartbit" }`);
      // For long secret-add lines, split into separate find/set/add operations to avoid 200-char import limit
      add(`:if ([:len [/ppp secret find name="${sub.username}"]] = 0) do={ /ppp secret add name="${sub.username}" password="${sub.secret}" profile=${profileName} service=pppoe comment="Dartbit:${sub.id}" }`);
      add(`:if ([:len [/ppp secret find name="${sub.username}"]] > 0) do={ /ppp secret set [find name="${sub.username}"] password="${sub.secret}" profile=${profileName} disabled=${disabled ? 'yes' : 'no'} }`);
      if (expired) {
        add(`:foreach a in=[/ppp active find name="${sub.username}"] do={ /ppp active remove \$a }`);
      }
      // Note: per-subscriber expiry is enforced by the sync script (runs every 60s).
      // When expiresAt passes, sync will set disabled=yes on the next cycle.
    }

    const hsUsers = subscribers.filter(s => s.service === 'HOTSPOT');
    for (const sub of hsUsers) {
      const speed = sub.package ? `${sub.package.speedUpKbps}k/${sub.package.speedDownKbps}k` : '5M/5M';
      const profileName = sub.package ? `db-h-${sub.package.id.substring(0, 8)}` : 'dartbit-default';
      const expired = sub.expiresAt && sub.expiresAt <= now;
      const disabled = !sub.isActive || expired;

      // Profile: split add+set so each line is short
      add(`:if ([:len [/ip hotspot user profile find name="${profileName}"]] = 0) do={ /ip hotspot user profile add name=${profileName} }`);
      add(`/ip hotspot user profile set [find name="${profileName}"] rate-limit="${speed}" shared-users=1 add-mac-cookie=yes`);
      add(`:if ([:len [/ip hotspot user find name="${sub.username}"]] = 0) do={ /ip hotspot user add name="${sub.username}" password="${sub.secret}" profile=${profileName} comment="Dartbit:${sub.id}" }`);
      add(`:if ([:len [/ip hotspot user find name="${sub.username}"]] > 0) do={ /ip hotspot user set [find name="${sub.username}"] password="${sub.secret}" profile=${profileName} disabled=${disabled ? 'yes' : 'no'} }`);
      if (expired) {
        add(`:foreach a in=[/ip hotspot active find user="${sub.username}"] do={ /ip hotspot active remove \$a }`);
      }
      // Note: per-subscriber expiry is enforced by the sync script (runs every 60s).
    }

    const staticUsers = subscribers.filter(s => s.service === 'STATIC' && s.ipAddress);
    for (const sub of staticUsers) {
      if (!sub.ipAddress) continue;
      add(`:if ([:len [/ip dhcp-server lease find address="${sub.ipAddress}"]] = 0) do={ /ip dhcp-server lease add address=${sub.ipAddress} ${sub.macAddress ? `mac-address=${sub.macAddress}` : ''} server=dartbit-hotspot-dhcp comment="Dartbit:${sub.id}" }`);
    }

    // ===== VOUCHERS — sync all non-fully-expired vouchers as hotspot users =====
    // We push BOTH used and unused vouchers because:
    //  - Unused vouchers must exist on the router so users can log in
    //  - Used vouchers must stay on the router until their individual session expires
    //    (limit-uptime = voucher's own durationMinutes), otherwise the session is cut short.
    //
    // Each voucher has its own expiresAt (set on redeem to: now + durationMinutes).
    // We include it on the router if it's either unused OR not yet expired.
    // Add a 1-hour grace period after expiresAt before removing, in case the user's
    // session is still active on MikroTik.
    const vouchers = await prisma.voucher.findMany({
      where: {
        tenantId: r.tenantId,
        AND: [
          // Router scope: either router-specific or any-router
          {
            OR: [
              { routerId: null },
              { routerId: r.id },
            ],
          },
          // Lifecycle: either unused, or used-but-still-within-session-window
          {
            OR: [
              { isUsed: false },
              { isUsed: true, expiresAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) } },
              { isUsed: true, expiresAt: null, usedAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
            ],
          },
        ],
      },
      include: { package: true },
      take: 2000,
    });
    console.log(`[sync] Router ${r.id}: found ${vouchers.length} vouchers to push`);

    // Group by package so we create one user profile per package
    const profilesByPkg: Record<string, { name: string; speed: string }> = {};
    for (const v of vouchers) {
      if (v.package) {
        const pid = v.package.id.substring(0, 8);
        const pname = `db-v-${pid}`;
        if (!profilesByPkg[pname]) {
          profilesByPkg[pname] = {
            name: pname,
            speed: `${v.package.speedUpKbps}k/${v.package.speedDownKbps}k`,
          };
        }
      }
    }
    for (const prof of Object.values(profilesByPkg)) {
      add(`:if ([:len [/ip hotspot user profile find name="${prof.name}"]] = 0) do={ /ip hotspot user profile add name=${prof.name} }`);
      add(`/ip hotspot user profile set [find name="${prof.name}"] rate-limit="${prof.speed}" shared-users=1 add-mac-cookie=yes`);
    }
    // Add each voucher as a hotspot user — username and password = code.
    // limit-uptime starts counting from first login (MikroTik behavior).
    add(`:log info "Dartbit: sync pushing ${vouchers.length} vouchers"`);
    for (const v of vouchers) {
      const profileName = v.package ? `db-v-${v.package.id.substring(0, 8)}` : 'dartbit-default';
      const sessionSec = v.durationMinutes * 60;
      const shortId = v.id.slice(-8);
      add(`:if ([:len [/ip hotspot user find name="${v.code}"]] = 0) do={ /ip hotspot user add name=${v.code} password=${v.code} profile=${profileName} limit-uptime=${sessionSec}s comment="Dbv:${shortId}" }`);
    }
    // Clean up voucher-users for vouchers that are no longer in our active list.
    // Comment format on router: "Dbv:<shortId>" — short to fit in 200-char line limit.
    if (vouchers.length > 0) {
      const knownIdsArray = vouchers.map(v => `"Dbv:${v.id.slice(-8)}"`).join(';');
      add(`:local kvc {${knownIdsArray}}`);
      add(`:foreach u in=[/ip hotspot user find comment~"Dbv:"] do={ :local c [/ip hotspot user get \$u comment]; :local k false; :foreach kc in=\$kvc do={ :if (\$c = \$kc) do={ :set k true } }; :if (!\$k) do={ /ip hotspot user remove \$u } }`);
    } else {
      add(`:foreach u in=[/ip hotspot user find comment~"Dbv:"] do={ /ip hotspot user remove \$u }`);
    }

    const knownIds = subscribers.map(s => `"Dartbit:${s.id}"`).join(';');
    add('');
    add('# Disable Dartbit-managed users no longer in backend');
    if (subscribers.length > 0) {
      add(`:local knownSubComments {${knownIds}}`);
      add(`:foreach s in=[/ppp secret find comment~"Dartbit:"] do={ :local c [/ppp secret get \$s comment]; :local keep false; :foreach kc in=\$knownSubComments do={ :if (\$c = \$kc) do={ :set keep true } }; :if (!\$keep) do={ /ppp secret disable \$s; :foreach a in=[/ppp active find name=[/ppp secret get \$s name]] do={ /ppp active remove \$a } } }`);
      add(`:foreach s in=[/ip hotspot user find comment~"Dartbit:"] do={ :local c [/ip hotspot user get \$s comment]; :local keep false; :foreach kc in=\$knownSubComments do={ :if (\$c = \$kc) do={ :set keep true } }; :if (!\$keep) do={ /ip hotspot user disable \$s } }`);
    } else {
      add(`:foreach s in=[/ppp secret find comment~"Dartbit:"] do={ /ppp secret disable \$s }`);
      add(`:foreach s in=[/ip hotspot user find comment~"Dartbit:"] do={ /ip hotspot user disable \$s }`);
    }

    res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    console.error('Sync script error:', err);
    res.status(500).type('text/plain').send(`# Error: ${err instanceof Error ? err.message : 'Unknown'}`);
  }
});

router.get('/commands', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || '');
    if (!apiKey) return res.status(400).type('text/plain').send('');
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return res.status(404).type('text/plain').send('');

    const cmds = await dequeueAll(r.id);
    if (cmds.length === 0) return res.type('text/plain').send('# No commands\n');

    const script = cmds.join('\n') + '\n:log info "Dartbit: Executed ' + cmds.length + ' command(s)"\n';
    res.type('text/plain').send(script);
  } catch {
    res.type('text/plain').send('');
  }
});

router.post('/enqueue-command/:routerId', async (req: Request, res: Response) => {
  try {
    const { routerId } = req.params;
    const { command } = req.body;
    if (!command) return sendError(res, 'command required', 400);
    const r = await prisma.mikrotikRouter.findUnique({ where: { id: routerId } });
    if (!r) return sendError(res, 'Router not found', 404);
    const queued = await enqueueCommand(routerId, command);
    res.json({ success: true, queued });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

router.get('/provision/:routerId', async (req: Request, res: Response) => {
  try {
    const { routerId } = req.params;
    let cfg = await prisma.routerProvisioningConfig.findUnique({ where: { routerId } });
    if (!cfg) {
      cfg = await prisma.routerProvisioningConfig.create({ data: { routerId } });
    }
    res.json({ success: true, data: cfg });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load provisioning config';
    sendError(res, msg, 500);
  }
});

router.post('/provision/:routerId', async (req: Request, res: Response) => {
  try {
    const { routerId } = req.params;
    const body = req.body || {};
    const allowed = [
      'wanInterface', 'lanInterface', 'bridgeName',
      'lanSubnet', 'lanGateway', 'dhcpPoolStart', 'dhcpPoolEnd', 'dnsServers',
      'pppoeEnabled', 'pppoeInterface', 'pppoeLocalAddress', 'pppoeRemotePool',
      'pppoePoolStart', 'pppoePoolEnd',
      'hotspotEnabled', 'hotspotInterface', 'hotspotNetwork', 'hotspotDnsName',
      'staticEnabled',
    ];
    const data: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in body && body[k] !== undefined) data[k] = body[k];
    }

    const r = await prisma.mikrotikRouter.findUnique({ where: { id: routerId } });
    if (!r) return sendError(res, 'Router not found', 404);

    const cfg = await prisma.routerProvisioningConfig.upsert({
      where: { routerId },
      create: { routerId, ...data },
      update: data,
    });
    res.json({ success: true, data: cfg });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to save provisioning config';
    sendError(res, msg, 500);
  }
});

// GET /router/list-interfaces/:routerId — get this router's discovered interfaces for the UI
router.get('/list-interfaces/:routerId', async (req: Request, res: Response) => {
  try {
    const interfaces = await prisma.routerInterface.findMany({
      where: { routerId: req.params.routerId },
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, data: interfaces });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export { generateZtpScript };
export default router;
