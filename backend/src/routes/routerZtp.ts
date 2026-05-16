import { Router, Request, Response } from 'express';
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

router.get('/ztp-script', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || '');
    if (!apiKey) return res.status(400).type('text/plain').send('# Error: apiKey required');

    const r = await findRouter(apiKey);
    if (!r) return res.status(404).type('text/plain').send('# Error: Router not found');

    let backendUrl = process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app';
    if (backendUrl.startsWith('http://') && backendUrl.includes('railway.app')) {
      backendUrl = backendUrl.replace('http://', 'https://');
    }
    if (backendUrl.includes('localhost') || backendUrl.includes('127.0.0.1')) {
      backendUrl = 'https://dartbit-production.up.railway.app';
    }
    const isHttps = backendUrl.startsWith('https://');
    const fetchFlags = isHttps ? ' mode=https check-certificate=no' : '';

    const cfg = r.provConfig;
    const wan        = cfg?.wanInterface     ?? 'ether1';
    const lan        = cfg?.lanInterface     ?? 'ether2';
    const bridge     = cfg?.bridgeName       ?? 'bridge-lan';
    const lanGw      = cfg?.lanGateway       ?? '192.168.88.1';
    const dhcpStart  = cfg?.dhcpPoolStart    ?? '192.168.88.10';
    const dhcpEnd    = cfg?.dhcpPoolEnd      ?? '192.168.88.254';
    const lanSubnet  = cfg?.lanSubnet        ?? '192.168.88.0/24';
    const dns        = cfg?.dnsServers       ?? '8.8.8.8,8.8.4.4';
    const pppoeLocal = cfg?.pppoeLocalAddress ?? '10.10.10.1';
    const pppoePool  = cfg?.pppoeRemotePool  ?? 'pppoe-pool';
    const pppoeStart = cfg?.pppoePoolStart   ?? '10.10.10.10';
    const pppoeEnd   = cfg?.pppoePoolEnd     ?? '10.10.10.200';

    const lanInterfaces = lan.split(',').map(s => s.trim()).filter(Boolean);

    const lines: string[] = [];
    const add = (s: string) => lines.push(s);

    add('# Dartbit ZTP Script v1.3.4');
    add(`# Router  : ${r.name}`);
    add(`# Tenant  : ${r.tenant.name}`);
    add('');
    add(':log info "Dartbit: Starting provisioning"');
    add('');

    // Bridge
    add('# 1. Bridge');
    add(`:if ([:len [/interface bridge find name="${bridge}"]] = 0) do={ /interface bridge add name=${bridge} comment="Dartbit LAN" }`);
    for (const port of lanInterfaces) {
      add(`:if ([:len [/interface bridge port find interface="${port}"]] = 0) do={ /interface bridge port add bridge=${bridge} interface=${port} comment="Dartbit LAN port" }`);
    }
    add('');

    // LAN IP
    add('# 2. LAN gateway IP');
    add(`:if ([:len [/ip address find interface="${bridge}"]] = 0) do={ /ip address add address=${lanGw}/24 interface=${bridge} comment="Dartbit LAN Gateway" }`);
    add('');

    // DHCP
    add('# 3. DHCP server');
    add(`:if ([:len [/ip pool find name="dhcp-pool"]] = 0) do={ /ip pool add name=dhcp-pool ranges=${dhcpStart}-${dhcpEnd} }`);
    add(`:if ([:len [/ip dhcp-server network find address="${lanSubnet}"]] = 0) do={ /ip dhcp-server network add address=${lanSubnet} gateway=${lanGw} dns-server=${dns} }`);
    add(`:if ([:len [/ip dhcp-server find name="dartbit-dhcp"]] = 0) do={ /ip dhcp-server add name=dartbit-dhcp interface=${bridge} address-pool=dhcp-pool disabled=no lease-time=1d }`);
    add('');

    // NAT
    add('# 4. NAT for WAN');
    add(`:if ([:len [/interface find name="${wan}"]] > 0 && [:len [/ip firewall nat find comment="Dartbit WAN NAT"]] = 0) do={ /ip firewall nat add chain=srcnat out-interface=${wan} action=masquerade comment="Dartbit WAN NAT" }`);
    add('');

    // PPPoE server
    add('# 5. PPPoE server');
    add(`:if ([:len [/ip pool find name="${pppoePool}"]] = 0) do={ /ip pool add name=${pppoePool} ranges=${pppoeStart}-${pppoeEnd} }`);
    add(`:if ([:len [/ppp profile find name="dartbit-pppoe"]] = 0) do={ /ppp profile add name=dartbit-pppoe local-address=${pppoeLocal} remote-address=${pppoePool} comment="Dartbit PPPoE" }`);
    add(`:if ([:len [/interface pppoe-server server find service-name="dartbit"]] = 0) do={ /interface pppoe-server server add service-name=dartbit interface=${bridge} authentication=chap,pap default-profile=dartbit-pppoe disabled=no comment="Dartbit PPPoE Server" }`);
    add('');

    // Hotspot
    add('# 6. Hotspot');
    add(`:if ([:len [/ip hotspot profile find name="hsprof-dartbit"]] = 0) do={ /ip hotspot profile add name=hsprof-dartbit hotspot-address=${lanGw} dns-name=dartbit.login }`);
    add(`:if ([:len [/ip hotspot user profile find name="dartbit-default"]] = 0) do={ /ip hotspot user profile add name=dartbit-default rate-limit="10M/10M" }`);
    add(`:if ([:len [/ip hotspot find name="dartbit-hotspot"]] = 0) do={ /ip hotspot add name=dartbit-hotspot interface=${bridge} address-pool=dhcp-pool profile=hsprof-dartbit disabled=no }`);
    add('');

    // Walled garden
    add('# 7. Walled garden');
    add(`:if ([:len [/ip hotspot walled-garden find comment="Dartbit backend"]] = 0) do={ /ip hotspot walled-garden add dst-host=dartbit-production.up.railway.app comment="Dartbit backend" }`);
    add('');

    // === Heartbeat — simple, single URL ===
    add('# 8. Heartbeat — pings backend every 15s');
    add(`:foreach s in=[/system scheduler find comment="Dartbit heartbeat"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-heartbeat"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-heartbeat policy=read,write,test source="/tool fetch url=\\"${backendUrl}/router/heartbeat?apiKey=${apiKey}\\"${fetchFlags} keep-result=no"`);
    add(`/system scheduler add name=dartbit-heartbeat interval=15s on-event="/system script run dartbit-heartbeat" comment="Dartbit heartbeat"`);
    add('');

    // === Stats reporter — uses braces source={...} which RouterOS handles much better ===
    add('# 8b. Stats reporter — CPU/uptime/memory every 60s');
    add(`:foreach s in=[/system scheduler find comment="Dartbit stats"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-stats"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-stats policy=read,write,test source={:local cpu [/system resource get cpu-load]; :local upt [/system resource get uptime]; :local mem [/system resource get free-memory]; :local id [/system identity get name]; :local url ("${backendUrl}/router/stats?apiKey=${apiKey}&cpu=" . \$cpu . "&uptime=" . \$upt . "&memFree=" . \$mem . "&identity=" . \$id); /tool fetch url=\$url${fetchFlags} keep-result=no}`);
    add(`/system scheduler add name=dartbit-stats interval=5s on-event="/system script run dartbit-stats" comment="Dartbit stats"`);
    add('');

    // === Subscriber sync ===
    add('# 9. Subscriber sync — every 60s');
    add(`:foreach s in=[/system scheduler find comment="Dartbit sub sync"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-sync"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-sync policy=read,write,test source={/tool fetch url="${backendUrl}/router/sync-script?apiKey=${apiKey}"${fetchFlags} dst-path=dartbit-sync.rsc; :delay 1s; /import file-name=dartbit-sync.rsc}`);
    add(`/system scheduler add name=dartbit-sync interval=60s on-event="/system script run dartbit-sync" comment="Dartbit sub sync"`);
    add('');

    // === Remote commands ===
    add('# 10. Remote commands');
    add(`:foreach s in=[/system scheduler find comment="Dartbit cmd"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-cmd"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-cmd policy=read,write,test,reboot source={/tool fetch url="${backendUrl}/router/commands?apiKey=${apiKey}"${fetchFlags} dst-path=dartbit-cmd.rsc; :delay 1s; :if ([:len [/file find name="dartbit-cmd.rsc"]] > 0) do={ /import file-name=dartbit-cmd.rsc; :delay 1s; /file remove [find name="dartbit-cmd.rsc"] }}`);
    add(`/system scheduler add name=dartbit-cmd interval=30s on-event="/system script run dartbit-cmd" comment="Dartbit cmd"`);
    add('');

    // === Active session reporter — every 5s with traffic stats ===
    add('# 11. Active session reporter — every 5s with bandwidth');
    add(`:foreach s in=[/system scheduler find comment="Dartbit session sync"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-sessions"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-sessions policy=read,write,test source={:local data ""; :foreach a in=[/ppp active find] do={ :local u [/ppp active get \$a name]; :local ip [/ppp active get \$a address]; :local up [/ppp active get \$a uptime]; :local iface ("<pppoe-" . \$u . ">"); :local rxr 0; :local txr 0; :do { :set rxr [/interface get \$iface rx-byte]; :set txr [/interface get \$iface tx-byte]; } on-error={}; :set data (\$data . \$u . "|" . \$ip . "|" . \$up . "|" . \$rxr . "|" . \$txr . ","); }; :local url ("${backendUrl}/router/sessions?apiKey=${apiKey}&pppoe=" . \$data); /tool fetch url=\$url${fetchFlags} keep-result=no}`);
    add(`/system scheduler add name=dartbit-sessions interval=5s on-event="/system script run dartbit-sessions" comment="Dartbit session sync"`);
    add('');

    add(':log info "Dartbit: Provisioning complete"');

    res.type('text/plain').send(lines.join('\n'));
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

