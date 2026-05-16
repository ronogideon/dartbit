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

// GET /router/ztp-script?apiKey=...
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

    // Build script using array join — avoids any template-literal escaping ambiguity
    const lines: string[] = [];
    const add = (s: string) => lines.push(s);

    add('# ============================================================');
    add(`# Dartbit ZTP Script v1.2.7`);
    add(`# Router  : ${r.name}`);
    add(`# Tenant  : ${r.tenant.name}`);
    add(`# Backend : ${backendUrl}`);
    add(`# Generated: ${new Date().toISOString()}`);
    add('# ============================================================');
    add('');
    add(':log info "Dartbit: Starting ZTP provisioning"');
    add('');

    add('# Bridge');
    add('/interface bridge');
    add(`add name=${bridge} comment="Dartbit LAN"`);
    add('/interface bridge port');
    add(`add bridge=${bridge} interface=${lan} comment="Dartbit LAN port"`);
    add('');

    add('# LAN gateway IP');
    add('/ip address');
    add(`add address=${lanGw}/24 interface=${bridge} comment="Dartbit LAN Gateway"`);
    add('');

    add('# DHCP server');
    add('/ip pool');
    add(`add name=dhcp-pool ranges=${dhcpStart}-${dhcpEnd}`);
    add('/ip dhcp-server network');
    add(`add address=${lanSubnet} gateway=${lanGw} dns-server=${dns}`);
    add('/ip dhcp-server');
    add(`add name=dartbit-dhcp interface=${bridge} address-pool=dhcp-pool disabled=no lease-time=1d`);
    add('');

    add('# NAT for WAN');
    add('/ip firewall nat');
    add(`add chain=srcnat out-interface=${wan} action=masquerade comment="Dartbit WAN NAT"`);
    add('');

    add('# PPPoE pool and profile');
    add('/ip pool');
    add(`add name=${pppoePool} ranges=${pppoeStart}-${pppoeEnd}`);
    add('/ppp profile');
    add(`add name=dartbit-pppoe local-address=${pppoeLocal} remote-address=${pppoePool} comment="Dartbit PPPoE"`);
    add('/interface pppoe-server server');
    add(`add service-name=dartbit interface=${bridge} authentication=chap,pap default-profile=dartbit-pppoe disabled=no comment="Dartbit PPPoE Server"`);
    add('');

    add('# Hotspot');
    add('/ip hotspot profile');
    add(`add name=hsprof-dartbit hotspot-address=${lanGw} dns-name=dartbit.login html-directory=hotspot`);
    add('/ip hotspot user profile');
    add(`add name=dartbit-default rate-limit="10M/10M" shared-users=1 comment="Dartbit Default"`);
    add('/ip hotspot');
    add(`add name=dartbit-hotspot interface=${bridge} address-pool=dhcp-pool profile=hsprof-dartbit disabled=no`);
    add('');

    add('# Walled garden — allow Dartbit backend');
    add('/ip hotspot walled-garden');
    add(`add dst-host=dartbit-production.up.railway.app comment="Dartbit backend"`);
    add('');

    add('# Default route');
    add('/ip route');
    add(`add dst-address=0.0.0.0/0 gateway=${wan} comment="Dartbit Default Route"`);
    add('');

    // Heartbeat — keep it single-line
    add('# Heartbeat scheduler — sends router status every 15s');
    add('/system scheduler');
    add(`remove [find comment="Dartbit heartbeat"]`);
    add(`add name=dartbit-heartbeat interval=15s comment="Dartbit heartbeat" on-event=":local id [/system identity get name]; :local cpu [/system resource get cpu-load]; :local upt [/system resource get uptime]; /tool fetch url=\\"${backendUrl}/router/heartbeat?apiKey=${apiKey}&identity=\$id&cpu=\$cpu&uptime=\$upt\\"${fetchFlags} output=none keep-result=no"`);
    add('');

    add(':log info "Dartbit: ZTP provisioning complete"');
    add('');

    res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    console.error('ZTP error:', err);
    res.status(500).type('text/plain').send(`# Error: ${err instanceof Error ? err.message : 'Unknown'}`);
  }
});

// POST /router/heartbeat — accepts GET as well for simpler MikroTik fetch
router.all('/heartbeat', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || req.body?.apiKey || '');
    if (!apiKey) return sendError(res, 'apiKey required', 400);

    const identity = String(req.query.identity || req.body?.identity || '');
    const cpu = parseFloat(String(req.query.cpu || req.body?.cpuLoad || '0'));
    const uptime = String(req.query.uptime || req.body?.uptime || '');

    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);

    await prisma.mikrotikRouter.update({
      where: { id: r.id },
      data: {
        identity: identity || r.identity,
        cpuLoad: isNaN(cpu) ? r.cpuLoad : cpu,
        uptime: uptime || r.uptime,
        status: 'ONLINE',
        lastSeenAt: new Date(),
      },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Heartbeat error:', err);
    sendError(res, 'Heartbeat failed', 500);
  }
});

// POST /router/interfaces
router.post('/interfaces', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || req.body?.apiKey || '');
    if (!apiKey) return sendError(res, 'apiKey required', 400);
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);
    res.json({ ok: true });
  } catch {
    sendError(res, 'Failed', 500);
  }
});

// POST /router/sessions
router.post('/sessions', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || req.body?.apiKey || '');
    if (!apiKey) return sendError(res, 'apiKey required', 400);
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);
    res.json({ ok: true });
  } catch {
    sendError(res, 'Failed', 500);
  }
});

export default router;
