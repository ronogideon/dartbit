// Fair Use Policy (FUP)
// ---------------------------------------------------------------------------------------------
// Throttles a subscriber once they pass a per-package data allowance, then restores full speed at
// the start of the next period.
//
// Scope (deliberate, see v1.11.76 notes):
//   * PPPoE only for now. STATIC has NO usage source on the router today — the ZTP reporter only
//     emits sessions marked P (PPPoE) or H (hotspot), and radius.ts never syncs STATIC — so a
//     Static cap could not be measured, only pretended. Adding per-IP queue accounting to the ZTP
//     is the follow-up that unlocks it.
//   * HOTSPOT is out of scope by product decision (sessions are too short for a daily cap).
//
// Usage sources (both are per-SESSION counters that reset on reconnect, so neither can be read as
// a running total directly):
//   * RADIUS path  — sum radacct rows whose session STARTED inside the period. Open sessions carry
//     live counters thanks to radius-interim-update, so in-flight usage is included.
//   * Legacy path  — the reporter re-sends a session's cumulative counters every cycle, so we store
//     the last value seen per session (OnlineSession.lastBytes*) and accumulate the DELTA.
//
// Everything is keyed on subscriberId, never routerId: replacing a MikroTik must not lose a
// customer's history. routerId is recorded for reference only and may be null.

import prisma from './prisma';

// Kenya is UTC+3 year-round (no DST), so a fixed offset is correct for "midnight EAT".
const EAT_OFFSET_MIN = 3 * 60;

export type PeriodType = 'DAILY' | 'MONTHLY';

export interface FupPeriod {
  periodType: PeriodType;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date | null;
}

// Resolve the current period window for a subscriber.
//   DAILY   — calendar day in EAT; the throttle lifts at midnight.
//   MONTHLY — pinned to the subscriber's own billing cycle, NOT the calendar month: the window runs
//             from (expiresAt - validityMinutes) to expiresAt, so the allowance resets when they
//             renew rather than on the 1st.
export function resolvePeriod(
  periodType: PeriodType,
  sub: { expiresAt?: Date | null },
  pkg: { validityMinutes?: number | null },
  now = new Date(),
): FupPeriod {
  if (periodType === 'DAILY') {
    const shifted = new Date(now.getTime() + EAT_OFFSET_MIN * 60_000);
    const key = shifted.toISOString().slice(0, 10); // YYYY-MM-DD in EAT
    const startUtc = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - EAT_OFFSET_MIN * 60_000);
    return { periodType, periodKey: key, periodStart: startUtc, periodEnd: new Date(startUtc.getTime() + 86_400_000) };
  }

  // MONTHLY, anchored to the billing cycle.
  const validityMs = Math.max(1, pkg.validityMinutes || 43_200) * 60_000;
  const end = sub.expiresAt ? new Date(sub.expiresAt) : null;
  const start = end ? new Date(end.getTime() - validityMs) : new Date(now.getTime() - validityMs);
  return {
    periodType,
    periodKey: start.toISOString().slice(0, 10),
    periodStart: start,
    periodEnd: end,
  };
}

// The throttled speed for a package. One percentage applies to BOTH directions (product decision);
// MANUAL takes explicit kbps for each. Never returns 0 — a 0 rate-limit on MikroTik means
// "unlimited", which would be the exact opposite of throttling.
export function throttleSpeedFor(pkg: {
  speedUpKbps: number; speedDownKbps: number;
  fupThrottleMode?: string | null; fupThrottlePercent?: number | null;
  fupThrottleUpKbps?: number | null; fupThrottleDownKbps?: number | null;
}): { up: number; down: number } {
  if ((pkg.fupThrottleMode || 'PERCENT') === 'MANUAL') {
    return {
      up: Math.max(64, pkg.fupThrottleUpKbps || 512),
      down: Math.max(64, pkg.fupThrottleDownKbps || 512),
    };
  }
  const pct = Math.min(100, Math.max(1, pkg.fupThrottlePercent ?? 20));
  return {
    up: Math.max(64, Math.round((pkg.speedUpKbps * pct) / 100)),
    down: Math.max(64, Math.round((pkg.speedDownKbps * pct) / 100)),
  };
}

// Bytes that count toward the cap, per the package's counting mode.
function countedBytes(mode: string | null | undefined, bytesIn: number, bytesOut: number): number {
  // NAS perspective: acctinputoctets is traffic the subscriber UPLOADED, acctoutputoctets is what
  // they DOWNLOADED. bytesIn/bytesOut on our rows follow the same convention.
  return (mode || 'COMBINED') === 'DOWNLOAD' ? bytesOut : bytesIn + bytesOut;
}

