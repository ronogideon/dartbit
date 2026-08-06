-- v1.11.26: dual-WAN load balancing + auto-failover toggle. Additive, IF NOT EXISTS (safe on db-push DBs).
ALTER TABLE "RouterProvisioningConfig" ADD COLUMN IF NOT EXISTS "loadBalance" BOOLEAN NOT NULL DEFAULT false;
