import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

// Helper to find router by apiKey
async function findRouter(apiKey: string) {
  return prisma.mikrotikRouter.findUnique({ where: { apiKey } });
}

// GET /router/ztp-script?apiKey=...
// Returns a RouterOS script for the router to self-configure
router.get('/ztp-script', async (req: Request, res: Response) => {
  const { apiKey } = req.query;
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).send('# Error: apiKey is required');
  }

  const mikrotikRouter = await findRouter(apiKey);
  if (!mikrotikRouter) {
    return res.status(404).send('# Error: Router not found');
  }

  const backendUrl = process.env.BACKEND_URL || 'http://localhost:4000';

  // RouterOS script — no :global used
  const script = `
# Dartbit ZTP Script
# Router: ${mikrotikRouter.name}
# Generated: ${new Date().toISOString()}

/system scheduler
add name="dartbit-heartbeat" interval=15s on-event={
  :local identity [/system identity get name];
  :local cpu [/system resource get cpu-load];
  :local uptime [/system resource get uptime];
  /tool fetch url="${backendUrl}/router/heartbeat" \\
    http-method=post \\
    http-header-field="Content-Type: application/json" \\
    http-data="{\\\"apiKey\\\":\\\"${apiKey}\\\",\\\"identity\\\":\\\"$identity\\\",\\\"cpuLoad\\\":$cpu,\\\"uptime\\\":\\\"$uptime\\\"}" \\
    output=none;
} comment="Dartbit heartbeat";

/system scheduler
add name="dartbit-interfaces" interval=5m on-event={
  :local ifaces "";
  :foreach i in=[/interface find] do={
    :local name [/interface get $i name];
    :local type [/interface get $i type];
    :local running [/interface get $i running];
    :local disabled [/interface get $i disabled];
    :local mac "";
    :do { :set mac [/interface get $i mac-address]; } on-error={};
    :set ifaces ($ifaces . "{\\\"name\\\":\\\"" . $name . "\\\",\\\"type\\\":\\\"" . $type . "\\\",\\\"macAddr\\\":\\\"" . $mac . "\\\",\\\"running\\\":" . $running . ",\\\"disabled\\\":" . $disabled . "},");
  };
  /tool fetch url="${backendUrl}/router/interfaces" \\
    http-method=post \\
    http-header-field="Content-Type: application/json" \\
    http-data="{\\\"apiKey\\\":\\\"${apiKey}\\\",\\\"interfaces\\\":[$ifaces]}" \\
    output=none;
} comment="Dartbit interface sync";

:log info "Dartbit ZTP script loaded successfully";
`.trim();

  res.setHeader('Content-Type', 'text/plain');
  res.send(script);
});

// POST /router/heartbeat
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
    const mikrotikRouter = await findRouter(apiKey);
    if (!mikrotikRouter) return sendError(res, 'Router not found', 404);

    await prisma.mikrotikRouter.update({
      where: { id: mikrotikRouter.id },
      data: {
        status: 'ONLINE',
        lastSeenAt: new Date(),
        identity: identity ?? mikrotikRouter.identity,
        cpuLoad: cpuLoad ?? mikrotikRouter.cpuLoad,
        uptime: uptime ?? mikrotikRouter.uptime,
      },
    });

    sendSuccess(res, { ok: true });
  } catch {
    sendError(res, 'Heartbeat failed', 500);
  }
});

// POST /router/interfaces
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
    const mikrotikRouter = await findRouter(apiKey);
    if (!mikrotikRouter) return sendError(res, 'Router not found', 404);

    // Upsert each interface
    for (const iface of interfaces) {
      await prisma.routerInterface.upsert({
        where: {
          id: `${mikrotikRouter.id}-${iface.name}`.replace(/[^a-zA-Z0-9]/g, ''),
        },
        create: {
          id: `${mikrotikRouter.id}-${iface.name}`.replace(/[^a-zA-Z0-9]/g, ''),
          routerId: mikrotikRouter.id,
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

export default router;
