import { Router, Request, Response } from 'express';
import prisma from '../utils/prisma';
import { sendError } from '../utils/response';

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

    const lines: string[] = [];
    const add = (s: string) => lines.push(s);

    add('# Dartbit ZTP Script');
    add(`# Router  : ${r.name}`);
    add(`# Tenant  : ${r.tenant.name}`);
    add(`# Backend : ${backendUrl}`);
    add('');
    add(':log info "Dartbit: Starting ZTP provisioning"');
    add('');

    // Bridge
    add('# 1. Bridge');
    add(`:if ([:len [/interface bridge find name="${bridge}"]] = 0) do={ /interface bridge add name=${bridge} comment="Dartbit LAN" }`);
    add(`:if ([:len [/interface bridge port find interface="${lan}"]] = 0) do={ /interface bridge port add bridge=${bridge} interface=${lan} comment="Dartbit LAN port" }`);
    add('');

    // LAN IP
    add('# 2. LAN gateway IP');
    add(`:if ([:len [/ip address find address="${lanGw}/24"]] = 0) do={ /ip address add address=${lanGw}/24 interface=${bridge} comment="Dartbit LAN Gateway" }`);
    add('');

    // DHCP
    add('# 3. DHCP server');
    add(`:if ([:len [/ip pool find name="dhcp-pool"]] = 0) do={ /ip pool add name=dhcp-pool ranges=${dhcpStart}-${dhcpEnd} }`);
    add(`:if ([:len [/ip dhcp-server network find address="${lanSubnet}"]] = 0) do={ /ip dhcp-server network add address=${lanSubnet} gateway=${lanGw} dns-server=${dns} }`);
    add(`:if ([:len [/ip dhcp-server find name="dartbit-dhcp"]] = 0) do={ /ip dhcp-server add name=dartbit-dhcp interface=${bridge} address-pool=dhcp-pool disabled=no lease-time=1d }`);
    add('');

    // NAT
    add('# 4. NAT for WAN');
    add(`:if ([:len [/ip firewall nat find comment="Dartbit WAN NAT"]] = 0) do={ /ip firewall nat add chain=srcnat out-interface=${wan} action=masquerade comment="Dartbit WAN NAT" }`);
    add('');

    // PPPoE
    add('# 5. PPPoE server');
    add(`:if ([:len [/ip pool find name="${pppoePool}"]] = 0) do={ /ip pool add name=${pppoePool} ranges=${pppoeStart}-${pppoeEnd} }`);
    add(`:if ([:len [/ppp profile find name="dartbit-pppoe"]] = 0) do={ /ppp profile add name=dartbit-pppoe local-address=${pppoeLocal} remote-address=${pppoePool} comment="Dartbit PPPoE" }`);
    add(`:if ([:len [/interface pppoe-server server find service-name="dartbit"]] = 0) do={ /interface pppoe-server server add service-name=dartbit interface=${bridge} authentication=chap,pap default-profile=dartbit-pppoe disabled=no comment="Dartbit PPPoE Server" }`);
    add('');

    // Hotspot — note: requires html-directory which must already exist on router. Skip user profile if conflicting.
    add('# 6. Hotspot');
    add(`:if ([:len [/ip hotspot profile find name="hsprof-dartbit"]] = 0) do={ /ip hotspot profile add name=hsprof-dartbit hotspot-address=${lanGw} dns-name=dartbit.login }`);
    add(`:if ([:len [/ip hotspot user profile find name="dartbit-default"]] = 0) do={ /ip hotspot user profile add name=dartbit-default rate-limit="10M/10M" }`);
    add(`:if ([:len [/ip hotspot find name="dartbit-hotspot"]] = 0) do={ /ip hotspot add name=dartbit-hotspot interface=${bridge} address-pool=dhcp-pool profile=hsprof-dartbit disabled=no }`);
    add('');

    // Walled garden
    add('# 7. Walled garden');
    add(`:if ([:len [/ip hotspot walled-garden find comment="Dartbit backend"]] = 0) do={ /ip hotspot walled-garden add dst-host=dartbit-production.up.railway.app comment="Dartbit backend" }`);
    add('');

    // Default route
    add('# 8. Default route');
    add(`:if ([:len [/ip route find comment="Dartbit Default Route"]] = 0) do={ /ip route add dst-address=0.0.0.0/0 gateway=${wan} comment="Dartbit Default Route" }`);
    add('');

    // Heartbeat — use a script object instead of inline on-event to avoid escaping issues
    add('# 9. Heartbeat — runs every 15s via scheduler');
    add(`:foreach s in=[/system scheduler find comment="Dartbit heartbeat"] do={ /system scheduler remove $s }`);
    add(`:foreach s in=[/system script find name="dartbit-heartbeat"] do={ /system script remove $s }`);
    // /tool fetch with keep-result=no doesn't need output=none
    add(`/system script add name=dartbit-heartbeat policy=read,write,test source="/tool fetch url=\\"${backendUrl}/router/heartbeat?apiKey=${apiKey}\\"${fetchFlags} keep-result=no"`);
    add(`/system scheduler add name=dartbit-heartbeat interval=15s on-event="/system script run dartbit-heartbeat" comment="Dartbit heartbeat"`);
    add('');

    add(':log info "Dartbit: ZTP provisioning complete"');

    res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    console.error('ZTP error:', err);
    res.status(500).type('text/plain').send(`# Error: ${err instanceof Error ? err.message : 'Unknown'}`);
  }
});

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

router.post('/interfaces', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || req.body?.apiKey || '');
    if (!apiKey) return sendError(res, 'apiKey required', 400);
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);
    res.json({ ok: true });
  } catch { sendError(res, 'Failed', 500); }
});

router.post('/sessions', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || req.body?.apiKey || '');
    if (!apiKey) return sendError(res, 'apiKey required', 400);
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);
    res.json({ ok: true });
  } catch { sendError(res, 'Failed', 500); }
});

// GET /router/provision/:routerId — fetch provisioning config (creates default if missing)
router.get('/provision/:routerId', async (req: Request, res: Response) => {
  try {
    const { routerId } = req.params;
    let cfg = await prisma.routerProvisioningConfig.findUnique({ where: { routerId } });
    if (!cfg) {
      // Create default config
      cfg = await prisma.routerProvisioningConfig.create({
        data: { routerId },
      });
    }
    res.json({ success: true, data: cfg });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load provisioning config';
    console.error('Get provision error:', msg);
    sendError(res, msg, 500);
  }
});

// POST /router/provision/:routerId — save provisioning config (upsert)
router.post('/provision/:routerId', async (req: Request, res: Response) => {
  try {
    const { routerId } = req.params;
    const body = req.body || {};

    // Whitelist only valid fields — strip out id, routerId, createdAt, updatedAt
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

    // Verify router exists
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
    console.error('Save provision error:', msg);
    sendError(res, msg, 500);
  }
});

export default router;
