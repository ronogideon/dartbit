import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { promises as dns } from 'dns';
import prisma from '../utils/prisma';
import { sendError } from '../utils/response';
import { enqueueCommand, dequeueAll, clearQueue } from '../utils/commandQueue';

const router = Router();

// Gate for the OnlineSession schema self-heal in /sessions: at most one attempt per minute per
// process, so a heal that can't succeed (e.g. deeper DB problem) doesn't stampede on every poll.
let lastSessionHealAt = 0;
function canAttemptSessionHeal(): boolean {
  const now = Date.now();
  if (now - lastSessionHealAt < 60_000) return false;
  lastSessionHealAt = now;
  return true;
}

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

// Resolves the backend base URL for router scripts. Always returns an https:// URL because
// RouterOS /tool fetch requires mode=https. Falls back to api.dartbittech.com.
function resolveBackendUrl(): string {
  let backendUrl = process.env.BACKEND_URL || 'https://api.dartbittech.com';
  backendUrl = backendUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (backendUrl.includes('localhost') || backendUrl.includes('127.0.0.1')) {
    backendUrl = 'api.dartbittech.com';
  }
  return 'https://' + backendUrl;
}

// Generates the full ZTP provisioning script for a router (the same content the
// /ztp-script endpoint serves). Extracted so reprovision can deliver it directly
// through the command queue without the router needing a second fetch.
async function generateZtpScript(apiKey: string, opts?: { skipCmdScript?: boolean }): Promise<string> {
    const r = await findRouter(apiKey);
    if (!r) throw new Error('Router not found');
    const skipCmdScript = opts?.skipCmdScript === true;

    const backendUrl = resolveBackendUrl();
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
    add('');

    // 0. Cleanup — remove Dartbit artifacts from any PRIOR provisioning so a (re)provision starts
    // clean and can't leave stale half-state. Scoped strictly to Dartbit's own names/comments, so a
    // coexisting system on the same router (e.g. centipid) is never touched. The sections below
    // re-create everything Dartbit needs.
    //
    // CRITICAL: never remove dartbit-cmd / dartbit-cmd-upd here. When a reprovision is delivered
    // THROUGH the command queue, this very script is being imported by the dartbit-cmd poller —
    // removing it mid-import kills the import (so "Provisioning complete" never logs) AND destroys
    // the command channel (skipCmdScript means it isn't recreated). Excluding the poller keeps the
    // reprovision alive end-to-end. The poller is managed separately in section 11.
    add('# 0. Cleanup prior Dartbit artifacts (idempotent reprovision; preserves the cmd poller)');
    add(`:foreach s in=[/system scheduler find where name~"dartbit"] do={ :local n [/system scheduler get $s name]; :if ($n != "dartbit-cmd" && $n != "dartbit-cmd-upd") do={ /system scheduler remove $s } }`);
    add(`:foreach s in=[/system scheduler find where comment~"Dartbit"] do={ :local n [/system scheduler get $s name]; :if ($n != "dartbit-cmd" && $n != "dartbit-cmd-upd") do={ /system scheduler remove $s } }`);
    add(`:foreach s in=[/system script find where name~"dartbit"] do={ :local n [/system script get $s name]; :if ($n != "dartbit-cmd" && $n != "dartbit-cmd-upd") do={ /system script remove $s } }`);
    // NOTE: we do NOT remove /radius entries here. Section 8e removes+re-adds them atomically when
    // RADIUS is active. Stripping them unconditionally here would wipe a working router's RADIUS
    // config whenever the backend's RADIUS env switch is momentarily off — and never restore it,
    // leaving the router sending nothing to FreeRADIUS ("times out, no requests").
    add('');

    // 0b. Identity — make the MikroTik system identity match the dashboard name, so there's ONE name
    // across the whole system. Renaming the router in the dashboard updates the identity on next push.
    const identity = (r.name || 'dartbit').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'dartbit';
    add(`/system identity set name="${identity}"`);
    add('');

    // 1. Bridge
    add('# 1. Bridge');
    add(`:if ([:len [/interface bridge find name="${bridge}"]] = 0) do={ /interface bridge add name=${bridge} comment="Dartbit LAN" }`);
    // Runtime WAN detection: the interface carrying the active default route (resolving "gw%iface"
    // notation and PPPoE-client WANs to the physical port). Used to keep the live uplink out of the
    // bridge even if the stored config names a different port.
    add(`:local wandet ""; :do { :local rt [/ip route find where dst-address="0.0.0.0/0" and active]; :if ([:len $rt] > 0) do={ :local gw [/ip route get [:pick $rt 0] immediate-gw]; :if ([:typeof $gw] = "str") do={ :local p [:find $gw "%"]; :if ([:typeof $p] = "num") do={ :set wandet [:pick $gw ($p+1) [:len $gw]] } else={ :set wandet $gw } } } } on-error={}; :do { :if ([:len [/interface pppoe-client find name=$wandet]] > 0) do={ :set wandet [/interface pppoe-client get [find name=$wandet] interface] } } on-error={}`);
    for (const port of lanInterfaces) {
      // First remove the port from ANY other bridge it might be on (this is the fix —
      // RouterOS silently rejects adding a port that's already on another bridge).
      add(`:foreach p in=[/interface bridge port find interface="${port}"] do={ :local b [/interface bridge port get $p bridge]; :if ($b != "${bridge}") do={ /interface bridge port remove $p; :log info ("Dartbit: moved ${port} from " . $b . " to ${bridge}") } }`);
      add(`:if ("${port}" != $wandet && [:len [/interface bridge port find interface="${port}" bridge="${bridge}"]] = 0) do={ /interface bridge port add bridge=${bridge} interface=${port} comment="Dartbit LAN port" }`);
    }
    // Safety net: add every remaining LAN-side interface that isn't on ANY bridge yet — all ethernet
    // except the WAN uplink, plus any wireless — into the bridge. Error-safe, so a freshly installed
    // router ends up with every AP/LAN port on the one bridge even if not all were enumerated.
    add(`:foreach i in=[/interface ethernet find where name!="${wan}"] do={ :local n [/interface ethernet get $i name]; :if ($n != $wandet && [:len [/interface bridge port find interface=$n]] = 0 && [:len [/ip address find interface=$n]] = 0 && [:len [/ip dhcp-client find interface=$n]] = 0) do={ :do { /interface bridge port add bridge=${bridge} interface=$n comment="Dartbit LAN (auto)" } on-error={} } }`);
    add(`:foreach w in=[/interface find where type="wlan"] do={ :local n [/interface get $w name]; :if ([:len [/interface bridge port find interface=$n]] = 0 && [:len [/ip address find interface=$n]] = 0 && [:len [/ip dhcp-client find interface=$n]] = 0) do={ :do { /interface bridge port add bridge=${bridge} interface=$n comment="Dartbit WLAN (auto)" } on-error={} } }`);
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
    // NAT must follow the REAL uplink: prefer the runtime-detected default-route interface
    // (wandet, from section 1) over the configured value, and self-correct an existing rule that
    // points at the wrong port (e.g. provisioned before detection, or the uplink moved).
    add(`:local natif "${wan}"; :if ([:len $wandet] > 0) do={ :set natif $wandet }`);
    add(`:if ([:len [/ip firewall nat find comment="Dartbit WAN NAT"]] = 0) do={ /ip firewall nat add chain=srcnat out-interface=$natif action=masquerade comment="Dartbit WAN NAT" } else={ :if ([/ip firewall nat get [find comment="Dartbit WAN NAT"] out-interface] != $natif) do={ /ip firewall nat set [find comment="Dartbit WAN NAT"] out-interface=$natif; :log info ("Dartbit: WAN NAT moved to " . $natif) } }`);
    add('');

    // 4b. ANTI-TETHERING (block hotspot/USB sharing) — TTL based, DISABLED BY DEFAULT.
    // 4b. ANTI-TETHERING (TTL) — DISABLED. TTL-based detection is unsafe on this product's typical
    // topology: in a WISP/hotspot deployment, legitimate customer traffic frequently arrives already
    // decremented (TTL 63/127) because it passes through the customer's own router or a routed AP
    // before reaching the MikroTik. Enabling the drop therefore blocks paying customers, not just
    // tethered second devices (confirmed in the field). The rules are kept here, created DISABLED, so
    // an operator whose topology is flat L2 (every client a direct bridge member) can opt in with:
    //   /ip firewall filter enable [find comment~"Dartbit anti-tether"]
    // The reprovision below also REMOVES any previously-enabled copies so a bad enable can't persist.
    add('# 4b. Anti-tethering (TTL) — DISABLED (unsafe for routed-client topologies)');
    add(`:foreach f in=[/ip firewall filter find comment~"Dartbit anti-tether"] do={ /ip firewall filter remove \$f }`);
    add(`:foreach f in=[/ip firewall mangle find comment~"Dartbit ttl"] do={ /ip firewall mangle remove \$f }`);
    add(`/ip firewall filter add chain=forward in-interface-list=LAN out-interface=${wan} ttl=equal:63 dst-address-list=!dartbit-backend action=drop comment="Dartbit anti-tether 63" disabled=yes`);
    add(`/ip firewall filter add chain=forward in-interface-list=LAN out-interface=${wan} ttl=equal:127 dst-address-list=!dartbit-backend action=drop comment="Dartbit anti-tether 127" disabled=yes`);
    add('');

    // 5. PPPoE server
    add('# 5. PPPoE server');
    add(`:if ([:len [/ip pool find name="${pppoePool}"]] = 0) do={ /ip pool add name=${pppoePool} ranges=${pppoeStart}-${pppoeEnd} }`);
    add(`:if ([:len [/ppp profile find name="dartbit-pppoe"]] = 0) do={ /ppp profile add name=dartbit-pppoe local-address=${pppoeLocal} remote-address=${pppoePool} comment="Dartbit PPPoE" }`);
    add(`:if ([:len [/interface pppoe-server server find service-name="dartbit"]] = 0) do={ /interface pppoe-server server add service-name=dartbit interface=${bridge} authentication=chap,pap default-profile=dartbit-pppoe disabled=no comment="Dartbit PPPoE Server" }`);
    // Expired/restricted PPPoE profile: expired subscribers are moved here instead of being
    // disconnected, so they STAY connected but can only reach the Dartbit portal/backend to renew.
    // The profile tags connected clients into the "dartbit-expired" address-list; firewall rules
    // below permit only DNS + the backend/portal address-list and drop everything else for them.
    add(`:if ([:len [/ppp profile find name="dartbit-expired"]] = 0) do={ /ppp profile add name=dartbit-expired local-address=${pppoeLocal} remote-address=${pppoePool} address-list=dartbit-expired comment="Dartbit Expired (portal-only)" }`);
    add(`/ppp profile set [find name="dartbit-expired"] address-list=dartbit-expired`);
    // Walled-garden firewall for expired PPPoE/Static: allow DNS, the backend, and the portal;
    // drop all other forwarded traffic from expired clients. Rules are idempotent (recreated).
    add(`:foreach f in=[/ip firewall filter find comment~"Dartbit expired"] do={ /ip firewall filter remove $f }`);
    add(`/ip firewall filter add chain=forward src-address-list=dartbit-expired protocol=udp dst-port=53 action=accept comment="Dartbit expired: DNS"`);
    add(`/ip firewall filter add chain=forward src-address-list=dartbit-expired protocol=tcp dst-port=53 action=accept comment="Dartbit expired: DNS tcp"`);
    add(`/ip firewall filter add chain=forward src-address-list=dartbit-expired dst-address-list=dartbit-backend action=accept comment="Dartbit expired: portal+backend"`);
    add(`/ip firewall filter add chain=forward src-address-list=dartbit-expired action=drop comment="Dartbit expired: block rest"`);
    add('');

    // 6. Hotspot — captive portal with DHCP managed by the hotspot itself
    add('# 6. Hotspot — captive portal');
    // login-by=mac ONLY (plus the form methods http-pap for manual code/credential entry):
    //  - mac: MikroTik auto-authenticates a device whose MAC matches a hotspot user named after
    //    that MAC. The sync maintains that MAC user for every ACTIVE device and REMOVES it the
    //    moment the package expires — so auto-login is implicitly "on for active, off for expired".
    //  We deliberately DROP "cookie" from login-by: the MAC cookie would keep half-logging-in an
    //  EXPIRED device (cookie is its own credential, independent of the user existing), bouncing it
    //  in a reconnect loop on the captive portal and blocking the purchase flow. MAC auth alone
    //  gives robust auto-login for active devices without that loop.
    add(`:if ([:len [/ip hotspot profile find name="hsprof-dartbit"]] = 0) do={ /ip hotspot profile add name=hsprof-dartbit hotspot-address=${lanGw} dns-name=dartbit.login login-by=cookie,mac,http-pap mac-auth-password=dartbit use-radius=no }`);
    // Always sync the profile settings (idempotent — no disruption). use-radius is intentionally NOT
    // set here: new profiles default to use-radius=no (the create above), and section 8e flips it to
    // =yes when RADIUS is active — so we never downgrade a RADIUS-mode profile on reprovision.
    add(`/ip hotspot profile set [find name="hsprof-dartbit"] hotspot-address=${lanGw} dns-name=dartbit.login login-by=cookie,mac,http-pap mac-auth-password=dartbit`);
    // User profile — one device per credential. No add-mac-cookie (cookie auth removed; MAC auth
    // via the MAC-named user is the reconnect mechanism and it cleanly stops at expiry).
    add(`:if ([:len [/ip hotspot user profile find name="dartbit-default"]] = 0) do={ /ip hotspot user profile add name=dartbit-default rate-limit="10M/10M" shared-users=1 address-pool=dhcp-pool }`);
    add(`:do { /ip hotspot user profile set [find name="dartbit-default"] add-mac-cookie=yes } on-error={}`);
    // Hotspot itself on the bridge
    add(`:if ([:len [/ip hotspot find name="dartbit-hotspot"]] = 0) do={ /ip hotspot add name=dartbit-hotspot interface=${bridge} address-pool=dhcp-pool profile=hsprof-dartbit disabled=no }`);
    // Sync hotspot settings — idempotent, RouterOS handles no-op gracefully
    add(`/ip hotspot set [find name="dartbit-hotspot"] interface=${bridge} address-pool=dhcp-pool profile=hsprof-dartbit disabled=no`);
    // Remove any other hotspots on this interface (e.g. from other tools)
    add(`:foreach h in=[/ip hotspot find interface="${bridge}"] do={ :if ([/ip hotspot get $h name] != "dartbit-hotspot") do={ /ip hotspot remove $h } }`);
    // Diagnostic logging
    add('');

    // 6a. Replace MikroTik's default login.html with one that redirects to Dartbit's portal.
    //     On models WITH flash storage (hAP, hEX, most ARM boards) the persistent filesystem lives
    //     under flash/, so the HTML must go to flash/hotspot — writing to hotspot/ lands in RAM and
    //     the hotspot serves its BUILT-IN DEFAULT page instead (dartbit.login -> MikroTik login).
    add('# 6a. Install Dartbit captive portal HTML');
    add(`:local hdir "hotspot"; :if ([:len [/file find where name="flash"]] > 0) do={ :set hdir "flash/hotspot" }`);
    add(`:do { /ip hotspot profile set [find name="hsprof-dartbit"] html-directory=$hdir; :local got [/ip hotspot profile get [find name="hsprof-dartbit"] html-directory]; :if ($got != $hdir) do={ /ip hotspot profile set [find name="hsprof-dartbit"] html-directory="hotspot" } } on-error={}`);
    // Download our login.html — it's a tiny redirect page to the Dartbit-hosted portal
    add(`/tool fetch url="${backendUrl}/hotspot-html/login?apiKey=${apiKey}" dst-path=($hdir . "/login.html")${fetchFlags}`);
    add(`:delay 1s`);
    // Also overwrite alogin.html which is shown on successful login
    add(`/tool fetch url="${backendUrl}/hotspot-html/login?apiKey=${apiKey}" dst-path=($hdir . "/alogin.html")${fetchFlags}`);
    add(`:delay 1s`);
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
    // Also resolve the portal frontend domain so expired PPPoE/hotspot clients can load the
    // portal web app (not just the API). Apex + a representative subdomain cover the CDN IPs.
    const portalBaseHost = (process.env.PORTAL_BASE_DOMAIN || 'dartbittech.com').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    // The tenant's actual portal subdomain (e.g. "jja.dartbittech.com") — this is the host an
    // expired customer must reach to renew. We resolve BOTH the apex and this specific subdomain so
    // its (possibly different CDN) IPs are whitelisted for unentitled/expired accounts.
    const tenantPortalHost = r.tenant?.subdomain ? `${r.tenant.subdomain}.${portalBaseHost}` : '';
    const tenantDomain = r.tenant?.domain || '';
    const portalIps = await resolveBackendIps(portalBaseHost).catch(() => [] as string[]);
    const tenantPortalIps = tenantPortalHost ? await resolveBackendIps(tenantPortalHost).catch(() => [] as string[]) : [];
    const tenantDomainIps = tenantDomain ? await resolveBackendIps(tenantDomain).catch(() => [] as string[]) : [];
    const allowIps = Array.from(new Set([...backendIps, ...portalIps, ...tenantPortalIps, ...tenantDomainIps]));

    // 6c. CRITICAL: pre-seed DNS static and walled garden by IP FIRST so AJAX from
    //     captive portal can reach Dartbit without being caught by the force-redirect.
    add('# 6c. Backend whitelisting (must come before force-redirect rules)');
    // Add backend IPs to a firewall address list — used by the force-redirect rules below
    add(`:do { /ip firewall address-list remove [find list="dartbit-backend"] } on-error={}`);
    for (const ip of allowIps) {
      add(`/ip firewall address-list add list=dartbit-backend address=${ip} comment="Dartbit backend"`);
    }
    // ALSO add the hostnames by FQDN. RouterOS 7 resolves these and keeps the address-list entry
    // updated as the IPs change, and (critically) covers the tenant subdomains/portal whose CDN
    // IPs may differ from the apex. This is what lets a no-package PPPoE/static user reach the
    // tenant subdomain to buy a plan, not just the apex.
    add(`/ip firewall address-list add list=dartbit-backend address=${backendHost} comment="Dartbit backend fqdn"`);
    add(`/ip firewall address-list add list=dartbit-backend address=${portalBaseHost} comment="Dartbit portal fqdn"`);
    // The tenant's own portal subdomain — explicitly allowed so an expired/unpaid customer on ANY
    // account can always reach tenant.dartbittech.com to pay, regardless of payment status.
    if (tenantPortalHost) add(`/ip firewall address-list add list=dartbit-backend address=${tenantPortalHost} comment="Dartbit tenant portal fqdn"`);
    if (tenantDomain) add(`/ip firewall address-list add list=dartbit-backend address=${tenantDomain} comment="Dartbit tenant domain"`);
    add('');

    add('# 6d. (Dartbit redirect rules removed — relying on MikroTik native hotspot interception)');
    add(`:foreach n in=[/ip firewall nat find comment~"Dartbit redirect"] do={ /ip firewall nat remove $n }`);
    add('');

    // 7. Walled garden — allow Dartbit backend AND the portal page so unauth/expired users can
    //    reach it to renew. We whitelist BOTH the API host and the portal frontend domain.
    const portalBase = (process.env.PORTAL_BASE_DOMAIN || 'dartbittech.com').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    add('# 7. Walled garden — allow Dartbit portal & backend');
    add(`:foreach w in=[/ip hotspot walled-garden find comment~"Dartbit" !dynamic] do={ /ip hotspot walled-garden remove $w }`);
    add(`/ip hotspot walled-garden add dst-host=${backendHost} comment="Dartbit backend"`);
    add(`/ip hotspot walled-garden add dst-host=*.${backendHost} comment="Dartbit backend wildcard"`);
    // The customer portal lives on the tenant subdomain of the portal base domain — allow it
    // (and the apex) so an expired customer can load the portal page and renew without a plan.
    add(`/ip hotspot walled-garden add dst-host=${portalBase} comment="Dartbit portal"`);
    add(`/ip hotspot walled-garden add dst-host=*.${portalBase} comment="Dartbit portal wildcard"`);
    // The tenant's OWN portal subdomain, explicitly (not just via the wildcard above) — this is the
    // exact host a customer hits to buy/renew, so it must always be reachable pre-login.
    if (tenantPortalHost) add(`/ip hotspot walled-garden add dst-host=${tenantPortalHost} comment="Dartbit tenant portal"`);
    // Safaricom — so the M-Pesa STK/Daraja flow and the customer's M-Pesa interactions are reachable
    // from the captive portal before the device is authenticated.
    add(`/ip hotspot walled-garden add dst-host=safaricom.co.ke comment="Dartbit safaricom"`);
    add(`/ip hotspot walled-garden add dst-host=*.safaricom.co.ke comment="Dartbit safaricom wildcard"`);
    if (tenantDomain) {
      add(`/ip hotspot walled-garden add dst-host=${tenantDomain} comment="Dartbit tenant domain"`);
      add(`/ip hotspot walled-garden add dst-host=*.${tenantDomain} comment="Dartbit tenant domain wildcard"`);
    }
    add(`:foreach w in=[/ip hotspot walled-garden ip find comment~"Dartbit" !dynamic] do={ /ip hotspot walled-garden ip remove $w }`);
    // Walled-garden IP list lets unauthenticated traffic to these IPs pass through MikroTik's hotspot rejection
    for (const ip of allowIps) {
      add(`/ip hotspot walled-garden ip add dst-address=${ip} comment="Dartbit backend IP"`);
    }
    // Pre-seed the router's DNS cache so it resolves the backend hostname for clients
    add(`:foreach s in=[/ip dns static find name="${backendHost}" comment~"Dartbit"] do={ /ip dns static remove $s }`);
    for (const ip of backendIps) {
      add(`/ip dns static add name=${backendHost} address=${ip} ttl=5m comment="Dartbit backend"`);
    }
    // Pre-seed DNS for the tenant portal subdomain so expired clients resolve + reach it.
    if (tenantPortalHost && tenantPortalIps.length) {
      add(`:foreach s in=[/ip dns static find name="${tenantPortalHost}" comment~"Dartbit"] do={ /ip dns static remove $s }`);
      for (const ip of tenantPortalIps) {
        add(`/ip dns static add name=${tenantPortalHost} address=${ip} ttl=5m comment="Dartbit tenant portal"`);
      }
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
    //     MAC cookies are OFF by design — reconnect for a paid device is handled by its MAC-named
    //     user (which exists only while valid), so unknown/expired devices are always re-prompted.
    add('# 8c. Force hotspot to re-bind to bridge (picks up newly added ports)');
    add(`:foreach h in=[/ip hotspot find name="dartbit-hotspot"] do={ /ip hotspot set $h address-pool=dhcp-pool profile=hsprof-dartbit; /ip hotspot disable $h; :delay 500ms; /ip hotspot enable $h }`);
    add('');

    // === Heartbeat ===
    // === 8d. Management VPN (WireGuard) ===
    // Auto-join the Dartbit management VPN so the router is reachable for Winbox/RADIUS over a
    // stable private IP — no manual config paste. Provisioned automatically when this script is
    // generated; idempotent (re-running updates the same interface). Skipped silently if the VPN
    // isn't configured on the backend yet.
    try {
      const { wgConfigured, provisionRouterWg, buildMikrotikWgConfig } = await import('../utils/wireguard');
      if (wgConfigured()) {
        const prov = await provisionRouterWg(r.id);
        const fresh = await prisma.mikrotikRouter.findUnique({ where: { id: r.id } });
        const { decryptApiKey } = await import('../utils/blessedtexts');
        const priv = fresh?.wgPrivateKey ? decryptApiKey(fresh.wgPrivateKey) : '';
        if (priv) {
          add('# 8d. Dartbit management VPN (WireGuard) — auto-joined');
          // Remove any prior Dartbit VPN interface so re-provisioning is clean.
          add(`:foreach p in=[/interface wireguard peers find comment="Dartbit VPN"] do={ /interface wireguard peers remove $p }`);
          add(`:foreach i in=[/interface wireguard find name="dartbit-vpn"] do={ /interface wireguard remove $i }`);
          add(`:foreach a in=[/ip address find comment="Dartbit VPN"] do={ /ip address remove $a }`);
          add(buildMikrotikWgConfig({ wgIp: prov.wgIp, privateKey: priv, wanInterface: wan }));
          add('');
        }
      }
    } catch (e) {
      // Never let a VPN hiccup break the whole provisioning script.
      add(`# (Dartbit VPN auto-join skipped: ${e instanceof Error ? e.message.replace(/[\r\n]/g, ' ') : 'error'})`);
      add('');
    }

    // === 8e. RADIUS (PPPoE auth + accounting) ===
    // When this router has RADIUS enabled, point its PPP auth at the Dartbit RADIUS server over the
    // VPN, scoped by called-id="dartbit" so it COEXISTS with any other RADIUS (e.g. a second billing
    // system on a different PPPoE service) without conflict. src-address is the router's own VPN IP
    // so packets traverse the tunnel. Enables incoming CoA so the backend can disconnect on expiry,
    // and turns on accounting for live session/usage data. Idempotent.
    //
    // Gate on the ENV MASTER switch (radiusConfigured()), NOT the per-router radiusEnabled flag.
    // RADIUS is all-or-nothing system-wide; a router hand-configured before the flag existed would
    // otherwise be skipped here, so a reprovision would strip its RADIUS entries (section 0 cleanup)
    // and never restore them — exactly the "no radius server found" regression. With the env gate,
    // every (re)provision re-writes the full Dartbit RADIUS setup.
    let radiusActive = false;
    try { radiusActive = (await import('../utils/radius')).radiusConfigured(); } catch { radiusActive = false; }
    try {
      const fresh = await prisma.mikrotikRouter.findUnique({ where: { id: r.id }, select: { id: true, radiusSecret: true, wgIp: true } as never }) as never as { id: string; radiusSecret?: string | null; wgIp?: string | null };
      const radiusServerIp = (process.env.DARTBIT_WG_SUBNET || '10.8.0.0/24').split('.').slice(0, 3).join('.') + '.1'; // e.g. 10.8.0.1
      if (radiusActive && fresh?.wgIp) {
        // Ensure a RADIUS secret exists. If the router never had one (hand-configured, or freshly
        // provisioned), generate and persist it now so the router /radius entries and the droplet
        // clients.conf are written from the SAME value and can't drift.
        let secret = fresh.radiusSecret || '';
        if (!secret) {
          secret = (await import('crypto')).randomBytes(16).toString('hex');
          await prisma.mikrotikRouter.update({ where: { id: fresh.id }, data: { radiusSecret: secret, radiusEnabled: true } as never });
        }
        const sec = secret.replace(/[\\"]/g, '');
        add('# 8e. Dartbit RADIUS (PPPoE + Hotspot auth + accounting) — called-id scoped for coexistence');
        // Remove any prior Dartbit RADIUS entries so re-provisioning is clean (match by comment).
        add(`:foreach rr in=[/radius find where comment~"Dartbit RADIUS"] do={ /radius remove $rr }`);
        // PPPoE entry: the router sends called-id=dartbit for PPP logins.
        add(`/radius add service=ppp address=${radiusServerIp} secret="${sec}" src-address=${fresh.wgIp} called-id=dartbit timeout=3s comment="Dartbit RADIUS"`);
        // Hotspot entry: MikroTik sends the hotspot SERVER NAME (dartbit-hotspot) as called-id, so a
        // SEPARATE entry is required or hotspot logins get "no radius server found". Same secret/IP.
        add(`/radius add service=hotspot address=${radiusServerIp} secret="${sec}" src-address=${fresh.wgIp} called-id=dartbit-hotspot timeout=3s comment="Dartbit RADIUS Hotspot"`);
        // Accept incoming CoA/Disconnect (so the backend can kick expired sessions instantly).
        add(`/radius incoming set accept=yes port=3799`);
        // Enable RADIUS auth + accounting for PPP.
        add(`/ppp aaa set use-radius=yes accounting=yes interim-update=5m`);
        // Switch the Dartbit hotspot profile (only) to RADIUS auth with the login methods the portal
        // needs. Never touches other profiles (e.g. a coexisting centipid hotspot).
        add(`:foreach hp in=[/ip hotspot profile find where name="hsprof-dartbit"] do={ /ip hotspot profile set $hp use-radius=yes radius-accounting=yes radius-interim-update=5m login-by=cookie,mac,http-chap,http-pap }`);
        add('');
        // Register/refresh this router as a FreeRADIUS client on the droplet, from the SAME wgIp +
        // secret — so the client, both /radius entries, and clients.conf can never drift apart.
        try {
          const { registerRadiusClient } = await import('../utils/radius');
          await registerRadiusClient(r.id, fresh.wgIp, secret);
        } catch (e3) {
          add(`# (FreeRADIUS client registration skipped: ${e3 instanceof Error ? e3.message.replace(/[\r\n]/g, ' ') : 'error'})`);
        }
      }
    } catch (e) {
      add(`# (Dartbit RADIUS auto-config skipped: ${e instanceof Error ? e.message.replace(/[\r\n]/g, ' ') : 'error'})`);
      add('');
    }

    // Under RADIUS, accounting + session data come from FreeRADIUS (radacct), so the per-router
    // polling reporters that duplicate that are pure overhead on a small router. We skip installing
    // dartbit-sync (a no-op under RADIUS anyway). radiusActive is computed above (RADIUS section).

    add('# 9. Heartbeat');
    add(`:foreach s in=[/system scheduler find comment="Dartbit heartbeat"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-heartbeat"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-heartbeat policy=read,write,test source={/tool fetch url="${backendUrl}/router/heartbeat?apiKey=${apiKey}"${fetchFlags} keep-result=no}`);
    add(`/system scheduler add name=dartbit-heartbeat interval=30s on-event="/system script run dartbit-heartbeat" comment="Dartbit heartbeat"`);
    add('');

    // === Stats reporter ===
    add('# 9b. Stats reporter');
    add(`:foreach s in=[/system scheduler find comment="Dartbit stats"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-stats"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-stats policy=read,write,test source={:local cpu [/system resource get cpu-load]; :local upt [/system resource get uptime]; :local mem [/system resource get free-memory]; :local id [/system identity get name]; :local url ("${backendUrl}/router/stats?apiKey=${apiKey}&cpu=" . \$cpu . "&uptime=" . \$upt . "&memFree=" . \$mem . "&identity=" . \$id); /tool fetch url=\$url${fetchFlags} keep-result=no}`);
    add(`/system scheduler add name=dartbit-stats interval=30s on-event="/system script run dartbit-stats" comment="Dartbit stats"`);
    add('');

    // === Interfaces reporter — reports interface list to backend so UI can list ports ===
    add('# 9c. Interfaces reporter');
    add(`:foreach s in=[/system scheduler find comment="Dartbit interfaces"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-interfaces"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-interfaces policy=read,write,test source={:local data ""; :foreach i in=[/interface find where !disabled && (type=ether || type=wlan || type=vlan || type=bridge)] do={ :local n [/interface get \$i name]; :local t [/interface get \$i type]; :set data (\$data . \$n . ":" . \$t . ","); }; :local wan ""; :do { :local rt [/ip route find where dst-address="0.0.0.0/0" and active]; :if ([:len \$rt] > 0) do={ :local gw [/ip route get [:pick \$rt 0] immediate-gw]; :if ([:typeof \$gw] = "str") do={ :local p [:find \$gw "%"]; :if ([:typeof \$p] = "num") do={ :set wan [:pick \$gw (\$p+1) [:len \$gw]] } else={ :set wan \$gw } } } } on-error={}; :do { :if ([:len [/interface pppoe-client find name=\$wan]] > 0) do={ :set wan [/interface pppoe-client get [find name=\$wan] interface] } } on-error={}; :local url ("${backendUrl}/router/interfaces?apiKey=${apiKey}&wan=" . \$wan . "&data=" . \$data); /tool fetch url=\$url${fetchFlags} keep-result=no}`);
    add(`/system scheduler add name=dartbit-interfaces interval=60s on-event="/system script run dartbit-interfaces" comment="Dartbit interfaces"`);
    add('');

    // === Subscriber sync (legacy only) ===
    // Under RADIUS this script early-returns (FreeRADIUS is authoritative), so installing it just
    // burns a fetch + import every 60s for nothing. Only install on non-RADIUS routers.
    if (!radiusActive) {
      add('# 10. Subscriber sync');
      add(`:foreach s in=[/system scheduler find comment="Dartbit sub sync"] do={ /system scheduler remove $s }`);
      add(`:foreach s in=[/system script find name="dartbit-sync"] do={ /system script remove $s }`);
      add(`/system script add name=dartbit-sync policy=read,write,test source={/tool fetch url="${backendUrl}/router/sync-script?apiKey=${apiKey}"${fetchFlags} dst-path=dartbit-sync.rsc; :delay 1s; /import file-name=dartbit-sync.rsc}`);
      add(`/system scheduler add name=dartbit-sync interval=60s on-event="/system script run dartbit-sync" comment="Dartbit sub sync"`);
      add('');
    }

    // === Captive-portal refresh — re-download login.html every 3 min so tenant theme/branding
    // changes propagate automatically without a reprovision (independent of the subscriber sync). ===
    add('# 10b. Captive-portal refresh');
    add(`:foreach s in=[/system scheduler find comment="Dartbit portal"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-portal"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-portal policy=read,write,test source={:local hdir "hotspot"; :if ([:len [/file find where name="flash"]] > 0) do={ :set hdir "flash/hotspot" }; :do { /ip hotspot profile set [find name="hsprof-dartbit"] html-directory=\$hdir; :local got [/ip hotspot profile get [find name="hsprof-dartbit"] html-directory]; :if (\$got != \$hdir) do={ /ip hotspot profile set [find name="hsprof-dartbit"] html-directory="hotspot" } } on-error={}; /tool fetch url="${backendUrl}/hotspot-html/login?apiKey=${apiKey}" dst-path=(\$hdir . "/login.html")${fetchFlags}; /tool fetch url="${backendUrl}/hotspot-html/login?apiKey=${apiKey}" dst-path=(\$hdir . "/alogin.html")${fetchFlags}}`);
    add(`/system scheduler add name=dartbit-portal interval=3m on-event="/system script run dartbit-portal" comment="Dartbit portal"`);
    add('');

    // === Remote commands ===
    add('# 11. Remote commands');
    // dartbit-cmd: the command-queue poller. When this ZTP is itself delivered THROUGH
    // dartbit-cmd (a reprovision), recreating dartbit-cmd here would delete/replace the
    // very script doing the import — RouterOS kills it ("interrupted") and the rest of the
    // ZTP (e.g. dartbit-sessions) never runs. So on reprovision we skip recreating it
    // (the running one is already correct). On first-time provisioning (fetched directly,
    // not via the queue) we create it normally. The scheduler removal is also inside the
    // skip — otherwise reprovision would remove the poller's scheduler and never re-add it.
    if (!skipCmdScript) {
      add(`:foreach s in=[/system scheduler find comment="Dartbit cmd"] do={ /system scheduler remove $s }`);
      add(`:foreach s in=[/system script find name="dartbit-cmd"] do={ /system script remove $s }`);
      add(`/system script add name=dartbit-cmd policy=read,write,test,reboot source={:do {/tool fetch url="${backendUrl}/router/commands?apiKey=${apiKey}"${fetchFlags} dst-path=dartbit-cmd.rsc; :delay 1s; :if ([:len [/file find name="dartbit-cmd.rsc"]] > 0) do={ /import file-name=dartbit-cmd.rsc; :delay 1s; :foreach f in=[/file find name="dartbit-cmd.rsc"] do={ /file remove $f } }} on-error={}}`);
      add(`/system scheduler add name=dartbit-cmd interval=5s on-event="/system script run dartbit-cmd" comment="Dartbit cmd"`);
    } else {
      // Reprovision path: we can't recreate dartbit-cmd inline (it's the script running this
      // import — that interrupts it). But the poller must be updated when the backend URL
      // changes, else it keeps fetching the OLD backend forever. So we schedule a ONE-SHOT
      // updater that runs ~8s AFTER this import finishes: it fetches a dedicated flat .rsc
      // (/router/cmd-script) that rebuilds dartbit-cmd with the current URL, imports it, then
      // removes itself. Using a fetched flat file avoids deeply-nested source={} escaping.
      add(`:foreach s in=[/system scheduler find name="dartbit-cmd-upd"] do={ /system scheduler remove $s }`);
      add(`:foreach s in=[/system script find name="dartbit-cmd-upd"] do={ /system script remove $s }`);
      add(`/system script add name=dartbit-cmd-upd policy=read,write,test,reboot source={/tool fetch url="${backendUrl}/router/cmd-script?apiKey=${apiKey}"${fetchFlags} dst-path=dartbit-cmd-upd.rsc; :delay 2s; :if ([:len [/file find name="dartbit-cmd-upd.rsc"]] > 0) do={ /import file-name=dartbit-cmd-upd.rsc; :delay 1s; /file remove [find name="dartbit-cmd-upd.rsc"] }; /system scheduler remove [find name="dartbit-cmd-upd"]}`);
      add(`/system scheduler add name=dartbit-cmd-upd interval=8s on-event="/system script run dartbit-cmd-upd" comment="Dartbit cmd updater"`);
    }
    add('');

    // === Active session + live-speed reporter (3s) ===
    // This is the single source of the dashboard's "who's online + live up/down speed". It runs at
    // 3s for responsive speed readings. RADIUS still does ACCOUNTING (billing/usage) in the
    // background via radacct; this reporter only drives the live view. Resolves MAC-auth hotspot
    // logins back to their subscriber on the backend.
    add('# 12. Active session + live-speed reporter (3s)');
    add(`:foreach s in=[/system scheduler find comment="Dartbit session sync"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-sessions"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-sessions policy=read,write,test source={:local data ""; :foreach a in=[/ppp active find] do={ :local u [/ppp active get \$a name]; :local ip [/ppp active get \$a address]; :local up [/ppp active get \$a uptime]; :local iface ("<pppoe-" . \$u . ">"); :local rxr 0; :local txr 0; :do { :set rxr [/interface get \$iface rx-byte]; :set txr [/interface get \$iface tx-byte]; } on-error={}; :set data (\$data . \$u . "|" . \$ip . "|" . \$up . "|" . \$rxr . "|" . \$txr . "|P,"); }; :foreach a in=[/ip hotspot active find] do={ :local u [/ip hotspot active get \$a user]; :local ip [/ip hotspot active get \$a address]; :local up [/ip hotspot active get \$a uptime]; :local mac [/ip hotspot active get \$a mac-address]; :local bi 0; :local bo 0; :do { :set bi [/ip hotspot active get \$a bytes-in]; :set bo [/ip hotspot active get \$a bytes-out]; } on-error={}; :set data (\$data . \$u . "|" . \$ip . "|" . \$up . "|" . \$bi . "|" . \$bo . "|H|" . \$mac . ","); }; :local url ("${backendUrl}/router/sessions?apiKey=${apiKey}&pppoe=" . \$data); :do { /tool fetch url=\$url${fetchFlags} output=none as-value } on-error={}}`);
    add(`/system scheduler add name=dartbit-sessions interval=3s on-event="/system script run dartbit-sessions" comment="Dartbit session sync"`);
    add('');

    // 13. Provisioning-complete signal — a clear log line on the router AND a callback so the
    // dashboard can confirm the reprovision actually FINISHED (not merely that it was delivered).
    add('# 13. Provisioning complete');
    // Fire the heartbeat and interface report ONCE right now so the dashboard updates the moment the
    // script finishes — the schedulers then take over (heartbeat first at +30s, interfaces at +60s).
    add(`:do { /system script run dartbit-heartbeat } on-error={}`);
    add(`:do { /system script run dartbit-interfaces } on-error={}`);
    add(`:log info "Dartbit: PROVISIONING COMPLETE"`);
    add(`:do { /tool fetch url="${backendUrl}/router/provision-done?apiKey=${apiKey}"${fetchFlags} output=none as-value } on-error={}`);
    add('');

    return lines.join('\n');
}

// GET /router/cmd-script?apiKey=xxx — returns a FLAT .rsc that rebuilds the dartbit-cmd
// poller (script + 5s scheduler) pointing at the CURRENT backend URL. Used by the deferred
// dartbit-cmd-upd one-shot during reprovision to repoint the poller after a domain change,
// without the nested-source escaping that breaks the importer.
router.get('/cmd-script', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || '');
    if (!apiKey) return res.status(400).type('text/plain').send('# Error: apiKey required');
    const r = await findRouter(apiKey);
    if (!r) return res.status(404).type('text/plain').send('# Error: Router not found');
    const backendUrl = resolveBackendUrl();
    const fetchFlags = ' mode=https check-certificate=no';
    const lines = [
      `:foreach s in=[/system scheduler find comment="Dartbit cmd"] do={ /system scheduler remove $s }`,
      `:foreach s in=[/system script find name="dartbit-cmd"] do={ /system script remove $s }`,
      `/system script add name=dartbit-cmd policy=read,write,test,reboot source={:do {/tool fetch url="${backendUrl}/router/commands?apiKey=${apiKey}"${fetchFlags} dst-path=dartbit-cmd.rsc; :delay 1s; :if ([:len [/file find name="dartbit-cmd.rsc"]] > 0) do={ /import file-name=dartbit-cmd.rsc; :delay 1s; :foreach f in=[/file find name="dartbit-cmd.rsc"] do={ /file remove $f } }} on-error={}}`,
      `/system scheduler add name=dartbit-cmd interval=5s on-event="/system script run dartbit-cmd" comment="Dartbit cmd"`,
    ];
    res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    res.status(500).type('text/plain').send(`# Error: ${err instanceof Error ? err.message : 'Unknown'}`);
  }
});

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
    // First heartbeat during setup advances the link state machine to "awaiting interfaces".
    const advance = r.setupStage === 'AWAITING_HEARTBEAT' ? { setupStage: 'AWAITING_INTERFACES' } : {};
    await prisma.mikrotikRouter.update({
      where: { id: r.id },
      data: { status: 'ONLINE', lastSeenAt: new Date(), ...advance },
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

    // Auto-detected WAN (the interface carrying the active default route, reported by the router).
    // Persist it so the ZTP bridge-exclusion and the wizard's isWan flag always protect the right port.
    const detectedWan = String(req.query.wan || req.body?.wan || '').replace(/[^a-zA-Z0-9_\-\.]/g, '');
    if (detectedWan) {
      const cfg = await prisma.routerProvisioningConfig.findUnique({ where: { routerId: r.id } });
      if (!cfg) {
        await prisma.routerProvisioningConfig.create({ data: { routerId: r.id, wanInterface: detectedWan } });
        console.log(`[interfaces] router ${r.name}: WAN auto-detected as ${detectedWan}`);
      } else if (cfg.wanInterface !== detectedWan) {
        await prisma.routerProvisioningConfig.update({ where: { routerId: r.id }, data: { wanInterface: detectedWan } });
        console.log(`[interfaces] router ${r.name}: WAN updated ${cfg.wanInterface} → ${detectedWan} (auto-detected)`);
      }
    }

    // Wipe and rewrite — interfaces change rarely so this is fine
    await prisma.routerInterface.deleteMany({ where: { routerId: r.id } });

    const ifaces: Array<{ name: string; type: string; routerId: string }> = [];
    for (const e of entries) {
      const [name, type] = e.split(':');
      if (name) ifaces.push({ name, type: type || 'unknown', routerId: r.id });
    }
    if (ifaces.length > 0) {
      await prisma.routerInterface.createMany({ data: ifaces });
      // First interface list during setup advances the state machine to "awaiting port choice".
      if (r.setupStage === 'AWAITING_INTERFACES') {
        await prisma.mikrotikRouter.update({ where: { id: r.id }, data: { setupStage: 'AWAITING_PORTS' } });
      }
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

    // NOTE: no longer wiping all sessions here — see the upsert/targeted-delete below. Blanket
    // delete-then-recreate every ~3s destroyed every row's identity each cycle, which (a) reset
    // any "how long online" tracking to zero for EVERY session on EVERY poll, and (b) made the
    // active-users list visibly flicker/reflow on the frontend each refresh instead of updating
    // quietly in place.

    if (pppoeStr) {
      const entries = pppoeStr.split(',').filter(Boolean);
      const sessions: Array<{
        username: string; ipAddress: string; uptime?: string;
        uploadSpeed?: number; downloadSpeed?: number;
        macAddress?: string;
        service?: 'PPPOE' | 'HOTSPOT' | 'STATIC';
        routerId: string; tenantId: string;
      }> = [];

      const now = Date.now();

      for (const e of entries) {
        const parts = e.split('|');
        let username = '', ipAddress = '', uptime = '', rxBytes = 0, txBytes = 0, macAddress = '', svcMark = '';

        if (parts.length >= 2) {
          username = parts[0] || '';
          ipAddress = parts[1] || '';
          uptime = parts[2] || '';
          rxBytes = parseInt(parts[3] || '0', 10) || 0;
          txBytes = parseInt(parts[4] || '0', 10) || 0;
          // New reporter format: user|ip|uptime|bytesIn|bytesOut|<P or H>|<mac>
          // (PPPoE sends an empty mac field). Detect the service marker, then take the MAC from
          // the field AFTER it. Fall back to legacy: a MAC sitting in field 5 with no marker.
          const markIdx = parts.findIndex(p => p === 'P' || p === 'H');
          svcMark = markIdx >= 0 ? parts[markIdx] : '';
          if (markIdx >= 0 && parts[markIdx + 1]) {
            macAddress = parts[markIdx + 1];
          } else if (parts[5] && parts[5] !== 'P' && parts[5] !== 'H') {
            macAddress = parts[5];
          }
        } else {
          const [u, ip] = e.split(':');
          username = u || '';
          ipAddress = ip || '';
        }

        if (!username && !macAddress) continue;
        // Bypassed auto-connect devices report uptime="bypass" and carry a MAC. Their "username"
        // field is actually the binding label (name:expiry) — we resolve the real subscriber by MAC
        // below, so blank the username here to avoid a bad name match.
        const isBypass = uptime === 'bypass';
        if (isBypass) username = '';

        let uploadKbps = 0, downloadKbps = 0;
        // Key live-speed tracking by username for normal sessions, by MAC for bypass devices.
        const key = isBypass ? `${r.id}:mac:${macAddress}` : `${r.id}:${username}`;
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
          username, ipAddress, uptime: isBypass ? '' : uptime,
          uploadSpeed: uploadKbps,
          downloadSpeed: downloadKbps,
          macAddress: macAddress || undefined,
          service: svcMark === 'P' ? 'PPPOE' : svcMark === 'H' ? 'HOTSPOT' : undefined,
          routerId: r.id, tenantId: r.tenantId,
        });
      }

      // Resolve subscribers: normal sessions link by username; MAC auto-login sessions have the
      // MAC as their username; bypass devices link by the session MAC. Collect all candidate MACs
      // (from BOTH the username field — when it's a MAC — and the macAddress field) so we can map
      // a MAC-authenticated session back to its owning subscriber's D-number.
      const looksLikeMacEarly = (u: string) => /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/.test(u || '');
      const usernames = sessions.map(s => s.username).filter(Boolean);
      const macSet = new Set<string>();
      for (const s of sessions) {
        if (s.macAddress) macSet.add(s.macAddress.toUpperCase());
        if (s.username && looksLikeMacEarly(s.username)) macSet.add(s.username.toUpperCase());
      }
      const macs = Array.from(macSet);
      // Match MACs case-insensitively: subscribers store uppercase MACs, but pull both the exact
      // and lowercase forms to be safe across RouterOS casing.
      const macVariants = macs.flatMap(m => [m, m.toLowerCase()]);
      const subs = await prisma.subscriber.findMany({
        where: {
          tenantId: r.tenantId,
          OR: [
            usernames.length ? { username: { in: usernames } } : undefined,
            macVariants.length ? { macAddress: { in: macVariants } } : undefined,
          ].filter(Boolean) as object[],
        },
        select: { id: true, username: true, service: true, macAddress: true, expiresAt: true, isActive: true },
      });
      const subByUsername: Record<string, { id: string; service: string }> = {};
      const subByMac: Record<string, { id: string; service: string; username: string }> = {};
      // Subscribers that are connected but should NOT show as online: expired PPPoE sitting in the
      // walled garden (still connected, but they've effectively "run out"). The dashboard treats them
      // as offline.
      const hiddenSubIds = new Set<string>();
      for (const s of subs) {
        subByUsername[s.username] = { id: s.id, service: s.service };
        if (s.macAddress) subByMac[s.macAddress.toUpperCase()] = { id: s.id, service: s.service, username: s.username };
        if (s.service === 'PPPOE' && s.isActive && s.expiresAt && s.expiresAt.getTime() <= now) hiddenSubIds.add(s.id);
      }

      // Recognise a username that is actually a MAC address (from the MAC auto-login user). We
      // map it back to the owning subscriber so the active page shows the D-number + phone, never
      // the raw MAC. The MAC user is purely a router-side auth entry.
      const looksLikeMac = (u: string) => /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/.test(u || '');

      const sessionsWithIds = sessions.map(s => {
        if (!s.username && s.macAddress) {
          // Bypass device — resolve by MAC and backfill the real username.
          const m = subByMac[s.macAddress.toUpperCase()];
          if (m) return { ...s, username: m.username, subscriberId: m.id };
          return { ...s, username: s.macAddress }; // unknown device; show its MAC
        }
        // MAC auto-login: the session's username IS the device MAC. Resolve to the subscriber and
        // replace the displayed username with their D-number so the MAC never surfaces in the UI.
        if (looksLikeMac(s.username)) {
          const m = subByMac[s.username.toUpperCase()];
          if (m) return { ...s, username: m.username, macAddress: s.username, subscriberId: m.id };
        }
        // Also backfill via the session's own MAC if the username didn't resolve to a subscriber.
        const direct = subByUsername[s.username];
        if (!direct && s.macAddress) {
          const m = subByMac[s.macAddress.toUpperCase()];
          if (m) return { ...s, username: m.username, subscriberId: m.id };
        }
        return { ...s, subscriberId: direct?.id || undefined };
      });

      // Strip the transient `service` marker — it's used only for SessionRecord classification
      // and is NOT an OnlineSession column. Leaving it in made Prisma throw "Unknown argument
      // service" → 500 on every sessions report (the dartbit-sessions scheduler errors in the
      // router log). macAddress IS a valid column, so we keep it.
      // Hide walled-garden (expired PPPoE) sessions from the active list — connected but not "online".
      const onlineRows = sessionsWithIds
        .filter(s => { const sid = (s as { subscriberId?: string }).subscriberId; return !(sid && hiddenSubIds.has(sid)); })
        .map(({ service: _svc, ...rest }) => rest);

      // Device identity for uniqueness: MAC when known (each physical device is its own session —
      // correct for a subscriber with multiple devices on one hotspot account), else username
      // (correct for PPPoE, which is one session per username by construction).
      const sessionKeyOf = (s: { username: string; macAddress?: string }) => s.macAddress || s.username;

      // Collapse duplicates BEFORE building the batch. A single poll can legitimately contain the
      // same device twice — a stale hotspot host alongside its live session, a device present in
      // both the hotspot and PPPoE lists, or two entries that resolve to the same key. Postgres
      // rejects a multi-row INSERT ... ON CONFLICT that proposes the same conflict target twice
      // ("ON CONFLICT DO UPDATE command cannot affect row a second time", SQLSTATE 21000), which
      // failed the WHOLE batch → 500 on every poll for that router. Later entries win, so the most
      // recently parsed reading for a device is the one kept.
      const dedupedByKey = new Map<string, (typeof onlineRows)[number]>();
      for (const s of onlineRows) {
        const k = sessionKeyOf(s);
        if (k) dedupedByKey.set(k, s);
      }
      const uniqueRows = Array.from(dedupedByKey.values());
      const reportedKeys = Array.from(dedupedByKey.keys());

      if (uniqueRows.length > 0) {
        // Upsert every reported session in ONE batched multi-row query. This is what keeps an
        // ongoing session's row STABLE (same id, same startedAt) across the ~3s poll cycle instead
        // of destroying and recreating it every time — startedAt is set only on first INSERT and
        // is never touched by the ON CONFLICT branch, so it's a true "since when has this session
        // been continuously online" anchor for the active-users page to sort on.
        const cols = ['id', 'username', '"ipAddress"', '"macAddress"', '"uploadSpeed"', '"downloadSpeed"', 'uptime', '"routerId"', '"subscriberId"', '"tenantId"', '"sessionKey"', '"startedAt"', '"createdAt"', '"updatedAt"'];
        const values: unknown[] = [];
        const rowsSql: string[] = [];
        uniqueRows.forEach((s, i) => {
          const b = i * 11;
          rowsSql.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},NOW(),NOW(),NOW())`);
          values.push(
            crypto.randomUUID(), s.username, s.ipAddress || null, s.macAddress || null,
            s.uploadSpeed ?? null, s.downloadSpeed ?? null, s.uptime || null, r.id,
            (s as { subscriberId?: string }).subscriberId || null, r.tenantId, sessionKeyOf(s),
          );
        });
        const upsertSql =
          `INSERT INTO "OnlineSession" (${cols.join(',')}) VALUES ${rowsSql.join(',')}
           ON CONFLICT ("routerId","sessionKey") DO UPDATE SET
             username=EXCLUDED.username, "ipAddress"=EXCLUDED."ipAddress", "macAddress"=EXCLUDED."macAddress",
             "uploadSpeed"=EXCLUDED."uploadSpeed", "downloadSpeed"=EXCLUDED."downloadSpeed",
             uptime=EXCLUDED.uptime, "subscriberId"=EXCLUDED."subscriberId", "updatedAt"=NOW()`;
        try {
          await prisma.$executeRawUnsafe(upsertSql, ...values);
        } catch (upErr) {
          const msg = upErr instanceof Error ? upErr.message : String(upErr);
          // Self-heal ONLY for genuine schema gaps (missing column / missing unique index), e.g. if
          // the boot-time migration lost a race during a zero-downtime deploy overlap. Deliberately
          // does NOT match SQLSTATE 21000 ("cannot affect row a second time"), which is a DATA
          // problem — duplicate keys within one batch — and is prevented by the dedupe above.
          // Matching it here previously masked the real cause behind a pointless schema repair.
          const isSchemaGap = /no unique or exclusion constraint|does not exist|undefined column/i.test(msg);
          if (isSchemaGap && canAttemptSessionHeal()) {
            console.warn(`[sessions] upsert failed ("${msg.slice(0, 140)}") — self-healing OnlineSession schema and retrying`);
            await prisma.$executeRawUnsafe(`ALTER TABLE "OnlineSession" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`).catch(() => {});
            await prisma.$executeRawUnsafe(`ALTER TABLE "OnlineSession" ADD COLUMN IF NOT EXISTS "sessionKey" TEXT NOT NULL DEFAULT ''`).catch(() => {});
            await prisma.$executeRawUnsafe(`UPDATE "OnlineSession" SET "sessionKey" = COALESCE(NULLIF("macAddress",''), username) WHERE "sessionKey" = ''`).catch(() => {});
            await prisma.$executeRawUnsafe(`DELETE FROM "OnlineSession" a USING "OnlineSession" b WHERE a.id < b.id AND a."routerId" = b."routerId" AND a."sessionKey" = b."sessionKey"`).catch(() => {});
            await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "OnlineSession_routerId_sessionKey_key" ON "OnlineSession"("routerId","sessionKey")`).catch(() => {});
            await prisma.$executeRawUnsafe(upsertSql, ...values);
            console.log('[sessions] self-heal succeeded — upsert retry OK');
          } else {
            throw upErr;
          }
        }

        // Targeted delete: only DEVICES genuinely no longer reported (i.e. actually disconnected)
        // are removed — everything still being reported keeps its row, id, and startedAt untouched.
        await prisma.$executeRawUnsafe(
          `DELETE FROM "OnlineSession" WHERE "routerId"=$1 AND "sessionKey" NOT IN (${reportedKeys.length ? reportedKeys.map((_, i) => `$${i + 2}`).join(',') : "''"})`,
          r.id, ...reportedKeys,
        );

        for (const s of uniqueRows) {
          if (!s.username) continue;
          await prisma.subscriber.updateMany({
            where: { tenantId: r.tenantId, username: s.username },
            data: { lastOnlineAt: new Date(), ipAddress: s.ipAddress || undefined, routerId: r.id },
          });
        }
      } else {
        // Nothing reported at all — every session on this router has genuinely ended.
        await prisma.onlineSession.deleteMany({ where: { routerId: r.id } });
      }

      // === Persistent session history (SessionRecord) ===
      await recordSessionHistory(r.id, r.tenantId, sessionsWithIds, subByUsername, now);
    } else {
      // Empty poll = no active sessions at all. End all currently-tracked sessions for this router.
      await prisma.onlineSession.deleteMany({ where: { routerId: r.id } });
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
  sessions: Array<{ username: string; ipAddress: string; uptime?: string; service?: 'PPPOE' | 'HOTSPOT' | 'STATIC' }>,
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
    // Prefer the service reported directly by the router (P=PPPoE/H=hotspot marker) — this is
    // accurate even for hotspot sessions logged in by the M-Pesa code (whose username isn't a
    // subscriber username). Fall back to the subscriber's service, then HOTSPOT.
    const service = s.service || (sub?.service as 'PPPOE' | 'HOTSPOT' | 'STATIC') || 'HOTSPOT';

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
    add('');
    // Keep the command poller fast (2s) so purchases/changes apply near-instantly. Updating it here
    // means the speed-up takes effect WITHOUT a reprovision.
    add(`:foreach s in=[/system scheduler find name="dartbit-cmd"] do={ /system scheduler set \$s interval=2s }`);
    // Refresh the captive portal HTML from the backend each sync so portal logic changes (e.g. the
    // free-trial one-tap flow) deploy WITHOUT requiring a reprovision. Best-effort; ignored on error.
    {
      const portalBackend = (process.env.BACKEND_URL || `https://${req.get('host')}`).replace(/\/$/, '');
      add(`:local phdir "hotspot"; :if ([:len [/file find where name="flash"]] > 0) do={ :set phdir "flash/hotspot" }`);
      add(`:do { /tool fetch url="${portalBackend}/hotspot-html/login?apiKey=${apiKey}" dst-path=($phdir . "/login.html") mode=https check-certificate=no } on-error={}`);
      add(`:do { /tool fetch url="${portalBackend}/hotspot-html/login?apiKey=${apiKey}" dst-path=($phdir . "/alogin.html") mode=https check-certificate=no } on-error={}`);
    }
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

    // RADIUS mode (env master switch): FreeRADIUS is the single source of truth for hotspot + voucher
    // auth, rate-limit and expiry. We STOP generating the local per-user push and purge stale
    // Dartbit-tagged hotspot/voucher users so they can't shadow RADIUS. Poller + portal refresh +
    // expiry-scheduler cleanup above all still run. (Matches the env-gated subscriber lifecycle.)
    const { radiusConfigured } = await import('../utils/radius');
    if (radiusConfigured()) {
      add(`:foreach u in=[/ip hotspot user find comment~"Dartbit:"] do={ /ip hotspot user remove \$u }`);
      add(`:foreach u in=[/ip hotspot user find comment~"DbMac:"] do={ /ip hotspot user remove \$u }`);
      add(`:foreach u in=[/ip hotspot user find comment~"Dbm:"] do={ /ip hotspot user remove \$u }`);
      add(`:foreach u in=[/ip hotspot user find comment~"Dbv:"] do={ /ip hotspot user remove \$u }`);
      add(`:foreach u in=[/ip hotspot user find comment~"DbVMac:"] do={ /ip hotspot user remove \$u }`);
      return res.type('text/plain').send(lines.join('\n'));
    }

    const pppoeUsers = subscribers.filter(s => s.service === 'PPPOE');
    for (const sub of pppoeUsers) {
      const speed = sub.package ? `${sub.package.speedUpKbps}k/${sub.package.speedDownKbps}k` : '10M/10M';
      const profileName = sub.package ? `db-p-${sub.package.id.substring(0, 8)}` : 'dartbit-pppoe';
      const expired = sub.expiresAt && sub.expiresAt <= now;
      // Admin-disabled (not active) → fully blocked. Expired (subscription lapsed) → kept
      // connected on the restricted "dartbit-expired" profile so they can reach the portal to
      // renew. Active → their normal package profile.
      const adminDisabled = !sub.isActive;
      const effectiveProfile = expired && !adminDisabled ? 'dartbit-expired' : profileName;

      // Each line stays short — uses inline strings, no shared state needed.
      add(`:if ([:len [/ppp profile find name="${profileName}"]] = 0) do={ /ppp profile add name=${profileName} local-address=10.10.10.1 remote-address=pppoe-pool rate-limit="${speed}" comment="Dartbit" }`);
      add(`:if ([:len [/ppp secret find name="${sub.username}"]] = 0) do={ /ppp secret add name="${sub.username}" password="${sub.secret}" profile=${effectiveProfile} service=pppoe comment="Dartbit:${sub.id}" }`);
      add(`:if ([:len [/ppp secret find name="${sub.username}"]] > 0) do={ /ppp secret set [find name="${sub.username}"] password="${sub.secret}" profile=${effectiveProfile} disabled=${adminDisabled ? 'yes' : 'no'} }`);
      // Drop the live session so it reconnects onto the correct profile: expired users reconnect
      // onto the walled-garden profile (portal-only); admin-disabled users are dropped and stay out.
      if (expired || adminDisabled) {
        add(`:foreach a in=[/ppp active find name="${sub.username}"] do={ /ppp active remove \$a }`);
      }
    }

    const hsUsers = subscribers.filter(s => s.service === 'HOTSPOT');

    // Pre-create EVERY hotspot package profile up-front, before any user references it. This makes
    // authentication independent of per-package timing: a brand-new package (created after the last
    // reprovision) has its profile guaranteed to exist before its first MAC/D-name user is added,
    // so auto-login works for ALL packages — existing or newly created. We also always ensure the
    // stable dartbit-default profile exists as a universal fallback.
    add(`:if ([:len [/ip hotspot user profile find name="dartbit-default"]] = 0) do={ /ip hotspot user profile add name=dartbit-default rate-limit="10M/10M" shared-users=1 add-mac-cookie=yes address-pool=dhcp-pool }`);
    const hsProfilesSeen = new Set<string>();
    for (const sub of hsUsers) {
      if (!sub.package) continue;
      const pn = `db-h-${sub.package.id.substring(0, 8)}`;
      if (hsProfilesSeen.has(pn)) continue;
      hsProfilesSeen.add(pn);
      const sp = `${sub.package.speedUpKbps}k/${sub.package.speedDownKbps}k`;
      // MAC cookie written on login so the device reconnects instantly; it expires 60s AFTER the
      // package validity (mac-cookie-timeout is relative to login ≈ purchase), so it never outlives
      // the paid window. Expiry enforcement also wipes it, as a backstop.
      const ckSec = (sub.package.validityMinutes || 60) * 60 + 60;
      add(`:if ([:len [/ip hotspot user profile find name="${pn}"]] = 0) do={ /ip hotspot user profile add name=${pn} address-pool=dhcp-pool }`);
      add(`/ip hotspot user profile set [find name="${pn}"] rate-limit="${sp}" shared-users=1 add-mac-cookie=yes mac-cookie-timeout=${ckSec}s address-pool=dhcp-pool`);
    }

    for (const sub of hsUsers) {
      const profileName = sub.package ? `db-h-${sub.package.id.substring(0, 8)}` : 'dartbit-default';
      const expired = sub.expiresAt && sub.expiresAt <= now;
      const hasPackage = !!sub.packageId;
      const entitled = sub.isActive && !expired && hasPackage;
      const macU = sub.macAddress ? sub.macAddress.toUpperCase() : '';
      const macBind = macU ? ` mac-address=${macU}` : '';

      if (!entitled) {
        // NOT entitled: write nothing, remove both users + kick session (seamless disconnect).
        add(`:foreach u in=[/ip hotspot user find name="${sub.username}"] do={ /ip hotspot user remove \$u }`);
        add(`:foreach a in=[/ip hotspot active find user="${sub.username}"] do={ /ip hotspot active remove \$a }`);
        if (macU) {
          add(`:foreach u in=[/ip hotspot user find name="${macU}"] do={ /ip hotspot user remove \$u }`);
          add(`:foreach a in=[/ip hotspot active find mac-address="${macU}"] do={ /ip hotspot active remove \$a }`);
          add(`:foreach c in=[/ip hotspot cookie find mac-address="${macU}"] do={ /ip hotspot cookie remove \$c }`);
          add(`:foreach h in=[/ip hotspot host find mac-address="${macU}"] do={ /ip hotspot host remove \$h }`);
        }
        continue;
      }

      // ENTITLED: profile is guaranteed to exist (pre-created up-front for ALL packages above), so
      // authentication is not pegged on per-package timing — it works for any package, including
      // ones created after the last reprovision. Create the D-name + MAC users on that profile.
      add(`:if ([:len [/ip hotspot user find name="${sub.username}"]] = 0) do={ /ip hotspot user add name="${sub.username}" password="${sub.secret}" profile=${profileName}${macBind} comment="Dartbit:${sub.id}" }`);
      add(`:if ([:len [/ip hotspot user find name="${sub.username}"]] > 0) do={ /ip hotspot user set [find name="${sub.username}"] password="${sub.secret}" profile=${profileName} disabled=no${macBind} }`);
      if (macU) {
        add(`:if ([:len [/ip hotspot user find name="${macU}"]] = 0) do={ /ip hotspot user add name="${macU}" password=dartbit mac-address=${macU} profile=${profileName} comment="DbMac:${sub.id}" }`);
        add(`:if ([:len [/ip hotspot user find name="${macU}"]] > 0) do={ /ip hotspot user set [find name="${macU}"] password=dartbit mac-address=${macU} profile=${profileName} disabled=no }`);
      }
    }

    const staticUsers = subscribers.filter(s => s.service === 'STATIC' && s.ipAddress);

    // Remove bypassed auto-connect bindings (comment "Dbb:...") for hotspot subscribers whose
    // package has expired, so a lapsed device stops getting free internet. The binding was added
    // at payment time keyed to the device MAC; we match by the subscriber's stored MAC.
    for (const sub of hsUsers) {
      const expired = sub.expiresAt && sub.expiresAt <= now;
      if (expired && sub.macAddress) {
        add(`:foreach b in=[/ip hotspot ip-binding find mac-address="${sub.macAddress}" type=bypassed] do={ /ip hotspot ip-binding remove \$b }`);
      }
    }

    // Maintain the dartbit-expired address-list for STATIC subscribers: expired (lapsed) static
    // IPs are added so the walled-garden firewall limits them to the portal; active static IPs are
    // removed from the list so they have full access. (PPPoE expiry is handled by its profile.)
    for (const sub of staticUsers) {
      if (!sub.ipAddress) continue;
      const expired = sub.expiresAt && sub.expiresAt <= now;
      const adminDisabled = !sub.isActive;
      if (expired && !adminDisabled) {
        add(`:if ([:len [/ip firewall address-list find list="dartbit-expired" address="${sub.ipAddress}"]] = 0) do={ /ip firewall address-list add list=dartbit-expired address=${sub.ipAddress} comment="Dartbit:${sub.id}" }`);
      } else {
        add(`:foreach a in=[/ip firewall address-list find list="dartbit-expired" address="${sub.ipAddress}"] do={ /ip firewall address-list remove \$a }`);
      }
    }

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

    // Group by package so we create one user profile per package. M-Pesa-receipt vouchers
    // (batchId="MPESA") share the SAME profile as their hotspot subscriber (db-h-<pkg>) so the
    // code, username/password and MAC are one identity; standalone vouchers use db-v-<pkg>.
    const profilesByPkg: Record<string, { name: string; speed: string; validityMin: number }> = {};
    for (const v of vouchers) {
      if (v.package) {
        const pid = v.package.id.substring(0, 8);
        const pname = v.batchId === 'MPESA' ? `db-h-${pid}` : `db-v-${pid}`;
        if (!profilesByPkg[pname]) {
          profilesByPkg[pname] = {
            name: pname,
            speed: `${v.package.speedUpKbps}k/${v.package.speedDownKbps}k`,
            validityMin: v.durationMinutes,
          };
        }
      }
    }
    for (const prof of Object.values(profilesByPkg)) {
      add(`:if ([:len [/ip hotspot user profile find name="${prof.name}"]] = 0) do={ /ip hotspot user profile add name=${prof.name} address-pool=dhcp-pool }`);
      // MAC cookie written on login for instant reconnect, expiring 60s after the voucher validity.
      add(`/ip hotspot user profile set [find name="${prof.name}"] rate-limit="${prof.speed}" shared-users=1 add-mac-cookie=yes mac-cookie-timeout=${prof.validityMin * 60 + 60}s address-pool=dhcp-pool`);
    }
    // Add each voucher as a hotspot user — username and password = code.
    // limit-uptime caps cumulative active time, BUT we ALSO enforce wall-clock expiry:
    // when a voucher's expiresAt has passed, we disable the user and kick any active
    // session so the device cannot stay/reconnect after its time window — even if the
    // cumulative uptime limit wasn't reached (intermittent use). This is the fix for
    // "expired voucher still reconnects".
    for (const v of vouchers) {
      const pid = v.package ? v.package.id.substring(0, 8) : '';
      // M-Pesa vouchers live on the hotspot subscriber profile (db-h-) so the code shares the
      // same rate-limit/identity as the username+password; standalone vouchers use db-v-.
      const profileName = v.package ? `${v.batchId === 'MPESA' ? 'db-h-' : 'db-v-'}${pid}` : 'dartbit-default';
      const sessionSec = v.durationMinutes * 60;
      const shortId = v.id.slice(-8);
      const expired = !!(v.expiresAt && v.expiresAt <= now);
      // Bind the voucher user to the MAC that redeemed/purchased it (usedByMac), uppercased to
      // match how MikroTik stores MACs. Unredeemed vouchers (no usedByMac) stay open until first
      // use, then get bound on next sync after redemption captures the MAC.
      const macBind = v.usedByMac ? ` mac-address=${v.usedByMac.toUpperCase()}` : '';
      // No limit-uptime: that limits CUMULATIVE connected time across reconnects, so once a voucher's
      // total uptime is used the device gets logged out seconds after each reconnect (the flap). The
      // voucher's life is governed purely by wall-clock expiry — RADIUS Expiration on the code+MAC
      // identities rejects re-auth after expiry, and the expired branch below disables the user.
      add(`:if ([:len [/ip hotspot user find name="${v.code}"]] = 0) do={ /ip hotspot user add name=${v.code} password=${v.code} profile=${profileName}${macBind} comment="Dbv:${shortId}" }`);
      // Keep profile + binding current on existing users (MAC may have been captured after creation).
      // Also CLEAR any limit-uptime carried by users created before this fix and reset their used
      // counter — otherwise the cumulative-uptime limit keeps logging the device out seconds after
      // each reconnect (the flap), and reprovision alone wouldn't fix already-created users.
      add(`:if ([:len [/ip hotspot user find name="${v.code}"]] > 0) do={ /ip hotspot user set [find name="${v.code}"] profile=${profileName} limit-uptime=0s; :do { /ip hotspot user reset-counters [find name="${v.code}"] } on-error={} }`);
      if (v.usedByMac) {
        add(`:if ([:len [/ip hotspot user find name="${v.code}"]] > 0) do={ /ip hotspot user set [find name="${v.code}"] mac-address=${v.usedByMac.toUpperCase()} }`);
      }
      if (expired) {
        // Wall-clock expired: disable the user and remove any active session + cookie so the device
        // is dropped and cannot auto-reconnect. The MAC cookie is keyed by mac-address (not user),
        // so we remove by BOTH user AND mac — this is what actually bounds the cookie's life to the
        // session regardless of the cookie's nominal timeout.
        add(`:if ([:len [/ip hotspot user find name="${v.code}"]] > 0) do={ /ip hotspot user set [find name="${v.code}"] disabled=yes }`);
        add(`:foreach a in=[/ip hotspot active find user="${v.code}"] do={ /ip hotspot active remove \$a }`);
        add(`:foreach c in=[/ip hotspot cookie find user="${v.code}"] do={ /ip hotspot cookie remove \$c }`);
        if (v.usedByMac) add(`:foreach c in=[/ip hotspot cookie find mac-address="${v.usedByMac.toUpperCase()}"] do={ /ip hotspot cookie remove \$c }`);
      } else {
        add(`:if ([:len [/ip hotspot user find name="${v.code}"]] > 0) do={ /ip hotspot user set [find name="${v.code}"] disabled=no }`);
      }
      // Native MAC auto-login for this voucher's device (login-by=mac). For M-Pesa vouchers the
      // subscriber sync already creates the MAC user, but this also covers standalone vouchers.
      // Skip if there's a same-MAC subscriber (avoid duplicate user churn) — the subscriber path
      // owns it. We detect that on-router by only adding if no DbMac user already exists.
      if (v.usedByMac) {
        const macU = v.usedByMac.toUpperCase();
        if (expired) {
          add(`:foreach u in=[/ip hotspot user find name="${macU}" comment~"DbVMac"] do={ /ip hotspot user remove \$u }`);
          // Seamless disconnect: drop the live session + host so the device is logged out and
          // re-prompted to sign in (only affects standalone vouchers; subscriber path owns its own).
          add(`:foreach a in=[/ip hotspot active find mac-address="${macU}"] do={ /ip hotspot active remove \$a }`);
          add(`:foreach c in=[/ip hotspot cookie find mac-address="${macU}"] do={ /ip hotspot cookie remove \$c }`);
        } else {
          add(`:if ([:len [/ip hotspot user find name="${macU}"]] = 0) do={ /ip hotspot user add name="${macU}" password=dartbit mac-address=${macU} profile=${profileName} comment="DbVMac:${shortId}" }`);
        }
      }
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

// GET /router/debug-list?secret=dartbit-seed-2024 — diagnostic: lists all routers in
// the database this backend is connected to, with masked API keys + status. Use this to
// confirm whether a router you "linked" actually exists here, and which apiKey is current.
router.get('/debug-list', async (req: Request, res: Response) => {
  if (req.query.secret !== 'dartbit-seed-2024') return res.status(403).json({ error: 'Forbidden' });
  try {
    const routers = await prisma.mikrotikRouter.findMany({
      select: { id: true, name: true, apiKey: true, status: true, tenantId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      count: routers.length,
      routers: routers.map(r => ({
        id: r.id,
        name: r.name,
        status: r.status,
        apiKeyFull: r.apiKey,          // full key so you can match your bootstrap command
        tenantId: r.tenantId,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'failed' });
  }
});

// GET /router/queue-status?apiKey=xxx — diagnostic: how many commands are pending for
// this router, and whether the RouterCommand table is reachable. Helps confirm whether
// reprovision is actually being queued.
router.get('/queue-status', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || '');
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return res.status(404).json({ error: 'Router not found' });
    const pending = await prisma.routerCommand.count({ where: { routerId: r.id, consumed: false } });
    const total = await prisma.routerCommand.count({ where: { routerId: r.id } });
    const recent = await prisma.routerCommand.findMany({
      where: { routerId: r.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, consumed: true, createdAt: true, command: true },
    });
    res.json({
      router: r.name,
      status: r.status,
      pendingCommands: pending,
      totalCommands: total,
      recent: recent.map(c => ({ id: c.id, consumed: c.consumed, createdAt: c.createdAt, length: c.command.length })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'failed', hint: 'If this errors, the RouterCommand table may not exist — check DB patch.' });
  }
});

// GET /router/clear-queue?apiKey=xxx — drain all pending commands for this router. Use to recover
// from a poisoned queue (e.g. several stacked reprovisions). Safe: only clears UNCONSUMED rows.
router.get('/clear-queue', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || '');
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return res.status(404).json({ error: 'Router not found' });
    const cleared = await clearQueue(r.id);
    res.json({ router: r.name, cleared });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'failed' });
  }
});

router.get('/provision-done', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || '');
    if (!apiKey) return res.status(400).type('text/plain').send('');
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return res.status(404).type('text/plain').send('');
    await prisma.$executeRawUnsafe(`UPDATE "MikrotikRouter" SET "provisionedAt"=NOW(), "lastSeenAt"=NOW() WHERE id=$1`, r.id);
    console.log(`[provision-done] router ${r.id} (${r.name}) — PROVISIONING COMPLETE`);
    res.type('text/plain').send('ok');
  } catch {
    res.type('text/plain').send('');
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

    console.log(`[commands] delivering ${cmds.length} command(s) to router ${r.id} (${r.name}), total ${cmds.reduce((n, c) => n + c.length, 0)} chars`);
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
