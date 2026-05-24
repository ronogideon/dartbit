import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { signToken } from '../utils/jwt';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid input', 400);

    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return sendError(res, 'Invalid credentials', 401);

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return sendError(res, 'Invalid credentials', 401);

    // Deactivated system users cannot log in
    if (user.isActive === false) return sendError(res, 'Your account has been deactivated. Contact your administrator.', 403);

    const token = signToken({ userId: user.id, role: user.role, tenantId: user.tenantId || undefined });

    // Include the tenant's subdomain so the frontend can route the admin to their
    // tenant-scoped URL (/t/<subdomain>/... now, <subdomain>.domain later).
    let subdomain: string | null = null;
    if (user.tenantId) {
      const t = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { subdomain: true } });
      subdomain = t?.subdomain || null;
    }

    sendSuccess(res, {
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId },
      subdomain,
    });
  } catch {
    sendError(res, 'Login failed', 500);
  }
});

// Customer portal login
const subscriberLoginSchema = z.object({
  username: z.string(),
  password: z.string(),
  tenantId: z.string(),
});

router.post('/subscriber-login', async (req: Request, res: Response) => {
  try {
    const parsed = subscriberLoginSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid input', 400);

    const { username, password, tenantId } = parsed.data;
    const subscriber = await prisma.subscriber.findFirst({
      where: { username, tenantId },
      include: { package: true },
    });

    if (!subscriber || subscriber.secret !== password) return sendError(res, 'Invalid credentials', 401);

    const token = signToken({ userId: subscriber.id, role: 'SUBSCRIBER', tenantId: subscriber.tenantId });
    sendSuccess(res, { token, subscriber });
  } catch {
    sendError(res, 'Login failed', 500);
  }
});

// Hotspot login — validates subscriber credentials (MikroTik hotspot page)
const hotspotLoginSchema = z.object({
  username: z.string(),
  password: z.string(),
  mac: z.string().optional(),
  ip: z.string().optional(),
});

router.post('/subscriber-login-hotspot', async (req: Request, res: Response) => {
  try {
    const parsed = hotspotLoginSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid input', 400);

    const { username, password, mac, ip } = parsed.data;

    // Find subscriber across all tenants by username
    const subscriber = await prisma.subscriber.findFirst({
      where: { username },
      include: { package: true, router: true },
    });

    if (!subscriber || subscriber.secret !== password) return sendError(res, 'Invalid credentials', 401);

    // Check if subscription is active
    const now = new Date();
    const expired = subscriber.expiresAt ? subscriber.expiresAt < now : false;
    if (!subscriber.isActive || expired) {
      return sendError(res, 'Subscription expired or inactive', 403);
    }

    // Update last seen and MAC/IP if provided
    await prisma.subscriber.update({
      where: { id: subscriber.id },
      data: {
        lastOnlineAt: now,
        macAddress: mac || subscriber.macAddress,
        ipAddress: ip || subscriber.ipAddress,
      },
    });

    sendSuccess(res, {
      authenticated: true,
      subscriber: {
        id: subscriber.id,
        username: subscriber.username,
        fullName: subscriber.fullName,
        service: subscriber.service,
        expiresAt: subscriber.expiresAt,
        package: subscriber.package,
      },
    });
  } catch {
    sendError(res, 'Hotspot login failed', 500);
  }
});

export default router;
