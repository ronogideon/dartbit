import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

async function findRouter(apiKey: string) {
  return prisma.mikrotikRouter.findUnique({
    where: { apiKey },
    include: { provConfig: true, tenant: { include: { settings: true } } },
  });
}

// ─── GET /router/ztp-script?apiKey=... ───────────────────────────────────────
router.get('/ztp-script', async (req: Request, res: Response) => {
  const { apiKey } = req.query;
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).send('# Error: apiKey is required');
  }

  const r = await findRouter(apiKey);
  if (!r) return res.status(404).send('# Error: Router not found');

  let backendUrl = process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app';
  // Force HTTPS for Railway URLs and replace localhost with Railway public URL
  if (backendUrl.startsWith('http://') && backendUrl.includes('railway.app')) {
    backendUrl = backendUrl.replace('http://', 'https://');
  }
  if (backendUrl.includes('localhost') || backendUrl.includes('127.0.0.1')) {
    backendUrl = 'https://dartbit-production.up.railway.app';
  }
  const isHttps = backendUrl.startsWith('https://');
  const fetchFlags = isHttps ? ' mode=https check-certificate=no' : '';
  const hotspotLoginUrl = backendUrl + '/hotspot';
  const cfg = r.provConfig;

  // Defaults if no provConfig yet
  const wan           = cfg?.wanInterface        ?? 'ether1';
  const lan           = cfg?.lanInterface        ?? 'ether2';
  const bridge        = cfg?.bridgeName          ?? 'bridge-lan';
  const lanGw         = cfg?.lanGateway          ?? '192.168.88.1';
  const dhcpStart     = cfg?.dhcpPoolStart       ?? '192.168.88.10';
  const dhcpEnd       = cfg?.dhcpPoolEnd         ?? '192.168.88.254';
  const dns           = cfg?.dnsServers          ?? '8.8.8.8,8.8.4.4';
  const pppoeLocal    = cfg?.pppoeLocalAddress   ?? '10.10.10.1';
  const pppoePool     = cfg?.pppoeRemotePool     ?? 'pppoe-pool';
  const pppoePoolStart= cfg?.pppoePoolStart      ?? '10.10.10.10';
  const pppoePoolEnd  = cfg?.pppoePoolEnd        ?? '10.10.10.200';
  const hsIface       = cfg?.hotspotInterface    ?? bridge;
  const hsDns         = cfg?.hotspotDnsName      ?? 'dartbit.login';
  const lanSubnet     = cfg?.lanSubnet           ?? '192.168.88.0/24';
  const dnsArr        = dns.split(',');
  const dns1          = dnsArr[0] ?? '8.8.8.8';
  const dns2          = dnsArr[1] ?? '8.8.4.4';
  const lanPrefix     = lanGw.split('.').slice(0, 3).join('.');

  const script = `
# ============================================================
# Dartbit ZTP Script v1.1.3
# Router : ${r.name}
# Tenant : ${r.tenant.name}
# Generated: ${new Date().toISOString()}
# ============================================================

:log info "Dartbit: Starting ZTP provisioning..."

# ── 1. BRIDGE ───────────────────────────────────────────────
/interface bridge
add name=${bridge} protocol-mode=rstp comment="Dartbit LAN Bridge"

/interface bridge port
add bridge=${bridge} interface=${lan} comment="Dartbit LAN port"

# ── 2. IP ADDRESSES ─────────────────────────────────────────
/ip address
add address=${lanGw}/24 interface=${bridge} comment="Dartbit LAN Gateway"

# ── 3. DHCP SERVER ──────────────────────────────────────────
/ip pool
add name=dhcp-pool ranges=${dhcpStart}-${dhcpEnd}

/ip dhcp-server
add name=dhcp-lan interface=${bridge} address-pool=dhcp-pool disabled=no lease-time=1h

/ip dhcp-server network
add address=${lanSubnet} gateway=${lanGw} dns-server=${dns1},${dns2} comment="Dartbit DHCP Network"

# ── 4. DNS ──────────────────────────────────────────────────
/ip dns
set servers=${dns1},${dns2} allow-remote-requests=yes

# ── 5. NAT MASQUERADE ───────────────────────────────────────
/ip firewall nat
add chain=srcnat out-interface=${wan} action=masquerade comment="Dartbit NAT"

# ── 6. FIREWALL BASICS ──────────────────────────────────────
/ip firewall filter
add chain=input connection-state=established,related action=accept comment="Accept established"
add chain=input connection-state=invalid action=drop comment="Drop invalid"
add chain=input in-interface=${wan} action=drop comment="Drop WAN input"
add chain=forward connection-state=established,related action=accept comment="Accept forward established"
add chain=forward connection-state=invalid action=drop comment="Drop forward invalid"

# ── 7. PPPOE SERVER ─────────────────────────────────────────
/ip pool
add name=${pppoePool} ranges=${pppoePoolStart}-${pppoePoolEnd}

/ppp profile
add name=dartbit-pppoe local-address=${pppoeLocal} remote-address=${pppoePool} \\
    use-compression=no use-encryption=no dns-server=${dns1},${dns2} \\
    comment="Dartbit PPPoE Profile"

/interface pppoe-server server
add service-name=dartbit interface=${bridge} authentication=chap,pap \\
    default-profile=dartbit-pppoe enabled=yes max-sessions=0 \\
    comment="Dartbit PPPoE Server"

# ── 8. PPPOE NAT RULE ───────────────────────────────────────
/ip firewall nat
add chain=srcnat src-address=${pppoePoolStart}-${pppoePoolEnd} \\
    out-interface=${wan} action=masquerade comment="Dartbit PPPoE NAT"

# ── 9. HOTSPOT ──────────────────────────────────────────────
/ip hotspot
add name=dartbit-hotspot interface=${hsIface} address-pool=dhcp-pool \\
    disabled=no profile=hsprof1 comment="Dartbit Hotspot"

/ip hotspot profile
set hsprof1 hotspot-address=${lanGw} dns-name=${hsDns} \\
    html-directory=hotspot login-by=http-chap,http-pap \\
    http-proxy=0.0.0.0:8080 smtp-server=0.0.0.0 \\
    rate-limit="" use-radius=no

/ip hotspot user profile
add name=dartbit-default rate-limit="10M/10M" shared-users=1 \\
    status-autorefresh=1m comment="Dartbit Default Profile"

# Redirect hotspot login page to Dartbit backend
/ip hotspot walled-garden
add dst-host=${hsDns} action=allow comment="Dartbit login page"
add dst-host=dartbit-production.up.railway.app action=allow comment="Dartbit backend"

/ip hotspot walled-garden ip
add dst-address=0.0.0.0/0 protocol=tcp dst-port=53 action=accept comment="Allow DNS"
add dst-address=0.0.0.0/0 protocol=udp dst-port=53 action=accept comment="Allow DNS UDP"

# ── 10. STATIC ARP BRIDGE (for static IP subscribers) ───────
/ip arp
set [find interface=${bridge}] disabled=no

# ── 11. ROUTING ─────────────────────────────────────────────
/ip route
add dst-address=0.0.0.0/0 gateway=${wan} comment="Dartbit Default Route" disabled=no

# ── 12. HEARTBEAT SCHEDULER ─────────────────────────────────
/system scheduler
remove [find comment="Dartbit heartbeat"]
add name="dartbit-heartbeat" interval=15s on-event={
  :local identity [/system identity get name]
  :local cpu [/system resource get cpu-load]
  :local uptime [/system resource get uptime]
  :local body ("{\"apiKey\":\"${apiKey}\",\"identity\":\"" . $identity . "\",\"cpuLoad\":" . $cpu . ",\"uptime\":\"" . $uptime . "\"}")
  /tool fetch url="${backendUrl}/router/heartbeat"${fetchFlags} \\
    http-method=post \\
    http-header-field="Content-Type: application/json" \\
    http-data=$body \\
    output=none keep-result=no
} comment="Dartbit heartbeat"

# ── 13. INTERFACE SYNC SCHEDULER ────────────────────────────
/system scheduler
remove [find comment="Dartbit interface sync"]
add name="dartbit-ifsync" interval=5m on-event={
  :local ifaces ""
  :foreach i in=[/interface find] do={
    :local iname [/interface get $i name]
    :local itype [/interface get $i type]
    :local irun [/interface get $i running]
    :local idis [/interface get $i disabled]
    :local imac ""
    :do { :set imac [/interface get $i mac-address] } on-error={}
    :set ifaces ($ifaces . "{\"name\":\"" . $iname . "\",\"type\":\"" . $itype . "\",\"macAddr\":\"" . $imac . "\",\"running\":" . $irun . ",\"disabled\":" . $idis . "},")
  }
  :local body ("{\"apiKey\":\"${apiKey}\",\"interfaces\":[" . $ifaces . "]}")
  /tool fetch url="${backendUrl}/router/interfaces"${fetchFlags} \\
    http-method=post \\
    http-header-field="Content-Type: application/json" \\
    http-data=$body \\
    output=none keep-result=no
} comment="Dartbit interface sync"

# ── 14. PPPOE SESSION SYNC SCHEDULER ────────────────────────
/system scheduler
remove [find comment="Dartbit session sync"]
add name="dartbit-sessions" interval=30s on-event={
  :local sessions ""
  :foreach s in=[/ppp active find] do={
    :local uname [/ppp active get $s name]
    :local uip [/ppp active get $s address]
    :local uuptime [/ppp active get $s uptime]
    :set sessions ($sessions . "{\"username\":\"" . $uname . "\",\"ipAddress\":\"" . $uip . "\",\"uptime\":\"" . $uuptime . "\"},")
  }
  :local hssessions ""
  :foreach h in=[/ip hotspot active find] do={
    :local huname [/ip hotspot active get $h user]
    :local hip [/ip hotspot active get $h address]
    :local hmac [/ip hotspot active get $h mac-address]
    :local huptime [/ip hotspot active get $h uptime]
    :set hssessions ($hssessions . "{\"username\":\"" . $huname . "\",\"ipAddress\":\"" . $hip . "\",\"macAddress\":\"" . $hmac . "\",\"uptime\":\"" . $huptime . "\"},")
  }
  :local body ("{\"apiKey\":\"${apiKey}\",\"sessions\":[" . $sessions . $hssessions . "]}")
  /tool fetch url="${backendUrl}/router/sessions"${fetchFlags} \\
    http-method=post \\
    http-header-field="Content-Type: application/json" \\
    http-data=$body \\
    output=none keep-result=no
} comment="Dartbit session sync"

:log info "Dartbit: ZTP provisioning complete!"
:log info "Dartbit: PPPoE server active on ${bridge}"
:log info "Dartbit: Hotspot active on ${hsIface}"
:log info "Dartbit: Heartbeat sending every 15s"
`.trim();

  res.setHeader('Content-Type', 'text/plain');
  res.send(script);
});

