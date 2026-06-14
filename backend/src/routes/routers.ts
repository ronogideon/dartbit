import { Router, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

const routerSchema = z.object({
  name: z.string().min(2),
  host: z.string().optional().default('auto'),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};
    const routers = await prisma.mikrotikRouter.findMany({
      where,
      include: { interfaces: true, provConfig: true },
      orderBy: { createdAt: 'desc' },
    });
    sendSuccess(res, routers);
  } catch {
    sendError(res, 'Failed to fetch routers', 500);
  }
});

router.post('/link', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = routerSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);

    const apiKey = uuidv4();
    let backendUrl = process.env.BACKEND_URL || 'https://api.dartbittech.com';
    // Normalize to always-https (strip any/no protocol, force https). MikroTik /tool fetch
    // requires mode=https and won't follow redirects, so the URL and flags must be https.
    backendUrl = backendUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (backendUrl.includes('localhost') || backendUrl.includes('127.0.0.1')) {
      backendUrl = 'api.dartbittech.com';
    }
    backendUrl = 'https://' + backendUrl;

    const mikrotikRouter = await prisma.mikrotikRouter.create({
      data: {
        ...parsed.data,
        apiKey,
        tenantId,
        status: 'UNKNOWN',
        setupStage: 'AWAITING_HEARTBEAT',
      },
    });

    // Bootstrap fetch — always include mode=https (RouterOS errors "Mode not specified" without it).
    const fetchFlags = ' mode=https check-certificate=no';
    const bootstrapCommand = `/tool fetch url="${backendUrl}/router/ztp-script?apiKey=${apiKey}" dst-path=dartbit-ztp.rsc${fetchFlags}; /import file-name=dartbit-ztp.rsc`;

    sendSuccess(res, {
      routerId: mikrotikRouter.id,
      apiKey,
      bootstrapCommand,
    }, 201);
  } catch {
    sendError(res, 'Failed to link router', 500);
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = routerSchema.partial().safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);
    const before = await prisma.mikrotikRouter.findUnique({ where: { id: req.params.id }, select: { name: true } });
    const r = await prisma.mikrotikRouter.update({
      where: { id: req.params.id },
      data: parsed.data,
    });
    // If the name changed, immediately reflect it on the router: set the MikroTik identity to match
    // (one unified name) and refresh the RADIUS client (keyed by stable id, so this just rewrites the
    // drop-in with the current IP/secret — no orphaned client). Best-effort, non-blocking.
    if (parsed.data.name && before && parsed.data.name !== before.name) {
      (async () => {
        try {
          const identity = parsed.data.name!.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'dartbit';
          const { enqueueCommand } = await import('../utils/commandQueue');
          await enqueueCommand(r.id, `/system identity set name="${identity}"`);
          const { radiusConfigured, registerRadiusClient } = await import('../utils/radius');
          if (radiusConfigured() && r.wgIp && (r as { radiusSecret?: string }).radiusSecret) {
            await registerRadiusClient(r.id, r.wgIp, (r as { radiusSecret?: string }).radiusSecret!);
          }
        } catch (e) {
          console.error('rename hook failed:', e instanceof Error ? e.message : e);
        }
      })();
    }
    sendSuccess(res, r);
  } catch {
    sendError(res, 'Failed to update router', 500);
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const routerId = req.params.id;

    // Remove the VPN peer from the droplet first (best-effort) so a deleted router can't keep a
    // tunnel. Frees its 10.8.0.x for reuse. Also drop its FreeRADIUS client drop-in.
    try {
      const { deprovisionRouterWg } = await import('../utils/wireguard');
      await deprovisionRouterWg(routerId);
    } catch (e) {
      console.error('Router delete: VPN deprovision failed (continuing):', e instanceof Error ? e.message : e);
    }
    try {
      const { unregisterRadiusClient } = await import('../utils/radius');
      await unregisterRadiusClient(routerId);
    } catch (e) {
      console.error('Router delete: RADIUS client removal failed (continuing):', e instanceof Error ? e.message : e);
    }

    // Remove ALL data tied to this router to keep server storage low. Session history and
    // usage (SessionRecord), live sessions, the command queue, interfaces and provisioning
    // config are deleted. Subscribers are unlinked (not deleted — they may move to another
    // router). MpesaTransaction rows are financial records: we keep them but unlink the router.
    await prisma.$transaction([
      prisma.onlineSession.deleteMany({ where: { routerId } }),
      prisma.sessionRecord.deleteMany({ where: { routerId } }),
      prisma.routerCommand.deleteMany({ where: { routerId } }),
      prisma.routerInterface.deleteMany({ where: { routerId } }),
      prisma.routerProvisioningConfig.deleteMany({ where: { routerId } }),
      prisma.mpesaTransaction.updateMany({ where: { routerId }, data: { routerId: null } }),
      prisma.subscriber.updateMany({ where: { routerId }, data: { routerId: null } }),
      prisma.mikrotikRouter.delete({ where: { id: routerId } }),
    ]);

    sendSuccess(res, { deleted: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to delete router';
    console.error('Delete router error:', msg);
    sendError(res, msg, 500);
  }
});

