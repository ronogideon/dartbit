import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

const paymentSchema = z.object({
  subscriberId: z.string(),
  amount: z.number().min(0),
  method: z.string().default('MANUAL'),
  reference: z.string().optional(),
  mpesaCode: z.string().optional(),
  notes: z.string().optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};
    const payments = await prisma.payment.findMany({
      where,
      include: { subscriber: true },
      orderBy: { createdAt: 'desc' },
    });
    sendSuccess(res, payments);
  } catch {
    sendError(res, 'Failed to fetch payments', 500);
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);

    // Fetch subscriber and package to extend expiry
    const subscriber = await prisma.subscriber.findUnique({
      where: { id: parsed.data.subscriberId },
      include: { package: true },
    });

    if (!subscriber) return sendError(res, 'Subscriber not found', 404);

    const payment = await prisma.payment.create({
      data: { ...parsed.data, source: 'MANUAL', packageId: subscriber.packageId || null, tenantId },
    });

    // Extend expiry automatically if subscriber has a package
    if (subscriber.package) {
      const now = new Date();
      const currentExpiry = subscriber.expiresAt && subscriber.expiresAt > now
        ? subscriber.expiresAt
        : now;
      const newExpiry = new Date(currentExpiry.getTime() + subscriber.package.validityMinutes * 60 * 1000);

      await prisma.subscriber.update({
        where: { id: subscriber.id },
        data: { expiresAt: newExpiry, isActive: true },
      });

      // Mirror the new expiry into RADIUS so gateway-managed routers enforce the extended window.
      try {
        const { radiusConfigured, syncSubscriberToRadius } = await import('../utils/radius');
        if (radiusConfigured() && (subscriber.service === 'PPPOE' || subscriber.service === 'HOTSPOT')) {
          await syncSubscriberToRadius(subscriber.id);
        }
      } catch (e) {
        console.error('payment: radius sync failed (continuing):', e instanceof Error ? e.message : e);
      }
    }

    sendSuccess(res, payment, 201);
  } catch {
    sendError(res, 'Failed to create payment', 500);
  }
});

// PATCH /:id — edit a MANUAL payment's amount and/or notes. Automatic (gateway) records are
// immutable — they're the financial source of truth from M-Pesa and must not be altered.
const editSchema = z.object({
  amount: z.number().min(0).optional(),
  notes: z.string().optional(),
});
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const existing = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!existing) return sendError(res, 'Payment not found', 404);
    if (tenantId && existing.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);
    if ((existing as { source?: string }).source === 'AUTOMATIC') {
      return sendError(res, 'Automatic (gateway) payments cannot be edited', 403);
    }
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);
    const data: Record<string, unknown> = {};
    if (parsed.data.amount !== undefined) data.amount = parsed.data.amount;
    if (parsed.data.notes !== undefined) data.notes = parsed.data.notes || null;
    const updated = await prisma.payment.update({ where: { id: req.params.id }, data });
    sendSuccess(res, updated);
  } catch {
    sendError(res, 'Failed to update payment', 500);
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const existing = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!existing) return sendError(res, 'Payment not found', 404);
    if (tenantId && existing.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);
    // Automatic (gateway) payments are an immutable financial record — never deletable.
    if ((existing as { source?: string }).source === 'AUTOMATIC') {
      return sendError(res, 'Automatic (gateway) payments cannot be deleted', 403);
    }
    await prisma.payment.delete({ where: { id: req.params.id } });
    sendSuccess(res, { deleted: true });
  } catch {
    sendError(res, 'Failed to delete payment', 500);
  }
});

export default router;
