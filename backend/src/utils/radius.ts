// Dartbit RADIUS integration (PPPoE pilot). Manages FreeRADIUS users in the droplet's Postgres
// `radius` DB by running psql over the existing SSH channel — no exposed database. On subscriber
// create/extend/edit we write radcheck (password) + radreply (rate-limit) + an Expiration check
// item; on expire/delete we remove them and fire a CoA-Disconnect to kick the live session at once.
//
// Runs in PARALLEL with the legacy script system: only PPPoE subscribers on RADIUS-enabled routers
// are synced here. Hotspot keeps using the existing flow until we migrate it later.
import prisma from './prisma';
import { dropletExec, dropletSshConfigured, shq, sqlq } from './dropletSsh';

const RADIUS_DB = process.env.DARTBIT_RADIUS_DB || 'radius';
// The NAS secret used for CoA-Disconnect packets (must match the secret set on the router and in
// the FreeRADIUS `nas` table). Per-router secrets could be stored later; one shared secret for now.
const COA_PORT = '3799';

export function radiusConfigured(): boolean {
  return dropletSshConfigured() && (process.env.DARTBIT_RADIUS_ENABLED === 'true');
}

// Run a psql statement against the radius DB on the droplet (as the postgres superuser via sudo).
async function radiusPsql(sql: string): Promise<string> {
  // -tA = tuples only, unaligned; -c runs one command.
  const cmd = `sudo -u postgres psql -d ${RADIUS_DB} -tA -c ${shq(sql)}`;
  return dropletExec(cmd);
}

// Map a package speed to a MikroTik rate-limit string (e.g. "5M/20M" up/down).
function rateLimit(upKbps?: number | null, downKbps?: number | null): string {
  const up = upKbps && upKbps > 0 ? `${Math.round(upKbps)}k` : '1M';
  const down = downKbps && downKbps > 0 ? `${Math.round(downKbps)}k` : '1M';
  return `${up}/${down}`;
}

// FreeRADIUS Expiration attribute format: "DD Mon YYYY HH:MM:SS" (e.g. "31 Dec 2026 23:59:59").
function radiusExpiry(d: Date): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = months[d.getMonth()];
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dd} ${mon} ${yyyy} ${hh}:${mi}:${ss}`;
}

interface RadiusSub {
  id: string;
  username: string;
  secret: string;
  isActive: boolean;
  expiresAt?: Date | null;
  service: string;
  routerId?: string | null;
  macAddress?: string | null;
  packageId?: string | null;
  package?: { speedUpKbps: number; speedDownKbps: number } | null;
}

// A single RADIUS login identity (radcheck row group): a name + the password it authenticates with.
interface RadiusIdentity { name: string; password: string; }

// Resolve whether a router is RADIUS-managed, plus the bits needed for CoA. We gate ALL syncing on
// this so the RADIUS path only ever touches routers explicitly switched to RADIUS (radiusEnabled).
// Everything else stays on the legacy script system, untouched.
async function routerRadius(routerId?: string | null): Promise<{ enabled: boolean; wgIp?: string | null; secret?: string | null }> {
  if (!routerId) return { enabled: false };
  const r = await prisma.mikrotikRouter.findUnique({
    where: { id: routerId },
    select: { radiusEnabled: true, wgIp: true, radiusSecret: true } as any,
  });
  return {
    enabled: !!(r as any)?.radiusEnabled,
    wgIp: (r as any)?.wgIp,
    secret: (r as any)?.radiusSecret,
  };
}

// Normalize a MAC to MikroTik's canonical uppercase colon format (AA:BB:CC:DD:EE:FF).
function normMac(mac?: string | null): string | null {
  if (!mac) return null;
  const m = mac.toUpperCase().trim();
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(m) ? m : null;
}

// Write (upsert) a subscriber into RADIUS. PPPoE → one identity (username/secret). HOTSPOT → two
// identities: the D-name (username/secret, for manual portal login) and the device MAC
// (username=password=MAC, for silent mac-auth auto-login). Each identity carries the same expiry +
// rate-limit. Idempotent — clears prior rows for every identity first, then inserts current state.
// Gated on the router being RADIUS-managed, so legacy-script routers are never touched here.
export async function syncSubscriberToRadius(subscriberId: string): Promise<void> {
  if (!radiusConfigured()) return;
  const sub = await prisma.subscriber.findUnique({
    where: { id: subscriberId },
    include: { package: true },
  }) as RadiusSub | null;
  if (!sub) return;
  if (sub.service !== 'PPPOE' && sub.service !== 'HOTSPOT') return;

  const { enabled } = await routerRadius(sub.routerId);
  if (!enabled) return; // router still on the legacy script system — leave it alone

  const now = new Date();
  const expired = sub.expiresAt ? sub.expiresAt <= now : false;
  // HOTSPOT entitlement also requires a package (matches the legacy expiry-watcher rule).
  const entitled = sub.service === 'HOTSPOT'
    ? sub.isActive && !!sub.packageId && !expired
    : sub.isActive && !expired;

  // Build the identity list for this subscriber.
  const identities: RadiusIdentity[] = [{ name: sub.username, password: sub.secret }];
  const mac = sub.service === 'HOTSPOT' ? normMac(sub.macAddress) : null;
  if (mac) identities.push({ name: mac, password: mac });

  const stmts: string[] = [];
  for (const id of identities) {
    const u = sqlq(id.name);
    stmts.push(`DELETE FROM radcheck WHERE username='${u}';`);
    stmts.push(`DELETE FROM radreply WHERE username='${u}';`);
    if (!entitled) continue;
    const pwd = sqlq(id.password);
    stmts.push(`INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Cleartext-Password',':=','${pwd}');`);
    if (sub.expiresAt) {
      const exp = sqlq(radiusExpiry(sub.expiresAt));
      stmts.push(`INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Expiration',':=','${exp}');`);
    }
    const rl = sqlq(rateLimit(sub.package?.speedUpKbps, sub.package?.speedDownKbps));
    stmts.push(`INSERT INTO radreply (username, attribute, op, value) VALUES ('${u}','Mikrotik-Rate-Limit',':=','${rl}');`);
  }

  await radiusPsql(stmts.join(' '));

  // If no longer entitled, kick any live session immediately via CoA-Disconnect (every identity).
  if (!entitled && sub.routerId) {
    await disconnectSession(sub, identities.map(i => i.name)).catch(() => { /* best-effort */ });
  }
}

