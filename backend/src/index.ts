import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import authRoutes from './routes/auth';
import subscriberRoutes from './routes/subscribers';
import packageRoutes from './routes/packages';
import paymentRoutes from './routes/payments';
import messageRoutes from './routes/messages';
import routerRoutes from './routes/routers';
import onlineSessionRoutes from './routes/onlineSessions';
import routerZtpRoutes from './routes/routerZtp';
import tenantRoutes from './routes/tenants';
import settingsRoutes from './routes/settings';
import signupRoutes from './routes/signup';
import adminRoutes from './routes/admin';

const app = express();
const PORT = process.env.PORT || 4000;

const allowedOrigins = [
  'https://dartbit-production.up.railway.app',
  'https://accomplished-patience-production-dd5a.up.railway.app',
  'http://localhost:3000',
  'http://localhost:3001',
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());

app.get('/', (_req, res) => res.json({ service: 'Dartbit API', version: '1.3.2', status: 'running' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '1.3.2', timestamp: new Date().toISOString() }));

app.use('/auth', authRoutes);
app.use('/signup', signupRoutes);
app.use('/admin', adminRoutes);
app.use('/router', routerZtpRoutes);
app.use('/subscribers', subscriberRoutes);
app.use('/packages', packageRoutes);
app.use('/payments', paymentRoutes);
app.use('/messages', messageRoutes);
app.use('/mikrotiks', routerRoutes);
app.use('/online-sessions', onlineSessionRoutes);
app.use('/tenants', tenantRoutes);
app.use('/settings', settingsRoutes);

app.use((_req, res) => res.status(404).json({ success: false, error: 'Route not found' }));

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Dartbit v1.3.2 running on port ${PORT}\n`);
  patchDatabase();
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

// Wrap each statement so one failure doesn't abort the rest
async function safeExec(prisma: PrismaClient, label: string, sql: string) {
  try {
    await prisma.$executeRawUnsafe(sql);
    console.log(`  ✓ ${label}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Ignore "already exists" errors — they're harmless
    if (msg.includes('already exists') || msg.includes('42P07') || msg.includes('42710')) {
      console.log(`  - ${label} (already exists)`);
    } else {
      console.log(`  ⚠ ${label}: ${msg.substring(0, 100)}`);
    }
  }
}

