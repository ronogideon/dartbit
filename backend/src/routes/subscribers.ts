import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { radiusConfigured } from '../utils/radius';

const router = Router();
router.use(authenticate);

const subscriberSchema = z.object({
  username: z.string().min(2),
  secret: z.string().min(4),
  fullName: z.string().min(2),
  phone: z.string().optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  service: z.enum(['PPPOE', 'HOTSPOT', 'STATIC']).default('PPPOE'),
  packageId: z.string().optional().or(z.literal('')),
  routerId: z.string().optional().or(z.literal('')),
  expiresAt: z.string().optional().or(z.literal('')),
  isActive: z.boolean().optional(),
  ipAddress: z.string().optional().or(z.literal('')),
  macAddress: z.string().optional().or(z.literal('')),
});

// Strip empty strings - converts "" to undefined so they're treated as "don't update"
function cleanForUpdate<T extends Record<string, unknown>>(data: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === '' || v === undefined || v === null) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

// ---- CSV subscriber import (bulk migration from other billing platforms) ----

// Minimal robust CSV parser: handles quoted fields, escaped quotes, embedded commas, CRLF.
function parseCsv(text: string): string[][] {
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

// Flexible date parse: ISO, unix seconds/ms, and day-first D/M/Y (common outside the US).
function parseFlexDate(v: string): Date | null {
  const s = (v || '').trim();
  if (!s) return null;
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
  if (/^\d{13}$/.test(s)) return new Date(Number(s));
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = new Date(s); if (!isNaN(d.getTime())) return d; }
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    const day = Number(m[1]), mon = Number(m[2]), yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(yr, mon - 1, day);
    if (!isNaN(d.getTime())) return d;
  }
  const nat = new Date(s);
  return isNaN(nat.getTime()) ? null : nat;
}

// Column detection shared by analyze + import.
function detectCols(header: string[]) {
  const col = (re: RegExp) => header.findIndex(h => re.test(h));
  return {
    iName: col(/name|customer|client/),
    iUser: col(/user.?name|account|login|^user$|pppoe/),
    iPhone: col(/phone|mobile|msisdn|contact|number|tel/),
    iExpiry: col(/expir|expires|due|valid|end.?date|renew/),
    iSecret: col(/password|secret|^pass|pin/),
    iService: col(/service|type|plan.?type/),
    iEmail: col(/e-?mail/),
    iPackage: col(/package|^plan$|rate.?limit|bandwidth|profile|speed|tariff/),
  };
}

// POST /subscribers/import/analyze — returns the distinct package/rate-limit values in the CSV so
// the tenant can map each to a real Dartbit package before importing.
router.post('/import/analyze', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?.tenantId) return sendError(res, 'No tenant', 400);
    const csv = String(req.body?.csv || '');
    if (!csv.trim()) return sendError(res, 'The CSV is empty', 400);
    const rows = parseCsv(csv);
    if (rows.length < 2) return sendError(res, 'The CSV needs a header row and at least one data row', 400);
    const header = rows[0].map(h => h.trim().toLowerCase());
    const cols = detectCols(header);
    if (cols.iUser === -1 && cols.iName === -1) return sendError(res, 'Could not find a username or name column in the CSV', 400);

    const counts = new Map<string, number>();
    if (cols.iPackage >= 0) {
      for (let r = 1; r < rows.length; r++) {
        const v = (rows[r][cols.iPackage] || '').trim();
        if (v) counts.set(v, (counts.get(v) || 0) + 1);
      }
    }
    const values = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    sendSuccess(res, {
      totalRows: rows.length - 1,
      packageColumn: cols.iPackage >= 0 ? rows[0][cols.iPackage].trim() : null,
      values, // distinct package/rate-limit names to map
      detected: { name: cols.iName >= 0, username: cols.iUser >= 0, phone: cols.iPhone >= 0, expiry: cols.iExpiry >= 0 },
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Analyze failed', 500);
  }
});

