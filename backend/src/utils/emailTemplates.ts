// Editable email templates. Mirrors utils/messageTemplates.ts (SMS): every email has a key and a
// code default; superadmin can override subject/heading/body from the dashboard, stored as
// PlatformSetting rows. Absent overrides fall back to the code default.
//
// Only the WORDS are editable. Credential blocks (temp passwords, login details) and action
// buttons are rendered by code, so an edit can never strip a password out of a reset email
// and lock someone out.
//
// Layout is hand-written table HTML with inline styles — the only thing that renders the same
// in Gmail, Apple Mail and desktop Outlook.
import prisma from './prisma';

export const FONT =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
export const DEFAULT_ACCENT = '#2563eb';
export const EMAIL_TEMPLATE_PREFIX = 'email_tpl:';

export const esc = (s: string | number | null | undefined) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const firstName = (name: string | null | undefined) =>
  (name ?? '').trim().split(/\s+/)[0] || 'there';

export interface Brand {
  name: string;
  accent: string;
  logoUrl: string | null;
  siteUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const validHex = (c: string | null | undefined) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : null);

/** Same base domain the rest of the backend resolves tenants against. */
export function portalBase(): string {
  return (process.env.PORTAL_BASE_DOMAIN || 'dartbittech.com')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

/** The tenant/staff dashboard origin (login, billing). */
export function appUrl(): string {
  const f = (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
  return f || `https://${portalBase()}`;
}

export function platformBrand(): Brand {
  return { name: 'Dartbit', accent: DEFAULT_ACCENT, logoUrl: null, siteUrl: appUrl() };
}

/** Tenant branding for subscriber-facing mail. Falls back to the platform look. */
export async function tenantBrand(tenantId: string): Promise<Brand> {
  const t = await prisma.tenant
    .findUnique({
      where: { id: tenantId },
      select: { name: true, themeColor: true, logoUrl: true, subdomain: true, domain: true },
    })
    .catch(() => null);
  if (!t) return platformBrand();
  const root = portalBase();
  const host = t.domain || (t.subdomain ? `${t.subdomain}.${root}` : root);
  return {
    name: t.name || 'Dartbit',
    accent: validHex(t.themeColor) || DEFAULT_ACCENT,
    logoUrl: t.logoUrl || null,
    siteUrl: `https://${host}`,
  };
}

// ---------------------------------------------------------------------------
// Layout primitives

export function layout(opts: { brand: Brand; preheader: string; body: string; footer?: string }): string {
  const { brand } = opts;
  const header = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" height="28" style="display:block;height:28px;width:auto;border:0;">`
    : `<span style="${FONT}font-size:15px;font-weight:800;letter-spacing:3px;color:${esc(brand.accent)};">${esc(
        brand.name.toUpperCase()
      )}</span>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">
<title>${esc(brand.name)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(
    opts.preheader
  )}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;">
    <tr><td style="padding:24px 24px 4px;">${header}</td></tr>
    <tr><td style="padding:12px 24px 28px;${FONT}font-size:15px;line-height:1.55;color:#111827;">${opts.body}</td></tr>
  </table>
  <p style="${FONT}font-size:12px;line-height:1.5;color:#6b7280;margin:16px 0 0;">
    ${esc(opts.footer ?? `${brand.name} · Nairobi, Kenya`)}<br>
    <a href="${esc(brand.siteUrl)}" style="color:#6b7280;">${esc(brand.siteUrl.replace(/^https?:\/\//, ''))}</a>
  </p>
</td></tr></table>
</body></html>`;
}

/** Bulletproof button — renders in desktop Outlook too. */
export function button(brand: Brand, href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;"><tr>
<td bgcolor="${esc(brand.accent)}" style="border-radius:999px;">
<a href="${esc(href)}" style="display:inline-block;padding:13px 24px;${FONT}font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;">${esc(
    label
  )}</a>
</td></tr></table>`;
}

const h1 = (s: string) =>
  `<p style="margin:0 0 14px;font-size:22px;font-weight:700;line-height:1.3;color:#0A0A0B;">${esc(s)}</p>`;

/** Plain text → paragraphs. Blank line = new paragraph, single newline = line break. */
function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;color:#374151;">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Monospaced credential block — a temp password or username/password pair. */
function credentials(rows: Array<[string, string]>): string {
  const cells = rows
    .map(
      ([k, v]) =>
        `<tr><td style="${FONT}font-size:13px;color:#6b7280;padding:2px 12px 2px 0;">${esc(
          k
        )}</td><td style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:16px;font-weight:600;color:#0A0A0B;padding:2px 0;">${esc(
          v
        )}</td></tr>`
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px;background:#f9fafb;border-radius:10px;">
<tr><td style="padding:14px 16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0">${cells}</table></td></tr></table>`;
}

