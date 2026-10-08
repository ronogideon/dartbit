// Server-side tenant branding for the installable app (manifest + icons).
//
// These requests come from the browser BEFORE anyone logs in, and the manifest is fetched without
// cookies, so branding is resolved from the Host header alone and fetched from the public
// /portal/tenant endpoint — the same one the portal login page already uses.
//
// Mirrors tenantSubdomainFromHost() in lib/api.ts, which can't be imported here: that module is
// browser-only (window, axios interceptors).

const PORTAL_BASE_DOMAIN = (process.env.NEXT_PUBLIC_PORTAL_BASE_DOMAIN || 'dartbittech.com').toLowerCase();
const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'https://api.dartbittech.com').replace(/\/+$/, '');
const RESERVED_SUBS = ['www', 'api', 'app', 'admin', 'superadmin'];

export const DEFAULT_THEME = '#2563eb';
export const APP_BACKGROUND = '#030712'; // gray-950 — the portal's own background

export interface PwaBrand {
  /** Tenant subdomain, or '' on the apex / unknown hosts. */
  subdomain: string;
  name: string;
  shortName: string;
  themeColor: string;
  logoUrl: string | null;
}

export function subdomainFromHost(rawHost: string | null | undefined): string {
  const host = (rawHost || '').split(':')[0].toLowerCase().trim();
  if (!host) return '';
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.up.railway.app') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return '';
  }
  if (host === PORTAL_BASE_DOMAIN || host === `www.${PORTAL_BASE_DOMAIN}`) return '';
  if (host.endsWith(`.${PORTAL_BASE_DOMAIN}`)) {
    const first = host.slice(0, host.length - PORTAL_BASE_DOMAIN.length - 1).split('.')[0];
    return first && !RESERVED_SUBS.includes(first) ? first : '';
  }
  const labels = host.split('.');
  if (labels.length >= 3 && labels[0] && !RESERVED_SUBS.includes(labels[0])) return labels[0];
  return '';
}

const validHex = (c: unknown): string | null =>
  typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null;

/** Home-screen labels are ~12 characters before Android/iOS truncate them. */
function shorten(name: string): string {
  const n = name.trim();
  if (n.length <= 12) return n;
  const firstWord = n.split(/\s+/)[0];
  return firstWord.length <= 12 ? firstWord : n.slice(0, 12);
}

const PLATFORM: PwaBrand = {
  subdomain: '',
  name: 'Dartbit',
  shortName: 'Dartbit',
  themeColor: DEFAULT_THEME,
  logoUrl: null,
};

export async function getPwaBrand(host: string | null | undefined): Promise<PwaBrand> {
  const subdomain = subdomainFromHost(host);
  if (!subdomain) return PLATFORM;
  try {
    const res = await fetch(`${API_URL}/portal/tenant?t=${encodeURIComponent(subdomain)}`, {
      // Branding rarely changes; a few minutes of caching keeps icon requests off the API.
      next: { revalidate: 300 },
    });
    if (!res.ok) return { ...PLATFORM, subdomain };
    const body = (await res.json()) as { tenant?: { name?: string; themeColor?: string | null; logoUrl?: string | null } };
    const t = body.tenant;
    if (!t?.name) return { ...PLATFORM, subdomain };
    return {
      subdomain,
      name: t.name,
      shortName: shorten(t.name),
      themeColor: validHex(t.themeColor) || DEFAULT_THEME,
      logoUrl: t.logoUrl || null,
    };
  } catch {
    return { ...PLATFORM, subdomain };
  }
}

/** Short stable hash, so a changed logo or colour gets a new icon URL and installs refresh. */
export function brandVersion(b: PwaBrand): string {
  const s = `${b.name}|${b.themeColor}|${b.logoUrl || ''}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
