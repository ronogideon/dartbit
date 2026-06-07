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
import notificationsRoutes from './routes/notifications';
import { startReminderScheduler } from './utils/reminderScheduler';
import { startSystemAlerts } from './utils/systemAlerts';
import routerRoutes from './routes/routers';
import onlineSessionRoutes from './routes/onlineSessions';
import analyticsRoutes from './routes/analytics';
import expenseRoutes from './routes/expenses';
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
import subscriberPortalRoutes from './routes/subscriberPortal';
import superadminAnalyticsRoutes from './routes/superadminAnalytics';
import superadminMessagingRoutes, { loadPlatformDefaults } from './routes/superadminMessaging';
import hotspotHtmlRoutes from './routes/hotspotHtml';

const app = express();
const PORT = process.env.PORT || 4000;

const allowedOrigins = [
  'https://api.dartbittech.com',                 // backend (self / same-origin calls)
  'https://dartbittech.com',                     // apex frontend
  'https://www.dartbittech.com',                 // www
  'https://app.dartbittech.com',                 // app subdomain (if used)
  'https://dartbit.up.railway.app',              // legacy main frontend (transition)
  'http://localhost:3000',                       // local dev — main frontend
  'http://localhost:3001',                       // local dev — superadmin frontend
  process.env.FRONTEND_URL,                      // override / additional main frontend origin
  process.env.SUPERADMIN_URL,                    // the separate superadmin analytics portal
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
    // Allow any subdomain of the configured portal base domain (e.g. *.dartbit.app)
    // so each tenant's subscriber portal can call the shared backend.
    const base = process.env.PORTAL_BASE_DOMAIN; // e.g. "dartbit.app"
    if (base) {
      try {
        const host = new URL(origin).hostname;
        if (host === base || host.endsWith(`.${base}`)) return callback(null, true);
      } catch { /* ignore */ }
    }
    callback(null, false);
  },
  credentials: true,
}));

// Webhooks must be registered BEFORE express.json() so the raw body is preserved
// for Paystack's HMAC signature verification.
app.use('/webhooks', webhookRoutes);

app.use(express.json());

app.get('/', (_req, res) => res.json({ service: 'Dartbit API', version: '1.10.13', status: 'running' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '1.10.13', timestamp: new Date().toISOString() }));

