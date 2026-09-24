// Propagating a package speed change to the subscribers already on it.
// ---------------------------------------------------------------------------------------------
// Editing a package updates the Package row, but each subscriber's rate lives in their OWN radreply
// row (`Mikrotik-Rate-Limit`, op `:=`), written at activation. radgroupreply/radusergroup are empty,
// so nothing propagates on its own — the speed only corrected on expiry + reactivation, because
// renewal, subscriber edit and bulk-sync all call syncSubscriberToRadius and the package-update
// handler never did.
//
// Two constraints shape this file:
//   1. It goes through syncSubscriberToRadius rather than a raw radreply UPDATE. That function
//      resolves an active FUP throttle first, so bypassing it would silently restore full speed to
//      every throttled subscriber on the package.
//   2. syncSubscriberToRadius writes via SSH-executed psql PER SUBSCRIBER, so it must never be
//      looped inline on a request: a package with hundreds of subscribers would hang the HTTP call
//      and a partial failure would leave silent drift. It runs detached, and the handler returns
//      immediately.

import prisma from './prisma';

// One in-flight job per package. A tenant saving twice in quick succession shouldn't start two
// overlapping sweeps writing the same rows.
const running = new Set<string>();

export interface ResyncSummary {
  packageId: string;
  total: number;
  synced: number;
  failed: number;
}

// Blast radius of a package speed change, shown BEFORE saving so the tenant chooses apply-now vs
// apply-on-renewal rather than having propagation silently change behaviour they may rely on for
// grandfathering.
//   total  — every subscriber on the package; ALL of these get their record rewritten.
//   active — the entitled subset (not expired, not disabled). Only these carry a package speed and
//            therefore only these get CoA-kicked. Reported separately so the dialog can explain
//            which users see an immediate change and which see it at renewal.
export async function countAffectedSubscribers(packageId: string, tenantId: string): Promise<{ total: number; active: number }> {
  const now = new Date();
  const [total, active] = await Promise.all([
    prisma.subscriber.count({ where: { packageId, tenantId } }),
    prisma.subscriber.count({
      where: {
        packageId, tenantId, isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    }),
  ]);
  return { total, active };
}

// Resync EVERY subscriber on a package (any online or expiry status). Sequential and paced on
// purpose: each iteration is
// an SSH psql write plus (with kick) a CoA-Disconnect, and firing hundreds at once would hammer the
// droplet and drop every PPPoE session on the package simultaneously.
export async function resyncPackageSubscribers(
  packageId: string,
  opts: { kick?: boolean } = {},
): Promise<ResyncSummary> {
  const summary: ResyncSummary = { packageId, total: 0, synced: 0, failed: 0 };
  if (running.has(packageId)) {
    console.log(`[pkg-resync] ${packageId} already running, skipping duplicate`);
    return summary;
  }
  running.add(packageId);

  try {
    const { radiusConfigured, syncSubscriberToRadius } = await import('./radius');
    if (!radiusConfigured()) {
      console.log('[pkg-resync] RADIUS not configured — nothing to propagate');
      return summary;
    }

    const now = new Date();
    const subs = await prisma.subscriber.findMany({
      where: {
        packageId,
        service: { in: ['PPPOE', 'HOTSPOT'] }, // STATIC is never synced to RADIUS
        isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true, username: true },
    });
    summary.total = subs.length;

    for (const sub of subs) {
      try {
        // throttleKbps is left undefined so the function resolves the subscriber's CURRENT throttle
        // itself — passing null would force full speed and undo an active FUP throttle.
        // kickToApply issues CoA-Disconnect so a live session picks up the new rate without the
        // subscriber having to reconnect manually.
        await syncSubscriberToRadius(sub.id, { kickToApply: !!opts.kick });
        summary.synced++;
      } catch (e) {
        summary.failed++;
        console.error(`[pkg-resync] ${sub.username} failed:`, e instanceof Error ? e.message : e);
      }
      // Pace the sweep so a large package doesn't saturate the SSH path or kick everyone at once.
      await new Promise(r => setTimeout(r, 150));
    }

    console.log(`[pkg-resync] ${packageId}: ${summary.synced}/${summary.total} synced, ${summary.failed} failed`);
    return summary;
  } finally {
    running.delete(packageId);
  }
}

// Fire-and-forget wrapper for request handlers: returns immediately, logs on completion.
export function queuePackageResync(packageId: string, opts: { kick?: boolean } = {}): void {
  resyncPackageSubscribers(packageId, opts).catch(e =>
    console.error('[pkg-resync] job failed:', e instanceof Error ? e.message : e));
}
