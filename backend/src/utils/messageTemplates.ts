// Editable SMS message templates. Each automatic message has a key and a default body with
// {placeholders}. Tenants can override any template; absent keys fall back to the default.
// Placeholders are replaced at send time from a context object.

export interface TemplateDef {
  key: string;
  group: 'hotspot' | 'pppoe' | 'system';
  label: string;
  description: string;
  default: string;
  placeholders: string[];   // for the UI hint
}

// Common placeholders:
//  {tenant} {name} {username} {login} {password} {package} {amount} {expiry} {remaining}
//  {router} {balance} {phone} {receipt}
export const TEMPLATES: TemplateDef[] = [
  // ---- Hotspot ----
  {
    key: 'hotspot_welcome', group: 'hotspot', label: 'Hotspot — Welcome',
    description: 'Sent the first time a hotspot customer pays.',
    default: 'Welcome to {tenant}! Your account {username} is ready. Enjoy your internet.',
    placeholders: ['{tenant}', '{username}', '{name}', '{phone}'],
  },
  {
    key: 'hotspot_receipt', group: 'hotspot', label: 'Hotspot — Payment receipt',
    description: 'Sent after every hotspot payment. Includes login + amount.',
    default: '{tenant}: Paid KES {amount} ({package}). Login: {login}. Ref {receipt}. Thank you!',
    placeholders: ['{tenant}', '{amount}', '{package}', '{login}', '{receipt}'],
  },
  {
    key: 'hotspot_reminder', group: 'hotspot', label: 'Hotspot — Expiry reminder',
    description: 'Sent before a hotspot subscription expires.',
    default: 'Hi, your {tenant} internet expires in {remaining}. Buy a new package on the portal to stay connected.',
    placeholders: ['{tenant}', '{remaining}', '{expiry}'],
  },
  {
    key: 'hotspot_expired', group: 'hotspot', label: 'Hotspot — Expired',
    description: 'Sent when a hotspot subscription has expired.',
    default: 'Your {tenant} internet has expired. Buy a new package on the portal to reconnect.',
    placeholders: ['{tenant}'],
  },
  // ---- PPPoE / Static ----
  {
    key: 'pppoe_welcome', group: 'pppoe', label: 'PPPoE/Static — Welcome',
    description: 'Sent when a PPPoE/Static subscriber is created.',
    default: 'Welcome to {tenant}, {name}! Your connection ({package}) is active. Username: {username}.',
    placeholders: ['{tenant}', '{name}', '{package}', '{username}'],
  },
  {
    key: 'pppoe_subscription', group: 'pppoe', label: 'PPPoE/Static — Subscription receipt',
    description: 'Sent on payment/renewal for a PPPoE/Static subscriber.',
    default: '{tenant}: Payment of KES {amount} received for {package}. Active until {expiry}. Thank you, {name}!',
    placeholders: ['{tenant}', '{amount}', '{package}', '{expiry}', '{name}'],
  },
  {
    key: 'pppoe_reminder', group: 'pppoe', label: 'PPPoE/Static — Expiry reminder',
    description: 'Sent before a PPPoE/Static subscription expires.',
    default: 'Hi {name}, your {tenant} subscription ({package}) expires in {remaining}. Please renew to stay connected.',
    placeholders: ['{tenant}', '{name}', '{package}', '{remaining}', '{expiry}'],
  },
  {
    key: 'pppoe_expired', group: 'pppoe', label: 'PPPoE/Static — Expired',
    description: 'Sent when a PPPoE/Static subscription has expired.',
    default: 'Hi {name}, your {tenant} subscription has expired. Please renew to restore your connection.',
    placeholders: ['{tenant}', '{name}'],
  },
  // ---- System ----
  {
    key: 'system_router_offline', group: 'system', label: 'System — Router offline',
    description: 'Sent to your alert numbers when a router is offline more than 5 minutes.',
    default: '{tenant} ALERT: Router "{router}" has been offline for over 5 minutes. Please check it.',
    placeholders: ['{tenant}', '{router}'],
  },
  {
    key: 'system_low_balance', group: 'system', label: 'System — Low SMS balance',
    description: 'Sent to your alert numbers when your SMS wallet runs low.',
    default: '{tenant} ALERT: Your Dartbit SMS balance is low (KES {balance}). Top up to keep notifications running.',
    placeholders: ['{tenant}', '{balance}'],
  },
];

const TEMPLATE_MAP = new Map(TEMPLATES.map(t => [t.key, t]));

export function defaultTemplate(key: string): string {
  return TEMPLATE_MAP.get(key)?.default || '';
}

// Resolve the effective template body for a tenant: their override if present, else default.
export function resolveTemplate(key: string, overrides: Record<string, string> | null | undefined): string {
  const o = overrides?.[key];
  if (typeof o === 'string' && o.trim()) return o;
  return defaultTemplate(key);
}

// Render a template by replacing {placeholders} from ctx. Unknown placeholders are removed.
export function renderTemplate(body: string, ctx: Record<string, string | number | null | undefined>): string {
  return body.replace(/\{(\w+)\}/g, (_m, k) => {
    const v = ctx[k];
    return v === null || v === undefined ? '' : String(v);
  }).replace(/\s{2,}/g, ' ').trim();
}

// Build the full templates map (defaults merged with overrides) for the settings UI.
export function allTemplatesWithDefaults(overrides: Record<string, string> | null | undefined) {
  return TEMPLATES.map(t => ({
    key: t.key,
    group: t.group,
    label: t.label,
    description: t.description,
    placeholders: t.placeholders,
    default: t.default,
    value: (overrides?.[t.key] && overrides[t.key].trim()) ? overrides[t.key] : t.default,
    isCustom: !!(overrides?.[t.key] && overrides[t.key].trim()),
  }));
}