// The throttle currently in force for a subscriber, or null. Used by radius.ts so an unrelated
// resync doesn't wipe an active throttle.
export async function activeThrottleFor(subscriberId: string): Promise<{ up: number; down: number } | null> {
  try {
    const sub = await prisma.subscriber.findUnique({
      where: { id: subscriberId },
      include: { package: true },
    });
    if (!sub?.package) return null;
    const pkg = sub.package as unknown as Record<string, unknown>;
    if (!pkg.fupEnabled) return null;

    const period = resolvePeriod((pkg.fupPeriod as PeriodType) || 'MONTHLY', sub, sub.package);
    const row = await prisma.subscriberUsage.findFirst({
      where: { subscriberId, periodType: period.periodType, periodKey: period.periodKey },
      select: { throttled: true },
    });
    if (!row?.throttled) return null;
    return throttleSpeedFor(sub.package as never);
  } catch {
    return null;
  }
}

// Pull period usage for a RADIUS-managed subscriber straight out of radacct. Sessions that STARTED
// inside the window are counted in full; a session spanning a boundary lands in the period it began
// (an accepted approximation — the alternative is per-interim delta bookkeeping for marginal gain).
async function radacctUsage(username: string, since: Date): Promise<{ bytesIn: number; bytesOut: number } | null> {
  try {
    const { radiusConfigured } = await import('./radius');
    if (!radiusConfigured()) return null;
    const { radiusUsageSince } = await import('./radius');
    return await radiusUsageSince(username, since);
  } catch {
    return null;
  }
}

// Legacy (non-RADIUS) accumulation.
// The ZTP reporter already computes per-session byte deltas every ~5s to derive live speed. Writing
// those to the database on every poll would be N routers x M sessions of writes per 5 seconds, so
// deltas are buffered in memory here and drained by the 5-minute sweep instead.
// Consequence: a backend restart drops the un-drained buffer (at most 5 minutes of usage per
// subscriber). That is an acceptable undercount for a fair-use cap, and it only affects legacy
// routers — on RADIUS the totals are re-read from radacct and are authoritative.
const legacyBuffer = new Map<string, { routerId: string | null; bytesIn: number; bytesOut: number }>();

export function bufferLegacyDelta(tenantId: string, username: string, routerId: string | null, dIn: number, dOut: number): void {
  if ((dIn <= 0 && dOut <= 0) || !username) return;
  const key = `${tenantId}|${username}`;
  const cur = legacyBuffer.get(key) || { routerId, bytesIn: 0, bytesOut: 0 };
  cur.bytesIn += dIn; cur.bytesOut += dOut; cur.routerId = routerId ?? cur.routerId;
  legacyBuffer.set(key, cur);
}

// Move buffered legacy deltas into the period buckets. Entries are removed as they're consumed so a
// failure mid-drain can't double-count.
async function drainLegacyBuffer(): Promise<void> {
  if (legacyBuffer.size === 0) return;
  const entries = Array.from(legacyBuffer.entries());
  legacyBuffer.clear();
  for (const [key, val] of entries) {
    const [tenantId, username] = key.split('|');
    try {
      const sub = await prisma.subscriber.findFirst({
        where: { tenantId, username, service: 'PPPOE' },
        include: { package: true },
      });
      if (!sub?.package) continue;
      const pkg = sub.package as unknown as Record<string, unknown>;
      if (!pkg.fupEnabled) continue;
      const period = resolvePeriod((pkg.fupPeriod as PeriodType) || 'MONTHLY', sub, sub.package);
      await addUsage({
        subscriberId: sub.id, tenantId, routerId: val.routerId,
        period, bytesIn: val.bytesIn, bytesOut: val.bytesOut,
      });
    } catch (e) {
      console.error('[fup] drain failed for', key, e instanceof Error ? e.message : e);
    }
  }
}

// Upsert a usage delta into the period bucket.
async function addUsage(p: {
  subscriberId: string; tenantId: string; routerId: string | null;
  period: FupPeriod; bytesIn: number; bytesOut: number;
}): Promise<void> {
  const { subscriberId, tenantId, routerId, period, bytesIn, bytesOut } = p;
  await prisma.subscriberUsage.upsert({
    where: {
      subscriberId_periodType_periodKey: {
        subscriberId, periodType: period.periodType, periodKey: period.periodKey,
      },
    } as never,
    create: {
      subscriberId, tenantId, routerId,
      periodType: period.periodType, periodKey: period.periodKey,
      periodStart: period.periodStart, periodEnd: period.periodEnd,
      bytesIn, bytesOut,
    } as never,
    update: { bytesIn: { increment: bytesIn }, bytesOut: { increment: bytesOut }, routerId } as never,
  });
}