// ---------------------------------------------------------------------------
// Template registry

export type EmailAudience = 'tenant' | 'subscriber' | 'platform';

export interface EmailTemplateDef {
  key: string;
  audience: EmailAudience;
  label: string;
  description: string;
  subject: string;
  heading: string;
  body: string;
  placeholders: string[];
}

export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
  {
    key: 'signup_welcome', audience: 'tenant', label: 'Signup — Welcome',
    description: 'Sent to the new admin when an ISP signs up. Includes the free-trial end date.',
    subject: 'Welcome to Dartbit, {name}',
    heading: 'Your free trial has started',
    body: 'Hi {name}, {tenant} is set up on Dartbit and your 14-day free trial is running.\n\nYour trial ends on {trialEnd}. You can use everything until then — add your routers, import subscribers, and start collecting payments.\n\nWe will email you an invoice 5 days before the trial ends.',
    placeholders: ['{name}', '{tenant}', '{trialEnd}'],
  },
  {
    key: 'signup_alert', audience: 'platform', label: 'Signup — Superadmin alert',
    description: 'Sent to every superadmin when a new ISP signs up.',
    subject: 'New ISP signup: {tenant}',
    heading: 'A new ISP signed up',
    body: '{tenant} ({subdomain}) just created an account.\n\nAdmin: {name}\nEmail: {email}\nPhone: {phone}\n\nTheir free trial ends on {trialEnd}.',
    placeholders: ['{tenant}', '{subdomain}', '{name}', '{email}', '{phone}', '{trialEnd}'],
  },
  {
    key: 'billing_invoice', audience: 'tenant', label: 'Billing — Invoice',
    description: 'Sent when the 5-day payment window opens (5 days before the due date).',
    subject: 'Your Dartbit invoice: KES {amount} due {dueDate}',
    heading: 'Your invoice is ready',
    body: 'Hi {name}, the invoice for {tenant} is now open for payment.\n\nAmount due: KES {amount}\nDue date: {dueDate}\n\nPlease pay before the due date to keep every feature running without interruption.',
    placeholders: ['{name}', '{tenant}', '{amount}', '{dueDate}'],
  },
  {
    key: 'billing_paid', audience: 'tenant', label: 'Billing — Payment confirmation',
    description: 'Sent when a tenancy payment is confirmed.',
    subject: 'Payment received — thank you',
    heading: 'Payment received',
    body: 'Hi {name}, we have received your payment for {tenant}. Thank you.\n\nAmount: KES {amount}\nReference: {reference}\nNext due date: {nextDue}',
    placeholders: ['{name}', '{tenant}', '{amount}', '{reference}', '{nextDue}'],
  },
  {
    key: 'trial_ended', audience: 'tenant', label: 'Billing — Trial ended',
    description: 'Sent when a free trial ends without payment. Features are disabled at this point.',
    subject: 'Your Dartbit free trial has ended',
    heading: 'Your free trial has ended',
    body: 'Hi {name}, the free trial for {tenant} has ended.\n\nDashboard features are now paused until the first invoice is paid. Your subscribers stay online and can still pay for internet — nothing on your network is switched off.\n\nAmount due: KES {amount}',
    placeholders: ['{name}', '{tenant}', '{amount}'],
  },
  {
    key: 'billing_overdue', audience: 'tenant', label: 'Billing — Features disabled',
    description: 'Sent when an invoice passes its due date unpaid and features are disabled.',
    subject: 'Action needed: features disabled for {tenant}',
    heading: 'Your account features are disabled',
    body: 'Hi {name}, the invoice for {tenant} was due on {dueDate} and has not been paid, so dashboard features are now disabled.\n\nYour subscribers stay online and can still pay for internet — nothing on your network is switched off.\n\nAmount due: KES {amount}\n\nEverything is restored the moment the invoice is paid.',
    placeholders: ['{name}', '{tenant}', '{amount}', '{dueDate}'],
  },
  {
    key: 'staff_password_reset', audience: 'tenant', label: 'Password reset — Staff',
    description: 'Temporary password for ISP admins and staff. The password block is added automatically.',
    subject: 'Your temporary Dartbit password',
    heading: 'Reset your password',
    body: "Hi {name}, we got a request to reset your password. Sign in with the temporary password below — you'll be asked to set a new one straight away.\n\nDidn't ask for this? Your old password no longer works, so reset it again from the sign-in page to take back control.",
    placeholders: ['{name}'],
  },
  {
    key: 'superadmin_password_reset', audience: 'platform', label: 'Password reset — Superadmin',
    description: 'Temporary password for superadmin accounts. The password block is added automatically.',
    subject: 'Your temporary Dartbit superadmin password',
    heading: 'Reset your password',
    body: "Hi {name}, we got a request to reset your superadmin password. Sign in with the temporary password below — you'll be asked to set a new one straight away.\n\nDidn't ask for this? Reset it again immediately and review your superadmin team.",
    placeholders: ['{name}'],
  },
  {
    key: 'subscriber_login', audience: 'subscriber', label: 'Subscriber — Login details',
    description: "Sent to a subscriber who asks for their login. Uses the ISP's branding. Login details are added automatically.",
    subject: 'Your {tenant} login details',
    heading: 'Your login details',
    body: "Here are the details for your {tenant} internet connection.\n\nDidn't ask for this? Contact us and we'll look into it.",
    placeholders: ['{tenant}'],
  },
];

