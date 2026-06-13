import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { enqueueCommand } from '../utils/commandQueue';

const router = Router();
router.use(authenticate);

// Generate a random voucher code — alphanumeric, no ambiguous chars
function generateCode(length = 8): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
  let code = '';
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// GET /vouchers — list vouchers for tenant
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    // M-Pesa receipts are registered as vouchers (batchId='MPESA') purely so the receipt works as an
    // alternative login/reconnect code — they are NOT real vouchers, so they're hidden from the tab.
    const where = { ...(tenantId ? { tenantId } : {}), NOT: { batchId: 'MPESA' } };
    const vouchers = await prisma.voucher.findMany({
      where,
      include: { package: true, router: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    sendSuccess(res, vouchers);
  } catch {
    sendError(res, 'Failed to fetch vouchers', 500);
  }
});

// POST /vouchers/generate — generate a batch of vouchers
const generateSchema = z.object({
  count: z.number().int().min(1).max(500),
  packageId: z.string().optional(),
  routerId: z.string().optional(),
  durationMinutes: z.number().int().min(1).max(60 * 24 * 365).default(60), // up to 1 year
  codeLength: z.number().int().min(4).max(16).default(8),
  notes: z.string().optional(),
});
router.post('/generate', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'tenantId required', 400);

    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.errors[0].message, 400);

    const { count, packageId, routerId, durationMinutes, codeLength, notes } = parsed.data;
    const batchId = 'batch_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);

    // Generate unique codes — collision-resistant
    const codes = new Set<string>();
    const maxAttempts = count * 10;
    for (let i = 0; i < maxAttempts && codes.size < count; i++) {
      codes.add(generateCode(codeLength));
    }
    if (codes.size < count) return sendError(res, 'Failed to generate unique codes — try a longer code length', 500);

    const vouchers = Array.from(codes).map(code => ({
      code,
      tenantId,
      packageId: packageId || null,
      routerId: routerId || null,
      durationMinutes,
      batchId,
      notes: notes || null,
    }));

    await prisma.voucher.createMany({ data: vouchers, skipDuplicates: true });

    const created = await prisma.voucher.findMany({
      where: { batchId },
      include: { package: true, router: true },
      orderBy: { createdAt: 'desc' },
    });

    // Immediately push vouchers to all NON-RADIUS routers as local hotspot users (limit-uptime is
    // cumulative session time — only starts counting once the user logs in for the first time, so
    // vouchers can sit unused indefinitely). RADIUS-enabled routers are handled by the bulk RADIUS
    // sync below instead, where the same cumulative-uptime semantics come from the dartbit_uptime
    // sqlcounter.
    // Local push happens only in legacy (non-RADIUS) mode; under RADIUS the bulk sync below is
    // authoritative (cumulative-uptime via the dartbit_uptime sqlcounter).
    try {
      const { radiusConfigured } = await import('../utils/radius');
      const targetRouters = radiusConfigured() ? [] : (routerId
        ? await prisma.mikrotikRouter.findMany({ where: { id: routerId, tenantId } as any })
        : await prisma.mikrotikRouter.findMany({ where: { tenantId } as any }));

      for (const r of targetRouters) {
        // Determine profile and speed for the package
        const pkg = packageId ? created[0]?.package : undefined;
        const profileName = pkg ? `db-v-${pkg.id.substring(0, 8)}` : 'dartbit-default';
        const speed = pkg ? `${pkg.speedUpKbps}k/${pkg.speedDownKbps}k` : '10M/10M';
        const sessionSec = durationMinutes * 60;

        const cmds: string[] = [];
        cmds.push(`:if ([:len [/ip hotspot user profile find name="${profileName}"]] = 0) do={ /ip hotspot user profile add name=${profileName} }`);
        cmds.push(`/ip hotspot user profile set [find name="${profileName}"] rate-limit=${speed} shared-users=1`);
        for (const v of created) {
          const shortId = v.id.slice(-8);
          // Add each voucher as a hotspot user; limit-uptime starts counting on first login.
          cmds.push(`:if ([:len [/ip hotspot user find name="${v.code}"]] = 0) do={ /ip hotspot user add name=${v.code} password=${v.code} profile=${profileName} limit-uptime=${sessionSec}s comment="Dbv:${shortId}" }`);
        }
        cmds.push(`:log info "Dartbit: pushed ${created.length} new vouchers to router"`);
        await enqueueCommand(r.id, cmds.join('\n'));
      }
    } catch (pushErr) {
      // Non-fatal — sync script will eventually push them
      console.error('Voucher push to routers failed (will retry on next sync):', pushErr);
    }

    // RADIUS-enabled routers: write the batch into FreeRADIUS (radcheck code + Max-All-Session cap +
    // rate-limit). Cumulative uptime is enforced by the dartbit_uptime sqlcounter. Best-effort.
    try {
      const { radiusConfigured, bulkSyncVouchersToRadius } = await import('../utils/radius');
      if (radiusConfigured()) {
        await bulkSyncVouchersToRadius({ tenantId, batchId, ...(routerId ? { routerId } : {}) });
      }
    } catch (radErr) {
      console.error('Voucher RADIUS sync failed:', radErr instanceof Error ? radErr.message : radErr);
    }

    sendSuccess(res, { batchId, count: created.length, vouchers: created });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to generate vouchers';
    console.error('Voucher generation error:', msg);
    sendError(res, msg, 500);
  }
});