// POST /mikrotiks/:id/reboot — queue a reboot command for the router
router.post('/:id/reboot', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const r = await prisma.mikrotikRouter.findUnique({ where: { id: req.params.id } });
    if (!r) return sendError(res, 'Router not found', 404);
    if (tenantId && r.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);

    const { enqueueCommand } = await import('../utils/commandQueue');
    await enqueueCommand(r.id, ':log info "Dartbit: Remote reboot in 5s"; :delay 5s; /system reboot');

    sendSuccess(res, { queued: true, message: 'Reboot scheduled (executes within 30 seconds)' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to queue reboot';
    sendError(res, msg, 500);
  }
});

// POST /mikrotiks/:id/command — run arbitrary RouterOS command
router.post('/:id/command', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const { command } = req.body;
    if (!command) return sendError(res, 'command required', 400);

    const r = await prisma.mikrotikRouter.findUnique({ where: { id: req.params.id } });
    if (!r) return sendError(res, 'Router not found', 404);
    if (tenantId && r.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);

    const { enqueueCommand } = await import('../utils/commandQueue');
    await enqueueCommand(r.id, command);

    sendSuccess(res, { queued: true });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /mikrotiks/:id/winbox/open — open remote Winbox access to this router.
// Assigns a stable public port (once), opens a DNAT on the droplet (public port -> 10.8.0.x:8291),
// and sets a 2h auto-close. Tenants then point Winbox at <winboxHost>:<port> — no VPN client needed.
const WINBOX_PORT_BASE = 21000;
const WINBOX_PORT_MAX = 21999; // 1000 routers; widen the range when you outgrow it
const WINBOX_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

router.post('/:id/winbox/open', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const r = await prisma.mikrotikRouter.findUnique({ where: { id: req.params.id } });
    if (!r) return sendError(res, 'Router not found', 404);
    if (tenantId && r.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);
    if (!r.wgIp) return sendError(res, 'This router has no VPN address yet — provision it first.', 400);

    const { winboxHost, openWinboxPort } = await import('../utils/wireguard');

    // Assign a stable port on first use: the lowest free one in the range.
    let port = r.winboxPort ?? null;
    if (!port) {
      const used = new Set(
        (await prisma.mikrotikRouter.findMany({ where: { winboxPort: { not: null } }, select: { winboxPort: true } }))
          .map(x => x.winboxPort as number),
      );
      for (let p = WINBOX_PORT_BASE; p <= WINBOX_PORT_MAX; p++) { if (!used.has(p)) { port = p; break; } }
      if (!port) return sendError(res, 'No free Winbox ports left — widen the range.', 500);
    }

    await openWinboxPort(port, r.wgIp);
    const openUntil = new Date(Date.now() + WINBOX_TTL_MS);
    await prisma.mikrotikRouter.update({ where: { id: r.id }, data: { winboxPort: port, winboxOpenUntil: openUntil } });

    sendSuccess(res, {
      host: winboxHost,
      port,
      address: `${winboxHost}:${port}`,
      expiresAt: openUntil,
      message: `Open Winbox and connect to ${winboxHost}:${port} (closes ${openUntil.toLocaleTimeString()}).`,
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed to open Winbox access', 500);
  }
});

// POST /mikrotiks/:id/winbox/close — close remote Winbox access now.
router.post('/:id/winbox/close', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const r = await prisma.mikrotikRouter.findUnique({ where: { id: req.params.id } });
    if (!r) return sendError(res, 'Router not found', 404);
    if (tenantId && r.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);

    if (r.winboxPort) {
      const { closeWinboxPort } = await import('../utils/wireguard');
      await closeWinboxPort(r.winboxPort);
    }
    await prisma.mikrotikRouter.update({ where: { id: r.id }, data: { winboxOpenUntil: null } });
    sendSuccess(res, { closed: true });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed to close Winbox access', 500);
  }
});

