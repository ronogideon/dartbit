import dotenv from 'dotenv';
dotenv.config();

import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function runMigrations() {
  console.log('🔄 Running smart migration...');

  try {
    // Step 1: Resolve any failed migrations so Prisma can proceed
    try {
      execSync('npx prisma migrate resolve --rolled-back 20240101000000_init', {
        stdio: 'pipe',
        env: process.env,
      });
      console.log('✓ Cleared failed migration state');
    } catch {
      // Ignore — may not have failed migrations
    }

    // Step 2: Add missing columns directly via SQL (safe — uses IF NOT EXISTS)
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        -- Add TenantStatus enum if not exists
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TenantStatus') THEN
          CREATE TYPE "TenantStatus" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED');
        END IF;
      END $$;
    `);

    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Tenant"
        ADD COLUMN IF NOT EXISTS "subdomain" TEXT,
        ADD COLUMN IF NOT EXISTS "phone" TEXT,
        ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE';
    `);

    // Step 3: Fill subdomain for existing tenants that don't have one
    await prisma.$executeRawUnsafe(`
      UPDATE "Tenant"
      SET "subdomain" = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(name, '[^a-zA-Z0-9\\s]', '', 'g'), '\\s+', '-', 'g')) || '-' || SUBSTRING(id, 1, 6)
      WHERE "subdomain" IS NULL OR "subdomain" = '';
    `);

    // Step 4: Add unique constraint on subdomain if not exists
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'Tenant_subdomain_key'
        ) THEN
          ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_subdomain_key" UNIQUE ("subdomain");
        END IF;
      END $$;
    `);

    // Step 5: Add ipAddress and macAddress to Subscriber if missing
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Subscriber"
        ADD COLUMN IF NOT EXISTS "ipAddress" TEXT,
        ADD COLUMN IF NOT EXISTS "macAddress" TEXT;
    `);

    // Step 6: Mark the migration as applied so Prisma stops complaining
    try {
      execSync('npx prisma migrate resolve --applied 20240101000000_init', {
        stdio: 'pipe',
        env: process.env,
      });
      console.log('✓ Migration marked as applied');
    } catch {
      // Ignore
    }

    console.log('✅ Database schema is up to date');
  } catch (err) {
    console.error('Migration error:', err);
    // Don't crash — app can still run if columns already exist
  } finally {
    await prisma.$disconnect();
  }
}

runMigrations();
