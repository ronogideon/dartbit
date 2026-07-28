import { Router, Response } from 'express';
import crypto from 'crypto';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { enqueueCommand } from '../utils/commandQueue';

// Per-router DNS/Firewall blocking. A tenant enables the firewall on a router and adds domains to
// block; those domains then resolve to a dead address AND are dropped at the firewall, so the sites
// serve no data while the rest of the internet stays reachable. Enforcement is RouterOS-native
// (static DNS + firewall address-list drop) pushed via the command queue — no dependency on an
// external resolver being up for blocking to hold. Raw SQL for deploy robustness.

const router = Router();
router.use(authenticate);

const uid = () => crypto.randomUUID();
// Accept a bare hostname/domain; strip scheme, path, port, whitespace. Reject anything that isn't a
// plausible domain so we never push junk into a router's DNS/firewall config.
function cleanDomain(input: unknown): string | null {
  let d = String(input ?? '').trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split('#')[0].split(':')[0].trim();
  if (d.length < 3 || d.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  return d;
}

const isAdmin = (req: AuthRequest) => req.user?.role === 'TENANT_ADMIN' || req.user?.role === 'SUPERADMIN';

async function ownRouter(req: AuthRequest, routerId: string) {
  const tenantId = req.user?.tenantId;
  if (!tenantId) return null;
  return prisma.mikrotikRouter.findFirst({ where: { id: routerId, tenantId } });
}

// Build the RouterOS command that makes the router's live config match the stored blocklist exactly:
// rebuild the Dartbit-managed static DNS entries + the "dartbit-block" address-list, and ensure the
// two firewall drop rules exist. Everything Dartbit-owned is comment/list-scoped so we never touch
// the tenant's or Centipid's own rules. Sending the FULL desired state each time keeps it
// idempotent and self-correcting.
export function buildBlockSync(enabled: boolean, domains: string[]): string {
  const L: string[] = [];
  // Clear previously-managed entries first (scoped to our comment/list so we never touch the
  // tenant's or Centipid's own config). Each statement is its OWN line: the command queue delivers
  // this as an /import file that runs line-by-line, so one failing statement can't abort the rest.
  L.push(`:foreach d in=[/ip dns static find comment="dartbit-block"] do={ /ip dns static remove $d }`);
  L.push(`:foreach a in=[/ip firewall address-list find list="dartbit-block"] do={ /ip firewall address-list remove $a }`);

  if (enabled && domains.length) {
    for (const d of domains) {
      // RouterOS 7 match-subdomain=yes blocks the domain AND every subdomain in one entry, resolving
      // it to a dead address. This is the primary block and needs clients to use the router's DNS —
      // which the redirect below guarantees.
      L.push(`:do { /ip dns static add name="${d}" address=0.0.0.0 match-subdomain=yes comment="dartbit-block" } on-error={ :do { /ip dns static add name="${d}" address=0.0.0.0 comment="dartbit-block" } on-error={} }`);
      // Second layer: resolve the name at the firewall too, so traffic to its IP is dropped even if a
      // client somehow reaches it without the router's DNS answer (cached IP, hardcoded host).
      L.push(`:do { /ip firewall address-list add list="dartbit-block" address="${d}" comment="dartbit-block" } on-error={}`);
    }
    // THE KEY FIX: force every client DNS query through the router. Without this, a device set to
    // 8.8.8.8 never sees our static entries and the block does nothing — which is exactly the
    // "works as usual" symptom. Redirecting 53/udp+tcp to the router makes it answer ALL lookups,
    // so the blocklist applies to every device regardless of its configured DNS. Scoped by comment,
    // and skipped on hotspot routers where the hotspot already owns the DNS redirect.
    L.push(`:if ([:len [/ip firewall nat find comment="dartbit-dns-force"]] = 0 && [:len [/ip hotspot]] = 0) do={ /ip firewall nat add chain=dstnat protocol=udp dst-port=53 action=redirect to-ports=53 comment="dartbit-dns-force" }`);
    L.push(`:if ([:len [/ip firewall nat find comment="dartbit-dns-force-tcp"]] = 0 && [:len [/ip hotspot]] = 0) do={ /ip firewall nat add chain=dstnat protocol=tcp dst-port=53 action=redirect to-ports=53 comment="dartbit-dns-force-tcp" }`);
    // Firewall drop for the resolved IPs (forward = client traffic, output = router's own).
    L.push(`:if ([:len [/ip firewall filter find comment="dartbit-block-fwd"]] = 0) do={ /ip firewall filter add chain=forward dst-address-list="dartbit-block" action=drop comment="dartbit-block-fwd" place-before=0 }`);
    L.push(`:if ([:len [/ip firewall filter find comment="dartbit-block-out"]] = 0) do={ /ip firewall filter add chain=output dst-address-list="dartbit-block" action=drop comment="dartbit-block-out" place-before=0 }`);
    // The router must actually run a resolver for its clients.
    L.push(`:do { /ip dns set allow-remote-requests=yes } on-error={}`);
  } else {
    // Disabled: remove our drop rules AND the DNS redirect, leaving the router fully open.
    L.push(`:foreach f in=[/ip firewall filter find comment="dartbit-block-fwd"] do={ /ip firewall filter remove $f }`);
    L.push(`:foreach f in=[/ip firewall filter find comment="dartbit-block-out"] do={ /ip firewall filter remove $f }`);
    L.push(`:foreach n in=[/ip firewall nat find comment="dartbit-dns-force"] do={ /ip firewall nat remove $n }`);
    L.push(`:foreach n in=[/ip firewall nat find comment="dartbit-dns-force-tcp"] do={ /ip firewall nat remove $n }`);
  }
  L.push(`:do { /ip dns cache flush } on-error={}`);
  L.push(`:log info "Dartbit: firewall blocklist applied (${enabled ? domains.length : 0} domains)"`);
  return L.join('\n');
}

async function pushSync(routerId: string) {
  const cfg = await prisma.$queryRawUnsafe(
    `SELECT enabled FROM "RouterFirewall" WHERE "routerId"=$1`, routerId) as { enabled: boolean }[];
  const enabled = cfg.length ? cfg[0].enabled : false;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT domain FROM "RouterBlockedDomain" WHERE "routerId"=$1 ORDER BY domain ASC`, routerId) as { domain: string }[];
  await enqueueCommand(routerId, buildBlockSync(enabled, rows.map(r => r.domain)));
}

// GET /router-firewall/:routerId — current firewall state + blocklist for a router.
router.get('/:routerId', async (req: AuthRequest, res: Response) => {
  try {
    const r = await ownRouter(req, req.params.routerId);
    if (!r) return sendError(res, 'Router not found', 404);
    const cfg = await prisma.$queryRawUnsafe(
      `SELECT enabled, "updatedAt" FROM "RouterFirewall" WHERE "routerId"=$1`, r.id) as { enabled: boolean; updatedAt: Date }[];
    const domains = await prisma.$queryRawUnsafe(
      `SELECT id, domain, "createdAt" FROM "RouterBlockedDomain" WHERE "routerId"=$1 ORDER BY domain ASC`, r.id);
    sendSuccess(res, {
      enabled: cfg.length ? cfg[0].enabled : false,
      updatedAt: cfg.length ? cfg[0].updatedAt : null,
      domains,
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// PATCH /router-firewall/:routerId — toggle the firewall on/off.
router.patch('/:routerId', async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) return sendError(res, 'Only admins can change firewall settings', 403);
    const r = await ownRouter(req, req.params.routerId);
    if (!r) return sendError(res, 'Router not found', 404);
    const enabled = !!req.body?.enabled;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "RouterFirewall" (id, "routerId", "tenantId", enabled, "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$4,NOW(),NOW())
       ON CONFLICT ("routerId") DO UPDATE SET enabled=$4, "updatedAt"=NOW()`,
      uid(), r.id, r.tenantId, enabled);
    await pushSync(r.id);
    sendSuccess(res, { enabled, message: enabled ? 'Firewall enabled — blocklist is being applied.' : 'Firewall disabled — all sites are reachable again.' });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /router-firewall/:routerId/domains — block a domain. Body: { domain }
router.post('/:routerId/domains', async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) return sendError(res, 'Only admins can change the blocklist', 403);
    const r = await ownRouter(req, req.params.routerId);
    if (!r) return sendError(res, 'Router not found', 404);
    const domain = cleanDomain(req.body?.domain);
    if (!domain) return sendError(res, 'Enter a valid website, e.g. example.com', 400);
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM "RouterBlockedDomain" WHERE "routerId"=$1 AND domain=$2`, r.id, domain) as { id: string }[];
    if (existing.length) return sendError(res, 'That site is already blocked', 409);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "RouterBlockedDomain" (id, "routerId", "tenantId", domain, "createdAt") VALUES ($1,$2,$3,$4,NOW())`,
      uid(), r.id, r.tenantId, domain);
    await pushSync(r.id);
    sendSuccess(res, { domain, message: `${domain} will be blocked on this router.` });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// DELETE /router-firewall/:routerId/domains/:id — unblock a domain.