// DELETE /vouchers/:id — delete a single voucher (only if unused)
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const v = await prisma.voucher.findUnique({ where: { id: req.params.id } });
    if (!v) return sendError(res, 'Voucher not found', 404);
    if (tenantId && v.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);
    if (v.isUsed) return sendError(res, 'Cannot delete a used voucher', 400);

    await prisma.voucher.delete({ where: { id: req.params.id } });
    try {
      const { radiusConfigured, removeVoucherFromRadius } = await import('../utils/radius');
      if (radiusConfigured()) await removeVoucherFromRadius(v.code);
    } catch { /* best-effort */ }
    sendSuccess(res, { deleted: true });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// DELETE /vouchers/batch/:batchId — delete an entire batch (only unused ones)
router.delete('/batch/:batchId', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where: { batchId: string; isUsed: boolean; tenantId?: string } = {
      batchId: req.params.batchId,
      isUsed: false,
    };
    if (tenantId) where.tenantId = tenantId;

    // Capture the codes about to be deleted so we can clear them from RADIUS too.
    const doomed = await prisma.voucher.findMany({ where, select: { code: true } });
    const result = await prisma.voucher.deleteMany({ where });
    try {
      const { radiusConfigured, removeVoucherFromRadius } = await import('../utils/radius');
      if (radiusConfigured()) {
        for (const d of doomed) await removeVoucherFromRadius(d.code);
      }
    } catch { /* best-effort */ }
    sendSuccess(res, { deleted: result.count });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /vouchers/batches — list batches summary
router.get('/batches', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};
    const vouchers = await prisma.voucher.findMany({
      where,
      include: { package: true },
      orderBy: { createdAt: 'desc' },
    });

    // Group by batchId
    const batches: Record<string, {
      batchId: string;
      createdAt: Date;
      packageName?: string;
      durationMinutes: number;
      total: number;
      used: number;
      unused: number;
      notes?: string;
    }> = {};
    for (const v of vouchers) {
      const key = v.batchId || 'no-batch';
      if (!batches[key]) {
        batches[key] = {
          batchId: key,
          createdAt: v.createdAt,
          packageName: v.package?.name,
          durationMinutes: v.durationMinutes,
          total: 0, used: 0, unused: 0,
          notes: v.notes || undefined,
        };
      }
      batches[key].total++;
      if (v.isUsed) batches[key].used++;
      else batches[key].unused++;
    }

    sendSuccess(res, Object.values(batches).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()));
  } catch {
    sendError(res, 'Failed', 500);
  }
});

export default router;