// Remove a subscriber from RADIUS entirely (on delete) and kick the session. Clears every identity
// (D-name + MAC for hotspot).
export async function removeSubscriberFromRadius(sub: RadiusSub): Promise<void> {
  if (!radiusConfigured()) return;
  if (sub.service !== 'PPPOE' && sub.service !== 'HOTSPOT') return;
  const { enabled } = await routerRadius(sub.routerId);
  if (!enabled) return;
  const names = [sub.username];
  const mac = sub.service === 'HOTSPOT' ? normMac(sub.macAddress) : null;
  if (mac) names.push(mac);
  const dels = names.map(n => { const u = sqlq(n); return `DELETE FROM radcheck WHERE username='${u}'; DELETE FROM radreply WHERE username='${u}';`; }).join(' ');
  await radiusPsql(dels).catch(() => {});
  await disconnectSession(sub, names).catch(() => {});
}

// Send a CoA Disconnect-Request to the router so the live session drops at once, for each given
// User-Name (PPPoE: the username; hotspot: the D-name AND the MAC, since the live session may be
// authenticated under either). Uses the router's VPN IP + the NAS shared secret. radclient runs on
// the droplet (it has FreeRADIUS tools).
async function disconnectSession(sub: RadiusSub, names: string[]): Promise<void> {
  if (!sub.routerId) return;
  const { wgIp, secret } = await routerRadius(sub.routerId);
  if (!wgIp || !secret) return;
  for (const name of names) {
    const attrs = `User-Name=${name}`;
    const cmd = `echo ${shq(attrs)} | radclient -x ${shq(`${wgIp}:${COA_PORT}`)} disconnect ${shq(secret)}`;
    await dropletExec(cmd).catch(() => { /* best-effort per identity */ });
  }
}

// One-time / on-demand bulk sync: push ALL entitled PPPoE subscribers for a tenant (optionally a
// single router) into RADIUS in a single batched psql call. Used to migrate existing customers into
// RADIUS before enabling it on the router. Returns how many were written.
export async function bulkSyncPppoeToRadius(opts: { tenantId?: string; routerId?: string }): Promise<{ synced: number; skipped: number }> {
  if (!radiusConfigured()) throw new Error('RADIUS not configured');
  const subs = await prisma.subscriber.findMany({
    where: {
      service: 'PPPOE',
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(opts.routerId ? { routerId: opts.routerId } : {}),
    },
    include: { package: true },
  });

  const now = new Date();
  const stmts: string[] = [];
  let synced = 0, skipped = 0;
  for (const sub of subs) {
    const expired = sub.expiresAt ? sub.expiresAt <= now : false;
    const entitled = sub.isActive && !expired;
    const u = sqlq(sub.username);
    // Always clear prior rows for a clean upsert.
    stmts.push(`DELETE FROM radcheck WHERE username='${u}';`);
    stmts.push(`DELETE FROM radreply WHERE username='${u}';`);
    if (!entitled) { skipped++; continue; }
    const pwd = sqlq(sub.secret);
    stmts.push(`INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Cleartext-Password',':=','${pwd}');`);
    if (sub.expiresAt) {
      const exp = sqlq(radiusExpiry(sub.expiresAt));
      stmts.push(`INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Expiration',':=','${exp}');`);
    }
    const rl = sqlq(rateLimit(sub.package?.speedUpKbps, sub.package?.speedDownKbps));
    stmts.push(`INSERT INTO radreply (username, attribute, op, value) VALUES ('${u}','Mikrotik-Rate-Limit',':=','${rl}');`);
    synced++;
  }

  if (stmts.length) {
    // Wrap in a transaction; run in chunks so the command line never gets too long.
    const CHUNK = 200;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      const chunk = stmts.slice(i, i + CHUNK).join(' ');
      await radiusPsql(`BEGIN; ${chunk} COMMIT;`);
    }
  }
  return { synced, skipped };
}

