import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import prisma from '../utils/prisma';
import { authenticate, requireSuperAdmin, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

function generateSubdomain(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);
}

// GET /tenants/resolve?subdomain=acme — PUBLIC. Validates that a subdomain belongs to a real,
// active tenant. The frontend calls this before rendering anything on a tenant subdomain, so
// random/unknown subdomains never show a login or portal. No auth required, minimal fields,
// and it does not reveal anything beyond existence + display name + active state.
router.get('/resolve', async (req: Request, res: Response) => {
  try {
    const sub = String(req.query.subdomain || '').trim().toLowerCase();
    if (!sub) return sendError(res, 'subdomain required', 400);
    const tenant = await prisma.tenant.findUnique({
      where: { subdomain: sub },
      select: { name: true, subdomain: true, status: true, isActive: true },
    });
    if (!tenant || !tenant.isActive) {
      return res.status(404).json({ success: true, data: { valid: false } });
    }
    // Suspended/cancelled tenants resolve but are flagged so the UI can show the right message.
    const usable = tenant.status === 'ACTIVE' || tenant.status === 'TRIAL';
    sendSuccess(res, { valid: true, usable, name: tenant.name, subdomain: tenant.subdomain, status: tenant.status });
  } catch {
    sendError(res, 'Failed to resolve subdomain', 500);
  }
});

// GET /tenants/my — must be before router.use(authenticate, requireSuperAdmin)
router.get('/my', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { settings: true, _count: { select: { subscribers: true, routers: true } } },
    });
    sendSuccess(res, tenant);
  } catch {
    sendError(res, 'Failed to fetch tenant', 500);
  }
});

// All routes below require superadmin
router.use(authenticate, requireSuperAdmin);

const tenantSchema = z.object({
  name: z.string().min(2),
  subdomain: z.string().optional(),
  domain: z.string().optional(),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
  adminName: z.string().min(2),
  phone: z.string().optional(),
});

router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    const tenants = await prisma.tenant.findMany({
      include: { _count: { select: { subscribers: true, routers: true } } },
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

    const { adminEmail, adminPassword, adminName, subdomain: customSubdomain, ...tenantData } = parsed.data;

    // Generate subdomain from name if not provided
    let subdomain = customSubdomain || generateSubdomain(tenantData.name);

    // Ensure uniqueness
    const existing = await prisma.tenant.findUnique({ where: { subdomain } });
    if (existing) {
      subdomain = `${subdomain}-${Math.floor(Math.random() * 9000) + 1000}`;
    }

    const hashed = await bcrypt.hash(adminPassword, 10);
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const tenant = await prisma.tenant.create({
      data: {
        ...tenantData,
        subdomain,
        status: 'TRIAL',
        trialEndsAt,
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