const EMAIL_MAP = new Map(EMAIL_TEMPLATES.map((t) => [t.key, t]));

type Override = { subject?: string; heading?: string; body?: string };
let overrides: Record<string, Override> = {};

/** Refresh the in-memory override cache. Called at boot and after every superadmin save. */
export async function loadEmailOverrides(): Promise<void> {
  try {
    const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: EMAIL_TEMPLATE_PREFIX } } });
    const next: Record<string, Override> = {};
    for (const r of rows) {
      try {
        next[r.key.slice(EMAIL_TEMPLATE_PREFIX.length)] = JSON.parse(r.value) as Override;
      } catch {
        /* a corrupt row falls back to the code default */
      }
    }
    overrides = next;
  } catch (e) {
    console.error('[email] could not load template overrides:', e instanceof Error ? e.message : e);
  }
}

export function isEmailTemplateKey(key: string): boolean {
  return EMAIL_MAP.has(key);
}

function effective(key: string): { subject: string; heading: string; body: string } {
  const d = EMAIL_MAP.get(key);
  if (!d) throw new Error(`Unknown email template: ${key}`);
  const o = overrides[key] || {};
  const pick = (v: string | undefined, fallback: string) => (v && v.trim() ? v : fallback);
  return { subject: pick(o.subject, d.subject), heading: pick(o.heading, d.heading), body: pick(o.body, d.body) };
}