// In-memory cache of last reading per username for bandwidth delta calc
const lastTrafficReading: Record<string, { rx: number; tx: number; at: number }> = {};

router.all('/sessions', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || req.body?.apiKey || '');
    if (!apiKey) return sendError(res, 'apiKey required', 400);
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);

    // New format: "username|ip|uptime|rxBytes|txBytes,..."
    // Old format: "username:ip,..."
    const pppoeStr = String(req.query.pppoe || '').replace(/[^a-zA-Z0-9_\-\.,:|\/]/g, '');

    // Clear existing sessions for this router
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
        // Try new format first (pipe-delimited)
        const parts = e.split('|');
        let username = '', ipAddress = '', uptime = '', rxBytes = 0, txBytes = 0;

        if (parts.length >= 2) {
          username = parts[0] || '';
          ipAddress = parts[1] || '';
          uptime = parts[2] || '';
          rxBytes = parseInt(parts[3] || '0', 10) || 0;
          txBytes = parseInt(parts[4] || '0', 10) || 0;
        } else {
          // Fallback to old colon format
          const [u, ip] = e.split(':');
          username = u || '';
          ipAddress = ip || '';
        }

        if (!username) continue;

        // Calculate bandwidth from byte deltas
        let uploadKbps = 0, downloadKbps = 0;
        const key = `${r.id}:${username}`;
        const prev = lastTrafficReading[key];

        if (prev && rxBytes > 0 && txBytes > 0) {
          const dt = (now - prev.at) / 1000; // seconds
          if (dt > 0 && dt < 120) { // sanity check
            // From router perspective: rx = client uploaded TO router, tx = router downloaded TO client
            const rxDelta = Math.max(0, rxBytes - prev.rx);
            const txDelta = Math.max(0, txBytes - prev.tx);
            uploadKbps = Math.round((rxDelta * 8) / 1024 / dt);
            downloadKbps = Math.round((txDelta * 8) / 1024 / dt);
          }
        }

        // Save current reading for next calculation
        if (rxBytes > 0 || txBytes > 0) {
          lastTrafficReading[key] = { rx: rxBytes, tx: txBytes, at: now };
        }

        sessions.push({
          username, ipAddress, uptime,
          uploadSpeed: uploadKbps,
          downloadSpeed: downloadKbps,
          routerId: r.id, tenantId: r.tenantId,
        });
      }

      if (sessions.length > 0) {
        await prisma.onlineSession.createMany({ data: sessions });

        for (const s of sessions) {
          await prisma.subscriber.updateMany({
            where: { tenantId: r.tenantId, username: s.username },
            data: { lastOnlineAt: new Date(), ipAddress: s.ipAddress || undefined, routerId: r.id },
          });
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Sessions error:', err);
    sendError(res, 'Failed', 500);
  }
});

