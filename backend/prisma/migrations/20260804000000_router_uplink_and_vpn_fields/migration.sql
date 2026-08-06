-- v1.11.24/25: VPN endpoint-family display + dual-uplink / explicit-bridge fields.
-- Additive only. IF NOT EXISTS makes it safe on databases already synced via `prisma db push`.
ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "wgEndpoint" TEXT;
ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "wgVia" TEXT;
ALTER TABLE "RouterProvisioningConfig" ADD COLUMN IF NOT EXISTS "wanInterface2" TEXT;
ALTER TABLE "RouterProvisioningConfig" ADD COLUMN IF NOT EXISTS "autoBridgeLan" BOOLEAN NOT NULL DEFAULT true;
