// Expiry-reminder scheduler. Runs every 15 minutes. For each tenant, looks up its
// configured reminder offsets (default 5d/3d/4h), finds subscribers/vouchers whose
// expiresAt falls in the upcoming window for any offset, and sends a reminder SMS.
// Each reminder is deduped via Message.dedupKey so we never send the same reminder twice.
import prisma from './prisma';
import { sendNotification } from './notifications';

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

    for (const offsetMin of offsets) {
      const offsetMs = offsetMin * 60 * 1000;
      // Target window: expiresAt - offset falls within [now, now + WINDOW_MS]
      // i.e. expiresAt in [now + offset, now + offset + WINDOW_MS]
      const winStart = new Date(now + offsetMs);
      const winEnd = new Date(now + offsetMs + WINDOW_MS);

      // Subscribers expiring in this window
      const subs = await prisma.subscriber.findMany({
        where: {
          tenantId: t.id,
          isActive: true,
          phone: { not: null },
          expiresAt: { gte: winStart, lt: winEnd },
        },
        select: { id: true, username: true, fullName: true, phone: true, expiresAt: true, service: true },
      });
      for (const s of subs) {
        const remaining = fmtRemaining(offsetMin);
        const body = `Hi ${s.fullName || s.username}, your ${t.name} ${s.service.toLowerCase()} subscription expires in ${remaining}. Top up to stay connected.`;
        await sendNotification({
          tenantId: t.id,
          phone: s.phone!,
          body,
          category: 'REMINDER',
          dedupKey: `REMINDER:SUB:${s.id}:${offsetMin}`,
          subscriberId: s.id,
          username: s.username,
        }).catch(err => console.error('[reminder] sub error:', err instanceof Error ? err.message : err));
      }

      // Vouchers (hotspot) expiring in this window — only if we have a phone via the MpesaTransaction.
      // We find vouchers whose code matches a recent MpesaTransaction so we can recover the phone.
      const vouchers = await prisma.voucher.findMany({
        where: {
          tenantId: t.id,
          isUsed: true,
          expiresAt: { gte: winStart, lt: winEnd },
        },
        select: { id: true, code: true, expiresAt: true, durationMinutes: true },
      });
      for (const v of vouchers) {
        const tx = await prisma.mpesaTransaction.findFirst({
          where: { tenantId: t.id, mpesaReceipt: v.code },
          select: { phone: true, username: true },
        });
        if (!tx?.phone) continue;
        const remaining = fmtRemaining(offsetMin);
        const body = `Hi, your ${t.name} internet access expires in ${remaining}. Buy a new package on the captive portal to stay connected.`;
        await sendNotification({
          tenantId: t.id,
          phone: tx.phone,
          body,
          category: 'REMINDER',
          dedupKey: `REMINDER:VCH:${v.id}:${offsetMin}`,
          username: tx.username,
        }).catch(err => console.error('[reminder] vch error:', err instanceof Error ? err.message : err));
      }
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
