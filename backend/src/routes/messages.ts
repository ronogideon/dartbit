import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { sendNotification } from '../utils/notifications';

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
      take: 500,
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

    if (parsed.data.type === 'SMS') {
      // Route SMS through the configured gateway; Messages row is created/updated by
      // sendNotification with phone, cost, delivery status, and gateway message id.
      const result = await sendNotification({
        tenantId,
        phone: parsed.data.recipient,
        body: parsed.data.body,
        category: 'MANUAL',
      });
      if (!result.ok) return sendError(res, result.reason || 'Send failed', 400);
      const latest = await prisma.message.findFirst({
        where: { tenantId, gatewayMsgId: result.messageId },
        orderBy: { createdAt: 'desc' },
      });
      sendSuccess(res, latest, 201);
    } else {
      // EMAIL not yet wired to a provider — record as PENDING for now.
      const message = await prisma.message.create({
        data: { ...parsed.data, tenantId, status: 'PENDING' },
      });
      sendSuccess(res, message, 201);
    }
  } catch {
    sendError(res, 'Failed to send message', 500);
  }
});

export default router;