// Apply or lift the throttle for one subscriber.
async function setThrottle(sub: { id: string; username: string; routerId: string | null; service: string },
                           speed: { up: number; down: number } | null): Promise<void> {
  const { radiusConfigured } = await import('./radius');
  if (radiusConfigured()) {
    // RADIUS: rewrite the rate-limit, then kick the session so the new limit binds immediately —
    // rate-limit is handed out at authentication, so without a re-auth it wouldn't apply until the
    // subscriber happened to reconnect.
    const { syncSubscriberToRadius } = await import('./radius');
    await syncSubscriberToRadius(sub.id, { throttleKbps: speed, kickToApply: true });
    return;
  }
  // Legacy: push the PPP profile rate-limit for this user. Takes effect on their next reconnect,
  // so throttling on a legacy router is not instantaneous.
  if (!sub.routerId) return;
  const { enqueueCommand } = await import('./commandQueue');
  const rl = speed ? `${speed.up}k/${speed.down}k` : '';
  if (!rl) return;
  await enqueueCommand(sub.routerId,
    `:foreach s in=[/ppp secret find name="${sub.username}"] do={ /ppp secret set $s rate-limit="${rl}" }`);
}

// Evaluate every FUP-enabled subscriber: accumulate RADIUS usage, then throttle or release.
// Idempotent and safe to run on a timer.
export async function runFupSweep(): Promise<{ checked: number; throttled: number; released: number }> {
  let checked = 0, throttled = 0, released = 0;
  await drainLegacyBuffer();
  const subs = await prisma.subscriber.findMany({
    where: { service: 'PPPOE', package: { fupEnabled: true } as never },
    include: { package: true },
  });

  for (const sub of subs) {
    if (!sub.package) continue;
    const pkg = sub.package as unknown as Record<string, unknown>;
    const limitMb = Number(pkg.fupLimitMb || 0);
    if (limitMb <= 0) continue;
    checked++;

    try {
      const period = resolvePeriod((pkg.fupPeriod as PeriodType) || 'MONTHLY', sub, sub.package);

      // RADIUS path: refresh the bucket from radacct (authoritative). Legacy path accumulates via
      // recordLegacyUsageDelta as reports arrive, so nothing to pull here.
      const fromRadius = await radacctUsage(sub.username, period.periodStart);
      if (fromRadius) {
        await prisma.subscriberUsage.upsert({
          where: {
            subscriberId_periodType_periodKey: {
              subscriberId: sub.id, periodType: period.periodType, periodKey: period.periodKey,
            },
          } as never,
          create: {
            subscriberId: sub.id, tenantId: sub.tenantId, routerId: sub.routerId,
            periodType: period.periodType, periodKey: period.periodKey,
            periodStart: period.periodStart, periodEnd: period.periodEnd,
            bytesIn: fromRadius.bytesIn, bytesOut: fromRadius.bytesOut,
          } as never,
          // Authoritative totals, so SET rather than increment.
          update: { bytesIn: fromRadius.bytesIn, bytesOut: fromRadius.bytesOut, routerId: sub.routerId } as never,
        });
      }

      const row = await prisma.subscriberUsage.findFirst({
        where: { subscriberId: sub.id, periodType: period.periodType, periodKey: period.periodKey },
      });
      if (!row) continue;

      const used = countedBytes(pkg.fupCountMode as string, row.bytesIn, row.bytesOut);
      const limitBytes = limitMb * 1024 * 1024;
      const shouldThrottle = used >= limitBytes;

      if (shouldThrottle && !row.throttled) {
        const speed = throttleSpeedFor(sub.package as never);
        await setThrottle(sub as never, speed);
        await prisma.subscriberUsage.update({
          where: { id: row.id },
          data: { throttled: true, throttledAt: new Date() },
        });
        throttled++;

        if (pkg.fupNotify && !row.notifiedAt && sub.phone) {
          try {
            const { sendNotification } = await import('./notifications');
            await sendNotification({
              tenantId: sub.tenantId,
              phone: sub.phone,
              subscriberId: sub.id,
              // 'OTHER' is always enabled — the tenant already opted in per-package via fupNotify,
              // so it shouldn't be second-gated by a global category switch.
              category: 'OTHER',
              username: sub.username,
              dedupKey: `FUP:${sub.id}:${period.periodType}:${period.periodKey}`,
              body: `Hi ${sub.fullName || sub.username}, you've used your ${limitMb}MB ${String(pkg.fupPeriod).toLowerCase()} data allowance. Your speed is now reduced until the next period.`,
            } as never);
            await prisma.subscriberUsage.update({ where: { id: row.id }, data: { notifiedAt: new Date() } });
          } catch { /* notification is best-effort; never block the throttle */ }
        }
      } else if (!shouldThrottle && row.throttled) {
        // New period (or the allowance was raised) — restore full package speed.
        await setThrottle(sub as never, null);
        const { radiusConfigured } = await import('./radius');
        if (radiusConfigured()) {
          const { syncSubscriberToRadius } = await import('./radius');
          await syncSubscriberToRadius(sub.id, { throttleKbps: null, kickToApply: true });
        } else if (sub.routerId) {
          const { enqueueCommand } = await import('./commandQueue');
          const full = `${sub.package.speedUpKbps}k/${sub.package.speedDownKbps}k`;
          await enqueueCommand(sub.routerId,
            `:foreach s in=[/ppp secret find name="${sub.username}"] do={ /ppp secret set $s rate-limit="${full}" }`);
        }
        await prisma.subscriberUsage.update({
          where: { id: row.id },
          data: { throttled: false, throttledAt: null },
        });
        released++;
      }
    } catch (e) {
      console.error(`[fup] ${sub.username} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return { checked, throttled, released };
}

// One computed status per subscriber for the UI dot. Deliberately a single enum rather than two
// booleans: online+throttled is four combinations, and the fourth ("offline but throttled") has no
// agreed rendering, so the two pages would drift apart. Offline wins visually — the throttle stays
// in the data and reapplies on reconnect.
export type FupStatus = 'online' | 'throttled' | 'offline';

// Resolve FUP status for a batch of subscribers in ONE query.
// The period key is derived per subscriber (MONTHLY is anchored to their own billing cycle), so it
// cannot be a plain SQL join — instead the keys are computed here with the SAME resolvePeriod() the
// worker uses, then fetched together. Reimplementing the key logic is how last cycle's throttle
// ends up showing yellow forever, so this must stay the single source.
export async function fupStatusFor(
  subs: Array<{
    id: string;
    expiresAt?: Date | null;
    service?: string | null;
    package?: { validityMinutes?: number | null; fupEnabled?: boolean | null; fupPeriod?: string | null } | null;
  }>,
  isOnline: (id: string) => boolean,
): Promise<Map<string, FupStatus>> {
  const out = new Map<string, FupStatus>();
  const lookups: Array<{ subscriberId: string; periodType: string; periodKey: string }> = [];

  for (const s of subs) {
    out.set(s.id, isOnline(s.id) ? 'online' : 'offline');
    const pkg = s.package as Record<string, unknown> | null | undefined;
    // Only FUP-enabled packages can be throttled, so skip the rest entirely.
    if (!pkg?.fupEnabled) continue;
    const period = resolvePeriod(((pkg.fupPeriod as PeriodType) || 'MONTHLY'), s, s.package || {});
    lookups.push({ subscriberId: s.id, periodType: period.periodType, periodKey: period.periodKey });
  }
  if (lookups.length === 0) return out;

  try {
    const rows = await prisma.subscriberUsage.findMany({
      where: { OR: lookups } as never,
      select: { subscriberId: true, throttled: true },
    });
    for (const r of rows) {
      // Offline wins: a throttled subscriber who isn't connected still reads as offline.
      if (r.throttled && out.get(r.subscriberId) === 'online') out.set(r.subscriberId, 'throttled');
    }
  } catch (e) {
    console.error('[fup] status lookup failed:', e instanceof Error ? e.message : e);
  }
  return out;
}

// Called on renewal: a new billing cycle means a new MONTHLY bucket, so lift any throttle at once
// rather than waiting for the next sweep (the customer just paid — they should get full speed now).
export async function clearFupOnRenewal(subscriberId: string): Promise<void> {
  try {
    const sub = await prisma.subscriber.findUnique({ where: { id: subscriberId }, include: { package: true } });
    if (!sub?.package) return;
    const pkg = sub.package as unknown as Record<string, unknown>;
    if (!pkg.fupEnabled || sub.service !== 'PPPOE') return;
    if (((pkg.fupPeriod as string) || 'MONTHLY') !== 'MONTHLY') return;

    const stale = await prisma.subscriberUsage.findMany({
      where: { subscriberId, periodType: 'MONTHLY', throttled: true },
    });
    if (stale.length === 0) return;
    await prisma.subscriberUsage.updateMany({
      where: { id: { in: stale.map(r => r.id) } },
      data: { throttled: false, throttledAt: null },
    });
    await setThrottle(sub as never, null);
    const { radiusConfigured, syncSubscriberToRadius } = await import('./radius');
    if (radiusConfigured()) await syncSubscriberToRadius(sub.id, { throttleKbps: null, kickToApply: true });
  } catch (e) {
    console.error('[fup] clearOnRenewal failed:', e instanceof Error ? e.message : e);
  }
}