async function patchDatabase() {
  const prisma = new PrismaClient();
  try {
    console.log('🔧 Patching database schema...');

    // TenantStatus enum
    await safeExec(prisma, 'TenantStatus enum',
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TenantStatus') THEN
          CREATE TYPE "TenantStatus" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED');
        END IF;
      END $$;`);

    // Tenant columns
    await safeExec(prisma, 'Tenant.subdomain', `ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "subdomain" TEXT NOT NULL DEFAULT ''`);
    await safeExec(prisma, 'Tenant.phone', `ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "phone" TEXT`);
    await safeExec(prisma, 'Tenant.trialEndsAt', `ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3)`);
    await safeExec(prisma, 'Tenant.status', `ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE'`);

    // Fill subdomains
    await safeExec(prisma, 'Fill subdomains',
      `UPDATE "Tenant" SET "subdomain" = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(name), '[^a-zA-Z0-9 ]', '', 'g'), ' +', '-', 'g')) || '-' || SUBSTRING(id, 1, 6) WHERE "subdomain" = '' OR "subdomain" IS NULL`);

    // Tenant subdomain unique
    await safeExec(prisma, 'Tenant.subdomain unique',
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Tenant_subdomain_key') THEN
          ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_subdomain_key" UNIQUE ("subdomain");
        END IF;
      END $$;`);

    // Subscriber columns
    await safeExec(prisma, 'Subscriber.ipAddress', `ALTER TABLE "Subscriber" ADD COLUMN IF NOT EXISTS "ipAddress" TEXT`);
    await safeExec(prisma, 'Subscriber.macAddress', `ALTER TABLE "Subscriber" ADD COLUMN IF NOT EXISTS "macAddress" TEXT`);

    // RouterProvisioningConfig — CREATE TABLE first
    await safeExec(prisma, 'RouterProvisioningConfig table',
      `CREATE TABLE IF NOT EXISTS "RouterProvisioningConfig" (
        "id" TEXT NOT NULL,
        "routerId" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "RouterProvisioningConfig_pkey" PRIMARY KEY ("id")
      )`);

    // Now add all columns one at a time — if table existed without these, they'll be added
    const provColumns: [string, string][] = [
      ['wanInterface', `TEXT NOT NULL DEFAULT 'ether1'`],
      ['lanInterface', `TEXT NOT NULL DEFAULT 'ether2'`],
      ['bridgeName', `TEXT NOT NULL DEFAULT 'bridge-lan'`],
      ['lanSubnet', `TEXT NOT NULL DEFAULT '192.168.88.0/24'`],
      ['lanGateway', `TEXT NOT NULL DEFAULT '192.168.88.1'`],
      ['dhcpPoolStart', `TEXT NOT NULL DEFAULT '192.168.88.10'`],
      ['dhcpPoolEnd', `TEXT NOT NULL DEFAULT '192.168.88.254'`],
      ['dnsServers', `TEXT NOT NULL DEFAULT '8.8.8.8,8.8.4.4'`],
      ['pppoeEnabled', `BOOLEAN NOT NULL DEFAULT true`],
      ['pppoeInterface', `TEXT NOT NULL DEFAULT 'bridge-lan'`],
      ['pppoeLocalAddress', `TEXT NOT NULL DEFAULT '10.10.10.1'`],
      ['pppoeRemotePool', `TEXT NOT NULL DEFAULT 'pppoe-pool'`],
      ['pppoePoolStart', `TEXT NOT NULL DEFAULT '10.10.10.10'`],
      ['pppoePoolEnd', `TEXT NOT NULL DEFAULT '10.10.10.200'`],
      ['hotspotEnabled', `BOOLEAN NOT NULL DEFAULT true`],
      ['hotspotInterface', `TEXT NOT NULL DEFAULT 'bridge-lan'`],
      ['hotspotNetwork', `TEXT NOT NULL DEFAULT '192.168.88.0/24'`],
      ['hotspotDnsName', `TEXT NOT NULL DEFAULT 'dartbit.login'`],
      ['staticEnabled', `BOOLEAN NOT NULL DEFAULT false`],
    ];
    for (const [col, type] of provColumns) {
      await safeExec(prisma, `RouterProvisioningConfig.${col}`,
        `ALTER TABLE "RouterProvisioningConfig" ADD COLUMN IF NOT EXISTS "${col}" ${type}`);
    }

    // Unique constraint on routerId
    await safeExec(prisma, 'RouterProvisioningConfig.routerId unique',
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RouterProvisioningConfig_routerId_key') THEN
          ALTER TABLE "RouterProvisioningConfig" ADD CONSTRAINT "RouterProvisioningConfig_routerId_key" UNIQUE ("routerId");
        END IF;
      END $$;`);

    // FK to MikrotikRouter
    await safeExec(prisma, 'RouterProvisioningConfig FK',
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RouterProvisioningConfig_routerId_fkey') THEN
          ALTER TABLE "RouterProvisioningConfig" ADD CONSTRAINT "RouterProvisioningConfig_routerId_fkey" FOREIGN KEY ("routerId") REFERENCES "MikrotikRouter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
      END $$;`);

    // RouterInterface table
    await safeExec(prisma, 'RouterInterface table',
      `CREATE TABLE IF NOT EXISTS "RouterInterface" (
        "id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "macAddr" TEXT,
        "running" BOOLEAN NOT NULL DEFAULT false,
        "disabled" BOOLEAN NOT NULL DEFAULT false,
        "routerId" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "RouterInterface_pkey" PRIMARY KEY ("id")
      )`);

    // OnlineSession table
    await safeExec(prisma, 'OnlineSession table',
      `CREATE TABLE IF NOT EXISTS "OnlineSession" (
        "id" TEXT NOT NULL,
        "username" TEXT NOT NULL,
        "ipAddress" TEXT,
        "macAddress" TEXT,
        "uploadSpeed" DOUBLE PRECISION,
        "downloadSpeed" DOUBLE PRECISION,
        "uptime" TEXT,
        "routerId" TEXT NOT NULL,
        "subscriberId" TEXT,
        "tenantId" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "OnlineSession_pkey" PRIMARY KEY ("id")
      )`);

    // Make host optional on MikrotikRouter
    await safeExec(prisma, 'MikrotikRouter.host nullable',
      `ALTER TABLE "MikrotikRouter" ALTER COLUMN "host" DROP NOT NULL`);

    console.log('✅ Database patch complete');
  } catch (err) {
    console.error('⚠️  Fatal patch error:', err instanceof Error ? err.message : err);
  } finally {
    await prisma.$disconnect();
  }
}

export default app;