app.use('/auth', authRoutes);
app.use('/signup', signupRoutes);
app.use('/admin', adminRoutes);
app.use('/router', routerZtpRoutes);
app.use('/subscribers', subscriberRoutes);
app.use('/packages', packageRoutes);
app.use('/payments', paymentRoutes);
app.use('/messages', messageRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/mikrotiks', routerRoutes);
app.use('/online-sessions', onlineSessionRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/expenses', expenseRoutes);
app.use('/tenants', tenantRoutes);
app.use('/settings', settingsRoutes);
app.use('/vouchers', voucherRoutes);
app.use('/billing', billingRoutes);
app.use('/users', usersRoutes);
app.use('/payment-config', paymentConfigRoutes);
app.use('/hotspot', mpesaRoutes);
app.use('/hotspot', hotspotPublicRoutes);
app.use('/portal', subscriberPortalRoutes);
app.use('/superadmin/messaging', superadminMessagingRoutes);
app.use('/superadmin', superadminAnalyticsRoutes);
app.use('/hotspot-html', hotspotHtmlRoutes);

app.use((_req, res) => res.status(404).json({ success: false, error: 'Route not found' }));

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Dartbit v1.10.13 running on port ${PORT}\n`);
  patchDatabase();
  startSessionCleanup();
  startBillingStatusUpdater();
  startExpiryWatcher();
  startReminderScheduler();
  startSystemAlerts();
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

// Aggressive expiry enforcement: every 5 seconds, find hotspot subscribers whose package has just
// expired and push an immediate removal (user delete + session kick + host/cookie clear) so the
// device is thrown out within ~5s of expiry and gets no more data until they buy again. A short
// in-memory dedup set avoids re-pushing the same expiry every tick; entries age out after a few
// minutes so a re-created session is caught again. The 60s sync remains the safety-net reconciler.
function startExpiryWatcher() {
  const prisma = new PrismaClient();
  const pushed = new Map<string, number>(); // subscriberId -> expiry epoch already pushed
  const run = async () => {
    try {
      const now = new Date();
      // Find HOTSPOT subscribers who are NOT entitled (expired or deactivated) but STILL have a live
      // OnlineSession on a router — these are the ones to kick, regardless of HOW LONG ago they
      // expired. (The old 10-minute window missed admins setting expiry far in the past.) Keying off
      // the live session table keeps this precise and cheap.
      const liveSessions = await prisma.onlineSession.findMany({
        where: { subscriber: { service: 'HOTSPOT' } },
        select: { subscriberId: true, subscriber: { select: { id: true, isActive: true, expiresAt: true, packageId: true, routerId: true } } },
      });
      const toKick: { id: string; exp: number }[] = [];
      for (const ls of liveSessions) {
        const sub = ls.subscriber;
        if (!sub || !sub.routerId) continue;
        const expired = sub.expiresAt ? sub.expiresAt <= now : false;
        const entitled = sub.isActive && !!sub.packageId && !expired;
        if (!entitled) toKick.push({ id: sub.id, exp: sub.expiresAt ? sub.expiresAt.getTime() : 0 });
      }
      const { pushSubscriberToRouter } = await import('./utils/pushSubscriber');
      for (const s of toKick) {
        // Re-push if we haven't pushed this exact expiry yet (handles expiry being changed/renewed).
        if (pushed.get(s.id) === s.exp) continue;
        await pushSubscriberToRouter(s.id); // builds removal cmds for an unentitled sub
        pushed.set(s.id, s.exp);
      }
      // Age out the dedup map so a device that reconnects after a stale session is re-kicked, and
      // so the map doesn't grow unbounded.
      if (pushed.size > 5000) pushed.clear();
    } catch (err) {
      console.error('Expiry watcher error:', err instanceof Error ? err.message : err);
    }
  };
  run();
  setInterval(run, 3 * 1000); // every 3 seconds — aggressive enforcement (≈5s incl. 2s router poll)
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

    // Expense ledger (SMS top-ups, tenancy, manual)
    await safeExec(prisma, 'Expense table',
      `CREATE TABLE IF NOT EXISTS "Expense" (
        "id" TEXT NOT NULL,
        "tenantId" TEXT NOT NULL,
        "amount" DOUBLE PRECISION NOT NULL,
        "category" TEXT NOT NULL DEFAULT 'OTHER',
        "description" TEXT,
        "paymentMode" TEXT,
        "reference" TEXT,
        "source" TEXT NOT NULL DEFAULT 'MANUAL',
        "incurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
      )`);
    await safeExec(prisma, 'Expense tenant idx', `CREATE INDEX IF NOT EXISTS "Expense_tenantId_incurredAt_idx" ON "Expense"("tenantId","incurredAt")`);

    // System users: add TENANT_VIEWER enum value + User.isActive
    await safeExec(prisma, 'UserRole TENANT_VIEWER', `ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'TENANT_VIEWER'`);
    await safeExec(prisma, 'UserRole SUPERADMIN_VIEWER', `ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'SUPERADMIN_VIEWER'`);
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
    // v1.10.13 payout/fee columns
    await safeExec(prisma, 'MpesaTx collectedVia', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "collectedVia" TEXT DEFAULT 'TENANT'`);
    await safeExec(prisma, 'MpesaTx platformFee', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "platformFee" DOUBLE PRECISION NOT NULL DEFAULT 0`);
    await safeExec(prisma, 'MpesaTx netToTenant', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "netToTenant" DOUBLE PRECISION NOT NULL DEFAULT 0`);
    await safeExec(prisma, 'MpesaTx payoutStatus', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "payoutStatus" TEXT`);
    await safeExec(prisma, 'MpesaTx payoutRef', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "payoutRef" TEXT`);
    await safeExec(prisma, 'MpesaTx payoutAt', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "payoutAt" TIMESTAMP(3)`);

    // Persistent router command queue (replaces in-memory queue that lost commands on restart)
    await safeExec(prisma, 'RouterCommand table',
      `CREATE TABLE IF NOT EXISTS "RouterCommand" (
        "id" TEXT NOT NULL,
        "routerId" TEXT NOT NULL,
        "command" TEXT NOT NULL,
        "consumed" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "RouterCommand_pkey" PRIMARY KEY ("id")
      )`);
    await safeExec(prisma, 'RouterCommand idx', `CREATE INDEX IF NOT EXISTS "RouterCommand_routerId_consumed_idx" ON "RouterCommand"("routerId","consumed")`);

    // Notifications config table (per-tenant SMS gateway + automatic notification settings).
    await safeExec(prisma, 'NotificationConfig table',
      `CREATE TABLE IF NOT EXISTS "NotificationConfig" (
        "id" TEXT NOT NULL,
        "tenantId" TEXT NOT NULL,
        "gateway" TEXT NOT NULL DEFAULT 'DARTBIT',
        "apiKey" TEXT,
        "senderId" TEXT,
        "sendWelcome" BOOLEAN NOT NULL DEFAULT true,
        "sendPaymentReceipt" BOOLEAN NOT NULL DEFAULT true,
        "sendExpiryReminders" BOOLEAN NOT NULL DEFAULT true,
        "reminderOffsets" INTEGER[] NOT NULL DEFAULT ARRAY[7200, 4320, 240]::INTEGER[],
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "NotificationConfig_pkey" PRIMARY KEY ("id")
      )`);
    await safeExec(prisma, 'NotificationConfig tenant unique', `CREATE UNIQUE INDEX IF NOT EXISTS "NotificationConfig_tenantId_key" ON "NotificationConfig"("tenantId")`);

    // Extend Message with phone/cost/delivery/dedup columns (idempotent ALTERs).
    for (const col of [
      `ADD COLUMN IF NOT EXISTS "gateway" TEXT`,
      `ADD COLUMN IF NOT EXISTS "gatewayMsgId" TEXT`,
      `ADD COLUMN IF NOT EXISTS "cost" DOUBLE PRECISION NOT NULL DEFAULT 0`,
      `ADD COLUMN IF NOT EXISTS "errorCode" TEXT`,
      `ADD COLUMN IF NOT EXISTS "errorMessage" TEXT`,
      `ADD COLUMN IF NOT EXISTS "subscriberId" TEXT`,
      `ADD COLUMN IF NOT EXISTS "username" TEXT`,
      `ADD COLUMN IF NOT EXISTS "category" TEXT`,
      `ADD COLUMN IF NOT EXISTS "dedupKey" TEXT`,
    ]) {
      await safeExec(prisma, `Message ${col.replace(/.*"([^"]+)".*/, '$1')}`, `ALTER TABLE "Message" ${col}`);
    }
    await safeExec(prisma, 'Message dedupKey unique', `CREATE UNIQUE INDEX IF NOT EXISTS "Message_dedupKey_key" ON "Message"("dedupKey") WHERE "dedupKey" IS NOT NULL`);

    // Allow deleting a subscriber without FK violations: make Payment.subscriberId and
    // OnlineSession.subscriberId nullable and ON DELETE SET NULL (so payments are preserved
    // for the record, sessions just detach). Previously deleting a subscriber failed with
    // "Failed to delete subscriber" because of these foreign keys.
    await safeExec(prisma, 'Payment.subscriberId nullable', `ALTER TABLE "Payment" ALTER COLUMN "subscriberId" DROP NOT NULL`);
    await safeExec(prisma, 'Payment FK drop', `ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_subscriberId_fkey"`);
    await safeExec(prisma, 'Payment FK setnull', `ALTER TABLE "Payment" ADD CONSTRAINT "Payment_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE`);
    await safeExec(prisma, 'OnlineSession FK drop', `ALTER TABLE "OnlineSession" DROP CONSTRAINT IF EXISTS "OnlineSession_subscriberId_fkey"`);
    await safeExec(prisma, 'OnlineSession FK setnull', `ALTER TABLE "OnlineSession" ADD CONSTRAINT "OnlineSession_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE`);

    // SMS prepaid wallet (per-tenant balance), ledger, and platform settings.
    await safeExec(prisma, 'SmsWallet table',
      `CREATE TABLE IF NOT EXISTS "SmsWallet" (
        "id" TEXT NOT NULL,
        "tenantId" TEXT NOT NULL,
        "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "toppedUp" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "spent" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "SmsWallet_pkey" PRIMARY KEY ("id")
      )`);
    await safeExec(prisma, 'SmsWallet tenant unique', `CREATE UNIQUE INDEX IF NOT EXISTS "SmsWallet_tenantId_key" ON "SmsWallet"("tenantId")`);
    await safeExec(prisma, 'SmsWalletTxn table',
      `CREATE TABLE IF NOT EXISTS "SmsWalletTxn" (
        "id" TEXT NOT NULL,
        "walletId" TEXT NOT NULL,
        "tenantId" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "amount" DOUBLE PRECISION NOT NULL,
        "balanceAfter" DOUBLE PRECISION NOT NULL,
        "reference" TEXT,
        "note" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "SmsWalletTxn_pkey" PRIMARY KEY ("id")
      )`);
    await safeExec(prisma, 'SmsWalletTxn idx', `CREATE INDEX IF NOT EXISTS "SmsWalletTxn_tenantId_createdAt_idx" ON "SmsWalletTxn"("tenantId","createdAt")`);
    await safeExec(prisma, 'PlatformSetting table',
      `CREATE TABLE IF NOT EXISTS "PlatformSetting" (
        "id" TEXT NOT NULL,
        "key" TEXT NOT NULL,
        "value" TEXT NOT NULL,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id")
      )`);
    await safeExec(prisma, 'PlatformSetting key unique', `CREATE UNIQUE INDEX IF NOT EXISTS "PlatformSetting_key_key" ON "PlatformSetting"("key")`);
    await safeExec(prisma, 'MpesaTransaction purpose', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "purpose" TEXT`);

    // v1.10.13 — editable templates + system alerts.
    await safeExec(prisma, 'NotifConfig templates', `ALTER TABLE "NotificationConfig" ADD COLUMN IF NOT EXISTS "templates" JSONB`);
    await safeExec(prisma, 'NotifConfig provider', `ALTER TABLE "NotificationConfig" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'BLESSEDTEXTS'`);
    await safeExec(prisma, 'Package isTrial', `ALTER TABLE "Package" ADD COLUMN IF NOT EXISTS "isTrial" BOOLEAN NOT NULL DEFAULT false`);
    await safeExec(prisma, 'TrialClaim table', `CREATE TABLE IF NOT EXISTS "TrialClaim" ("id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "macAddress" TEXT NOT NULL, "packageId" TEXT, "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await safeExec(prisma, 'TrialClaim unique', `CREATE UNIQUE INDEX IF NOT EXISTS "TrialClaim_tenantId_macAddress_key" ON "TrialClaim" ("tenantId", "macAddress")`);
    await safeExec(prisma, 'NotifConfig alertPhones', `ALTER TABLE "NotificationConfig" ADD COLUMN IF NOT EXISTS "alertPhones" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`);
    await safeExec(prisma, 'NotifConfig routerOfflineAlert', `ALTER TABLE "NotificationConfig" ADD COLUMN IF NOT EXISTS "routerOfflineAlert" BOOLEAN NOT NULL DEFAULT true`);
    await safeExec(prisma, 'NotifConfig lowBalanceAlert', `ALTER TABLE "NotificationConfig" ADD COLUMN IF NOT EXISTS "lowBalanceAlert" BOOLEAN NOT NULL DEFAULT true`);
    await safeExec(prisma, 'NotifConfig lowBalanceThreshold', `ALTER TABLE "NotificationConfig" ADD COLUMN IF NOT EXISTS "lowBalanceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 50`);
    await safeExec(prisma, 'Router offlineAlertSent', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "offlineAlertSent" BOOLEAN NOT NULL DEFAULT false`);
    await safeExec(prisma, 'SmsWallet lowBalanceAlerted', `ALTER TABLE "SmsWallet" ADD COLUMN IF NOT EXISTS "lowBalanceAlerted" BOOLEAN NOT NULL DEFAULT false`);
    await safeExec(prisma, 'User phone', `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT`);
    await safeExec(prisma, 'Payment packageId', `ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "packageId" TEXT`);
    await safeExec(prisma, 'Tenant themeColor', `ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "themeColor" TEXT`);
    await safeExec(prisma, 'Tenant fontFamily', `ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "fontFamily" TEXT`);
    await safeExec(prisma, 'Tenant supportPhone', `ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "supportPhone" TEXT`);
    await safeExec(prisma, 'Router setupStage', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "setupStage" TEXT NOT NULL DEFAULT 'COMPLETE'`);
    await safeExec(prisma, 'Router offlineSince', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "offlineSince" TIMESTAMP(3)`);

    console.log('✅ Database patch complete');
    // Load superadmin platform-default message templates into the notification baseline.
    await loadPlatformDefaults();
  } catch (err) {
    console.error('⚠️  Fatal patch error:', err instanceof Error ? err.message : err);
  } finally {
    await prisma.$disconnect();
  }
}

export default app;
