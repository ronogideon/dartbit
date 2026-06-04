// System-alert monitor. Runs periodically and sends SMS alerts to a tenant's alert numbers
// (their admin phones + any extra numbers they configured) when:
//   1. a router has been offline for more than 5 minutes (once per offline episode), and
//   2. their SMS wallet drops below the configured low-balance threshold (once until top-up).
// Alerts are charged to the tenant's SMS wallet like any other message.
import prisma from './prisma';
import { sendNotification } from './notifications';
import { resolveTemplate, renderTemplate } from './messageTemplates';

const TICK_MS = 60 * 1000;            // check every minute
const OFFLINE_AFTER_MS = 5 * 60 * 1000; // 5 minutes

// Human-friendly outage duration, e.g. "12 min", "1 hr 5 min", "2 days 3 hr".
function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hrs < 24) return remMin ? `${hrs} hr ${remMin} min` : `${hrs} hr`;
  const days = Math.floor(hrs / 24);
  const remHr = hrs % 24;
  return remHr ? `${days} day${days > 1 ? 's' : ''} ${remHr} hr` : `${days} day${days > 1 ? 's' : ''}`;
}

// Collect the alert recipients for a tenant: the phone they signed up with (Tenant.phone) plus
// any extra alert numbers they configured.
async function alertRecipients(tenantId: string, cfgAlertPhones: string[]): Promise<string[]> {
  const set = new Set<string>();
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { phone: true } }).catch(() => null);
  if (tenant?.phone && tenant.phone.trim()) set.add(tenant.phone.trim());
  for (const p of cfgAlertPhones || []) { if (p && p.trim()) set.add(p.trim()); }
  return Array.from(set);
}

async function tickOnce() {
  const now = Date.now();

  // ---- 1. Router offline > 5 min ----
  const routers = await prisma.mikrotikRouter.findMany({
    select: { id: true, name: true, tenantId: true, lastSeenAt: true, status: true, offlineAlertSent: true, offlineSince: true },
  });
  for (const r of routers) {
    const lastSeen = r.lastSeenAt ? r.lastSeenAt.getTime() : 0;
    const isOffline = !lastSeen || (now - lastSeen) > OFFLINE_AFTER_MS;

    if (!isOffline) {
      // Back online. If we had alerted about this outage, send a "back online" alert with the
      // outage duration, then clear the outage flags so a future outage alerts again.
      if (r.offlineAlertSent) {
        const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId: r.tenantId } });
        // Respect the same toggle as offline alerts (one switch governs router status alerts).
        if (!cfg || cfg.routerOfflineAlert !== false) {
          const tenant = await prisma.tenant.findUnique({ where: { id: r.tenantId }, select: { name: true } });
          const recipients = await alertRecipients(r.tenantId, cfg?.alertPhones || []);
          if (recipients.length > 0) {
            // Outage spanned from offlineSince (when it went down) until lastSeen (first beat back).
            const downStart = r.offlineSince ? r.offlineSince.getTime() : (lastSeen - OFFLINE_AFTER_MS);
            const durationMs = Math.max(0, lastSeen - downStart);
            const overrides = (cfg?.templates as Record<string, string> | null) || null;
            const body = renderTemplate(resolveTemplate('system_router_online', overrides), {
              tenant: tenant?.name || 'Dartbit', router: r.name, duration: formatDuration(durationMs),
            });
            for (const phone of recipients) {
              await sendNotification({
                tenantId: r.tenantId, phone, body, category: 'SYSTEM',
                dedupKey: `SYS:ROUTER_ONLINE:${r.id}:${Math.floor(downStart / 1000)}`,
              }).catch(e => console.error('[alerts] router online send:', e instanceof Error ? e.message : e));
            }
          }
        }
        await prisma.mikrotikRouter.update({ where: { id: r.id }, data: { offlineAlertSent: false, offlineSince: null } }).catch(() => {});
      }
      continue;
    }
    // Currently offline: record when the outage began (first time we notice it down).
    if (!r.offlineSince && lastSeen) {
      await prisma.mikrotikRouter.update({ where: { id: r.id }, data: { offlineSince: new Date(lastSeen) } }).catch(() => {});
    }
    if (r.offlineAlertSent) continue; // already alerted for this episode
    if (!lastSeen) continue;          // never connected — don't alert on never-seen routers

    const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId: r.tenantId } });
    if (cfg && cfg.routerOfflineAlert === false) { continue; }
    const tenant = await prisma.tenant.findUnique({ where: { id: r.tenantId }, select: { name: true } });
    const recipients = await alertRecipients(r.tenantId, cfg?.alertPhones || []);
    if (recipients.length === 0) { continue; }

    const overrides = (cfg?.templates as Record<string, string> | null) || null;
    const body = renderTemplate(resolveTemplate('system_router_offline', overrides), {
      tenant: tenant?.name || 'Dartbit', router: r.name,
    });
    for (const phone of recipients) {
      await sendNotification({
        tenantId: r.tenantId, phone, body, category: 'SYSTEM',
        dedupKey: `SYS:ROUTER_OFFLINE:${r.id}:${Math.floor(lastSeen / 1000)}`,
      }).catch(e => console.error('[alerts] router offline send:', e instanceof Error ? e.message : e));
    }
    await prisma.mikrotikRouter.update({ where: { id: r.id }, data: { offlineAlertSent: true } }).catch(() => {});
  }

  // ---- 2. Low SMS wallet balance ----
  const wallets = await prisma.smsWallet.findMany({
    select: { tenantId: true, balance: true, lowBalanceAlerted: true },
  });
  for (const w of wallets) {
    const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId: w.tenantId } });
    if (cfg && cfg.lowBalanceAlert === false) continue;
    const threshold = cfg?.lowBalanceThreshold ?? 50;

    if (w.balance >= threshold) {
      if (w.lowBalanceAlerted) {
        await prisma.smsWallet.update({ where: { tenantId: w.tenantId }, data: { lowBalanceAlerted: false } }).catch(() => {});
      }
      continue;
    }
    if (w.lowBalanceAlerted) continue; // already alerted until they top up

    const tenant = await prisma.tenant.findUnique({ where: { id: w.tenantId }, select: { name: true } });
    const recipients = await alertRecipients(w.tenantId, cfg?.alertPhones || []);
    if (recipients.length === 0) continue;

    const overrides = (cfg?.templates as Record<string, string> | null) || null;
    const body = renderTemplate(resolveTemplate('system_low_balance', overrides), {
      tenant: tenant?.name || 'Dartbit', balance: w.balance.toFixed(0),
    });
    for (const phone of recipients) {
      await sendNotification({
        tenantId: w.tenantId, phone, body, category: 'SYSTEM',
        dedupKey: `SYS:LOW_BAL:${w.tenantId}:${Date.now()}`,
      }).catch(e => console.error('[alerts] low balance send:', e instanceof Error ? e.message : e));
    }
    await prisma.smsWallet.update({ where: { tenantId: w.tenantId }, data: { lowBalanceAlerted: true } }).catch(() => {});
  }
}

export function startSystemAlerts() {
  setTimeout(() => {
    tickOnce().catch(e => console.error('[alerts] first tick:', e instanceof Error ? e.message : e));
    setInterval(() => {
      tickOnce().catch(e => console.error('[alerts] tick:', e instanceof Error ? e.message : e));
    }, TICK_MS);
  }, 45 * 1000);
}
