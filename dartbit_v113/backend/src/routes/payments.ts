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
      data: { ...parsed.data, tenantId },
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
    }

    sendSuccess(res, payment, 201);
  } catch {
    sendError(res, 'Failed to create payment', 500);
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.payment.delete({ where: { id: req.params.id } });
    sendSuccess(res, { deleted: true });
  } catch {
    sendError(res, 'Failed to delete payment', 500);
  }
});

export default router;
