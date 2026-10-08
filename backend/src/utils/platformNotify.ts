// Dartbit -> ISP notifications: billing lifecycle and signup.
//
// These come from Dartbit, not from the ISP, so two rules differ from tenant notifications:
//   - Branding is Dartbit's, not the tenant's.
//   - SMS goes out on Dartbit's own SMS account and is NEVER charged to the tenant's wallet.
//     An overdue tenant is the likeliest to have an empty wallet, so charging it would make the
//     most important billing SMS fail exactly when it matters.
//
// Every send is idempotent per recipient per billing cycle, so the 30-minute status updater
// re-running, or Paystack verify and webhook both confirming one payment, never double-sends.
import prisma from './prisma';
import { sendEmail } from './email';
import { renderEmail, platformBrand, appUrl, firstName } from './emailTemplates';
import { defaultTemplate, renderTemplate } from './messageTemplates';
import { getDefaultProvider, dartbitCredsFor, sendViaProvider } from './smsGateway';
import { normalizeKenyanPhone } from './blessedtexts';

type Category = 'WELCOME' | 'RECEIPT' | 'REMINDER' | 'EXPIRED' | 'SYSTEM' | 'MANUAL' | 'OTHER';

export const fmtDate = (d: Date | null | undefined) =>
  d
    ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' })
    : '—';
export const fmtKes = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('en-US');

