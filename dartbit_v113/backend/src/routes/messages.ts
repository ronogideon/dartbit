import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

const messageSchema = z.object({
  type: z.enum(['SMS', 'EMAIL']).default('SMS'),
  recipient: z.string(),
  body: z.string(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};
    const messages = await prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    sendSuccess(res, messages);
  } catch {
    sendError(res, 'Failed to fetch messages', 500);
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);

    // Placeholder: In production, integrate with SMS/email provider
    const message = await prisma.message.create({
      data: { ...parsed.data, tenantId, status: 'SENT' },
    });

    sendSuccess(res, message, 201);
  } catch {
    sendError(res, 'Failed to send message', 500);
  }
});

export default router;
