// Notifications helper. Used by event hooks (provisioning success, expiry reminder
// scheduler, etc.) to send an SMS for a tenant, using either the tenant's own gateway
// credentials or Dartbit's shared BlessedTexts account, and to record every send to the
// Message table for the Messages tab.
import prisma from './prisma';
import { dartbitDefaultCreds, decryptApiKey, normalizeKenyanPhone, sendSms, type SmsCreds } from './blessedtexts';

type Category = 'WELCOME' | 'RECEIPT' | 'REMINDER' | 'MANUAL' | 'OTHER';

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
export async function resolveSmsCreds(tenantId: string): Promise<SmsCreds | null> {
  const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId } });
  if (cfg && cfg.gateway === 'CUSTOM' && cfg.apiKey && cfg.senderId) {
    try {
      return { apiKey: decryptApiKey(cfg.apiKey), senderId: cfg.senderId };
    } catch (e) {
      console.error('[sms] failed to decrypt tenant api key, falling back to dartbit:', e);
    }
  }
  return dartbitDefaultCreds();
}

// Whether a particular category is enabled for the tenant (defaults: all on).
export async function isCategoryEnabled(tenantId: string, category: Category): Promise<boolean> {
  if (category === 'MANUAL' || category === 'OTHER') return true;
  const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId } });
  if (!cfg) return true; // defaults are "on" if config doesn't exist yet
  if (category === 'WELCOME') return cfg.sendWelcome;
  if (category === 'RECEIPT') return cfg.sendPaymentReceipt;
  if (category === 'REMINDER') return cfg.sendExpiryReminders;
  return true;
}

// Send + record one SMS. Records a Message row regardless of success/failure so the
// Messages tab shows every attempt with delivery status and cost. Dedup via dedupKey
// (e.g. "REMINDER:<subId>:7200") prevents the same reminder being sent twice.
export async function sendNotification(args: SendNotifyArgs): Promise<NotifyResult> {
  const { tenantId, phone, body, category, dedupKey, subscriberId, username } = args;

  // Category-level enabled check.
  if (!(await isCategoryEnabled(tenantId, category))) {
    return { ok: false, skipped: true, reason: 'category disabled' };
  }

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

  const creds = await resolveSmsCreds(tenantId);
  if (!creds) {
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
        status: 'PENDING', gateway: 'BLESSEDTEXTS',
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
    const result = await sendSms(creds, to, body);
    await prisma.message.update({
      where: { id: msg.id },
      data: {
        status: result.ok ? 'SENT' : 'FAILED',
        gatewayMsgId: result.messageId,
        cost: result.cost,
        errorCode: result.ok ? null : result.statusCode || null,
        errorMessage: result.ok ? null : result.statusDesc || null,
      },
    });
    return { ok: result.ok, messageId: result.messageId, cost: result.cost, reason: result.ok ? undefined : result.statusDesc };
  } catch (err) {
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: 'FAILED', errorMessage: err instanceof Error ? err.message : 'send failed' },
    });
    return { ok: false, reason: err instanceof Error ? err.message : 'send failed' };
  }
}
