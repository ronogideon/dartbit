import { Request } from 'express';
import prisma from './prisma';

// Resolve a tenant's subdomain identifier from a request, in priority order:
//   1. Host subdomain  (acme.yourdomain.com -> "acme")  [future, once custom domain is live]
//   2. ?subdomain= or ?t= query param                    [works everywhere now]
//   3. X-Tenant header                                   [for API clients]
// Returns the subdomain string, or null.
export function extractSubdomain(req: Request): string | null {
  // 1. Host header subdomain — only when on the custom base domain (PORTAL_BASE_DOMAIN).
  const base = process.env.PORTAL_BASE_DOMAIN; // e.g. "dartbit.app"
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (base && host.endsWith(`.${base}`)) {
    const sub = host.slice(0, host.length - base.length - 1);
    if (sub && sub !== 'www') return sub;
  }

  // 2. Query param (path-based interim): ?subdomain=acme or ?t=acme
  const q = String(req.query.subdomain || req.query.t || '').trim().toLowerCase();
  if (q) return q;

  // 3. Header
  const h = String(req.headers['x-tenant'] || '').trim().toLowerCase();
  if (h) return h;

  return null;
}

export async function resolveTenantBySubdomain(req: Request): Promise<{ id: string; name: string; subdomain: string; logoUrl: string | null; themeColor: string | null; fontFamily: string | null; supportPhone: string | null; phone: string | null } | null> {
  const sub = extractSubdomain(req);
  if (!sub) return null;
  return prisma.tenant.findUnique({
    where: { subdomain: sub },
    select: { id: true, name: true, subdomain: true, logoUrl: true, themeColor: true, fontFamily: true, supportPhone: true, phone: true },
  });
}
