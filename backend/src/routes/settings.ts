import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

const settingsSchema = z.object({
  smsSenderId: z.string().optional(),
  smsApiKey: z.string().optional(),
  emailFromAddress: z.string().email().optional(),
  currency: z.string().optional(),
  timezone: z.string().optional(),
  backendUrl: z.string().optional(),
  autoDeleteOfflineDays: z.number().int().min(0).max(3650).optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const settings = await prisma.tenantSetting.findUnique({ where: { tenantId } });
    sendSuccess(res, settings);
  } catch {
    sendError(res, 'Failed to fetch settings', 500);
  }
});

router.put('/', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const settings = await prisma.tenantSetting.upsert({
      where: { tenantId },
      create: { tenantId, ...parsed.data },
      update: parsed.data,
    });
    sendSuccess(res, settings);
  } catch {
    sendError(res, 'Failed to update settings', 500);
  }
});

export default router;
