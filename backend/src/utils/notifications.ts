// Notifications helper. Used by event hooks (provisioning success, expiry reminder
// scheduler, etc.) to send an SMS for a tenant, using either the tenant's own gateway
// credentials or Dartbit's shared BlessedTexts account, and to record every send to the
// Message table for the Messages tab.
import prisma from './prisma';
import { normalizeKenyanPhone } from './blessedtexts';
import { resolveGateway, sendViaProvider } from './smsGateway';
import { canSend, debitForSms } from './smsWallet';

type Category = 'WELCOME' | 'RECEIPT' | 'REMINDER' | 'EXPIRED' | 'SYSTEM' | 'MANUAL' | 'OTHER';

export interface SendNotifyArgs {
  tenantId: string;
  phone: string;                  // any common Kenyan format; will be normalized
  body: string;
  category: Category;
  dedupKey?: string;              // if set, skip when a Message with this key already exists
  subscriberId?: string | null;
  username?: string | null;
}

export interface NotifyResult {
  ok: boolean;
  skipped?: boolean;              // true when dedup hit or notifications disabled
  reason?: string;
  messageId?: string;
  cost?: number;
}

// Resolves the SMS credentials for a tenant: tenant's own when gateway=CUSTOM and apiKey is
// set, otherwise the shared Dartbit account from env. Returns null when nothing is configured.
export { resolveGateway } from './smsGateway';

// Whether a particular category is enabled for the tenant (defaults: all on).
export async function isCategoryEnabled(tenantId: string, category: Category): Promise<boolean> {
  if (category === 'MANUAL' || category === 'OTHER' || category === 'SYSTEM') return true;
  const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId } });
  if (!cfg) return true; // defaults are "on" if config doesn't exist yet
  if (category === 'WELCOME') return cfg.sendWelcome;
  if (category === 'RECEIPT') return cfg.sendPaymentReceipt;
  if (category === 'REMINDER' || category === 'EXPIRED') return cfg.sendExpiryReminders;
  return true;
}

