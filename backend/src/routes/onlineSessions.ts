import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};
    const sessions = await prisma.onlineSession.findMany({
      where,
      include: { subscriber: true, router: true },
      orderBy: { updatedAt: 'desc' },
    });
    // Hide expired subscribers from the active page. Expired PPPoE/static devices are deliberately
    // kept connected (portal-only) so they can reach tenant.dartbittech.com to renew — but they
    // are NOT "active" customers, so they should not clutter the active-users view.
    const now = Date.now();
    const visible = sessions.filter(s => {
      const sub = s.subscriber;
      if (!sub) return true; // unidentified sessions still shown
      const expired = sub.expiresAt ? new Date(sub.expiresAt).getTime() <= now : false;
      return sub.isActive && !expired;
    });
    sendSuccess(res, visible);
  } catch {
    sendError(res, 'Failed to fetch sessions', 500);
  }
});

// Router reports active sessions
const sessionSchema = z.object({
  apiKey: z.string(),
  sessions: z.array(z.object({
    username: z.string(),
    ipAddress: z.string().optional(),
    macAddress: z.string().optional(),
    uploadSpeed: z.number().optional(),
    downloadSpeed: z.number().optional(),
    uptime: z.string().optional(),
  })),
});

router.post('/sync', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = sessionSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid payload', 400);

    const mikrotikRouter = await prisma.mikrotikRouter.findUnique({
      where: { apiKey: parsed.data.apiKey },
    });
    if (!mikrotikRouter) return sendError(res, 'Router not found', 404);

    // Clear old sessions for this router
    await prisma.onlineSession.deleteMany({ where: { routerId: mikrotikRouter.id } });

    // Insert new sessions
    for (const s of parsed.data.sessions) {
      const subscriber = await prisma.subscriber.findFirst({
        where: { username: s.username, tenantId: mikrotikRouter.tenantId },
      });

      await prisma.onlineSession.create({
        data: {
          ...s,
          routerId: mikrotikRouter.id,
          subscriberId: subscriber?.id,
          tenantId: mikrotikRouter.tenantId,
        },
      });

      if (subscriber) {
        await prisma.subscriber.update({
          where: { id: subscriber.id },
          data: { lastOnlineAt: new Date() },
        });
      }
    }

    sendSuccess(res, { synced: parsed.data.sessions.length });
  } catch {
    sendError(res, 'Session sync failed', 500);
  }
});

export default router;
