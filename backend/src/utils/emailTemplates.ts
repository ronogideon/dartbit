// Hand-written table HTML with inline styles: the only thing that renders the same
// in Gmail, Apple Mail and desktop Outlook. No framework, no build step.
//
// Branding is passed in rather than hardcoded: tenant mail uses the tenant's
// logoUrl/themeColor (already on the Tenant model), platform mail uses Dartbit's.
import prisma from './prisma';

export const FONT =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

export const DEFAULT_ACCENT = '#2563eb';

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

export function platformBrand(): Brand {
  return {
    name: 'Dartbit',
    accent: DEFAULT_ACCENT,
    logoUrl: null,
    siteUrl: process.env.PUBLIC_APP_URL || 'https://dartbittech.com',
  };
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

  const root = (process.env.PUBLIC_APP_URL || 'https://dartbittech.com').replace(/^https?:\/\//, '');
  const host = t.domain || (t.subdomain ? `${t.subdomain}.${root}` : root);
  return {
    name: t.name || 'Dartbit',
    accent: validHex(t.themeColor) || DEFAULT_ACCENT,
    logoUrl: t.logoUrl || null,
    siteUrl: `https://${host}`,
  };
}

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
    <a href="${esc(brand.siteUrl)}" style="color:#6b7280;">${esc(
    brand.siteUrl.replace(/^https?:\/\//, '')
  )}</a>
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

export const h1 = (s: string) =>
  `<p style="margin:0 0 6px;font-size:22px;font-weight:700;line-height:1.3;color:#0A0A0B;">${s}</p>`;
export const lead = (s: string) => `<p style="margin:0 0 20px;color:#4b5563;">${s}</p>`;
export const small = (s: string) =>
  `<p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#6b7280;">${s}</p>`;

/** Monospaced credential block — a temp password or username/password pair. */
export function credentials(rows: Array<[string, string]>): string {
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
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0;background:#f9fafb;border-radius:10px;padding:0;">
<tr><td style="padding:14px 16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0">${cells}</table></td></tr></table>`;
}

// ---------------------------------------------------------------------------
// Account templates

export function staffTempPasswordEmail(opts: {
  brand: Brand;
  name: string | null;
  tempPassword: string;
  smsSent: boolean;
}): RenderedEmail {
  const { brand } = opts;
  const html = layout({
    brand,
    preheader: 'A temporary password for your staff account.',
    body: `${h1('Reset your password')}
${lead(
      `Hi ${esc(
        firstName(opts.name)
      )}, we got a request to reset the password for your ${esc(brand.name)} staff account. Sign in with the temporary password below — you'll be asked to set a new one straight away.`
    )}
${credentials([['Temporary password', opts.tempPassword]])}
${button(brand, `${brand.siteUrl}/login`, 'Sign in')}
${opts.smsSent ? small('We also sent this to your phone by SMS — either one works.') : ''}
${small(
      "Didn't ask for this? Your old password no longer works, so reset it again from the sign-in page to take back control."
    )}`,
    footer: `${brand.name} · Staff account`,
  });

  const text = `Reset your password

Hi ${firstName(opts.name)}, we got a request to reset the password for your ${brand.name} staff account.

Temporary password: ${opts.tempPassword}

Sign in at ${brand.siteUrl}/login and you'll be asked to set a new one.
${opts.smsSent ? '\nWe also sent this to your phone by SMS — either one works.\n' : ''}
Didn't ask for this? Your old password no longer works, so reset it again from the sign-in page.`;

  return { subject: `Your ${brand.name} temporary password`, html, text };
}

export function subscriberLoginEmail(opts: {
  brand: Brand;
  username: string;
  secret: string;
  smsSent: boolean;
}): RenderedEmail {
  const { brand } = opts;
  const html = layout({
    brand,
    preheader: `Your ${brand.name} internet login details.`,
    body: `${h1('Your login details')}
${lead(`Here are the details for your ${esc(brand.name)} internet connection.`)}
${credentials([
      ['Username', opts.username],
      ['Password', opts.secret],
    ])}
${button(brand, brand.siteUrl, 'Open your account')}
${opts.smsSent ? small('We also sent these to your phone by SMS.') : ''}
${small("Didn't ask for this? Contact us and we'll look into it.")}`,
  });

  const text = `Your ${brand.name} login details

Username: ${opts.username}
Password: ${opts.secret}

Open your account: ${brand.siteUrl}
${opts.smsSent ? '\nWe also sent these to your phone by SMS.\n' : ''}
Didn't ask for this? Contact us and we'll look into it.`;

  return { subject: `Your ${brand.name} login details`, html, text };
}
