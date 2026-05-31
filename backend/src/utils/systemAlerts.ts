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

// Collect the alert recipients for a tenant: configured alertPhones + all tenant-admin phones.
async function alertRecipients(tenantId: string, cfgAlertPhones: string[]): Promise<string[]> {
  const set = new Set<string>();
  for (const p of cfgAlertPhones || []) { if (p && p.trim()) set.add(p.trim()); }
  // Admin phones — Users don't always have a phone; pull any that do.
  const admins = await prisma.user.findMany({
    where: { tenantId, role: 'TENANT_ADMIN' },
    select: { phone: true },
  }).catch(() => [] as { phone: string | null }[]);
  for (const a of admins) { if (a.phone && a.phone.trim()) set.add(a.phone.trim()); }
  return Array.from(set);
}

async function tickOnce() {
  const now = Date.now();

  // ---- 1. Router offline > 5 min ----
  const routers = await prisma.mikrotikRouter.findMany({
    select: { id: true, name: true, tenantId: true, lastSeenAt: true, status: true, offlineAlertSent: true },
  });
  for (const r of routers) {
    const lastSeen = r.lastSeenAt ? r.lastSeenAt.getTime() : 0;
    const isOffline = !lastSeen || (now - lastSeen) > OFFLINE_AFTER_MS;

    if (!isOffline) {
      // Back online — clear the alert flag so a future outage alerts again.
      if (r.offlineAlertSent) {
        await prisma.mikrotikRouter.update({ where: { id: r.id }, data: { offlineAlertSent: false } }).catch(() => {});
      }
      continue;
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