// GET /mikrotiks/:id/ztp-command — get the fetch+import command for an EXISTING router
// Used for reprovisioning without creating a new router
router.get('/:id/ztp-command', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const r = await prisma.mikrotikRouter.findUnique({ where: { id: req.params.id } });
    if (!r) return sendError(res, 'Router not found', 404);
    if (tenantId && r.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);

    let backendUrl = process.env.BACKEND_URL || 'https://api.dartbittech.com';
    backendUrl = backendUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (backendUrl.includes('localhost') || backendUrl.includes('127.0.0.1')) {
      backendUrl = 'api.dartbittech.com';
    }
    backendUrl = 'https://' + backendUrl;
    const fetchFlags = ' mode=https check-certificate=no';

    const command = `/tool fetch url="${backendUrl}/router/ztp-script?apiKey=${r.apiKey}" dst-path=dartbit-ztp.rsc${fetchFlags}; /import file-name=dartbit-ztp.rsc`;

    sendSuccess(res, { command, apiKey: r.apiKey });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /mikrotiks/:id/reprovision — queue the reprovision command to the router directly
router.post('/:id/reprovision', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const r = await prisma.mikrotikRouter.findUnique({ where: { id: req.params.id } });
    if (!r) return sendError(res, 'Router not found', 404);
    if (tenantId && r.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);
    if (r.status !== 'ONLINE') return sendError(res, 'Router must be online to reprovision remotely', 400);

    // Reprovision by delivering the FULL ZTP script directly through the command queue.
    // The router's dartbit-cmd already fetches /router/commands and imports it (proven to
    // work). So instead of telling the router to fetch the ztp itself (which failed because
    // a bare imported fetch loses its url quoting), we put the entire ztp script — same
    // content, same embedded apiKey — straight into the queue. The router imports it
    // directly: no second fetch, no scheduler, nothing to break.
    const { generateZtpScript } = await import('./routerZtp');
    const ztpScript = await generateZtpScript(r.apiKey, { skipCmdScript: true });

    const { enqueueCommand } = await import('../utils/commandQueue');
    // Replace any previously-queued-but-unconsumed ZTP for this router so tapping reprovision
    // multiple times can't stack 19KB scripts into one oversized, un-importable blob. We match the
    // ZTP by its unique start marker, leaving small one-off commands (e.g. subscriber enables) intact.
    const purged = await prisma.routerCommand.deleteMany({
      where: { routerId: r.id, consumed: false, command: { contains: 'Dartbit: Starting provisioning' } },
    });
    const cmdId = await enqueueCommand(r.id, ztpScript);
    console.log(`[reprovision] queued ZTP (${ztpScript.length} chars) for router ${r.id} (${r.name}), command id=${cmdId}, purged ${purged.count} stale`);

    sendSuccess(res, { queued: true, commandId: cmdId, message: 'Reprovision queued — the router will apply it within ~10 seconds.' });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /mikrotiks/:id/identity — change router identity (the system name on RouterOS)
router.post('/:id/identity', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const { identity } = req.body;

    // Sanitize: RouterOS identity is alphanumeric with -_.
    if (!identity || typeof identity !== 'string') return sendError(res, 'identity required', 400);
    const clean = identity.replace(/[^a-zA-Z0-9\-_\.]/g, '').substring(0, 50);
    if (!clean) return sendError(res, 'Invalid identity (use letters, numbers, -_.)', 400);

    const r = await prisma.mikrotikRouter.findUnique({ where: { id: req.params.id } });
    if (!r) return sendError(res, 'Router not found', 404);
    if (tenantId && r.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);

    const { enqueueCommand } = await import('../utils/commandQueue');
    await enqueueCommand(r.id, `/system identity set name="${clean}"`);

    // Save to DB so it persists in the UI; the stats reporter will also pick it up
    await prisma.mikrotikRouter.update({
      where: { id: r.id },
      data: { identity: clean },
    });

    sendSuccess(res, { queued: true, identity: clean });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /:id/link-status — polled by the link wizard. Returns the setup stage, online status,
// and (once available) the reported interface list so the tenant can pick bridge ports.
router.get('/:id/link-status', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const r = await prisma.mikrotikRouter.findUnique({
      where: { id: req.params.id },
      include: { interfaces: true },
    });
    if (!r) return sendError(res, 'Router not found', 404);
    if (tenantId && r.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);
    sendSuccess(res, {
      stage: r.setupStage,
      status: r.status,
      identity: r.identity,
      lastSeenAt: r.lastSeenAt,
      interfaces: r.interfaces
        .filter(i => i.type === 'ether' || i.type === 'wlan' || i.type === 'vlan')
        .map(i => ({ name: i.name, type: i.type })),
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

router.post('/:id/lan-ports', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const { ports } = req.body;

    if (!Array.isArray(ports)) return sendError(res, 'ports must be an array', 400);
    const cleanPorts: string[] = ports
      .filter((p): p is string => typeof p === 'string')
      .map(p => p.trim().replace(/[^a-zA-Z0-9\-_]/g, ''))
      .filter(Boolean);

    if (cleanPorts.length === 0) return sendError(res, 'At least one port required', 400);

    const r = await prisma.mikrotikRouter.findUnique({
      where: { id: req.params.id },
      include: { provConfig: true },
    });
    if (!r) return sendError(res, 'Router not found', 404);
    if (tenantId && r.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);

    const lanCsv = cleanPorts.join(',');
    const bridge = r.provConfig?.bridgeName || 'bridge-lan';

    // Update saved config
    await prisma.routerProvisioningConfig.upsert({
      where: { routerId: r.id },
      create: { routerId: r.id, lanInterface: lanCsv },
      update: { lanInterface: lanCsv },
    });

    // Build commands. Each is a single self-contained line (the command queue
    // runs them via /import, so we avoid the [:find (list) x] syntax which is invalid).
    const cmds: string[] = [];
    // 1. Remove ports from THIS bridge that aren't in the desired list.
    //    Build a RouterOS array of desired interface names and check membership.
    const desiredArray = cleanPorts.map(p => `"${p}"`).join(';');
    cmds.push(`:local want {${desiredArray}}`);
    cmds.push(`:foreach p in=[/interface bridge port find bridge="${bridge}"] do={ :local nm [/interface bridge port get $p interface]; :local keep false; :foreach w in=$want do={ :if ($nm = $w) do={ :set keep true } }; :if (!$keep) do={ /interface bridge port remove $p } }`);
    // 2. For each desired port: move from any other bridge, then add to ours if missing.
    for (const port of cleanPorts) {
      cmds.push(`:foreach p in=[/interface bridge port find interface="${port}"] do={ :if ([/interface bridge port get $p bridge] != "${bridge}") do={ /interface bridge port remove $p } }`);
      cmds.push(`:if ([:len [/interface bridge port find interface="${port}" bridge="${bridge}"]] = 0 && [:len [/interface find name="${port}"]] > 0) do={ /interface bridge port add bridge=${bridge} interface=${port} comment="Dartbit LAN port" }`);
    }
    cmds.push(`:log info "Dartbit: LAN ports updated"`);
    const cmd = cmds.join('\n');

    const { enqueueCommand } = await import('../utils/commandQueue');
    await enqueueCommand(r.id, cmd);

    // Port selection is the final setup step — mark setup complete.
    await prisma.mikrotikRouter.update({ where: { id: r.id }, data: { setupStage: 'COMPLETE' } });

    sendSuccess(res, { queued: true, ports: cleanPorts });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /mikrotiks/:id/vpn/provision — assign a VPN IP + keypair and register the peer on the
// droplet. Returns the MikroTik config the router runs once to join the management VPN.
router.post('/:id/vpn/provision', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const router_ = await prisma.mikrotikRouter.findFirst({ where: { id: req.params.id, ...(tenantId ? { tenantId } : {}) } });
    if (!router_) return sendError(res, 'Router not found', 404);
    const { wgConfigured, provisionRouterWg, buildMikrotikWgConfig } = await import('../utils/wireguard');
    if (!wgConfigured()) return sendError(res, 'VPN is not configured on the server yet', 400);
    const result = await provisionRouterWg(router_.id);
    // Decrypt the private key just to render the one-time router config (not stored in the response log).
    const fresh = await prisma.mikrotikRouter.findUnique({ where: { id: router_.id } });
    const { decryptApiKey } = await import('../utils/blessedtexts');
    const privPlain = fresh?.wgPrivateKey ? decryptApiKey(fresh.wgPrivateKey) : '';
    const mikrotikConfig = buildMikrotikWgConfig({ wgIp: result.wgIp, privateKey: privPlain });
    sendSuccess(res, { wgIp: result.wgIp, endpoint: result.endpoint, mikrotikConfig });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'VPN provisioning failed';
    console.error('[vpn] provision error:', msg);
    sendError(res, `VPN setup failed: ${msg}`, 500);
  }
});

// GET /mikrotiks/:id/vpn — VPN status + the one-time router config (owner tenant only). Keys are
// NOT exposed except inside the router config block (which the tenant needs once to join).
router.get('/:id/vpn', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const router_ = await prisma.mikrotikRouter.findFirst({ where: { id: req.params.id, ...(tenantId ? { tenantId } : {}) } });
    if (!router_) return sendError(res, 'Router not found', 404);
    const { wgEnv, buildMikrotikWgConfig } = await import('../utils/wireguard');
    let mikrotikConfig: string | null = null;
    if (router_.wgIp && router_.wgPrivateKey) {
      const { decryptApiKey } = await import('../utils/blessedtexts');
      mikrotikConfig = buildMikrotikWgConfig({ wgIp: router_.wgIp, privateKey: decryptApiKey(router_.wgPrivateKey) });
    }
    // "VPN online" = a handshake within the last ~3 minutes.
    const online = router_.wgLastHandshake ? (Date.now() - new Date(router_.wgLastHandshake).getTime() < 3 * 60 * 1000) : false;
    sendSuccess(res, {
      provisioned: !!router_.wgIp,
      wgIp: router_.wgIp,
      endpoint: wgEnv.endpoint,
      vpnOnline: online,
      lastHandshake: router_.wgLastHandshake,
      mikrotikConfig,
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /mikrotiks/vpn/diagnose — tells us exactly which link in the VPN chain fails.
router.get('/vpn/diagnose', async (_req: AuthRequest, res: Response) => {
  try {
    const { diagnoseWg } = await import('../utils/wireguard');
    const report = await diagnoseWg();
    sendSuccess(res, report);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /mikrotiks/:id/radius — enable/disable RADIUS on a router + set its shared secret (for the
// PPPoE-over-RADIUS pilot). Body: { enabled: boolean, secret?: string }.
router.post('/:id/radius', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const router_ = await prisma.mikrotikRouter.findFirst({ where: { id: req.params.id, ...(tenantId ? { tenantId } : {}) } });
    if (!router_) return sendError(res, 'Router not found', 404);
    const enabled = !!req.body?.enabled;
    const secret = typeof req.body?.secret === 'string' ? req.body.secret.trim() : undefined;
    await prisma.mikrotikRouter.update({
      where: { id: router_.id },
      data: { radiusEnabled: enabled, ...(secret ? { radiusSecret: secret } : {}) } as never,
    });
    // Auto-register the router as a FreeRADIUS client (graceful reload, no manual restart needed).
    try {
      const r = await prisma.mikrotikRouter.findUnique({ where: { id: router_.id }, select: { wgIp: true, radiusSecret: true, name: true } as never }) as never as { wgIp?: string; radiusSecret?: string; name?: string };
      const { registerRadiusClient, unregisterRadiusClient } = await import('../utils/radius');
      if (enabled && r?.wgIp && r?.radiusSecret) {
        await registerRadiusClient(router_.id, r.wgIp, r.radiusSecret);

        // Also push the ROUTER-SIDE RADIUS config so the full path is automatic (no manual .rsc).
        // TWO entries are required because MikroTik sets the request's called-id to the SERVICE name:
        // PPPoE sends called-id=dartbit, but the hotspot sends its server name (dartbit-hotspot). A
        // single entry can only carry one called-id, so hotspot logins would find "no radius server".
        // Both entries share the SAME secret (= the one we register in clients.conf) and src-address
        // = the router's real VPN IP, so packets egress WireGuard and FreeRADIUS recognises the client.
        try {
          const { wgEnv } = await import('../utils/wireguard');
          const serverIp = `${(wgEnv.subnet || '10.8.0.0/24').split('/')[0].split('.').slice(0, 3).join('.')}.1`;
          const sec = r.radiusSecret.replace(/"/g, '');
          const cmds = [
            // Clean any prior Dartbit entries first so re-running can't duplicate or leave stale ones.
            `:foreach x in=[/radius find where comment~"Dartbit RADIUS"] do={ /radius remove $x }`,
            `/radius add service=ppp address=${serverIp} secret="${sec}" called-id=dartbit src-address=${r.wgIp} timeout=3s comment="Dartbit RADIUS"`,
            `/radius add service=hotspot address=${serverIp} secret="${sec}" called-id=dartbit-hotspot src-address=${r.wgIp} timeout=3s comment="Dartbit RADIUS Hotspot"`,
            `/radius incoming set accept=yes port=3799`,
            `/ppp aaa set use-radius=yes`,
            // Scope to the Dartbit hotspot profile ONLY — never touch centipid/default profiles.
            `:foreach p in=[/ip hotspot profile find where name="hsprof-dartbit"] do={ /ip hotspot profile set $p use-radius=yes login-by=mac,cookie,http-chap,http-pap radius-accounting=yes radius-interim-update=1m }`,
            `:log info "Dartbit: RADIUS configured (server ${serverIp}, src ${r.wgIp}, ppp+hotspot)"`,
          ].join('\n');
          const { enqueueCommand } = await import('../utils/commandQueue');
          await enqueueCommand(router_.id, cmds);
        } catch (e2) {
          console.error('router-side RADIUS config push failed:', e2 instanceof Error ? e2.message : e2);
        }
      } else if (!enabled && r?.wgIp) {
        await unregisterRadiusClient(router_.id);
        // Revert the router to local auth so it keeps working off RADIUS.
        try {
          const { enqueueCommand } = await import('../utils/commandQueue');
          await enqueueCommand(router_.id, [
            `/ppp aaa set use-radius=no`,
            `:foreach p in=[/ip hotspot profile find where name="hsprof-dartbit"] do={ /ip hotspot profile set $p use-radius=no }`,
            `:foreach x in=[/radius find where comment~"Dartbit RADIUS"] do={ /radius remove $x }`,
            `:log info "Dartbit: RADIUS disabled, reverted to local auth"`,
          ].join('\n'));
        } catch { /* best-effort */ }
      }
    } catch (e) {
      console.error('radius client registration failed:', e instanceof Error ? e.message : e);
    }
    sendSuccess(res, { radiusEnabled: enabled, hasSecret: !!(secret || (router_ as never as { radiusSecret?: string }).radiusSecret) });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /mikrotiks/radius/bulk-sync — push all entitled PPPoE subscribers (this tenant, or a given
// router) into RADIUS. Use once to migrate existing customers before enabling RADIUS on the router.
router.post('/radius/bulk-sync', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const routerId = typeof req.body?.routerId === 'string' ? req.body.routerId : undefined;
    const { radiusConfigured, bulkSyncPppoeToRadius } = await import('../utils/radius');
    if (!radiusConfigured()) return sendError(res, 'RADIUS not configured/enabled', 400);
    const result = await bulkSyncPppoeToRadius({ tenantId: tenantId || undefined, routerId });
    sendSuccess(res, result);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Bulk sync failed', 500);
  }
});

// POST /mikrotiks/radius/bulk-sync — one-time migration: push existing PPPoE subscribers into
// RADIUS. Body: { allRouters?: boolean } (default false = only RADIUS-enabled routers).
router.post('/radius/bulk-sync', async (req: AuthRequest, res: Response) => {
  try {
    const { radiusConfigured, bulkSyncPppoeToRadius } = await import('../utils/radius');
    if (!radiusConfigured()) return sendError(res, 'RADIUS not configured/enabled', 400);
    const tenantId = req.user?.tenantId;
    const routerId = typeof req.body?.routerId === 'string' ? req.body.routerId : undefined;
    const result = await bulkSyncPppoeToRadius({ ...(tenantId ? { tenantId } : {}), ...(routerId ? { routerId } : {}) });
    sendSuccess(res, result);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Bulk sync failed', 500);
  }
});

// POST /mikrotiks/radius/bulk-sync-hotspot — migrate existing HOTSPOT subscribers (D-name + MAC)
// on RADIUS-enabled routers into FreeRADIUS. Run once when cutting a router over to RADIUS.
router.post('/radius/bulk-sync-hotspot', async (req: AuthRequest, res: Response) => {
  try {
    const { radiusConfigured, bulkSyncHotspotToRadius } = await import('../utils/radius');
    if (!radiusConfigured()) return sendError(res, 'RADIUS not configured/enabled', 400);
    const tenantId = req.user?.tenantId;
    const routerId = typeof req.body?.routerId === 'string' ? req.body.routerId : undefined;
    const result = await bulkSyncHotspotToRadius({ ...(tenantId ? { tenantId } : {}), ...(routerId ? { routerId } : {}) });
    sendSuccess(res, result);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Bulk hotspot sync failed', 500);
  }
});

// POST /mikrotiks/radius/bulk-sync-vouchers — migrate existing (unredeemed + active) vouchers on
// RADIUS-enabled routers into FreeRADIUS. MPESA receipt vouchers are skipped (handled via the
// subscriber's MAC/D-name rows).
router.post('/radius/bulk-sync-vouchers', async (req: AuthRequest, res: Response) => {
  try {
    const { radiusConfigured, bulkSyncVouchersToRadius } = await import('../utils/radius');
    if (!radiusConfigured()) return sendError(res, 'RADIUS not configured/enabled', 400);
    const tenantId = req.user?.tenantId;
    const routerId = typeof req.body?.routerId === 'string' ? req.body.routerId : undefined;
    const result = await bulkSyncVouchersToRadius({ ...(tenantId ? { tenantId } : {}), ...(routerId ? { routerId } : {}) });
    sendSuccess(res, result);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Bulk voucher sync failed', 500);
  }
});

// GET /mikrotiks/radius/diagnose — confirms the backend can reach RADIUS Postgres over SSH.
router.get('/radius/diagnose', async (_req: AuthRequest, res: Response) => {
  try {
    const { diagnoseRadius } = await import('../utils/radius');
    sendSuccess(res, await diagnoseRadius());
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export default router;
