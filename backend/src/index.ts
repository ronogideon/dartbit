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

app.get('/', (_req, res) => res.json({ service: 'Dartbit API', version: '1.2.3', status: 'running' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '1.2.3', timestamp: new Date().toISOString() }));

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

// START SERVER FIRST — then patch DB in background
const server = app.listen(PORT, () => {
  console.log(`\n🚀 Dartbit v1.2.3 running on port ${PORT}\n`);
  // Patch DB after server is already listening
  patchDatabase();
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

async function patchDatabase() {
  const prisma = new PrismaClient();
  try {
    console.log('🔧 Patching database schema...');

    // Create TenantStatus enum if missing
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TenantStatus') THEN
          CREATE TYPE "TenantStatus" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED');
        END IF;
      END $$;
    `);

    // Add missing columns to Tenant
    await prisma.$executeRawUnsafe(`ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "subdomain" TEXT NOT NULL DEFAULT ''`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "phone" TEXT`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3)`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE'`);

    // Fill empty subdomains for existing tenants
    await prisma.$executeRawUnsafe(`
      UPDATE "Tenant"
      SET "subdomain" = LOWER(
        REGEXP_REPLACE(REGEXP_REPLACE(TRIM(name), '[^a-zA-Z0-9 ]', '', 'g'), ' +', '-', 'g')
      ) || '-' || SUBSTRING(id, 1, 6)
      WHERE "subdomain" = '' OR "subdomain" IS NULL
    `);

    // Add unique constraint on subdomain
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Tenant_subdomain_key') THEN
          ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_subdomain_key" UNIQUE ("subdomain");
        END IF;
      END $$;
    `);

    // Add missing columns to Subscriber
    await prisma.$executeRawUnsafe(`ALTER TABLE "Subscriber" ADD COLUMN IF NOT EXISTS "ipAddress" TEXT`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Subscriber" ADD COLUMN IF NOT EXISTS "macAddress" TEXT`);

    console.log('✅ Database schema patched');
  } catch (err) {
    console.error('⚠️  Patch error (non-fatal):', err instanceof Error ? err.message : err);
  } finally {
    await prisma.$disconnect();
  }
}

export default app;