// ─── POST /router/heartbeat ───────────────────────────────────────────────────
const heartbeatSchema = z.object({
  apiKey: z.string(),
  identity: z.string().optional(),
  cpuLoad: z.number().optional(),
  uptime: z.string().optional(),
});

router.post('/heartbeat', async (req: Request, res: Response) => {
  try {
    const parsed = heartbeatSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid heartbeat payload', 400);

    const { apiKey, identity, cpuLoad, uptime } = parsed.data;
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);

    await prisma.mikrotikRouter.update({
      where: { id: r.id },
      data: {
        status: 'ONLINE',
        lastSeenAt: new Date(),
        identity: identity ?? r.identity,
        cpuLoad: cpuLoad ?? r.cpuLoad,
        uptime: uptime ?? r.uptime,
      },
    });

    sendSuccess(res, { ok: true });
  } catch {
    sendError(res, 'Heartbeat failed', 500);
  }
});

// ─── POST /router/interfaces ──────────────────────────────────────────────────
const interfacesSchema = z.object({
  apiKey: z.string(),
  interfaces: z.array(z.object({
    name: z.string(),
    type: z.string(),
    macAddr: z.string().optional(),
    running: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })),
});

router.post('/interfaces', async (req: Request, res: Response) => {
  try {
    const parsed = interfacesSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid interfaces payload', 400);

    const { apiKey, interfaces } = parsed.data;
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);

    for (const iface of interfaces) {
      const ifaceId = `${r.id}${iface.name}`.replace(/[^a-zA-Z0-9]/g, '').substring(0, 25);
      await prisma.routerInterface.upsert({
        where: { id: ifaceId },
        create: {
          id: ifaceId,
          routerId: r.id,
          name: iface.name,
          type: iface.type,
          macAddr: iface.macAddr,
          running: iface.running ?? false,
          disabled: iface.disabled ?? false,
        },
        update: {
          type: iface.type,
          macAddr: iface.macAddr,
          running: iface.running ?? false,
          disabled: iface.disabled ?? false,
        },
      });
    }

    sendSuccess(res, { synced: interfaces.length });
  } catch {
    sendError(res, 'Interface sync failed', 500);
  }
});

