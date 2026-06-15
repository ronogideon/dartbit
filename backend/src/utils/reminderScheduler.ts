// Expiry-reminder scheduler. Runs every 15 minutes. For each tenant, looks up its
// configured reminder offsets (default 5d/3d/4h), finds subscribers/vouchers whose
// expiresAt falls in the upcoming window for any offset, and sends a reminder SMS.
// Each reminder is deduped via Message.dedupKey so we never send the same reminder twice.
import prisma from './prisma';
import { sendNotification } from './notifications';
import { resolveTemplate, renderTemplate } from './messageTemplates';

const TICK_MS = 15 * 60 * 1000; // 15 minutes
const WINDOW_MS = TICK_MS;       // we look for expiry-due reminders within one tick's worth

function fmtRemaining(minutes: number): string {
  if (minutes >= 60 * 24) {
    const d = Math.round(minutes / (60 * 24));
    return d === 1 ? '1 day' : `${d} days`;
  }
  if (minutes >= 60) {
    const h = Math.round(minutes / 60);
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  return `${minutes} min`;
}

async function tickOnce() {
  const now = Date.now();

  // For every tenant that has notifications enabled, check upcoming expiries.
  const tenants = await prisma.tenant.findMany({
    select: { id: true, name: true },
  });

  for (const t of tenants) {
    const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId: t.id } });
    // Default to enabled with default offsets when config row doesn't exist yet.
    const enabled = cfg ? cfg.sendExpiryReminders : true;
    if (!enabled) continue;
    const offsets = cfg?.reminderOffsets?.length ? cfg.reminderOffsets : [7200, 4320, 240];
    const overrides = (cfg?.templates as Record<string, string> | null) || null;

    for (const offsetMin of offsets) {
      const offsetMs = offsetMin * 60 * 1000;
      // Fire when the (expiresAt - offset) mark falls within a band around now. The band reaches
      // ~20 min BACK (so a late/restarted tick can't drop the reminder) and one tick FORWARD. The
      // dedup key (below) makes each subscriber+offset+expiry fire exactly once despite the overlap.
      const winStart = new Date(now + offsetMs - 20 * 60 * 1000);
      const winEnd = new Date(now + offsetMs + WINDOW_MS);

      // Subscribers expiring in this window
      const subs = await prisma.subscriber.findMany({
        where: {
          tenantId: t.id,
          isActive: true,
          phone: { not: null },
          expiresAt: { gte: winStart, lt: winEnd },
        },
        select: { id: true, username: true, fullName: true, phone: true, expiresAt: true, service: true, package: { select: { name: true } } },
      });
      for (const s of subs) {
        // Hotspot is a short-term purchase — no pre-expiry reminders (it gets hotspot_expired at the
        // end instead). Only PPPoE/Static get countdown reminders.
        if (s.service === 'HOTSPOT') continue;
        const remaining = fmtRemaining(offsetMin);
        const body = renderTemplate(resolveTemplate('pppoe_reminder', overrides), {
          tenant: t.name, name: s.fullName || s.username, username: s.username,
          remaining, expiry: s.expiresAt ? s.expiresAt.toLocaleString() : '',
          package: s.package?.name || '',
        });
        await sendNotification({
          tenantId: t.id,
          phone: s.phone!,
          body,
          category: 'REMINDER',
          dedupKey: `REMINDER:SUB:${s.id}:${offsetMin}:${s.expiresAt ? s.expiresAt.getTime() : 0}`,
          subscriberId: s.id,
          username: s.username,
        }).catch(err => console.error('[reminder] sub error:', err instanceof Error ? err.message : err));
      }
    }

    // At-expiry "Expired" notifications. Covers HOTSPOT (hotspot_expired) AND PPPoE/Static
    // (pppoe_expired) — the pre-expiry reminder loop above skips hotspot, so this is the only place
    // hotspot customers are notified. We scan subscribers whose expiry just passed (within a bounded
    // look-back so a restart can't permanently miss one) and send once. The dedup key includes the
    // expiry timestamp, so a renewed-then-expired-again subscriber is notified afresh each cycle.
    const lookback = new Date(now - 35 * 60 * 1000); // ~2 ticks: catches a missed run without firing a backlog of old expiries
    const justExpired = await prisma.subscriber.findMany({
      where: {
        tenantId: t.id,
        phone: { not: null },
        expiresAt: { lte: new Date(now), gt: lookback },
      },
      select: { id: true, username: true, fullName: true, phone: true, expiresAt: true, service: true, package: { select: { name: true } } },
    });
    for (const s of justExpired) {
      const tplKey = s.service === 'HOTSPOT' ? 'hotspot_expired' : 'pppoe_expired';
      const body = renderTemplate(resolveTemplate(tplKey, overrides), {
        tenant: t.name, name: s.fullName || s.username, username: s.username,
        remaining: '', expiry: s.expiresAt ? s.expiresAt.toLocaleString() : '',
        package: s.package?.name || '',
      });
      await sendNotification({
        tenantId: t.id,
        phone: s.phone!,
        body,
        category: 'EXPIRED',
        dedupKey: `EXPIRED:SUB:${s.id}:${s.expiresAt ? s.expiresAt.getTime() : 0}`,
        subscriberId: s.id,
        username: s.username,
      }).catch(err => console.error('[expired] sub error:', err instanceof Error ? err.message : err));
    }
  }
}

export function startReminderScheduler() {
  // Defer the first tick so DB patches finish before we query.
  setTimeout(() => {
    tickOnce().catch(err => console.error('[reminder] first tick error:', err instanceof Error ? err.message : err));
    setInterval(() => {
      tickOnce().catch(err => console.error('[reminder] tick error:', err instanceof Error ? err.message : err));
    }, TICK_MS);
  }, 30 * 1000);
}