// POST /subscribers/import — bulk-create subscribers from a raw CSV in one swoop.
router.post('/import', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const csv = String(req.body?.csv || '');
    if (!csv.trim()) return sendError(res, 'The CSV is empty', 400);

    const rows = parseCsv(csv);
    if (rows.length < 2) return sendError(res, 'The CSV needs a header row and at least one data row', 400);

    const header = rows[0].map(h => h.trim().toLowerCase());
    const { iName, iUser, iPhone, iExpiry, iSecret, iService, iEmail, iPackage } = detectCols(header);
    if (iUser === -1 && iName === -1) return sendError(res, 'Could not find a username or name column in the CSV', 400);

    // mapping: { "<csv package value>": { packageId?, newPackage?: { name, speedDownKbps, speedUpKbps, price?, validityMinutes?, service? } } }
    const mapping: Record<string, { packageId?: string; newPackage?: { name: string; speedDownKbps: number; speedUpKbps: number; price?: number; validityMinutes?: number; service?: string } }> = req.body?.mapping || {};
    const resolvedPkg: Record<string, string> = {}; // lowercased csv value -> real packageId
    const createdPackages: string[] = [];
    for (const [csvVal, m] of Object.entries(mapping)) {
      if (m?.packageId) {
        resolvedPkg[csvVal.toLowerCase()] = m.packageId;
      } else if (m?.newPackage?.name) {
        const np = m.newPackage;
        const pkg = await prisma.package.create({
          data: {
            tenantId, name: np.name,
            service: (np.service === 'HOTSPOT' ? 'HOTSPOT' : 'PPPOE'),
            speedDownKbps: Math.max(1, Math.round(np.speedDownKbps || 1024)),
            speedUpKbps: Math.max(1, Math.round(np.speedUpKbps || 1024)),
            validityMinutes: Math.max(1, Math.round(np.validityMinutes || 43200)), // default 30 days
            price: Math.max(0, np.price || 0),
          },
        });
        resolvedPkg[csvVal.toLowerCase()] = pkg.id;
        createdPackages.push(np.name);
      }
    }

    const existing = new Set((await prisma.subscriber.findMany({ where: { tenantId }, select: { username: true } }))
      .map(s => s.username.toLowerCase()));
    const seen = new Set<string>();
    const toCreate: Array<{ tenantId: string; username: string; secret: string; fullName: string; phone: string | null; email: string | null; service: 'PPPOE' | 'HOTSPOT'; expiresAt: Date | null; isActive: boolean; packageId: string | null }> = [];
    let skipped = 0, noExpiry = 0;

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const cell = (i: number) => (i >= 0 && i < row.length ? row[i].trim() : '');
      const name = iName >= 0 ? cell(iName) : '';
      let username = iUser >= 0 ? cell(iUser) : '';
      if (!username) username = name.replace(/\s+/g, '').toLowerCase(); // derive from name if absent
      if (!username) { skipped++; continue; }
      const key = username.toLowerCase();
      if (existing.has(key) || seen.has(key)) { skipped++; continue; }
      seen.add(key);
      const expiresAt = iExpiry >= 0 ? parseFlexDate(cell(iExpiry)) : null;
      if (iExpiry >= 0 && cell(iExpiry) && !expiresAt) noExpiry++;
      const pkgVal = iPackage >= 0 ? cell(iPackage).toLowerCase() : '';
      const packageId = (pkgVal && resolvedPkg[pkgVal]) || null;
      toCreate.push({
        tenantId, username,
        secret: (iSecret >= 0 && cell(iSecret)) || Math.random().toString(36).slice(2, 10),
        fullName: name || username,
        phone: (iPhone >= 0 && cell(iPhone)) || null,
        email: (iEmail >= 0 && cell(iEmail)) || null,
        service: (iService >= 0 && cell(iService).toUpperCase().includes('HOT')) ? 'HOTSPOT' : 'PPPOE',
        expiresAt, isActive: true, packageId,
      });
    }

    if (toCreate.length === 0) return sendSuccess(res, { imported: 0, skipped, message: 'No new subscribers found to import (all already exist or were blank).' });

    const result = await prisma.subscriber.createMany({ data: toCreate, skipDuplicates: true });

    // Best-effort background RADIUS sync so migrated users can authenticate right away.
    (async () => {
      try {
        const { radiusConfigured, bulkSyncPppoeToRadius, bulkSyncHotspotToRadius } = await import('../utils/radius');
        if (radiusConfigured()) {
          await bulkSyncPppoeToRadius({ tenantId }).catch(() => {});
          await bulkSyncHotspotToRadius({ tenantId }).catch(() => {});
        }
      } catch { /* best-effort */ }
    })();

    sendSuccess(res, { imported: result.count, skipped, unparsedExpiry: noExpiry, total: rows.length - 1, createdPackages });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Import failed', 500);
  }
});