// ─── Vouchers over RADIUS ────────────────────────────────────────────────────────────────────────
// A voucher authenticates by code (username=password=code). Its time limit is CUMULATIVE uptime that
// starts counting on first login — identical to the legacy MikroTik `limit-uptime`. We reproduce
// that with a FreeRADIUS sqlcounter (`dartbit_uptime`, reset=never, defined droplet-side in
// 08-hotspot-radius.sh): the voucher carries a `Max-All-Session := <seconds>` check item; the
// counter sums acctsessiontime from radacct and replies Session-Timeout=remaining, rejecting once
// the allowance is spent. So an unredeemed voucher sits indefinitely, and the clock only runs while
// it's actually online. MPESA-tagged vouchers (receipt codes) are skipped here — those devices are
// already authenticated via the subscriber's MAC/D-name radcheck rows.

function voucherRows(code: string, seconds: number, upKbps?: number | null, downKbps?: number | null): string[] {
  const u = sqlq(code);
  const rl = sqlq(rateLimit(upKbps, downKbps));
  return [
    `DELETE FROM radcheck WHERE username='${u}';`,
    `DELETE FROM radreply WHERE username='${u}';`,
    `INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Cleartext-Password',':=','${u}');`,
    `INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Max-All-Session',':=','${seconds}');`,
    `INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Simultaneous-Use',':=','1');`,
    `INSERT INTO radreply (username, attribute, op, value) VALUES ('${u}','Mikrotik-Rate-Limit',':=','${rl}');`,
  ];
}

// Write one voucher into RADIUS (on generate/edit). Gated on the router being RADIUS-managed.
export async function syncVoucherToRadius(voucherId: string): Promise<void> {
  if (!radiusConfigured()) return;
  const v = await prisma.voucher.findUnique({ where: { id: voucherId }, include: { package: true } });
  if (!v || v.batchId === 'MPESA') return;
  const { enabled } = await routerRadius(v.routerId);
  if (!enabled) return;
  const seconds = Math.max(60, v.durationMinutes * 60);
  await radiusPsql(voucherRows(v.code, seconds, v.package?.speedUpKbps, v.package?.speedDownKbps).join(' '));
}

// Remove a voucher from RADIUS (on delete).
export async function removeVoucherFromRadius(code: string): Promise<void> {
  if (!radiusConfigured()) return;
  const u = sqlq(code);
  await radiusPsql(`DELETE FROM radcheck WHERE username='${u}'; DELETE FROM radreply WHERE username='${u}';`).catch(() => {});
}

// Bulk-push vouchers for a tenant/router into RADIUS (migration + batch generate). Only vouchers on
// RADIUS-enabled routers are written; MPESA receipts are skipped. Returns counts.
export async function bulkSyncVouchersToRadius(opts: { tenantId?: string; routerId?: string; batchId?: string }): Promise<{ synced: number; skipped: number }> {
  if (!radiusConfigured()) throw new Error('RADIUS not configured');
  const vouchers = await prisma.voucher.findMany({
    where: {
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(opts.routerId ? { routerId: opts.routerId } : {}),
      ...(opts.batchId ? { batchId: opts.batchId } : {}),
    },
    include: { package: true },
  });

  // Resolve which routers are RADIUS-managed once, to avoid a DB hit per voucher.
  const routerIds = Array.from(new Set(vouchers.map((v: { routerId: string | null }) => v.routerId).filter(Boolean))) as string[];
  const radiusRouters = new Set(
    (await prisma.mikrotikRouter.findMany({
      where: { id: { in: routerIds }, radiusEnabled: true } as any,
      select: { id: true },
    })).map((r: { id: string }) => r.id)
  );

  const stmts: string[] = [];
  let synced = 0, skipped = 0;
  for (const v of vouchers) {
    if (v.batchId === 'MPESA' || !v.routerId || !radiusRouters.has(v.routerId)) { skipped++; continue; }
    const seconds = Math.max(60, v.durationMinutes * 60);
    stmts.push(...voucherRows(v.code, seconds, v.package?.speedUpKbps, v.package?.speedDownKbps));
    synced++;
  }

  if (stmts.length) {
    const CHUNK = 200;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await radiusPsql(`BEGIN; ${stmts.slice(i, i + CHUNK).join(' ')} COMMIT;`);
    }
  }
  return { synced, skipped };
}

