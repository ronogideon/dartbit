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
    let backendUrl = process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app';

    // Force HTTPS for Railway URLs (Railway redirects HTTP -> HTTPS but MikroTik /tool fetch doesn't follow redirects)
    if (backendUrl.startsWith('http://') && backendUrl.includes('railway.app')) {
      backendUrl = backendUrl.replace('http://', 'https://');
    }
    // If localhost is detected, use Railway URL instead (MikroTik can't reach localhost from the internet)
    if (backendUrl.includes('localhost') || backendUrl.includes('127.0.0.1')) {
      backendUrl = 'https://dartbit-production.up.railway.app';
    }

    const mikrotikRouter = await prisma.mikrotikRouter.create({
      data: {
        ...parsed.data,
        apiKey,
        tenantId,
        status: 'UNKNOWN',
      },
    });

    // Build bootstrap with proper HTTPS flags so MikroTik handles Railway's TLS correctly
    const isHttps = backendUrl.startsWith('https://');
    const fetchFlags = isHttps ? ' mode=https check-certificate=no' : '';
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

    // Delete related records first (no schema cascade is set on Subscriber/OnlineSession FKs)
    await prisma.$transaction([
      prisma.onlineSession.deleteMany({ where: { routerId } }),
      prisma.routerInterface.deleteMany({ where: { routerId } }),
      prisma.routerProvisioningConfig.deleteMany({ where: { routerId } }),
      // Unlink subscribers (don't delete them — just remove the router link)
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
    enqueueCommand(r.id, ':log info "Dartbit: Remote reboot in 5s"; :delay 5s; /system reboot');

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
    enqueueCommand(r.id, command);

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

    let backendUrl = process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app';
    if (backendUrl.startsWith('http://') && backendUrl.includes('railway.app')) {
      backendUrl = backendUrl.replace('http://', 'https://');
    }
    if (backendUrl.includes('localhost') || backendUrl.includes('127.0.0.1')) {
      backendUrl = 'https://dartbit-production.up.railway.app';
    }
    const isHttps = backendUrl.startsWith('https://');
    const fetchFlags = isHttps ? ' mode=https check-certificate=no' : '';

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

    let backendUrl = process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app';
    if (backendUrl.startsWith('http://') && backendUrl.includes('railway.app')) {
      backendUrl = backendUrl.replace('http://', 'https://');
    }
    if (backendUrl.includes('localhost') || backendUrl.includes('127.0.0.1')) {
      backendUrl = 'https://dartbit-production.up.railway.app';
    }
    const isHttps = backendUrl.startsWith('https://');
    const fetchFlags = isHttps ? ' mode=https check-certificate=no' : '';

    const command = `:log info "Dartbit: Reprovisioning"; /tool fetch url="${backendUrl}/router/ztp-script?apiKey=${r.apiKey}" dst-path=dartbit-ztp.rsc${fetchFlags}; :delay 2s; /import file-name=dartbit-ztp.rsc; :delay 2s; /file remove [find name="dartbit-ztp.rsc"]`;

    const { enqueueCommand } = await import('../utils/commandQueue');
    enqueueCommand(r.id, command);

    sendSuccess(res, { queued: true, message: 'Reprovision will start within 30 seconds' });
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
    enqueueCommand(r.id, `/system identity set name="${clean}"`);

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

// POST /mikrotiks/:id/reprovision — returns the bootstrap command for this router so user can re-run it
router.post('/:id/reprovision', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const r = await prisma.mikrotikRouter.findUnique({ where: { id: req.params.id } });
    if (!r) return sendError(res, 'Router not found', 404);
    if (tenantId && r.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);

    let backendUrl = process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app';
    if (backendUrl.startsWith('http://') && backendUrl.includes('railway.app')) {
      backendUrl = backendUrl.replace('http://', 'https://');
    }
    if (backendUrl.includes('localhost') || backendUrl.includes('127.0.0.1')) {
      backendUrl = 'https://dartbit-production.up.railway.app';
    }
    const isHttps = backendUrl.startsWith('https://');
    const fetchFlags = isHttps ? ' mode=https check-certificate=no' : '';

    const bootstrapCommand = `/tool fetch url="${backendUrl}/router/ztp-script?apiKey=${r.apiKey}" dst-path=dartbit-ztp.rsc${fetchFlags}; /import file-name=dartbit-ztp.rsc`;

    // Also queue the reprovision so the router can pick it up automatically if it's online
    const { enqueueCommand } = await import('../utils/commandQueue');
    enqueueCommand(r.id, bootstrapCommand);

    sendSuccess(res, {
      bootstrapCommand,
      apiKey: r.apiKey,
      queued: true,
      message: 'Reprovision queued — router will fetch the updated script within 30 seconds. You can also run the command manually below.',
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

    // Build a command that:
    // 1. Removes any port from this bridge that isn't in the new list
    // 2. Adds any new ports that aren't already on this bridge
    // 3. Bumps the hotspot interface so it picks up the new bridge membership
    const desiredQuoted = cleanPorts.map(p => `"${p}"`).join(',');
    const cmd = [
      `# Update LAN ports on bridge ${bridge}`,
      `:foreach p in=[/interface bridge port find bridge="${bridge}"] do={ :local iname [/interface bridge port get $p interface]; :if ([:len [:find (${desiredQuoted}) $iname]] = 0) do={ /interface bridge port remove $p } }`,
      ...cleanPorts.map(port =>
        `:if ([:len [/interface bridge port find interface="${port}"]] = 0 && [:len [/interface find name="${port}"]] > 0) do={ /interface bridge port add bridge=${bridge} interface=${port} comment="Dartbit LAN port" }`
      ),
      // Bump hotspot so it re-binds and intercepts traffic from the new port
      `:foreach h in=[/ip hotspot find interface="${bridge}"] do={ /ip hotspot disable $h; :delay 500ms; /ip hotspot enable $h }`,
      `:log info "Dartbit: LAN ports updated, hotspot re-bound"`,
    ].join('\n');

    const { enqueueCommand } = await import('../utils/commandQueue');
    enqueueCommand(r.id, cmd);

    sendSuccess(res, { queued: true, ports: cleanPorts });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export default router;
