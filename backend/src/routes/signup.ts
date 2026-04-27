import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import prisma from '../utils/prisma';
import { signToken } from '../utils/jwt';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

const signupSchema = z.object({
  companyName: z.string().min(2, 'Company name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  phone: z.string().min(8, 'Invalid phone number'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  adminName: z.string().min(2, 'Your name must be at least 2 characters'),
});

function generateSubdomain(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30) || 'isp';
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.errors[0].message, 400);
    }

    const { companyName, email, phone, password, adminName } = parsed.data;

    // Check email uniqueness
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return sendError(res, 'An account with this email already exists', 409);
    }

    // Generate unique subdomain
    let subdomain = generateSubdomain(companyName);
    const existingSub = await prisma.tenant.findUnique({ where: { subdomain } });
    if (existingSub) {
      subdomain = `${subdomain}-${Math.floor(Math.random() * 9000) + 1000}`;
    }

    // 14-day trial end date
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create everything in one transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create tenant
      const tenant = await tx.tenant.create({
        data: {
          name: companyName,
          subdomain,
          phone,
          status: 'TRIAL' as const,
          trialEndsAt,
          isActive: true,
        },
      });

      // Create settings
      await tx.tenantSetting.create({
        data: {
          tenantId: tenant.id,
          currency: 'KES',
          timezone: 'Africa/Nairobi',
          backendUrl: process.env.BACKEND_URL || '',
        },
      });

      // Create admin user
      const user = await tx.user.create({
        data: {
          email,
          password: hashedPassword,
          name: adminName,
          role: 'TENANT_ADMIN',
          tenantId: tenant.id,
        },
      });

      // Create default packages
      await tx.package.createMany({
        data: [
          {
            name: '10Mbps Home PPPoE',
            service: 'PPPOE',
            speedUpKbps: 10240,
            speedDownKbps: 10240,
            validityMinutes: 43200,
            price: 1500,
            tenantId: tenant.id,
          },
          {
            name: '5Mbps Hotspot Daily',
            service: 'HOTSPOT',
            speedUpKbps: 5120,
            speedDownKbps: 5120,
            validityMinutes: 1440,
            price: 50,
            tenantId: tenant.id,
          },
        ],
      });

      return { tenant, user };
    });

    // Issue JWT
    const token = signToken({
      userId: result.user.id,
      role: result.user.role,
      tenantId: result.tenant.id,
    });

    console.log(`✓ New ISP signed up: ${companyName} (${subdomain})`);

    sendSuccess(res, {
      token,
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        role: result.user.role,
        tenantId: result.tenant.id,
      },
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        subdomain: result.tenant.subdomain,
        status: result.tenant.status,
        trialEndsAt: result.tenant.trialEndsAt,
      },
    }, 201);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Signup failed';
    console.error('Signup error:', msg);
    // Return the actual error message so we can debug
    sendError(res, msg, 500);
  }
});

// GET /signup/check-subdomain?name=...
router.get('/check-subdomain', async (req: Request, res: Response) => {
  const { name } = req.query;
  if (!name || typeof name !== 'string') {
    return sendError(res, 'name is required', 400);
  }
  const subdomain = generateSubdomain(name);
  const existing = await prisma.tenant.findUnique({ where: { subdomain } });
  sendSuccess(res, { subdomain, available: !existing });
});

export default router;