// One-time / on-demand bulk sync for HOTSPOT subscribers: push all entitled hotspot subscribers
// (D-name + MAC identities) on RADIUS-enabled routers into RADIUS. Mirrors bulkSyncPppoeToRadius.
export async function bulkSyncHotspotToRadius(opts: { tenantId?: string; routerId?: string }): Promise<{ synced: number; skipped: number }> {
  if (!radiusConfigured()) throw new Error('RADIUS not configured');
  const subs = await prisma.subscriber.findMany({
    where: {
      service: 'HOTSPOT',
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(opts.routerId ? { routerId: opts.routerId } : {}),
    },
    include: { package: true },
  });
  const routerIds = Array.from(new Set(subs.map((s: { routerId: string | null }) => s.routerId).filter(Boolean))) as string[];
  const radiusRouters = new Set(
    (await prisma.mikrotikRouter.findMany({
      where: { id: { in: routerIds }, radiusEnabled: true } as any,
      select: { id: true },
    })).map((r: { id: string }) => r.id)
  );

  const now = new Date();
  const stmts: string[] = [];
  let synced = 0, skipped = 0;
  for (const sub of subs) {
    if (!sub.routerId || !radiusRouters.has(sub.routerId)) { skipped++; continue; }
    const expired = sub.expiresAt ? sub.expiresAt <= now : false;
    const entitled = sub.isActive && !!sub.packageId && !expired;
    const identities: RadiusIdentity[] = [{ name: sub.username, password: sub.secret }];
    const mac = normMac(sub.macAddress);
    if (mac) identities.push({ name: mac, password: mac });
    for (const id of identities) {
      const u = sqlq(id.name);
      stmts.push(`DELETE FROM radcheck WHERE username='${u}';`);
      stmts.push(`DELETE FROM radreply WHERE username='${u}';`);
      if (!entitled) continue;
      const pwd = sqlq(id.password);
      stmts.push(`INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Cleartext-Password',':=','${pwd}');`);
      if (sub.expiresAt) {
        const exp = sqlq(radiusExpiry(sub.expiresAt));
        stmts.push(`INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Expiration',':=','${exp}');`);
      }
      const rl = sqlq(rateLimit(sub.package?.speedUpKbps, sub.package?.speedDownKbps));
      stmts.push(`INSERT INTO radreply (username, attribute, op, value) VALUES ('${u}','Mikrotik-Rate-Limit',':=','${rl}');`);
    }
    if (entitled) synced++; else skipped++;
  }
  if (stmts.length) {
    const CHUNK = 200;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await radiusPsql(`BEGIN; ${stmts.slice(i, i + CHUNK).join(' ')} COMMIT;`);
    }
  }
  return { synced, skipped };
}

// Register (or remove) a router as a FreeRADIUS client on the droplet, via the dartbit-radius-client
// helper, which writes a clients.d/ drop-in and reloads FreeRADIUS GRACEFULLY (no manual restart,
// no dropped sessions). Call this when a router's RADIUS is enabled/disabled or its secret changes.
export async function registerRadiusClient(wgIp: string, secret: string, name: string): Promise<void> {
  if (!radiusConfigured()) return;
  const cmd = `sudo dartbit-radius-client add ${shq(wgIp)} ${shq(secret)} ${shq(name.replace(/[^A-Za-z0-9_]/g, '_'))}`;
  await dropletExec(cmd);
}
export async function unregisterRadiusClient(wgIp: string): Promise<void> {
  if (!radiusConfigured()) return;
  await dropletExec(`sudo dartbit-radius-client remove ${shq(wgIp)}`).catch(() => {});
}

// Diagnostic: confirm the backend can reach RADIUS Postgres over SSH and count users.
export async function diagnoseRadius(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    sshConfigured: dropletSshConfigured(),
    radiusEnabled: process.env.DARTBIT_RADIUS_ENABLED === 'true',
  };
  if (!dropletSshConfigured()) { out.result = 'SSH_NOT_CONFIGURED'; return out; }
  try {
    const count = await radiusPsql('SELECT count(*) FROM radcheck;');
    out.radcheckCount = parseInt(count, 10);
    out.nasCount = parseInt(await radiusPsql('SELECT count(*) FROM nas;'), 10);
    out.result = 'OK';
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    out.result = 'FAILED';
  }
  return out;
}