// ─── POST /router/sessions ────────────────────────────────────────────────────
const sessionsSchema = z.object({
  apiKey: z.string(),
  sessions: z.array(z.object({
    username: z.string(),
    ipAddress: z.string().optional(),
    macAddress: z.string().optional(),
    uploadSpeed: z.number().optional(),
    downloadSpeed: z.number().optional(),
    uptime: z.string().optional(),
  })),
});

router.post('/sessions', async (req: Request, res: Response) => {
  try {
    const parsed = sessionsSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid sessions payload', 400);

    const { apiKey, sessions } = parsed.data;
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return sendError(res, 'Router not found', 404);

    await prisma.onlineSession.deleteMany({ where: { routerId: r.id } });

    for (const s of sessions) {
      const subscriber = await prisma.subscriber.findFirst({
        where: { username: s.username, tenantId: r.tenantId },
      });
      await prisma.onlineSession.create({
        data: {
          ...s,
          routerId: r.id,
          subscriberId: subscriber?.id,
          tenantId: r.tenantId,
        },
      });
      if (subscriber) {
        await prisma.subscriber.update({
          where: { id: subscriber.id },
          data: { lastOnlineAt: new Date() },
        });
      }
    }

    sendSuccess(res, { synced: sessions.length });
  } catch {
    sendError(res, 'Session sync failed', 500);
  }
});

