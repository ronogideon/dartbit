import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Dartbit...');

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

  // Demo ISP Tenant
  let tenant = await prisma.tenant.findFirst({ where: { name: 'Demo ISP' } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        name: 'Demo ISP',
        domain: 'demoisp.com',
        settings: {
          create: {
            currency: 'KES',
            timezone: 'Africa/Nairobi',
            backendUrl: 'https://dartbit-production.up.railway.app',
          },
        },
      },
    });
  }

  // Tenant Admin
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

  // Demo packages
  const pppoe10 = await prisma.package.upsert({
    where: { id: 'pkg-pppoe-10mb' },
    update: {},
    create: {
      id: 'pkg-pppoe-10mb',
      name: '10Mbps Home',
      service: 'PPPOE',
      speedUpKbps: 10240,
      speedDownKbps: 10240,
      validityMinutes: 43200,
      price: 1500,
      tenantId: tenant.id,
    },
  });

  await prisma.package.upsert({
    where: { id: 'pkg-hotspot-5mb' },
    update: {},
    create: {
      id: 'pkg-hotspot-5mb',
      name: '5Mbps Hotspot Daily',
      service: 'HOTSPOT',
      speedUpKbps: 5120,
      speedDownKbps: 5120,
      validityMinutes: 1440,
      price: 100,
      tenantId: tenant.id,
    },
  });

  // Demo subscribers
  await prisma.subscriber.upsert({
    where: { id: 'sub-demo-001' },
    update: {},
    create: {
      id: 'sub-demo-001',
      username: 'john.doe',
      secret: 'password123',
      fullName: 'John Doe',
      phone: '+254700000001',
      email: 'john@example.com',
      service: 'PPPOE',
      packageId: pppoe10.id,
      tenantId: tenant.id,
      isActive: true,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  await prisma.subscriber.upsert({
    where: { id: 'sub-demo-002' },
    update: {},
    create: {
      id: 'sub-demo-002',
      username: 'jane.smith',
      secret: 'password123',
      fullName: 'Jane Smith',
      phone: '+254700000002',
      service: 'PPPOE',
      packageId: pppoe10.id,
      tenantId: tenant.id,
      isActive: false,
      expiresAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    },
  });

  console.log('✅ Seed complete!');
  console.log('   Superadmin: superadmin@dartbit.local / SuperAdmin123!');
  console.log('   Tenant Admin: admin@demoisp.com / Test12345');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
