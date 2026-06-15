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

app.get('/', (_req, res) => res.json({ service: 'Dartbit API', version: '1.10.55', status: 'running' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '1.10.55', timestamp: new Date().toISOString() }));

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
  console.log(`\n🚀 Dartbit v1.10.55 running on port ${PORT}\n`);
  patchDatabase();
  startSessionCleanup();
  startBillingStatusUpdater();
  startExpiryWatcher();
  startWgStatusRefresher();
  startAutoDeleteScheduler();
  startFreeradiusHealthCheck();
  startWinboxAutoClose();
  // NOTE: the live "who's online + speed" view is owned by the router-side 3s dartbit-sessions
  // reporter (single writer of OnlineSession). RADIUS still does accounting (radacct) in the
  // background for billing/usage; we intentionally do NOT mirror radacct into OnlineSession here,
  // to avoid two writers racing on the same rows.
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
  const kicked = new Map<string, number>(); // subscriberId -> last-kick epoch (ms), to avoid hammering
  const walledSynced = new Map<string, number>(); // subscriberId -> expiresAt(ms) already pushed to walled-garden
  const run = async () => {
    try {
      const now = new Date();

      // (0) Ensure expired-but-enabled PPPoE subscribers are in the WALLED GARDEN at the RADIUS layer
      // even when OFFLINE. An expired user is otherwise rejected at auth (stale Expiration), so they
      // never get online, never become a kick candidate, and never have their walled-garden reply
      // written — an endless redial. We write it once per expiry (deduped) so the very next auth is
      // ACCEPTED into the dartbit-expired list. Payment later re-syncs them to full service + CoA.
      try {
        const radiusMod = await import('./utils/radius').catch(() => null);
        if (radiusMod?.radiusConfigured()) {
          const expiredPppoe = await prisma.subscriber.findMany({
            where: { service: 'PPPOE', isActive: true, routerId: { not: null }, expiresAt: { lte: now } },
            select: { id: true, expiresAt: true },
          });
          for (const s of expiredPppoe) {
            const exp = s.expiresAt ? s.expiresAt.getTime() : 0;
            if (walledSynced.get(s.id) === exp) continue; // already walled-gardened for this expiry window
            walledSynced.set(s.id, exp);
            await radiusMod.syncSubscriberToRadius(s.id)
              .catch(e => console.error('[walled-garden] sync failed', s.id, e instanceof Error ? e.message : e));
          }
          if (walledSynced.size > 5000) { let n = 0; for (const k of walledSynced.keys()) { walledSynced.delete(k); if (++n > 1000) break; } }
        }
      } catch (e) { console.error('[walled-garden] pass error:', e instanceof Error ? e.message : e); }

      // Subscribers who are NO LONGER entitled but STILL have a live session — these are the ones to
      // disconnect. Covers PPPoE AND Hotspot, and runs regardless of RADIUS mode: we kick via the
      // RELIABLE command queue (/ppp active remove, /ip hotspot active remove) rather than CoA, which
      // proved unreliable (a router needs `/radius incoming accept=yes` for CoA, and even then PPPoE
      // matching is finicky). The radcheck rows are also cleared so they can't immediately re-auth.
      const candidates = await prisma.subscriber.findMany({
        where: {
          service: { in: ['PPPOE', 'HOTSPOT'] },
          routerId: { not: null },
          sessions: { some: { createdAt: { gte: new Date(now.getTime() - 60_000) } } }, // online now (snapshot refreshed ~5s)
          OR: [
            { isActive: false },
            { expiresAt: { lte: now } },
            { AND: [{ service: 'HOTSPOT' }, { packageId: null }, { expiresAt: null }] },
          ],
        },
        select: { id: true, username: true, service: true, macAddress: true, routerId: true, expiresAt: true, isActive: true, packageId: true },
      });
      if (candidates.length === 0) return;

      const { enqueueCommand } = await import('./utils/commandQueue');
      let radius: typeof import('./utils/radius') | null = null;
      try { radius = await import('./utils/radius'); } catch { radius = null; }

      for (const sub of candidates) {
        const expired = sub.expiresAt ? sub.expiresAt <= now : false;
        const entitled = sub.service === 'HOTSPOT'
          ? (sub.isActive && (!!sub.packageId || !!sub.expiresAt) && !expired)
          : (sub.isActive && !expired);
        if (entitled) continue;

        // Don't re-kick the same subscriber more than once per 20s — gives the router and the 5s
        // session reporter time to drop them out of the candidate set.
        if (Date.now() - (kicked.get(sub.id) || 0) < 20_000) continue;
        kicked.set(sub.id, Date.now());

        // (a) Stop them re-authenticating. Under RADIUS, clear radcheck (guarantees rejection even if
        // the Expiration attribute is evaluated in a different timezone on the FreeRADIUS host). In
        // legacy mode, disable the local credential.
        try {
          if (radius?.radiusConfigured()) {
            await radius.syncSubscriberToRadius(sub.id);
          } else if (sub.service === 'PPPOE') {
            await enqueueCommand(sub.routerId!, `:foreach s in=[/ppp secret find name="${sub.username}"] do={ /ppp secret set $s disabled=yes }`);
          } else {
            const { pushSubscriberToRouter } = await import('./utils/pushSubscriber');
            await pushSubscriberToRouter(sub.id);
          }
        } catch (e) { console.error('expiry: deauth failed for', sub.username, e instanceof Error ? e.message : e); }

        // (b) Drop the LIVE session reliably via the command queue (executes on the ~2s poll).
        try {
          if (sub.service === 'PPPOE') {
            await enqueueCommand(sub.routerId!, `:foreach a in=[/ppp active find name="${sub.username}"] do={ /ppp active remove $a }`);
          } else {
            const mac = (sub.macAddress || '').toUpperCase();
            const macClause = mac ? ` or mac-address="${mac}"` : '';
            await enqueueCommand(sub.routerId!, `:foreach a in=[/ip hotspot active find where user="${sub.username}"${macClause}] do={ /ip hotspot active remove $a }`);
          }
          console.log(`[expiry] kicked ${sub.username} (${sub.service})`);
        } catch (e) { console.error('expiry: kick failed for', sub.username, e instanceof Error ? e.message : e); }
      }

      // Age out the dedup map so it doesn't grow unbounded.
      if (kicked.size > 5000) { const c = Date.now(); for (const [k, v] of kicked) if (c - v > 120_000) kicked.delete(k); }
    } catch (err) {
      console.error('Expiry watcher error:', err instanceof Error ? err.message : err);
    }
  };
  run();
  setInterval(run, 10 * 1000); // every 10s — disconnects an expired user within ~10–12s
}