/** Superadmin editor payload: every template with its effective values. */
export function allEmailTemplates() {
  return EMAIL_TEMPLATES.map((d) => {
    const e = effective(d.key);
    const o = overrides[d.key];
    return {
      key: d.key,
      audience: d.audience,
      label: d.label,
      description: d.description,
      placeholders: d.placeholders,
      subject: e.subject,
      heading: e.heading,
      body: e.body,
      isDefault: !o || !(o.subject?.trim() || o.heading?.trim() || o.body?.trim()),
    };
  });
}

/** Replace {placeholders}. Unknown ones are left visible so a typo is noticed, not hidden. */
function fill(s: string, ctx: Record<string, string | number | null | undefined>): string {
  return s.replace(/\{(\w+)\}/g, (m, k) => {
    const v = ctx[k];
    return v === null || v === undefined ? m : String(v);
  });
}

export interface RenderOpts {
  brand: Brand;
  ctx: Record<string, string | number | null | undefined>;
  credentials?: Array<[string, string]>;
  cta?: { href: string; label: string };
  /** Small print after the button — e.g. "we also sent this by SMS". */
  note?: string;
  footer?: string;
}

export function renderEmail(key: string, opts: RenderOpts): RenderedEmail {
  const e = effective(key);
  const subject = fill(e.subject, opts.ctx);
  const heading = fill(e.heading, opts.ctx);
  const bodyText = fill(e.body, opts.ctx);

  // Credentials sit between the first paragraph and the rest, so the explanation reads first.
  const [first, ...rest] = bodyText.split(/\n\s*\n/);
  const html = layout({
    brand: opts.brand,
    preheader: heading,
    footer: opts.footer,
    body:
      h1(heading) +
      paragraphs(first || '') +
      (opts.credentials ? credentials(opts.credentials) : '') +
      paragraphs(rest.join('\n\n')) +
      (opts.cta ? button(opts.brand, opts.cta.href, opts.cta.label) : '') +
      (opts.note ? `<p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:#6b7280;">${esc(opts.note)}</p>` : ''),
  });

  const credText = opts.credentials ? '\n' + opts.credentials.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n' : '';
  const ctaText = opts.cta ? `\n\n${opts.cta.label}: ${opts.cta.href}` : '';
  const noteText = opts.note ? `\n\n${opts.note}` : '';
  const text = `${heading}\n\n${first || ''}\n${credText}\n${rest.join('\n\n')}${ctaText}${noteText}`
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Account templates (kept as named helpers so callers stay simple)

export function staffTempPasswordEmail(opts: {
  brand: Brand;
  name: string | null;
  tempPassword: string;
  smsSent: boolean;
}): RenderedEmail {
  return renderEmail('staff_password_reset', {
    brand: opts.brand,
    ctx: { name: firstName(opts.name) },
    credentials: [['Temporary password', opts.tempPassword]],
    cta: { href: `${appUrl()}/auth/login`, label: 'Sign in' },
    note: opts.smsSent ? 'We also sent this to your phone by SMS — either one works.' : undefined,
    footer: `${opts.brand.name} · Staff account`,
  });
}

export function superadminTempPasswordEmail(opts: { name: string | null; tempPassword: string; loginUrl: string }): RenderedEmail {
  return renderEmail('superadmin_password_reset', {
    brand: platformBrand(),
    ctx: { name: firstName(opts.name) },
    credentials: [['Temporary password', opts.tempPassword]],
    cta: { href: opts.loginUrl, label: 'Sign in' },
    footer: 'Dartbit · Superadmin',
  });
}

export function subscriberLoginEmail(opts: {
  brand: Brand;
  username: string;
  secret: string;
  smsSent: boolean;
}): RenderedEmail {
  return renderEmail('subscriber_login', {
    brand: opts.brand,
    ctx: { tenant: opts.brand.name },
    credentials: [
      ['Username', opts.username],
      ['Password', opts.secret],
    ],
    cta: { href: opts.brand.siteUrl, label: 'Open your account' },
    note: opts.smsSent ? 'We also sent these to your phone by SMS.' : undefined,
  });
}