// ─── POST /router/provision ───────────────────────────────────────────────────
// Save provisioning config for a router
const provisionSchema = z.object({
  wanInterface: z.string().optional(),
  lanInterface: z.string().optional(),
  bridgeName: z.string().optional(),
  lanSubnet: z.string().optional(),
  lanGateway: z.string().optional(),
  dhcpPoolStart: z.string().optional(),
  dhcpPoolEnd: z.string().optional(),
  dnsServers: z.string().optional(),
  pppoeEnabled: z.boolean().optional(),
  pppoeLocalAddress: z.string().optional(),
  pppoeRemotePool: z.string().optional(),
  pppoePoolStart: z.string().optional(),
  pppoePoolEnd: z.string().optional(),
  hotspotEnabled: z.boolean().optional(),
  hotspotInterface: z.string().optional(),
  hotspotDnsName: z.string().optional(),
  staticEnabled: z.boolean().optional(),
});

router.post('/provision/:routerId', async (req: Request, res: Response) => {
  try {
    const parsed = provisionSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);

    const config = await prisma.routerProvisioningConfig.upsert({
      where: { routerId: req.params.routerId },
      create: { routerId: req.params.routerId, ...parsed.data },
      update: parsed.data,
    });

    sendSuccess(res, config);
  } catch {
    sendError(res, 'Failed to save provisioning config', 500);
  }
});

// ─── GET /router/provision/:routerId ─────────────────────────────────────────
router.get('/provision/:routerId', async (req: Request, res: Response) => {
  try {
    const config = await prisma.routerProvisioningConfig.findUnique({
      where: { routerId: req.params.routerId },
    });
    sendSuccess(res, config);
  } catch {
    sendError(res, 'Failed to fetch provisioning config', 500);
  }
});

// ─── GET /router/pppoe-script?apiKey=... ─────────────────────────────────────
// Script to add/update a PPPoE subscriber on the router
router.get('/pppoe-script', async (req: Request, res: Response) => {
  const { apiKey, username, password, profile } = req.query;
  if (!apiKey || !username || !password) {
    return res.status(400).send('# Error: apiKey, username and password required');
  }

  const script = `
# Add/update PPPoE subscriber: ${username}
/ppp secret
remove [find name="${username}"]
add name="${username}" password="${password}" service=pppoe \\
    profile=${profile || 'dartbit-pppoe'} comment="Dartbit managed"
:log info "Dartbit: PPPoE user ${username} provisioned"
`.trim();

  res.setHeader('Content-Type', 'text/plain');
  res.send(script);
});

// ─── GET /router/hotspot-script?apiKey=... ────────────────────────────────────
router.get('/hotspot-script', async (req: Request, res: Response) => {
  const { apiKey, username, password, profile } = req.query;
  if (!apiKey || !username || !password) {
    return res.status(400).send('# Error: apiKey, username and password required');
  }

  const script = `
# Add/update Hotspot subscriber: ${username}
/ip hotspot user
remove [find name="${username}"]
add name="${username}" password="${password}" \\
    profile=${profile || 'dartbit-default'} comment="Dartbit managed"
:log info "Dartbit: Hotspot user ${username} provisioned"
`.trim();

  res.setHeader('Content-Type', 'text/plain');
  res.send(script);
});

export default router;