// Auto-close remote Winbox access once its window lapses: tears down the droplet DNAT so management
// ports aren't left open. Runs every minute.
function startWinboxAutoClose() {
  const prisma = new PrismaClient();
  const run = async () => {
    try {
      const now = new Date();
      const due = await prisma.mikrotikRouter.findMany({
        where: { winboxOpenUntil: { not: null, lte: now }, winboxPort: { not: null } },
        select: { id: true, winboxPort: true },
      });
      if (!due.length) return;
      const { closeWinboxPort } = await import('./utils/wireguard');
      for (const r of due) {
        if (r.winboxPort) await closeWinboxPort(r.winboxPort).catch(() => {});
        await prisma.mikrotikRouter.update({ where: { id: r.id }, data: { winboxOpenUntil: null } }).catch(() => {});
      }
    } catch (e) {
      console.error('[winbox] auto-close error:', e instanceof Error ? e.message : e);
    }
  };
  run();
  setInterval(run, 60 * 1000); // every 60s
}

// Periodically pull WireGuard peer handshakes from the droplet so the router cards show live VPN
// status. Best-effort; does nothing if the VPN isn't configured.
function startWgStatusRefresher() {
  const run = async () => {
    try {
      const { wgConfigured, refreshWgStatus } = await import('./utils/wireguard');
      if (!wgConfigured()) return;
      await refreshWgStatus();
    } catch (err) {
      console.error('WG status refresh error:', err instanceof Error ? err.message : err);
    }
  };
  run();
  setInterval(run, 60 * 1000); // every 60s
}

// Auto-remove subscribers that have been offline longer than each tenant's configured threshold
// (default 90 days; 0 = never). Applies to PPPoE, Hotspot, and Static. "Offline since" = lastOnlineAt
// if known, otherwise createdAt (a subscriber that never came online). Cleans RADIUS first.
function startAutoDeleteScheduler() {
  const prisma = new PrismaClient();
  const run = async () => {
    try {
      const settings = await prisma.tenantSetting.findMany({ select: { tenantId: true, autoDeleteOfflineDays: true } as never }) as never as { tenantId: string; autoDeleteOfflineDays: number }[];
      const { radiusConfigured, removeSubscriberFromRadius } = await import('./utils/radius');
      for (const st of settings) {
        const days = st.autoDeleteOfflineDays ?? 90;
        if (!days || days <= 0) continue; // 0 / unset → never auto-delete
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        // Offline-since is lastOnlineAt when present, else createdAt. Both must be before the cutoff.
        const stale = await prisma.subscriber.findMany({
          where: {
            tenantId: st.tenantId,
            OR: [
              { lastOnlineAt: { not: null, lt: cutoff } },
              { lastOnlineAt: null, createdAt: { lt: cutoff } },
            ],
          },
        });
        for (const sub of stale) {
          try {
            if (radiusConfigured()) await removeSubscriberFromRadius(sub as never).catch(() => {});
            await prisma.subscriber.delete({ where: { id: sub.id } });
            console.log(`[auto-delete] removed ${sub.username} (offline > ${days}d, tenant ${st.tenantId})`);
          } catch (e) {
            console.error('[auto-delete] failed for', sub.username, e instanceof Error ? e.message : e);
          }
        }
      }
    } catch (err) {
      console.error('auto-delete scheduler error:', err instanceof Error ? err.message : err);
    }
  };
  // First pass shortly after boot, then once every 12 hours.
  setTimeout(run, 5 * 60 * 1000);
  setInterval(run, 12 * 60 * 60 * 1000);
}