/** SMS on Dartbit's account. Recorded under the tenant at zero cost so it shows in their log. */
export async function sendPlatformSms(args: {
  tenantId: string;
  phone: string;
  body: string;
  category: Category;
  dedupKey: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const { tenantId, body, category, dedupKey } = args;
  const to = normalizeKenyanPhone(args.phone);
  if (!to) return { ok: false, reason: 'invalid phone' };

  const existing = await prisma.message.findUnique({ where: { dedupKey } }).catch(() => null);
  if (existing) return { ok: false, reason: 'duplicate' };

  const provider = await getDefaultProvider();
  const creds = dartbitCredsFor(provider);
  if (!creds) {
    console.warn(`[platform-sms] no Dartbit credentials for ${provider} — skipping billing SMS`);
    return { ok: false, reason: 'no platform SMS credentials' };
  }

  let ok = false;
  let msgId: string | undefined;
  let err: string | undefined;
  try {
    const r = await sendViaProvider(provider, creds, to, body);
    ok = r.ok;
    msgId = r.messageId;
    if (!r.ok) err = `${r.statusCode} ${r.statusDesc}`.trim();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }

  await prisma.message
    .create({
      data: {
        tenantId, type: 'SMS', recipient: to, body, category, dedupKey,
        status: ok ? 'SENT' : 'FAILED', gateway: provider, gatewayMsgId: msgId || null,
        cost: 0, errorMessage: err || null,
      },
    })
    .catch((e: unknown) => console.error('[platform-sms] could not record Message row:', e instanceof Error ? e.message : e));

  return ok ? { ok: true } : { ok: false, reason: err };
}

async function tenantAdmins(tenantId: string) {
  return prisma.user.findMany({
    where: { tenantId, role: 'TENANT_ADMIN', isActive: true },
    select: { id: true, name: true, email: true, phone: true },
  });
}

export type BillingEvent = 'invoice' | 'paid' | 'trial_ended' | 'overdue';

const EVENT_MAP: Record<BillingEvent, { email: string; sms: string; category: Category; cta: string }> = {
  invoice: { email: 'billing_invoice', sms: 'billing_invoice_sms', category: 'REMINDER', cta: 'Pay invoice' },
  paid: { email: 'billing_paid', sms: 'billing_paid_sms', category: 'RECEIPT', cta: 'Open dashboard' },
  trial_ended: { email: 'trial_ended', sms: 'trial_ended_sms', category: 'EXPIRED', cta: 'Pay now' },
  overdue: { email: 'billing_overdue', sms: 'billing_overdue_sms', category: 'EXPIRED', cta: 'Pay now' },
};

/**
 * Email + SMS every active admin of a tenant about a billing event.
 * cycleKey makes it once-per-cycle: the due date for status events, the invoice id for payments.
 */
export async function notifyTenantBilling(args: {
  tenantId: string;
  event: BillingEvent;
  cycleKey: string;
  amount: number;
  dueDate?: Date | null;
  nextDue?: Date | null;
  reference?: string | null;
}): Promise<void> {
  const { tenantId, event, cycleKey } = args;
  const map = EVENT_MAP[event];
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  if (!tenant) return;

  const admins = await tenantAdmins(tenantId);
  if (admins.length === 0) {
    console.warn(`[billing-notify] ${tenant.name}: no active TENANT_ADMIN to notify about ${event}`);
    return;
  }

  const ctx = {
    tenant: tenant.name,
    amount: fmtKes(args.amount),
    dueDate: fmtDate(args.dueDate),
    nextDue: fmtDate(args.nextDue),
    reference: args.reference || '—',
  };
  const smsBody = renderTemplate(defaultTemplate(map.sms), ctx);

  for (const a of admins) {
    const base = `${tenantId}/billing/${event}/${cycleKey}/${a.id}`;

    const email = renderEmail(map.email, {
      brand: platformBrand(),
      ctx: { ...ctx, name: firstName(a.name) },
      cta: { href: `${appUrl()}/dashboard`, label: map.cta },
      footer: 'Dartbit · Billing',
    });
    const er = await sendEmail({
      tenantId, to: a.email, category: map.category, tag: `billing_${event}`,
      dedupKey: `${base}/email`, ...email,
    }).catch((e: unknown) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));

    let sr: { ok: boolean; reason?: string } = { ok: false, reason: 'no phone' };
    if (a.phone) {
      sr = await sendPlatformSms({ tenantId, phone: a.phone, body: smsBody, category: map.category, dedupKey: `${base}/sms` })
        .catch((e: unknown) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
    }
    console.log(`[billing-notify] ${tenant.name} ${event} → ${a.email}: email=${er.ok ? 'ok' : er.reason} sms=${sr.ok ? 'ok' : sr.reason}`);
  }
}

/** Welcome to the new ISP's admin, plus an alert to every superadmin. */
export async function notifySignup(args: { tenantId: string; userId: string }): Promise<void> {
  const t = await prisma.tenant.findUnique({
    where: { id: args.tenantId },
    select: { name: true, subdomain: true, phone: true, trialEndsAt: true },
  });
  const u = await prisma.user.findUnique({ where: { id: args.userId }, select: { name: true, email: true, phone: true } });
  if (!t || !u) return;

  const welcome = renderEmail('signup_welcome', {
    brand: platformBrand(),
    ctx: { name: firstName(u.name), tenant: t.name, trialEnd: fmtDate(t.trialEndsAt) },
    cta: { href: `${appUrl()}/dashboard`, label: 'Open your dashboard' },
  });
  const wr = await sendEmail({
    tenantId: args.tenantId, to: u.email, category: 'WELCOME', tag: 'signup_welcome',
    dedupKey: `${args.tenantId}/signup/welcome/${args.userId}`, ...welcome,
  }).catch((e: unknown) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
  console.log(`[signup-notify] welcome → ${u.email}: ${wr.ok ? 'ok' : wr.reason}`);

  const supers = await prisma.user.findMany({
    where: { role: 'SUPERADMIN', isActive: true },
    select: { email: true },
  });
  const superadminUrl = (process.env.SUPERADMIN_URL || '').replace(/\/+$/, '');
  for (const s of supers) {
    const alert = renderEmail('signup_alert', {
      brand: platformBrand(),
      ctx: {
        tenant: t.name, subdomain: t.subdomain, name: u.name, email: u.email,
        phone: u.phone || t.phone || '—', trialEnd: fmtDate(t.trialEndsAt),
      },
      cta: superadminUrl ? { href: superadminUrl, label: 'Open superadmin' } : undefined,
      footer: 'Dartbit · Superadmin',
    });
    // Platform mail: no tenant row, or this alert would appear in the new ISP's own message log.
    await sendEmail({
      tenantId: null, to: s.email, category: 'SYSTEM', tag: 'signup_alert',
      dedupKey: `platform/signup-alert/${args.tenantId}/${s.email}`, ...alert,
    }).catch((e: unknown) => console.error('[signup-notify] superadmin alert failed:', e));
  }
}
