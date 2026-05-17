import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

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
    const where = tenantId ? { tenantId } : {};
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

    const result = await prisma.voucher.deleteMany({ where });
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
