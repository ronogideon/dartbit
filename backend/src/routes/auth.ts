import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { signToken } from '../utils/jwt';
import { sendSuccess, sendError } from '../utils/response';
import { extractSubdomain } from '../utils/tenantResolve';

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

    // SUBDOMAIN ISOLATION: when the request comes from a tenant subdomain
    // (dart.dartbittech.com → "dart"), the user MUST belong to that tenant. This keeps
    // each tenant's login scoped to its own subdomain — two tenants can have users with
    // the same email/name without one logging into the other's portal. Superadmins are
    // exempt (they manage all tenants and sign in from the apex/app host).
    const reqSubdomain = extractSubdomain(req); // from Host subdomain or X-Tenant header
    if (reqSubdomain && user.role !== 'SUPERADMIN' && user.role !== 'SUPERADMIN_VIEWER') {
      const subTenant = await prisma.tenant.findUnique({
        where: { subdomain: reqSubdomain },
        select: { id: true },
      });
      if (!subTenant) return sendError(res, 'Unknown portal', 404);
      if (user.tenantId !== subTenant.id) {
        // Don't reveal whether the email exists elsewhere — generic message.
        return sendError(res, 'Invalid credentials for this portal', 401);
      }
    }

    const token = signToken({ userId: user.id, role: user.role, tenantId: user.tenantId || undefined });

    // Include the tenant's subdomain so the frontend can route the admin to their
    // tenant-scoped URL (<subdomain>.dartbittech.com).
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

// ─── Password reset via SMS (staff Users + portal Subscribers) ──────────────────
// scope STAFF  → User (email);  scope CUSTOMER → Subscriber (username, per-tenant).
// A 6-digit code is hashed and stored for 15 min; the SMS goes out through the tenant's
// chosen gateway (sendNotification resolves it). Responses never reveal whether an account exists.
function genResetCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const forgotSchema = z.object({
  scope: z.enum(['STAFF', 'CUSTOMER']),
  identifier: z.string().min(1),
  tenantId: z.string().optional(),
});

router.post('/forgot-password', async (req: Request, res: Response) => {
  const generic = () => sendSuccess(res, { ok: true, message: 'If the account exists, a reset code has been sent.' });
  try {
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) return generic();
    const { scope, identifier } = parsed.data;
    let tenantId = parsed.data.tenantId || undefined;
    let subjectId = '';
    let phone: string | null | undefined;

    if (scope === 'STAFF') {
      const user = await prisma.user.findUnique({ where: { email: identifier.toLowerCase().trim() } });
      if (!user || !user.tenantId || !user.phone) return generic(); // need a tenant gateway + a phone
      subjectId = user.id; phone = user.phone; tenantId = user.tenantId;
    } else {
      if (!tenantId) {
        const sub = extractSubdomain(req);
        if (sub) tenantId = (await prisma.tenant.findUnique({ where: { subdomain: sub } }))?.id;
      }
      if (!tenantId) return generic();
      const subscriber = await prisma.subscriber.findFirst({ where: { username: identifier.trim(), tenantId } });
      if (!subscriber || !subscriber.phone) return generic();
      subjectId = subscriber.id; phone = subscriber.phone;
    }

    const code = genResetCode();
    const codeHash = await bcrypt.hash(code, 10);
    await prisma.passwordResetCode.updateMany({ where: { scope, subjectId, usedAt: null }, data: { usedAt: new Date() } });
    await prisma.passwordResetCode.create({ data: { scope, subjectId, codeHash, expiresAt: new Date(Date.now() + 15 * 60 * 1000) } });

    const { sendNotification } = await import('../utils/notifications');
    await sendNotification({
      tenantId: tenantId!,
      phone: phone!,
      body: `Use this code to reset your password: ${code}`,
      category: 'OTHER',
    }).catch(() => {});

    return generic();
  } catch {
    return sendSuccess(res, { ok: true, message: 'If the account exists, a reset code has been sent.' });
  }
});

const resetSchema = z.object({
  scope: z.enum(['STAFF', 'CUSTOMER']),
  identifier: z.string().min(1),
  tenantId: z.string().optional(),
  code: z.string().min(4),
  newPassword: z.string().min(4),
});

router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid request', 400);
    const { scope, identifier, code, newPassword } = parsed.data;
    let tenantId = parsed.data.tenantId || undefined;
    let subjectId = '';
    let subService: string | undefined;

    if (scope === 'STAFF') {
      const user = await prisma.user.findUnique({ where: { email: identifier.toLowerCase().trim() } });
      if (!user) return sendError(res, 'Invalid or expired code', 400);
      subjectId = user.id;
    } else {
      if (!tenantId) {
        const sub = extractSubdomain(req);
        if (sub) tenantId = (await prisma.tenant.findUnique({ where: { subdomain: sub } }))?.id;
      }
      if (!tenantId) return sendError(res, 'Invalid or expired code', 400);
      const subscriber = await prisma.subscriber.findFirst({ where: { username: identifier.trim(), tenantId } });
      if (!subscriber) return sendError(res, 'Invalid or expired code', 400);
      subjectId = subscriber.id; subService = subscriber.service;
    }

    const rec = await prisma.passwordResetCode.findFirst({
      where: { scope, subjectId, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!rec) return sendError(res, 'Code expired or not found. Request a new one.', 400);
    if (!(await bcrypt.compare(code.trim(), rec.codeHash))) return sendError(res, 'Invalid or expired code', 400);

    if (scope === 'STAFF') {
      await prisma.user.update({ where: { id: subjectId }, data: { password: await bcrypt.hash(newPassword, 10) } });
    } else {
      await prisma.subscriber.update({ where: { id: subjectId }, data: { secret: newPassword } });
      if (subService === 'PPPOE') {
        try {
          const { radiusConfigured, syncSubscriberToRadius } = await import('../utils/radius');
          if (radiusConfigured()) await syncSubscriberToRadius(subjectId, { kickToApply: true });
        } catch { /* best effort */ }
      }
    }
    await prisma.passwordResetCode.update({ where: { id: rec.id }, data: { usedAt: new Date() } });
    return sendSuccess(res, { ok: true });
  } catch (err) {
    return sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export default router;
