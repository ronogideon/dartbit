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
import voucherRoutes from './routes/vouchers';
import billingRoutes from './routes/billing';
import usersRoutes from './routes/users';
import paymentConfigRoutes from './routes/paymentConfig';
import webhookRoutes from './routes/webhooks';
import hotspotPublicRoutes from './routes/hotspotPublic';
import mpesaRoutes from './routes/mpesa';
import hotspotHtmlRoutes from './routes/hotspotHtml';

const app = express();
const PORT = process.env.PORT || 4000;

const allowedOrigins = [
  'https://dartbit-production.up.railway.app',
  'https://accomplished-patience-production-dd5a.up.railway.app',
  'http://localhost:3000',
  'http://localhost:3001',
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

// Captive portal pages are served by MikroTik routers from their gateway IPs
// (typically 40.40.88.1, 192.168.x.x, 10.x.x.x). The portal makes AJAX to this backend
// for voucher/credential verification. Allow these origins for CORS.
function isCaptivePortalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:') return false;
    const host = url.hostname;
    // 40.40.0.0/8 — our default captive portal subnet
    if (/^40\.40\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    // RFC1918 private ranges — covers any tenant-customized hotspot subnet
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (isCaptivePortalOrigin(origin)) return callback(null, true);
    // For other origins, don't throw — just don't set CORS headers.
    // Route-level middleware (e.g. on /hotspot) can override with permissive headers.
    callback(null, false);
  },
  credentials: true,
}));

// Webhooks must be registered BEFORE express.json() so the raw body is preserved
// for Paystack's HMAC signature verification.
app.use('/webhooks', webhookRoutes);

app.use(express.json());

app.get('/', (_req, res) => res.json({ service: 'Dartbit API', version: '1.6.8', status: 'running' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '1.6.8', timestamp: new Date().toISOString() }));

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
app.use('/vouchers', voucherRoutes);
app.use('/billing', billingRoutes);
app.use('/users', usersRoutes);
app.use('/payment-config', paymentConfigRoutes);
app.use('/hotspot', mpesaRoutes);
app.use('/hotspot', hotspotPublicRoutes);
app.use('/hotspot-html', hotspotHtmlRoutes);

