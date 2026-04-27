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
  adminName: z.string().min(2, 'Name must be at least 2 characters'),
});

// Generate subdomain from company name
function generateSubdomain(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);
}

// POST /signup — ISP self-registration
router.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.errors[0].message, 400);
    }

    const { companyName, email, phone, password, adminName } = parsed.data;

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return sendError(res, 'An account with this email already exists', 409);
    }

    // Generate unique subdomain
    let subdomain = generateSubdomain(companyName);
    const existing = await prisma.tenant.findUnique({ where: { subdomain } });
    if (existing) {
      // Append random suffix if subdomain taken
      subdomain = `${subdomain}-${Math.floor(Math.random() * 9000) + 1000}`;
    }

    // Check subdomain is still unique
    const subdomainTaken = await prisma.tenant.findUnique({ where: { subdomain } });
    if (subdomainTaken) {
      return sendError(res, 'Could not generate unique subdomain. Please try a different company name.', 409);
    }

    // 14-day trial
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create tenant + admin user + default settings atomically
    const tenant = await prisma.tenant.create({
      data: {
        name: companyName,
        subdomain,
        phone,
        status: 'TRIAL',
        trialEndsAt,
        isActive: true,
        settings: {
          create: {
            currency: 'KES',
            timezone: 'Africa/Nairobi',
            backendUrl: process.env.BACKEND_URL || '',
          },
        },
        users: {
          create: {
            email,
            password: hashedPassword,
            name: adminName,
            role: 'TENANT_ADMIN',
          },
        },
        // Seed default packages for new ISP
        packages: {
          create: [
            {
              name: '10Mbps Home PPPoE',
              service: 'PPPOE',
              speedUpKbps: 10240,
              speedDownKbps: 10240,
              validityMinutes: 43200,
              price: 1500,
            },
            {
              name: '5Mbps Hotspot Daily',
              service: 'HOTSPOT',
              speedUpKbps: 5120,
              speedDownKbps: 5120,
              validityMinutes: 1440,
              price: 50,
            },
          ],
        },
      },
      include: {
        users: true,
      },
    });

    const user = tenant.users[0];

    // Issue JWT token so they're logged in immediately
    const token = signToken({
      userId: user.id,
      role: user.role,
      tenantId: tenant.id,
    });

    sendSuccess(res, {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: tenant.id,
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subdomain: tenant.subdomain,
        status: tenant.status,
        trialEndsAt: tenant.trialEndsAt,
      },
    }, 201);
  } catch (err: unknown) {
    console.error('Signup error:', err);
    const msg = err instanceof Error ? err.message : 'Signup failed';
    sendError(res, msg, 500);
  }
});

// GET /signup/check-subdomain?name=... — check availability
router.get('/check-subdomain', async (req: Request, res: Response) => {
  const { name } = req.query;
  if (!name || typeof name !== 'string') {
    return sendError(res, 'name is required', 400);
  }
  const subdomain = generateSubdomain(name);
  const existing = await prisma.tenant.findUnique({ where: { subdomain } });
  sendSuccess(res, {
    subdomain,
    available: !existing,
  });
});

export default router;