// POST /subscribers/bulk-delete — delete many subscribers at once (with RADIUS cleanup).
router.post('/bulk-delete', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: unknown) => typeof x === 'string') : [];
    if (!ids.length) return sendError(res, 'No subscribers selected', 400);
    const subs = await prisma.subscriber.findMany({ where: { id: { in: ids }, tenantId } });
    try {
      const { radiusConfigured, removeSubscriberFromRadius } = await import('../utils/radius');
      if (radiusConfigured()) {
        for (const s of subs) {
          if (s.service === 'PPPOE' || s.service === 'HOTSPOT') await removeSubscriberFromRadius(s as never).catch(() => {});
        }
      }
    } catch { /* best-effort */ }
    const result = await prisma.subscriber.deleteMany({ where: { id: { in: ids }, tenantId } });
    sendSuccess(res, { deleted: result.count });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Bulk delete failed', 500);
  }
});

// GET /subscribers/counts — lightweight tenant-scoped totals for the sidebar bubbles.
router.get('/counts', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendSuccess(res, { total: 0, active: 0, routers: 0 });
    const now = new Date();
    const [total, active, routers] = await Promise.all([
      prisma.subscriber.count({ where: { tenantId } }),
      prisma.subscriber.count({
        where: { tenantId, isActive: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      }),
      prisma.mikrotikRouter.count({ where: { tenantId } }),
    ]);
    sendSuccess(res, { total, active, routers });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};

    const subscribers = await prisma.subscriber.findMany({
      where,
      include: { package: true, router: true },
      orderBy: [
        { isActive: 'desc' },
        { lastOnlineAt: 'desc' },
      ],
    });

    // Sort: active first, expired last
    const now = new Date();
    const sorted = subscribers.sort((a, b) => {
      const aExpired = a.expiresAt ? a.expiresAt < now : false;
      const bExpired = b.expiresAt ? b.expiresAt < now : false;
      if (aExpired !== bExpired) return aExpired ? 1 : -1;
      return 0;
    });

    // Online status: a subscriber is online if a current OnlineSession exists for them.
    const online = await prisma.onlineSession.findMany({
      where: tenantId ? { tenantId } : {},
      select: { subscriberId: true, username: true },
    });
    const onlineIds = new Set(online.map(o => o.subscriberId).filter(Boolean) as string[]);
    const onlineNames = new Set(online.map(o => o.username));
    const withOnline = sorted.map(s => ({
      ...s,
      isOnline: onlineIds.has(s.id) || onlineNames.has(s.username),
    }));

    sendSuccess(res, withOnline);
  } catch {
    sendError(res, 'Failed to fetch subscribers', 500);
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = subscriberSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);

    const { expiresAt, ...rest } = parsed.data;
    const subscriber = await prisma.subscriber.create({
      data: {
        ...rest,
        tenantId,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      },
      include: { package: true },
    });

    // RADIUS pilot: if this subscriber is on a RADIUS-enabled router, write it into FreeRADIUS too
    // (PPPoE and HOTSPOT). syncSubscriberToRadius internally no-ops for non-RADIUS routers, so this
    // is safe to call unconditionally. Best-effort + parallel to the legacy flow.
    try {
      const { radiusConfigured, syncSubscriberToRadius } = await import('../utils/radius');
      if (radiusConfigured() && (subscriber.service === 'PPPOE' || subscriber.service === 'HOTSPOT')) {
        await syncSubscriberToRadius(subscriber.id);
      }
    } catch (e) {
      console.error('radius sync (create) failed:', e instanceof Error ? e.message : e);
    }

    sendSuccess(res, subscriber, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to create subscriber';
    sendError(res, msg, 500);
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;

    // Strip empty strings BEFORE validation so they're treated as "don't change"
    const cleanedBody = cleanForUpdate(req.body || {});

    const parsed = subscriberSchema.partial().safeParse(cleanedBody);
    if (!parsed.success) return sendError(res, parsed.error.errors[0].message, 400);

    // Verify ownership
    const existing = await prisma.subscriber.findUnique({ where: { id: req.params.id } });
    if (!existing) return sendError(res, 'Subscriber not found', 404);
    if (tenantId && existing.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);

    const { expiresAt, ...rest } = parsed.data;
    const updateData: Record<string, unknown> = { ...rest };
    if (expiresAt !== undefined) {
      updateData.expiresAt = expiresAt ? new Date(expiresAt) : null;
    }

    const subscriber = await prisma.subscriber.update({
      where: { id: req.params.id },
      data: updateData,
      include: { package: true, router: true },
    });

    // Push the change to the router immediately (applied within ~2s by the cmd poller) so a manual
    // edit takes effect at once: if the subscriber is now expired/inactive/without a package, the
    // helper emits removal + session-kick commands (the device is thrown out); if still entitled, it
    // (re)creates the users. Covers the case of an admin setting expiry to the past to disconnect.
    // When RADIUS is the active auth system we do NOT push local users to the router at all — the
    // radcheck sync above is authoritative. Local pushes only happen in legacy (non-RADIUS) mode.
    if (subscriber.routerId && subscriber.service === 'HOTSPOT' && !radiusConfigured()) {
      try {
        const { pushSubscriberToRouter } = await import('../utils/pushSubscriber');
        await pushSubscriberToRouter(subscriber.id);
      } catch (e) {
        console.error('update: router push failed (continuing):', e instanceof Error ? e.message : e);
      }
    } else if (subscriber.routerId && subscriber.service !== 'HOTSPOT' && !radiusConfigured()) {
      // PPPoE/static: toggle the secret enable/disable + kick active session to match new state.
      try {
        const { enqueueCommand } = await import('../utils/commandQueue');
        const now = new Date();
        const expired = subscriber.expiresAt ? subscriber.expiresAt <= now : false;
        const entitled = subscriber.isActive && !expired;
        if (entitled) {
          await enqueueCommand(subscriber.routerId, `:foreach s in=[/ppp secret find name="${subscriber.username}"] do={ /ppp secret set $s disabled=no }`);
        } else {
          await enqueueCommand(subscriber.routerId,
            `:foreach s in=[/ppp secret find name="${subscriber.username}"] do={ /ppp secret set $s disabled=yes }\n` +
            `:foreach a in=[/ppp active find name="${subscriber.username}"] do={ /ppp active remove $a }`);
        }
      } catch (e) {
        console.error('update: ppp router push failed (continuing):', e instanceof Error ? e.message : e);
      }
    }

    // RADIUS: reflect edits into FreeRADIUS + CoA-kick if now unentitled (PPPoE and HOTSPOT).
    try {
      const { radiusConfigured, syncSubscriberToRadius } = await import('../utils/radius');
      if (radiusConfigured() && (subscriber.service === 'PPPOE' || subscriber.service === 'HOTSPOT')) {
        // kickToApply: drop the live session so the new state takes effect immediately — into the
        // walled garden if it just expired, or back to full service if the expiry was pushed out.
        await syncSubscriberToRadius(subscriber.id, { kickToApply: true });
      }
    } catch (e) {
      console.error('radius sync (update) failed:', e instanceof Error ? e.message : e);
    }

    sendSuccess(res, subscriber);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update subscriber';
    console.error('Update subscriber error:', msg);
    sendError(res, msg, 500);
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const sub = await prisma.subscriber.findUnique({ where: { id: req.params.id }, include: { router: { select: { radiusEnabled: true } } } });
    if (!sub) return sendError(res, 'Subscriber not found', 404);
    // Tenant scoping: a tenant admin can only delete their own subscribers.
    if (req.user?.tenantId && sub.tenantId !== req.user.tenantId) {
      return sendError(res, 'Not authorized', 403);
    }

    // Remove from the router immediately so they're kicked off (within ~2s via the cmd poller).
    // Use the shared helper so the MAC auto-login user + session/cookie/host are all cleared too.
    if (sub.routerId) {
      try {
        if (sub.service === 'HOTSPOT') {
          // RADIUS clears radcheck + CoA-kicks below. Local removal only in legacy mode.
          if (!radiusConfigured()) {
            const { pushSubscriberRemoval } = await import('../utils/pushSubscriber');
            await pushSubscriberRemoval(sub.routerId, sub.username, sub.macAddress);
          }
        } else if (!radiusConfigured()) {
          const { enqueueCommand } = await import('../utils/commandQueue');
          await enqueueCommand(sub.routerId,
            `:foreach a in=[/ppp active find name="${sub.username}"] do={ /ppp active remove $a }\n` +
            `:foreach s in=[/ppp secret find name="${sub.username}"] do={ /ppp secret remove $s }`);
        }
      } catch (e) {
        console.error('subscriber delete: router cleanup failed (continuing):', e instanceof Error ? e.message : e);
      }
    }

    // RADIUS: remove the user from FreeRADIUS + CoA-kick the live session (PPPoE and HOTSPOT).
    try {
      const { radiusConfigured, removeSubscriberFromRadius } = await import('../utils/radius');
      if (radiusConfigured() && (sub.service === 'PPPOE' || sub.service === 'HOTSPOT')) {
        await removeSubscriberFromRadius(sub as never);
      }
    } catch (e) {
      console.error('radius removal (delete) failed:', e instanceof Error ? e.message : e);
    }

    // Remove the subscriber AND their session/usage data to keep server storage low.
    // OnlineSession (live) + SessionRecord (history + data usage) are deleted; Payment rows are
    // financial records, so we keep them but unlink the subscriber. Done in one transaction.
    await prisma.$transaction([
      prisma.onlineSession.deleteMany({ where: { subscriberId: req.params.id } }),
      prisma.onlineSession.deleteMany({ where: { tenantId: sub.tenantId, username: sub.username } }),
      prisma.sessionRecord.deleteMany({ where: { subscriberId: req.params.id } }),
      prisma.sessionRecord.deleteMany({ where: { tenantId: sub.tenantId, username: sub.username } }),
      prisma.payment.updateMany({ where: { subscriberId: req.params.id }, data: { subscriberId: null } }),
      prisma.subscriber.delete({ where: { id: req.params.id } }),
    ]);
    sendSuccess(res, { deleted: true });
  } catch (err) {
    console.error('Delete subscriber error:', err instanceof Error ? err.message : err);
    sendError(res, err instanceof Error ? `Failed to delete subscriber: ${err.message}` : 'Failed to delete subscriber', 500);
  }
});

