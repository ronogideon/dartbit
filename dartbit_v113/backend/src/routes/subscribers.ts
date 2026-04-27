import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

const subscriberSchema = z.object({
  username: z.string().min(2),
  secret: z.string().min(4),
  fullName: z.string().min(2),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  service: z.enum(['PPPOE', 'HOTSPOT', 'STATIC']).default('PPPOE'),
  packageId: z.string().optional(),
  routerId: z.string().optional(),
  expiresAt: z.string().optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};

    const subscribers = await prisma.subscriber.findMany({
      where,
      include: { package: true, router: true },
      orderBy: [
        { isActive: 'desc' },
        { lastOnlineAt: 'desc' },
      ],
    });

    // Sort: active first, expired last
    const now = new Date();
    const sorted = subscribers.sort((a, b) => {
      const aExpired = a.expiresAt ? a.expiresAt < now : false;
      const bExpired = b.expiresAt ? b.expiresAt < now : false;
      if (aExpired !== bExpired) return aExpired ? 1 : -1;
      return 0;
    });

    sendSuccess(res, sorted);
  } catch {
    sendError(res, 'Failed to fetch subscribers', 500);
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = subscriberSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);

    const { expiresAt, ...rest } = parsed.data;
    const subscriber = await prisma.subscriber.create({
      data: {
        ...rest,
        tenantId,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      },
      include: { package: true },
    });

    sendSuccess(res, subscriber, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to create subscriber';
    sendError(res, msg, 500);
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = subscriberSchema.partial().safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);

    const { expiresAt, ...rest } = parsed.data;
    const subscriber = await prisma.subscriber.update({
      where: { id: req.params.id },
      data: {
        ...rest,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      },
      include: { package: true },
    });

    sendSuccess(res, subscriber);
  } catch {
    sendError(res, 'Failed to update subscriber', 500);
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.subscriber.delete({ where: { id: req.params.id } });
    sendSuccess(res, { deleted: true });
  } catch {
    sendError(res, 'Failed to delete subscriber', 500);
  }
});

export default router;
