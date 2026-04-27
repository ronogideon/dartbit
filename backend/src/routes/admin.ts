import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const router = Router();
const prisma = new PrismaClient();

function generateSubdomain(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);
}

// GET /admin/seed?secret=dartbit-seed-2024
router.get('/seed', async (req: Request, res: Response) => {
  const { secret } = req.query;
  if (secret !== 'dartbit-seed-2024') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const results: string[] = [];

    // Superadmin
    const superHash = await bcrypt.hash('SuperAdmin123!', 10);
    await prisma.user.upsert({
      where: { email: 'superadmin@dartbit.local' },
      update: {},
      create: {
        email: 'superadmin@dartbit.local',
        password: superHash,
        name: 'Super Admin',
        role: 'SUPERADMIN',
      },
    });
    results.push('✓ Superadmin created');

    // Demo Tenant
    const subdomain = 'demo-isp';
    let tenant = await prisma.tenant.findFirst({ where: { name: 'Demo ISP' } });
    if (!tenant) {
      // Check subdomain availability
      const existingSub = await prisma.tenant.findUnique({ where: { subdomain } });
      const finalSubdomain = existingSub ? `${subdomain}-${Date.now()}` : subdomain;

      tenant = await prisma.tenant.create({
        data: {
          name: 'Demo ISP',
          subdomain: finalSubdomain,
          domain: 'demoisp.com',
          status: 'ACTIVE',
          settings: {
            create: {
              currency: 'KES',
              timezone: 'Africa/Nairobi',
              backendUrl: process.env.BACKEND_URL || '',
            },
          },
        },
      });
      results.push('✓ Tenant created');
    } else {
      results.push('✓ Tenant already exists');
    }

    // Tenant admin
    const adminHash = await bcrypt.hash('Test12345', 10);
    await prisma.user.upsert({
      where: { email: 'admin@demoisp.com' },
      update: {},
      create: {
        email: 'admin@demoisp.com',
        password: adminHash,
        name: 'Demo Admin',
        role: 'TENANT_ADMIN',
        tenantId: tenant.id,
      },
    });
    results.push('✓ Tenant admin created');

    // Packages
    const pppoe = await prisma.package.upsert({
      where: { id: 'pkg-pppoe-10mb' },
      update: {},
      create: {
        id: 'pkg-pppoe-10mb',
        name: '10Mbps Home PPPoE',
        service: 'PPPOE',
        speedUpKbps: 10240,
        speedDownKbps: 10240,
        validityMinutes: 43200,
        price: 1500,
        tenantId: tenant.id,
      },
    });
    results.push(`✓ Package: ${pppoe.name}`);

    await prisma.package.upsert({
      where: { id: 'pkg-hotspot-daily' },
      update: {},
      create: {
        id: 'pkg-hotspot-daily',
        name: '5Mbps Hotspot Daily',
        service: 'HOTSPOT',
        speedUpKbps: 5120,
        speedDownKbps: 5120,
        validityMinutes: 1440,
        price: 50,
        tenantId: tenant.id,
      },
    });
    results.push('✓ Package: Hotspot Daily');

    // Demo subscriber
    await prisma.subscriber.upsert({
      where: { id: 'sub-demo-001' },
      update: {},
      create: {
        id: 'sub-demo-001',
        username: 'john.doe',
        secret: 'password123',
        fullName: 'John Doe',
        phone: '+254700000001',
        service: 'PPPOE',
        packageId: pppoe.id,
        tenantId: tenant.id,
        isActive: true,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    results.push('✓ Demo subscriber created');

    res.json({
      success: true,
      message: 'Database seeded!',
      results,
      credentials: {
        superadmin: 'superadmin@dartbit.local / SuperAdmin123!',
        tenantAdmin: 'admin@demoisp.com / Test12345',
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: msg });
  }
});

export default router;
