import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('');
  console.log('🌱 Seeding Dartbit database...');
  console.log(`   DB: ${process.env.DATABASE_URL?.split('@')[1] ?? 'unknown'}`);
  console.log('');

  // ── Superadmin ──────────────────────────────────────────────
  const superHash = await bcrypt.hash('SuperAdmin123!', 10);
  const superAdmin = await prisma.user.upsert({
    where: { email: 'superadmin@dartbit.local' },
    update: {},
    create: {
      email: 'superadmin@dartbit.local',
      password: superHash,
      name: 'Super Admin',
      role: 'SUPERADMIN',
    },
  });
  console.log(`✓ Superadmin: ${superAdmin.email}`);

  // ── Demo Tenant ─────────────────────────────────────────────
  let tenant = await prisma.tenant.findFirst({ where: { name: 'Demo ISP' } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        name: 'Demo ISP',
        subdomain: 'demo-isp',
        domain: 'demoisp.com',
        status: 'ACTIVE',
        settings: {
          create: {
            currency: 'KES',
            timezone: 'Africa/Nairobi',
            backendUrl: process.env.BACKEND_URL || 'http://localhost:4000',
          },
        },
      },
    });
    console.log(`✓ Tenant created: ${tenant.name}`);
  } else {
    console.log(`✓ Tenant exists: ${tenant.name}`);
  }

  // ── Tenant Admin ────────────────────────────────────────────
  const adminHash = await bcrypt.hash('Test12345', 10);
  const tenantAdmin = await prisma.user.upsert({
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
  console.log(`✓ Tenant admin: ${tenantAdmin.email}`);

  // ── Packages ────────────────────────────────────────────────
  const pppoe10 = await prisma.package.upsert({
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
  console.log(`✓ Package: ${pppoe10.name}`);

  const pppoe5 = await prisma.package.upsert({
    where: { id: 'pkg-pppoe-5mb' },
    update: {},
    create: {
      id: 'pkg-pppoe-5mb',
      name: '5Mbps Home PPPoE',
      service: 'PPPOE',
      speedUpKbps: 5120,
      speedDownKbps: 5120,
      validityMinutes: 43200,
      price: 800,
      tenantId: tenant.id,
    },
  });
  console.log(`✓ Package: ${pppoe5.name}`);

  const hotspot1 = await prisma.package.upsert({
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
  console.log(`✓ Package: ${hotspot1.name}`);

  const hotspot2 = await prisma.package.upsert({
    where: { id: 'pkg-hotspot-weekly' },
    update: {},
    create: {
      id: 'pkg-hotspot-weekly',
      name: '10Mbps Hotspot Weekly',
      service: 'HOTSPOT',
      speedUpKbps: 10240,
      speedDownKbps: 10240,
      validityMinutes: 10080,
      price: 200,
      tenantId: tenant.id,
    },
  });
  console.log(`✓ Package: ${hotspot2.name}`);

  // ── Subscribers ─────────────────────────────────────────────
  const sub1 = await prisma.subscriber.upsert({
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
  console.log(`✓ Subscriber: ${sub1.username}`);

  const sub2 = await prisma.subscriber.upsert({
    where: { id: 'sub-demo-002' },
    update: {},
    create: {
      id: 'sub-demo-002',
      username: 'jane.smith',
      secret: 'password123',
      fullName: 'Jane Smith',
      phone: '+254700000002',
      service: 'PPPOE',
      packageId: pppoe5.id,
      tenantId: tenant.id,
      isActive: false,
      expiresAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    },
  });
  console.log(`✓ Subscriber: ${sub2.username}`);

  const sub3 = await prisma.subscriber.upsert({
    where: { id: 'sub-demo-003' },
    update: {},
    create: {
      id: 'sub-demo-003',
      username: 'hotspot.user1',
      secret: 'hotspot123',
      fullName: 'Hotspot User One',
      phone: '+254700000003',
      service: 'HOTSPOT',
      packageId: hotspot1.id,
      tenantId: tenant.id,
      isActive: true,
      expiresAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
    },
  });
  console.log(`✓ Subscriber: ${sub3.username}`);

  // ── Sample Payment ──────────────────────────────────────────
  const existingPayment = await prisma.payment.findFirst({ where: { subscriberId: sub1.id } });
  if (!existingPayment) {
    await prisma.payment.create({
      data: {
        amount: 1500,
        method: 'MPESA',
        mpesaCode: 'QHX1234567',
        subscriberId: sub1.id,
        tenantId: tenant.id,
      },
    });
    console.log('✓ Sample payment created');
  }

  console.log('');
  console.log('✅ Seed complete!');
  console.log('');
  console.log('   Login credentials:');
  console.log('   ┌─────────────────────────────────────────────────────┐');
  console.log('   │ Superadmin:  superadmin@dartbit.local / SuperAdmin123!│');
  console.log('   │ Tenant Admin: admin@demoisp.com / Test12345          │');
  console.log('   │ Subscriber:  john.doe / password123                  │');
  console.log('   └─────────────────────────────────────────────────────┘');
  console.log('');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());