// Send + record one SMS. Records a Message row regardless of success/failure so the
// Messages tab shows every attempt with delivery status and cost. Dedup via dedupKey
// (e.g. "REMINDER:<subId>:7200") prevents the same reminder being sent twice.
export async function sendNotification(args: SendNotifyArgs): Promise<NotifyResult> {
  const { tenantId, phone, category, dedupKey, subscriberId, username } = args;
  let body = args.body;

  // Category-level enabled check.
  if (!(await isCategoryEnabled(tenantId, category))) {
    return { ok: false, skipped: true, reason: 'category disabled' };
  }

  // Sender label: on the shared Dartbit gateway the BlessedTexts sender ID is generic, so we append
  // "From {tenant}" at the END of every message so recipients know who it's from. Tenants on their
  // OWN gateway use their own sender ID and don't need the label.
  try {
    const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId }, select: { gateway: true } });
    const usesDartbit = !cfg || cfg.gateway === 'DARTBIT';
    if (usesDartbit) {
      const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      if (t?.name) {
        // Strip any legacy leading "From {tenant}: " prefix, then append as a suffix (once).
        const legacyPrefix = `From ${t.name}: `;
        if (body.startsWith(legacyPrefix)) body = body.slice(legacyPrefix.length);
        if (!body.trimEnd().endsWith(`From ${t.name}`)) body = body.trimEnd() + `\n\nFrom ${t.name}`;
      }
    }
  } catch { /* non-fatal */ }

  // Dedup — if a message with this key already exists for the tenant, skip.
  if (dedupKey) {
    const exists = await prisma.message.findFirst({ where: { tenantId, dedupKey } });
    if (exists) return { ok: false, skipped: true, reason: 'already sent', messageId: exists.gatewayMsgId || undefined };
  }

  const to = normalizeKenyanPhone(phone);
  if (!to) {
    await prisma.message.create({
      data: { tenantId, type: 'SMS', recipient: phone || '', body, status: 'FAILED', errorMessage: 'Invalid phone number', category, dedupKey: dedupKey || undefined, subscriberId: subscriberId || undefined, username: username || undefined },
    });
    return { ok: false, reason: 'invalid phone' };
  }

  // Prepaid wallet gate: tenants on the Dartbit shared gateway must have enough balance.
  // (Tenants on their OWN gateway aren't billed by Dartbit and always pass.) A long message
  // is multiple SMS segments (160 chars each), so charge accordingly.
  const segments = Math.max(1, Math.ceil(body.length / 160));
  const affordable = await canSend(tenantId, segments);
  if (affordable.usesDartbit && !affordable.ok) {
    await prisma.message.create({
      data: {
        tenantId, type: 'SMS', recipient: to, body, status: 'FAILED',
        errorMessage: `Insufficient SMS balance (need KES ${affordable.needed.toFixed(2)}, have ${affordable.balance.toFixed(2)})`,
        category, dedupKey: dedupKey || undefined, subscriberId: subscriberId || undefined, username: username || undefined,
      },
    });
    return { ok: false, reason: 'insufficient SMS balance' };
  }

  const gw = await resolveGateway(tenantId);
  if (!gw) {
    await prisma.message.create({
      data: { tenantId, type: 'SMS', recipient: to, body, status: 'FAILED', errorMessage: 'No SMS gateway configured', category, dedupKey: dedupKey || undefined, subscriberId: subscriberId || undefined, username: username || undefined },
    });
    return { ok: false, reason: 'no gateway' };
  }

  // Pre-create the Message in PENDING so the dedup key is reserved (so concurrent attempts
  // collide on the unique index rather than both sending). Then send and update.
  let msg;
  try {
    msg = await prisma.message.create({
      data: {
        tenantId, type: 'SMS', recipient: to, body,
        status: 'PENDING', gateway: gw.provider,
        category, dedupKey: dedupKey || undefined,
        subscriberId: subscriberId || undefined, username: username || undefined,
      },
    });
  } catch (e) {
    // Unique violation on dedupKey → another worker already sent it.
    if (dedupKey) {
      const exists = await prisma.message.findFirst({ where: { tenantId, dedupKey } });
      if (exists) return { ok: false, skipped: true, reason: 'already sent (race)' };
    }
    throw e;
  }

  try {
    const result = await sendViaProvider(gw.provider, gw.creds, to, body);
    // Determine the cost to record on the Message:
    //  - Dartbit shared gateway: the tenant is charged the superadmin-set rate × segments, so we
    //    record THAT as the cost (the gateway's own reported cost is irrelevant to the tenant and
    //    is often 0 — which previously showed as a dash). This guarantees a real cost is shown.
    //  - Tenant's own gateway (CUSTOM): record whatever the provider reported (they pay it directly).
    let recordedCost = result.cost || 0;
    let debited = 0;
    if (result.ok && gw.usesDartbit) {
      try { debited = await debitForSms(tenantId, segments, result.messageId || msg.id); }
      catch (e) { console.error('[wallet] debit failed:', e instanceof Error ? e.message : e); }
      recordedCost = debited; // the actual amount charged to the wallet (rate × segments)
    }
    await prisma.message.update({
      where: { id: msg.id },
      data: {
        status: result.ok ? 'SENT' : 'FAILED',
        gatewayMsgId: result.messageId,
        cost: recordedCost,
        errorCode: result.ok ? null : result.statusCode || null,
        errorMessage: result.ok ? null : result.statusDesc || null,
      },
    });
    return { ok: result.ok, messageId: result.messageId, cost: recordedCost, reason: result.ok ? undefined : result.statusDesc };
  } catch (err) {
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: 'FAILED', errorMessage: err instanceof Error ? err.message : 'send failed' },
    });
    return { ok: false, reason: err instanceof Error ? err.message : 'send failed' };
  }
}