// POST /subscribers/:id/extend — add time to a subscriber's expiry. Body: { minutes }.
// Adds to the CURRENT expiry if still in the future, otherwise from now (so extending an
// already-expired subscriber starts their new window from the moment of extension).
router.post('/:id/extend', async (req: AuthRequest, res: Response) => {
  try {
    const minutes = Number(req.body?.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return sendError(res, 'minutes must be > 0', 400);

    const sub = await prisma.subscriber.findUnique({ where: { id: req.params.id } });
    if (!sub) return sendError(res, 'Subscriber not found', 404);
    if (req.user?.tenantId && sub.tenantId !== req.user.tenantId) return sendError(res, 'Not authorized', 403);

    const now = new Date();
    const base = sub.expiresAt && sub.expiresAt > now ? sub.expiresAt : now;
    const newExpiry = new Date(base.getTime() + minutes * 60 * 1000);

    const updated = await prisma.subscriber.update({
      where: { id: sub.id },
      data: { expiresAt: newExpiry, isActive: true },
    });

    // RADIUS-managed routers enforce expiry from the radcheck `Expiration` item, so the new expiry
    // MUST be written there — otherwise RADIUS keeps enforcing the old window. syncSubscriberToRadius
    // no-ops for non-RADIUS routers, so this is safe to call unconditionally. (This was the gap that
    // made frontend expiry changes not take effect on RADIUS.)
    try {
      const { radiusConfigured, syncSubscriberToRadius } = await import('../utils/radius');
      if (radiusConfigured() && (sub.service === 'PPPOE' || sub.service === 'HOTSPOT')) {
        await syncSubscriberToRadius(sub.id);
      }
    } catch (e) {
      console.error('extend: radius sync failed (continuing):', e instanceof Error ? e.message : e);
    }

    // Keep the unified identity in lockstep: if this hotspot device has a linked M-Pesa voucher
    // (the receipt code), update its expiry to the SAME session end so the code, username/password
    // and MAC all expire together. Matched by the device MAC within this tenant.
    if (sub.service === 'HOTSPOT' && sub.macAddress) {
      try {
        await prisma.voucher.updateMany({
          where: { tenantId: sub.tenantId, batchId: 'MPESA', usedByMac: sub.macAddress.toUpperCase() },
          data: { expiresAt: newExpiry },
        });
      } catch (e) {
        console.error('extend: voucher expiry sync failed (continuing):', e instanceof Error ? e.message : e);
      }
    }

    // Push the change to the router (re-enable + update) via a sync so the user isn't kicked.
    // Legacy mode only — under RADIUS the radcheck Expiration written above is authoritative.
    if (sub.routerId && !radiusConfigured()) {
      try {
        const { enqueueCommand } = await import('../utils/commandQueue');
        if (sub.service === 'HOTSPOT') {
          await enqueueCommand(sub.routerId, `:foreach u in=[/ip hotspot user find name="${sub.username}"] do={ /ip hotspot user set $u disabled=no }`);
        } else {
          await enqueueCommand(sub.routerId, `:foreach s in=[/ppp secret find name="${sub.username}"] do={ /ppp secret set $s disabled=no }`);
        }
      } catch (e) {
        console.error('extend: router update failed (continuing):', e instanceof Error ? e.message : e);
      }
    }

    sendSuccess(res, { id: updated.id, expiresAt: updated.expiresAt });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed to extend', 500);
  }
});

// GET /subscribers/:id/detail — full subscriber info + 30-day usage + session history
router.get('/:id/detail', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const sub = await prisma.subscriber.findUnique({
      where: { id: req.params.id },
      include: { package: true, router: true },
    });
    if (!sub) return sendError(res, 'Subscriber not found', 404);
    if (tenantId && sub.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Session history for the past 30 days (most recent first)
    const records = await prisma.sessionRecord.findMany({
      where: {
        tenantId: sub.tenantId,
        subscriberId: sub.id,
        startedAt: { gte: thirtyDaysAgo },
      },
      orderBy: { startedAt: 'desc' },
      take: 500,
    });

    // Totals over the 30-day window
    // Byte semantics (subscriber POV):
    //   SessionRecord.rxBytes = counter the MikroTik RECEIVES from client = subscriber UPLOAD
    //   SessionRecord.txBytes = counter the MikroTik SENDS to client    = subscriber DOWNLOAD
    let totalUpload = 0n, totalDownload = 0n;
    const sessions = records.map(rec => {
      totalUpload += rec.rxBytes;
      totalDownload += rec.txBytes;
      const durationMs = (rec.endedAt ?? rec.lastSeenAt).getTime() - rec.startedAt.getTime();
      return {
        id: rec.id,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        active: !rec.endedAt,
        durationSeconds: Math.max(0, Math.round(durationMs / 1000)),
        ipAddress: rec.ipAddress,
        downloadBytes: rec.txBytes.toString(),
        uploadBytes: rec.rxBytes.toString(),
      };
    });

    const payments = await prisma.payment.findMany({
      where: { tenantId: sub.tenantId, subscriberId: sub.id },
      orderBy: { createdAt: 'desc' }, take: 200,
      include: { package: { select: { name: true } } },
    });
    const lifetimeValue = payments.reduce((s, p) => s + (p.amount || 0), 0);
    const messages = await prisma.message.findMany({
      where: { tenantId: sub.tenantId, OR: [{ subscriberId: sub.id }, ...(sub.phone ? [{ recipient: sub.phone }] : [])] },
      orderBy: { createdAt: 'desc' }, take: 200,
    });

    sendSuccess(res, {
      subscriber: {
        id: sub.id, username: sub.username, fullName: sub.fullName,
        phone: sub.phone, email: sub.email, service: sub.service,
        password: sub.secret,
        isActive: sub.isActive, expiresAt: sub.expiresAt,
        lastOnlineAt: sub.lastOnlineAt, ipAddress: sub.ipAddress,
        macAddress: sub.macAddress, createdAt: sub.createdAt,
        package: sub.package ? { id: sub.package.id, name: sub.package.name,
          speedUpKbps: sub.package.speedUpKbps, speedDownKbps: sub.package.speedDownKbps } : null,
        router: sub.router ? { id: sub.router.id, name: sub.router.name } : null,
      },
      usage30d: {
        totalDownloadBytes: totalDownload.toString(),
        totalUploadBytes: totalUpload.toString(),
        totalBytes: (totalDownload + totalUpload).toString(),
        sessionCount: records.length,
      },
      sessions,
      payments: payments.map(p => ({
        id: p.id, amount: p.amount, method: p.method, source: p.source,
        reference: p.reference, mpesaCode: p.mpesaCode, packageName: p.package?.name || null,
        createdAt: p.createdAt,
      })),
      lifetimeValue,
      messages: messages.map(m => ({
        id: m.id, recipient: m.recipient, body: m.body, status: m.status,
        category: m.category, createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    console.error('Subscriber detail error:', err);
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export default router;
