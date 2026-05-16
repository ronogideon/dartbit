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

    // === Active session reporter — uses braces for safe string building ===
    add('# 11. Active session reporter — every 30s');
    add(`:foreach s in=[/system scheduler find comment="Dartbit session sync"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-sessions"] do={ /system script remove $s }`);
    add(`/system script add name=dartbit-sessions policy=read,write,test source={:local data ""; :foreach a in=[/ppp active find] do={ :local u [/ppp active get \$a name]; :local ip [/ppp active get \$a address]; :set data (\$data . \$u . ":" . \$ip . ",") }; :local url ("${backendUrl}/router/sessions?apiKey=${apiKey}&pppoe=" . \$data); /tool fetch url=\$url${fetchFlags} keep-result=no}`);
    add(`/system scheduler add name=dartbit-sessions interval=30s on-event="/system script run dartbit-sessions" comment="Dartbit session sync"`);
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

// Active sessions report from router
router.all('/sessions', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || req.body?.apiKey || '');
    if (!apiKey) return sendError(res, 'apiKey required', 400);
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);

    // Sanitize but allow IP characters
    const pppoeStr = String(req.query.pppoe || '').replace(/[^a-zA-Z0-9_\-\.,:\/]/g, '');
    console.log(`[sessions] router=${r.name} pppoeStr="${pppoeStr}"`);

    // Clear existing sessions for this router
    await prisma.onlineSession.deleteMany({ where: { routerId: r.id } });

    if (pppoeStr) {
      const entries = pppoeStr.split(',').filter(Boolean);
      const sessions: Array<{ username: string; ipAddress: string; routerId: string; tenantId: string }> = [];
      for (const e of entries) {
        const [username, ipAddress] = e.split(':');
        if (username && username.length > 0) {
          sessions.push({ username, ipAddress: ipAddress || '', routerId: r.id, tenantId: r.tenantId });
        }
      }

      if (sessions.length > 0) {
        await prisma.onlineSession.createMany({ data: sessions });
        console.log(`[sessions] saved ${sessions.length} sessions for ${r.name}`);

        // Also update Subscriber.lastOnlineAt for these usernames
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

    const subscribers = await prisma.subscriber.findMany({
      where: {
        tenantId: r.tenantId,
        isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: { package: true },
    });

    const lines: string[] = [];
    const add = (s: string) => lines.push(s);

    add(`:log info "Dartbit: Syncing ${subscribers.length} subscribers"`);
    add('');

    const pppoeUsers = subscribers.filter(s => s.service === 'PPPOE');
    for (const sub of pppoeUsers) {
      const speed = sub.package ? `${sub.package.speedUpKbps}k/${sub.package.speedDownKbps}k` : '10M/10M';
      const profileName = sub.package ? `dartbit-pkg-${sub.package.id.substring(0, 8)}` : 'dartbit-pppoe';

      add(`:if ([:len [/ppp profile find name="${profileName}"]] = 0) do={ /ppp profile add name=${profileName} local-address=10.10.10.1 remote-address=pppoe-pool rate-limit=${speed} comment="Dartbit Package" }`);
      add(`:if ([:len [/ppp secret find name="${sub.username}"]] > 0) do={ /ppp secret set [find name="${sub.username}"] password="${sub.secret}" profile=${profileName} disabled=no comment="Dartbit:${sub.id}" } else={ /ppp secret add name="${sub.username}" password="${sub.secret}" profile=${profileName} service=pppoe disabled=no comment="Dartbit:${sub.id}" }`);
    }

    const hsUsers = subscribers.filter(s => s.service === 'HOTSPOT');
    for (const sub of hsUsers) {
      const speed = sub.package ? `${sub.package.speedUpKbps}k/${sub.package.speedDownKbps}k` : '5M/5M';
      const profileName = sub.package ? `dartbit-hspkg-${sub.package.id.substring(0, 8)}` : 'dartbit-default';

      add(`:if ([:len [/ip hotspot user profile find name="${profileName}"]] = 0) do={ /ip hotspot user profile add name=${profileName} rate-limit=${speed} comment="Dartbit Package" }`);
      add(`:if ([:len [/ip hotspot user find name="${sub.username}"]] > 0) do={ /ip hotspot user set [find name="${sub.username}"] password="${sub.secret}" profile=${profileName} disabled=no comment="Dartbit:${sub.id}" } else={ /ip hotspot user add name="${sub.username}" password="${sub.secret}" profile=${profileName} disabled=no comment="Dartbit:${sub.id}" }`);
    }

    const staticUsers = subscribers.filter(s => s.service === 'STATIC' && s.ipAddress);
    for (const sub of staticUsers) {
      if (!sub.ipAddress) continue;
      add(`:if ([:len [/ip dhcp-server lease find address="${sub.ipAddress}"]] = 0) do={ /ip dhcp-server lease add address=${sub.ipAddress} ${sub.macAddress ? `mac-address=${sub.macAddress}` : ''} server=dartbit-dhcp comment="Dartbit:${sub.id}" }`);
    }

    // Cleanup disabled users
    const activeUsernames = subscribers.map(s => `"${s.username}"`).join(',');
    add('');
    add('# Disable removed/expired users');
    add(`:foreach s in=[/ppp secret find comment~"Dartbit:"] do={ :local n [/ppp secret get \$s name]; :if ([:len [:find (${activeUsernames || '""'}) \$n]] = 0) do={ /ppp secret disable \$s } }`);
    add(`:foreach s in=[/ip hotspot user find comment~"Dartbit:"] do={ :local n [/ip hotspot user get \$s name]; :if ([:len [:find (${activeUsernames || '""'}) \$n]] = 0) do={ /ip hotspot user disable \$s } }`);
    add(`:foreach a in=[/ppp active find] do={ :local n [/ppp active get \$a name]; :local sec [/ppp secret find name=\$n]; :if ([:len \$sec] > 0 && [/ppp secret get \$sec disabled] = true) do={ /ppp active remove \$a } }`);

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
