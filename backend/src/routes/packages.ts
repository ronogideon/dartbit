import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

const packageSchema = z.object({
  name: z.string().min(2),
  service: z.enum(['PPPOE', 'HOTSPOT', 'STATIC']).default('PPPOE'),
  speedUpKbps: z.number().int().min(1),
  speedDownKbps: z.number().int().min(1),
  validityMinutes: z.number().int().min(1),
  price: z.number().min(0),
  isTrial: z.boolean().optional().default(false),
  routerIds: z.array(z.string()).optional().default([]), // empty = offered on all routers
  // ---- Fair Use Policy. Enforced for PPPOE only today (STATIC has no usage source on the router
  // yet), so the fields are accepted for any service but only act on PPPoE packages.
  fupEnabled: z.boolean().optional(),
  fupPeriod: z.enum(['DAILY', 'MONTHLY']).optional(),
  fupLimitMb: z.number().int().min(1).nullable().optional(),
  fupCountMode: z.enum(['DOWNLOAD', 'COMBINED']).optional(),
  fupThrottleMode: z.enum(['PERCENT', 'MANUAL']).optional(),
  fupThrottlePercent: z.number().int().min(1).max(100).nullable().optional(),
  fupThrottleUpKbps: z.number().int().min(1).nullable().optional(),
  fupThrottleDownKbps: z.number().int().min(1).nullable().optional(),
  fupNotify: z.boolean().optional(),
});

// FUP consistency checks, applied to both create and update. Kept OUT of the schema object so
// packageSchema stays a ZodObject and `.partial()` still works on the update route (.refine would
// turn it into ZodEffects, which has no .partial()).
function fupProblem(d: Record<string, unknown>): string | null {
  if (!d.fupEnabled) return null;
  const limit = d.fupLimitMb as number | null | undefined;
  if (limit == null || limit <= 0) return 'Set a data allowance before enabling FUP';
  if ((d.fupThrottleMode ?? 'PERCENT') === 'MANUAL') {
    if (d.fupThrottleUpKbps == null || d.fupThrottleDownKbps == null) {
      return 'Enter both upload and download throttle speeds';
    }
  } else if (d.fupThrottlePercent != null && ((d.fupThrottlePercent as number) < 1 || (d.fupThrottlePercent as number) > 100)) {
    return 'Throttle percentage must be between 1 and 100';
  }
  return null;
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};
    const packages = await prisma.package.findMany({ where, orderBy: { price: 'asc' } });
    sendSuccess(res, packages);
  } catch {
    sendError(res, 'Failed to fetch packages', 500);
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = packageSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);
    const bad = fupProblem(parsed.data as Record<string, unknown>);
    if (bad) return sendError(res, bad, 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);

    const pkg = await prisma.package.create({ data: { ...parsed.data, tenantId } });
    sendSuccess(res, pkg, 201);
  } catch {
    sendError(res, 'Failed to create package', 500);
  }
});

// How many subscribers a speed change on this package would touch. The UI calls this BEFORE saving
// so the tenant can choose apply-now vs apply-on-renewal — existing subscribers currently keep their
// old speed until renewal (a snapshot-at-activation side effect), and some tenants rely on that
// grandfathering, so propagation must be an explicit choice rather than a silent behaviour change.
router.get('/:id/impact', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const { countAffectedSubscribers } = await import('../utils/packageResync');
    const counts = await countAffectedSubscribers(req.params.id, tenantId);
    sendSuccess(res, counts);
  } catch {
    sendError(res, 'Failed to count affected subscribers', 500);
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = packageSchema.partial().safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);
    const bad = fupProblem(parsed.data as Record<string, unknown>);
    if (bad) return sendError(res, bad, 400);

    // Compare against the stored row so we only propagate when the SPEED actually changed — a price
    // or name edit shouldn't kick every session on the package.
    const before = await prisma.package.findUnique({
      where: { id: req.params.id },
      select: { speedUpKbps: true, speedDownKbps: true },
    });

    const pkg = await prisma.package.update({ where: { id: req.params.id }, data: parsed.data });

    const speedChanged = !!before && (
      (parsed.data.speedUpKbps !== undefined && parsed.data.speedUpKbps !== before.speedUpKbps) ||
      (parsed.data.speedDownKbps !== undefined && parsed.data.speedDownKbps !== before.speedDownKbps)
    );

    // applySpeedNow is the tenant's explicit choice. Without it the change applies on renewal only,
    // preserving today's grandfathering behaviour.
    const applyNow = req.body?.applySpeedNow === true;
    if (speedChanged && applyNow) {
      // Detached: each subscriber is an SSH psql write plus a CoA kick, so this must not block the
      // response. Partial failures are logged per subscriber by the job.
      const { queuePackageResync } = await import('../utils/packageResync');
      queuePackageResync(pkg.id, { kick: true });
    }

    sendSuccess(res, { ...pkg, speedChanged, resyncQueued: speedChanged && applyNow });
  } catch {
    sendError(res, 'Failed to update package', 500);
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.package.delete({ where: { id: req.params.id } });
    sendSuccess(res, { deleted: true });
  } catch {
    sendError(res, 'Failed to delete package', 500);
  }
});

export default router;
