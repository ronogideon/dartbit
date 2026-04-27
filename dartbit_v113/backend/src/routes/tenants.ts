import { Router, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import prisma from '../utils/prisma';
import { authenticate, requireSuperAdmin, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate, requireSuperAdmin);

const tenantSchema = z.object({
  name: z.string().min(2),
  domain: z.string().optional(),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
  adminName: z.string().min(2),
});

router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    const tenants = await prisma.tenant.findMany({
      include: {
        _count: { select: { subscribers: true, routers: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    sendSuccess(res, tenants);
  } catch {
    sendError(res, 'Failed to fetch tenants', 500);
  }
});

router.get('/stats', async (_req: AuthRequest, res: Response) => {
  try {
    const [tenantCount, subscriberCount, routerCount, paymentTotal] = await Promise.all([
      prisma.tenant.count(),
      prisma.subscriber.count(),
      prisma.mikrotikRouter.count(),
      prisma.payment.aggregate({ _sum: { amount: true } }),
    ]);

    sendSuccess(res, {
      tenants: tenantCount,
      subscribers: subscriberCount,
      routers: routerCount,
      totalRevenue: paymentTotal._sum.amount || 0,
    });
  } catch {
    sendError(res, 'Failed to fetch stats', 500);
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = tenantSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);

    const { adminEmail, adminPassword, adminName, ...tenantData } = parsed.data;
    const hashed = await bcrypt.hash(adminPassword, 10);

    const tenant = await prisma.tenant.create({
      data: {
        ...tenantData,
        users: {
          create: {
            email: adminEmail,
            password: hashed,
            name: adminName,
            role: 'TENANT_ADMIN',
          },
        },
        settings: { create: {} },
      },
      include: { users: true },
    });

    sendSuccess(res, tenant, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to create tenant';
    sendError(res, msg, 500);
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.tenant.delete({ where: { id: req.params.id } });
    sendSuccess(res, { deleted: true });
  } catch {
    sendError(res, 'Failed to delete tenant', 500);
  }
});

export default router;