// Sync script — generates RouterOS script for PPPoE secrets / Hotspot users / static leases
router.get('/sync-script', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || '');
    if (!apiKey) return res.status(400).type('text/plain').send('# Error: apiKey required');

    const r = await prisma.mikrotikRouter.findUnique({
      where: { apiKey },
      include: { tenant: true },
    });
    if (!r) return res.status(404).type('text/plain').send('# Error: Router not found');

    // Get ALL subscribers for this tenant (active and expired)
    const subscribers = await prisma.subscriber.findMany({
      where: { tenantId: r.tenantId },
      include: { package: true },
    });

    const now = new Date();
    const lines: string[] = [];
    const add = (s: string) => lines.push(s);

    add(`:log info "Dartbit: Syncing ${subscribers.length} subscribers"`);
    add('');

    // Format date for RouterOS scheduler: "mmm/dd/yyyy hh:mm:ss"
    // We'll use MikroTik's start-date and start-time
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

    // First: Remove ALL old per-user expiry schedulers so we can rebuild them
    add(`:foreach s in=[/system scheduler find comment~"Dartbit-expiry:"] do={ /system scheduler remove \$s }`);
    add('');

    const pppoeUsers = subscribers.filter(s => s.service === 'PPPOE');
    for (const sub of pppoeUsers) {
      const speed = sub.package ? `${sub.package.speedUpKbps}k/${sub.package.speedDownKbps}k` : '10M/10M';
      const profileName = sub.package ? `dartbit-pkg-${sub.package.id.substring(0, 8)}` : 'dartbit-pppoe';
      const expired = sub.expiresAt && sub.expiresAt <= now;
      const disabled = !sub.isActive || expired;

      add(`:if ([:len [/ppp profile find name="${profileName}"]] = 0) do={ /ppp profile add name=${profileName} local-address=10.10.10.1 remote-address=pppoe-pool rate-limit=${speed} comment="Dartbit Package" }`);
      add(`:if ([:len [/ppp secret find name="${sub.username}"]] > 0) do={ /ppp secret set [find name="${sub.username}"] password="${sub.secret}" profile=${profileName} disabled=${disabled ? 'yes' : 'no'} comment="Dartbit:${sub.id}" } else={ /ppp secret add name="${sub.username}" password="${sub.secret}" profile=${profileName} service=pppoe disabled=${disabled ? 'yes' : 'no'} comment="Dartbit:${sub.id}" }`);

      // If expired now → kick active session
      if (expired) {
        add(`:foreach a in=[/ppp active find name="${sub.username}"] do={ /ppp active remove \$a }`);
      }
      // If has future expiry → schedule one-shot disable & kick at that exact time
      else if (sub.expiresAt) {
        const { date, time } = rosDate(sub.expiresAt);
        const schedName = `dartbit-exp-${sub.id.substring(0, 8)}`;
        add(`/system scheduler add name=${schedName} start-date=${date} start-time=${time} interval=0 on-event={/ppp secret disable [find name="${sub.username}"]; :foreach a in=[/ppp active find name="${sub.username}"] do={ /ppp active remove \$a }; :log info ("Dartbit: Auto-expired ${sub.username}")} comment="Dartbit-expiry:${sub.id}"`);
      }
    }

    const hsUsers = subscribers.filter(s => s.service === 'HOTSPOT');
    for (const sub of hsUsers) {
      const speed = sub.package ? `${sub.package.speedUpKbps}k/${sub.package.speedDownKbps}k` : '5M/5M';
      const profileName = sub.package ? `dartbit-hspkg-${sub.package.id.substring(0, 8)}` : 'dartbit-default';
      const expired = sub.expiresAt && sub.expiresAt <= now;
      const disabled = !sub.isActive || expired;

      add(`:if ([:len [/ip hotspot user profile find name="${profileName}"]] = 0) do={ /ip hotspot user profile add name=${profileName} rate-limit=${speed} comment="Dartbit Package" }`);
      add(`:if ([:len [/ip hotspot user find name="${sub.username}"]] > 0) do={ /ip hotspot user set [find name="${sub.username}"] password="${sub.secret}" profile=${profileName} disabled=${disabled ? 'yes' : 'no'} comment="Dartbit:${sub.id}" } else={ /ip hotspot user add name="${sub.username}" password="${sub.secret}" profile=${profileName} disabled=${disabled ? 'yes' : 'no'} comment="Dartbit:${sub.id}" }`);

      if (expired) {
        add(`:foreach a in=[/ip hotspot active find user="${sub.username}"] do={ /ip hotspot active remove \$a }`);
      } else if (sub.expiresAt) {
        const { date, time } = rosDate(sub.expiresAt);
        const schedName = `dartbit-exp-${sub.id.substring(0, 8)}`;
        add(`/system scheduler add name=${schedName} start-date=${date} start-time=${time} interval=0 on-event={/ip hotspot user disable [find name="${sub.username}"]; :foreach a in=[/ip hotspot active find user="${sub.username}"] do={ /ip hotspot active remove \$a }; :log info ("Dartbit: Auto-expired ${sub.username}")} comment="Dartbit-expiry:${sub.id}"`);
      }
    }

    const staticUsers = subscribers.filter(s => s.service === 'STATIC' && s.ipAddress);
    for (const sub of staticUsers) {
      if (!sub.ipAddress) continue;
      add(`:if ([:len [/ip dhcp-server lease find address="${sub.ipAddress}"]] = 0) do={ /ip dhcp-server lease add address=${sub.ipAddress} ${sub.macAddress ? `mac-address=${sub.macAddress}` : ''} server=dartbit-dhcp comment="Dartbit:${sub.id}" }`);
    }

    // Cleanup: disable any Dartbit-managed users that aren't in our list anymore (deleted)
    const knownIds = subscribers.map(s => `"Dartbit:${s.id}"`).join(',');
    add('');
    add('# Disable Dartbit-managed users no longer in backend (deleted)');
    add(`:foreach s in=[/ppp secret find comment~"Dartbit:"] do={ :local c [/ppp secret get \$s comment]; :if ([:len [:find (${knownIds || '""'}) \$c]] = 0) do={ /ppp secret disable \$s; :foreach a in=[/ppp active find name=[/ppp secret get \$s name]] do={ /ppp active remove \$a } } }`);
    add(`:foreach s in=[/ip hotspot user find comment~"Dartbit:"] do={ :local c [/ip hotspot user get \$s comment]; :if ([:len [:find (${knownIds || '""'}) \$c]] = 0) do={ /ip hotspot user disable \$s } }`);

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

    const cmds = dequeueAll(r.id);
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
    const queued = enqueueCommand(routerId, command);
    res.json({ success: true, queued });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

router.post('/interfaces', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || req.body?.apiKey || '');
    if (!apiKey) return sendError(res, 'apiKey required', 400);
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);
    res.json({ ok: true });
  } catch { sendError(res, 'Failed', 500); }
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

export default router;