app.use((_req, res) => res.status(404).json({ success: false, error: 'Route not found' }));

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Dartbit v1.6.8 running on port ${PORT}\n`);
  patchDatabase();
  startSessionCleanup();
  startBillingStatusUpdater();
});

// Prune SessionRecords older than 30 days. Before deleting, ensure each subscriber's
// lastOnlineAt reflects their most recent session (so we keep the "last seen" summary).
function startSessionCleanup() {
  const prisma = new PrismaClient();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const run = async () => {
    try {
      const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
      // Delete ended sessions that ended before the cutoff.
      // (Subscriber.lastOnlineAt is already maintained live by the /sessions endpoint,
      //  so the "last online" summary survives pruning.)
      const result = await prisma.sessionRecord.deleteMany({
        where: { endedAt: { not: null, lt: cutoff } },
      });
      if (result.count > 0) console.log(`🧹 Pruned ${result.count} sessions older than 30 days`);
      // Also finalize zombie sessions: started but never ended and not seen in 10 minutes
      // (e.g. backend restarted and lost the in-memory active map).
      const zombieCutoff = new Date(Date.now() - 10 * 60 * 1000);
      await prisma.sessionRecord.updateMany({
        where: { endedAt: null, lastSeenAt: { lt: zombieCutoff } },
        data: { endedAt: zombieCutoff },
      });
    } catch (err) {
      console.error('Session cleanup error:', err instanceof Error ? err.message : err);
    }
  };
  run();
  setInterval(run, 60 * 60 * 1000); // hourly
}

// Update each tenant's billingStatus based on their due date:
//   no due date         -> unchanged (trial / not yet billed)
//   due in >5 days       -> CURRENT
//   due within 5 days    -> DUE_SOON
//   past due             -> OVERDUE
// PAID is set explicitly on payment confirmation (and cleared when a new cycle's
// due date is set). This runs alongside session cleanup.
function startBillingStatusUpdater() {
  const prisma = new PrismaClient();
  const run = async () => {
    try {
      const now = Date.now();
      const FIVE_DAYS = 5 * 24 * 60 * 60 * 1000;
      const tenants = await prisma.tenant.findMany({
        where: { billingDueDate: { not: null } },
        select: { id: true, billingDueDate: true, billingStatus: true },
      });
      for (const t of tenants) {
        if (!t.billingDueDate) continue;
        const due = t.billingDueDate.getTime();
        let status: string;
        if (now > due) status = 'OVERDUE';
        else if (due - now <= FIVE_DAYS) status = 'DUE_SOON';
        else status = 'CURRENT';
        // Don't override a PAID status that's still within the current cycle.
        if (t.billingStatus === 'PAID' && now <= due) continue;
        if (status !== t.billingStatus) {
          await prisma.tenant.update({ where: { id: t.id }, data: { billingStatus: status } });
        }
      }
    } catch (err) {
      console.error('Billing status update error:', err instanceof Error ? err.message : err);
    }
  };
  run();
  setInterval(run, 30 * 60 * 1000); // every 30 min
}

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

    // Voucher table
    await safeExec(prisma, 'Voucher table',
      `CREATE TABLE IF NOT EXISTS "Voucher" (
        "id" TEXT NOT NULL,
        "tenantId" TEXT NOT NULL,
        "code" TEXT NOT NULL,
        "packageId" TEXT,
        "routerId" TEXT,
        "durationMinutes" INTEGER NOT NULL DEFAULT 60,
        "isUsed" BOOLEAN NOT NULL DEFAULT false,
        "usedAt" TIMESTAMP(3),
        "usedByMac" TEXT,
        "usedByIp" TEXT,
        "expiresAt" TIMESTAMP(3),
        "batchId" TEXT,
        "notes" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
      )`);
    await safeExec(prisma, 'Voucher.code unique', `CREATE UNIQUE INDEX IF NOT EXISTS "Voucher_code_key" ON "Voucher"("code")`);
    await safeExec(prisma, 'Voucher tenant idx', `CREATE INDEX IF NOT EXISTS "Voucher_tenantId_isUsed_idx" ON "Voucher"("tenantId","isUsed")`);
    await safeExec(prisma, 'Voucher batch idx', `CREATE INDEX IF NOT EXISTS "Voucher_batchId_idx" ON "Voucher"("batchId")`);

    // SessionRecord table — persistent session history
    await safeExec(prisma, 'SessionRecord table',
      `CREATE TABLE IF NOT EXISTS "SessionRecord" (
        "id" TEXT NOT NULL,
        "username" TEXT NOT NULL,
        "service" "ServiceType" NOT NULL DEFAULT 'PPPOE',
        "ipAddress" TEXT,
        "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "endedAt" TIMESTAMP(3),
        "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "rxBytes" BIGINT NOT NULL DEFAULT 0,
        "txBytes" BIGINT NOT NULL DEFAULT 0,
        "startRx" BIGINT NOT NULL DEFAULT 0,
        "startTx" BIGINT NOT NULL DEFAULT 0,
        "subscriberId" TEXT,
        "routerId" TEXT,
        "tenantId" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "SessionRecord_pkey" PRIMARY KEY ("id")
      )`);
    await safeExec(prisma, 'SessionRecord sub idx', `CREATE INDEX IF NOT EXISTS "SessionRecord_tenantId_subscriberId_startedAt_idx" ON "SessionRecord"("tenantId","subscriberId","startedAt")`);
    await safeExec(prisma, 'SessionRecord user idx', `CREATE INDEX IF NOT EXISTS "SessionRecord_tenantId_username_startedAt_idx" ON "SessionRecord"("tenantId","username","startedAt")`);
    await safeExec(prisma, 'SessionRecord ended idx', `CREATE INDEX IF NOT EXISTS "SessionRecord_endedAt_idx" ON "SessionRecord"("endedAt")`);

    // Tenant billing columns
    await safeExec(prisma, 'Tenant.billingDueDate', `ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "billingDueDate" TIMESTAMP(3)`);
    await safeExec(prisma, 'Tenant.billingStatus', `ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "billingStatus" TEXT NOT NULL DEFAULT 'CURRENT'`);

    // TenantPayment table — platform billing history
    await safeExec(prisma, 'TenantPayment table',
      `CREATE TABLE IF NOT EXISTS "TenantPayment" (
        "id" TEXT NOT NULL,
        "tenantId" TEXT NOT NULL,
        "amount" DOUBLE PRECISION NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "paystackRef" TEXT,
        "paystackUrl" TEXT,
        "periodStart" TIMESTAMP(3) NOT NULL,
        "periodEnd" TIMESTAMP(3) NOT NULL,
        "dueDate" TIMESTAMP(3) NOT NULL,
        "paidAt" TIMESTAMP(3),
        "pppoeCount" INTEGER NOT NULL DEFAULT 0,
        "pppoeCharge" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "hotspotIncome" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "hotspotCharge" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "TenantPayment_pkey" PRIMARY KEY ("id")
      )`);
    await safeExec(prisma, 'TenantPayment ref unique', `CREATE UNIQUE INDEX IF NOT EXISTS "TenantPayment_paystackRef_key" ON "TenantPayment"("paystackRef")`);
    await safeExec(prisma, 'TenantPayment tenant idx', `CREATE INDEX IF NOT EXISTS "TenantPayment_tenantId_status_idx" ON "TenantPayment"("tenantId","status")`);

    // System users: add TENANT_VIEWER enum value + User.isActive
    await safeExec(prisma, 'UserRole TENANT_VIEWER', `ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'TENANT_VIEWER'`);
    await safeExec(prisma, 'User.isActive', `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true`);

    // PaymentConfig — tenant's collection method + (encrypted) credentials
    await safeExec(prisma, 'PaymentConfig table',
      `CREATE TABLE IF NOT EXISTS "PaymentConfig" (
        "id" TEXT NOT NULL,
        "tenantId" TEXT NOT NULL,
        "method" TEXT NOT NULL DEFAULT 'TILL_MANUAL',
        "payoutTill" TEXT,
        "payoutPhone" TEXT,
        "darajaShortcode" TEXT,
        "darajaType" TEXT,
        "darajaConsumerKey" TEXT,
        "darajaConsumerSecret" TEXT,
        "darajaPasskey" TEXT,
        "kopoClientId" TEXT,
        "kopoClientSecret" TEXT,
        "kopoTillNumber" TEXT,
        "kopoApiKey" TEXT,
        "configured" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PaymentConfig_pkey" PRIMARY KEY ("id")
      )`);
    await safeExec(prisma, 'PaymentConfig tenant unique', `CREATE UNIQUE INDEX IF NOT EXISTS "PaymentConfig_tenantId_key" ON "PaymentConfig"("tenantId")`);

    // MpesaTransaction — STK push lifecycle for hotspot purchases
    await safeExec(prisma, 'MpesaTransaction table',
      `CREATE TABLE IF NOT EXISTS "MpesaTransaction" (
        "id" TEXT NOT NULL,
        "tenantId" TEXT NOT NULL,
        "routerId" TEXT,
        "packageId" TEXT,
        "phone" TEXT NOT NULL,
        "amount" DOUBLE PRECISION NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "checkoutRequestId" TEXT,
        "merchantRequestId" TEXT,
        "mpesaReceipt" TEXT,
        "username" TEXT,
        "password" TEXT,
        "clientMac" TEXT,
        "clientIp" TEXT,
        "durationMinutes" INTEGER NOT NULL DEFAULT 60,
        "expiresAt" TIMESTAMP(3),
        "resultDesc" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "MpesaTransaction_pkey" PRIMARY KEY ("id")
      )`);
    await safeExec(prisma, 'MpesaTx checkout unique', `CREATE UNIQUE INDEX IF NOT EXISTS "MpesaTransaction_checkoutRequestId_key" ON "MpesaTransaction"("checkoutRequestId")`);
    await safeExec(prisma, 'MpesaTx tenant idx', `CREATE INDEX IF NOT EXISTS "MpesaTransaction_tenantId_status_idx" ON "MpesaTransaction"("tenantId","status")`);
    // v1.6.8 payout/fee columns
    await safeExec(prisma, 'MpesaTx collectedVia', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "collectedVia" TEXT DEFAULT 'TENANT'`);
    await safeExec(prisma, 'MpesaTx platformFee', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "platformFee" DOUBLE PRECISION NOT NULL DEFAULT 0`);
    await safeExec(prisma, 'MpesaTx netToTenant', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "netToTenant" DOUBLE PRECISION NOT NULL DEFAULT 0`);
    await safeExec(prisma, 'MpesaTx payoutStatus', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "payoutStatus" TEXT`);
    await safeExec(prisma, 'MpesaTx payoutRef', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "payoutRef" TEXT`);
    await safeExec(prisma, 'MpesaTx payoutAt', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "payoutAt" TIMESTAMP(3)`);

    console.log('✅ Database patch complete');
  } catch (err) {
    console.error('⚠️  Fatal patch error:', err instanceof Error ? err.message : err);
  } finally {
    await prisma.$disconnect();
  }
}

export default app;