// Every 5 minutes, make sure FreeRADIUS is alive on the droplet; restart it if it died (duplicate
// client file, OOM on the small droplet, etc.). Without this, a dead FreeRADIUS silently times out
// every router's RADIUS until someone SSHes in.
function startFreeradiusHealthCheck() {
  const run = async () => {
    try {
      const { ensureFreeradiusUp } = await import('./utils/radius');
      await ensureFreeradiusUp();
    } catch { /* best-effort */ }
  };
  setTimeout(run, 30 * 1000); // first check shortly after boot
  setInterval(run, 5 * 60 * 1000);
}

// Populate the active-sessions view from FreeRADIUS accounting (radacct) instead of every router
// polling /router/sessions every 5s. One backend read replaces N routers × 12 fetches/min, which is
// the biggest CPU/traffic saving on the router side. Mirrors radacct open sessions into OnlineSession,
// resolving each to its subscriber by username or device MAC.
function startRadiusSessionSync() {
  const prisma = new PrismaClient();
  const lastBytes = new Map<string, { in: number; out: number; at: number }>();
  const run = async () => {
    try {
      const { radiusConfigured, getRadiusActiveSessions } = await import('./utils/radius');
      if (!radiusConfigured()) return;
      const rows = await getRadiusActiveSessions();

      const routers = await prisma.mikrotikRouter.findMany({ where: { wgIp: { not: null } }, select: { id: true, tenantId: true, wgIp: true } });
      const byWgIp = new Map<string, { id: string; tenantId: string }>();
      for (const r of routers) if (r.wgIp) byWgIp.set(r.wgIp, { id: r.id, tenantId: r.tenantId });

      const usernames = Array.from(new Set(rows.map(r => r.username).filter(Boolean)));
      const macs = Array.from(new Set(rows.map(r => r.mac).filter(Boolean)));
      const macVariants = macs.flatMap(m => [m, m.toLowerCase()]);
      const subs = usernames.length || macVariants.length ? await prisma.subscriber.findMany({
        where: { OR: [usernames.length ? { username: { in: usernames } } : undefined, macVariants.length ? { macAddress: { in: macVariants } } : undefined].filter(Boolean) as object[] },
        select: { id: true, username: true, macAddress: true, tenantId: true },
      }) : [];
      const subByUser = new Map<string, { id: string; username: string }>();
      const subByMac = new Map<string, { id: string; username: string }>();
      for (const s of subs) {
        subByUser.set(`${s.tenantId}:${s.username}`, { id: s.id, username: s.username });
        if (s.macAddress) subByMac.set(`${s.tenantId}:${s.macAddress.toUpperCase()}`, { id: s.id, username: s.username });
      }

      const now = Date.now();
      const perRouter = new Map<string, Array<Record<string, unknown>>>();
      const matchedSubs = new Set<string>();
      for (const row of rows) {
        const r = byWgIp.get(row.nasIp);
        if (!r) continue;
        const sub = subByUser.get(`${r.tenantId}:${row.username}`) || (row.mac ? subByMac.get(`${r.tenantId}:${row.mac}`) : undefined);
        const key = `${r.id}:${row.username}`;
        const prev = lastBytes.get(key);
        let up = 0, down = 0;
        if (prev) { const dt = (now - prev.at) / 1000; if (dt > 0 && dt < 300) { up = Math.max(0, Math.round(((row.inOctets - prev.in) * 8) / 1024 / dt)); down = Math.max(0, Math.round(((row.outOctets - prev.out) * 8) / 1024 / dt)); } }
        lastBytes.set(key, { in: row.inOctets, out: row.outOctets, at: now });
        if (sub) matchedSubs.add(sub.id);
        const arr = perRouter.get(r.id) || [];
        arr.push({
          username: sub?.username || row.username,
          ipAddress: row.framedIp || null, macAddress: row.mac || null,
          uploadSpeed: up, downloadSpeed: down, uptime: String(row.sessionSecs),
          routerId: r.id, subscriberId: sub?.id || null, tenantId: r.tenantId,
        });
        perRouter.set(r.id, arr);
      }

      // Replace the snapshot for every RADIUS router (clears routers that now have no sessions).
      for (const r of routers) {
        await prisma.onlineSession.deleteMany({ where: { routerId: r.id } });
        const list = perRouter.get(r.id);
        if (list && list.length) { for (const d of list) await prisma.onlineSession.create({ data: d as never }); }
      }
      if (matchedSubs.size) await prisma.subscriber.updateMany({ where: { id: { in: Array.from(matchedSubs) } }, data: { lastOnlineAt: new Date() } });
    } catch (err) {
      console.error('radius session sync error:', err instanceof Error ? err.message : err);
    }
  };
  run();
  setInterval(run, 15 * 1000); // every 15s — RADIUS-native, replaces the per-router 5s reporter
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

    // MikrotikRouter — remote Winbox port-forward (per-router DNAT on the droplet).
    await safeExec(prisma, 'MikrotikRouter.winboxPort', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "winboxPort" INTEGER`);
    await safeExec(prisma, 'MikrotikRouter.winboxOpenUntil', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "winboxOpenUntil" TIMESTAMP(3)`);
    await safeExec(prisma, 'MikrotikRouter.winboxUser', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "winboxUser" TEXT`);
    await safeExec(prisma, 'MikrotikRouter.winboxPass', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "winboxPass" TEXT`);

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
    // v1.10.21 payout/fee columns
    await safeExec(prisma, 'MpesaTx collectedVia', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "collectedVia" TEXT DEFAULT 'TENANT'`);
    await safeExec(prisma, 'MpesaTx platformFee', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "platformFee" DOUBLE PRECISION NOT NULL DEFAULT 0`);
    await safeExec(prisma, 'MpesaTx netToTenant', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "netToTenant" DOUBLE PRECISION NOT NULL DEFAULT 0`);
    await safeExec(prisma, 'MpesaTx payoutStatus', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "payoutStatus" TEXT`);
    await safeExec(prisma, 'MpesaTx payoutRef', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "payoutRef" TEXT`);
    await safeExec(prisma, 'MpesaTx payoutAt', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "payoutAt" TIMESTAMP(3)`);

    // v1.10.23 — classify payments as AUTOMATIC (gateway-created) vs MANUAL (admin-recorded).
    // Backfill: any existing payment that carries an M-Pesa receipt was gateway-created.
    await safeExec(prisma, 'Payment.source', `ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'MANUAL'`);
    await safeExec(prisma, 'Payment.source backfill', `UPDATE "Payment" SET "source"='AUTOMATIC' WHERE "source"='MANUAL' AND "mpesaCode" IS NOT NULL`);

    // v1.10.27 — PPPoE/Static renewals carry the exact subscriber, and tenant-configurable auto-delete.
    await safeExec(prisma, 'MpesaTx.subscriberId', `ALTER TABLE "MpesaTransaction" ADD COLUMN IF NOT EXISTS "subscriberId" TEXT`);
    await safeExec(prisma, 'TenantSetting.autoDeleteOfflineDays', `ALTER TABLE "TenantSetting" ADD COLUMN IF NOT EXISTS "autoDeleteOfflineDays" INTEGER NOT NULL DEFAULT 90`);

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

    // v1.10.21 — editable templates + system alerts.
    await safeExec(prisma, 'NotifConfig templates', `ALTER TABLE "NotificationConfig" ADD COLUMN IF NOT EXISTS "templates" JSONB`);
    await safeExec(prisma, 'NotifConfig provider', `ALTER TABLE "NotificationConfig" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'BLESSEDTEXTS'`);
    await safeExec(prisma, 'Package isTrial', `ALTER TABLE "Package" ADD COLUMN IF NOT EXISTS "isTrial" BOOLEAN NOT NULL DEFAULT false`);
    await safeExec(prisma, 'Router wgIp', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "wgIp" TEXT`);
    await safeExec(prisma, 'Router wgPublicKey', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "wgPublicKey" TEXT`);
    await safeExec(prisma, 'Router wgPrivateKey', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "wgPrivateKey" TEXT`);
    await safeExec(prisma, 'Router wgPeerAdded', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "wgPeerAdded" BOOLEAN NOT NULL DEFAULT false`);
    await safeExec(prisma, 'Router wgLastHandshake', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "wgLastHandshake" TIMESTAMP(3)`);
    await safeExec(prisma, 'Router radiusSecret', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "radiusSecret" TEXT`);
    await safeExec(prisma, 'Router radiusEnabled', `ALTER TABLE "MikrotikRouter" ADD COLUMN IF NOT EXISTS "radiusEnabled" BOOLEAN NOT NULL DEFAULT false`);
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
