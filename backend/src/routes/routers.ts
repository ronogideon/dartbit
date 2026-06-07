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
    const r = await prisma.mikrotikRouter.update({
      where: { id: req.params.id },
      data: parsed.data,
    });
    sendSuccess(res, r);
  } catch {
    sendError(res, 'Failed to update router', 500);
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const routerId = req.params.id;

    // Remove the VPN peer from the droplet first (best-effort) so a deleted router can't keep a
    // tunnel. Frees its 10.8.0.x for reuse.
    try {
      const { deprovisionRouterWg } = await import('../utils/wireguard');
      await deprovisionRouterWg(routerId);
    } catch (e) {
      console.error('Router delete: VPN deprovision failed (continuing):', e instanceof Error ? e.message : e);
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
    const cmdId = await enqueueCommand(r.id, ztpScript);
    console.log(`[reprovision] queued ZTP (${ztpScript.length} chars) for router ${r.id} (${r.name}), command id=${cmdId}`);

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
    sendError(res, err instanceof Error ? err.message : 'VPN provisioning failed', 500);
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

export default router;