router.delete('/:routerId/domains/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) return sendError(res, 'Only admins can change the blocklist', 403);
    const r = await ownRouter(req, req.params.routerId);
    if (!r) return sendError(res, 'Router not found', 404);
    await prisma.$executeRawUnsafe(
      `DELETE FROM "RouterBlockedDomain" WHERE id=$1 AND "routerId"=$2`, req.params.id, r.id);
    await pushSync(r.id);
    sendSuccess(res, { ok: true });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /router-firewall/:routerId/resync — re-push the full desired state (e.g. after reprovision).
router.post('/:routerId/resync', async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) return sendError(res, 'Only admins can resync', 403);
    const r = await ownRouter(req, req.params.routerId);
    if (!r) return sendError(res, 'Router not found', 404);
    await pushSync(r.id);
    sendSuccess(res, { ok: true, message: 'Blocklist re-sent to the router.' });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /router-firewall/:routerId/preview — the exact RouterOS commands the current blocklist
// produces. Lets us confirm what's being pushed without shell access to the router.
router.get('/:routerId/preview', async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) return sendError(res, 'Admins only', 403);
    const r = await ownRouter(req, req.params.routerId);
    if (!r) return sendError(res, 'Router not found', 404);
    const cfg = await prisma.$queryRawUnsafe(`SELECT enabled FROM "RouterFirewall" WHERE "routerId"=$1`, r.id) as { enabled: boolean }[];
    const rows = await prisma.$queryRawUnsafe(`SELECT domain FROM "RouterBlockedDomain" WHERE "routerId"=$1 ORDER BY domain ASC`, r.id) as { domain: string }[];
    const script = buildBlockSync(cfg.length ? cfg[0].enabled : false, rows.map(x => x.domain));
    sendSuccess(res, { enabled: cfg.length ? cfg[0].enabled : false, domainCount: rows.length, script });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export default router;
