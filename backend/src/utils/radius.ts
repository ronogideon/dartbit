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
export async function syncSubscriberToRadius(subscriberId: string, opts?: { kickToApply?: boolean }): Promise<void> {
  if (!radiusConfigured()) { console.log(`[radius] skip ${subscriberId}: not configured (DARTBIT_RADIUS_ENABLED / SSH)`); return; }
  const sub = await prisma.subscriber.findUnique({
    where: { id: subscriberId },
    include: { package: true },
  }) as RadiusSub | null;
  if (!sub) { console.log(`[radius] skip ${subscriberId}: subscriber not found`); return; }
  if (sub.service !== 'PPPOE' && sub.service !== 'HOTSPOT') { console.log(`[radius] skip ${sub.username}: service=${sub.service} not synced`); return; }

  // NOTE: We intentionally do NOT gate on the per-router `radiusEnabled` flag here. That flag
  // defaults to false and silently suppressed every per-subscriber write while the flag-agnostic
  // bulk sync worked — the exact mismatch we hit. The env master switch `radiusConfigured()`
  // (checked above) is now the single source of truth, so per-subscriber writes behave identically
  // to bulk-sync. A routerId is still needed only for the CoA-Disconnect kick (handled gracefully
  // below if its VPN IP / secret aren't known).

  const now = new Date();
  const expired = sub.expiresAt ? sub.expiresAt <= now : false;
  // HOTSPOT entitlement: active + not expired, and EITHER a linked package OR a real expiry window.
  // Requiring a package alone wrongly de-entitled paid users without one (vouchers, custom durations,
  // M-Pesa buys with no package) — their radcheck got cleared and auto-login then looped forever.
  const entitled = sub.service === 'HOTSPOT'
    ? sub.isActive && !expired && (!!sub.packageId || !!sub.expiresAt)
    : sub.isActive && !expired;

  // Build the identity list for this subscriber.
  const identities: RadiusIdentity[] = [{ name: sub.username, password: sub.secret }];
  const mac = sub.service === 'HOTSPOT' ? normMac(sub.macAddress) : null;
  if (mac) identities.push({ name: mac, password: mac });

  // Expired PPPoE that's still admin-enabled goes to the WALLED GARDEN instead of being rejected:
  // we Access-Accept it (so the CPE connects ONCE and stays up — no reject→redial loop that burns
  // CPU), but with no Expiration, a throttled rate, and Mikrotik-Address-List=dartbit-expired so the
  // router's existing firewall only lets it reach the portal + M-Pesa. Admin-disabled or expired
  // HOTSPOT still gets fully cleared (rejected).
  const walledGarden = sub.service === 'PPPOE' && sub.isActive && expired;

  const stmts: string[] = [];
  for (const id of identities) {
    const u = sqlq(id.name);
    stmts.push(`DELETE FROM radcheck WHERE username='${u}';`);
    stmts.push(`DELETE FROM radreply WHERE username='${u}';`);
    const pwd = sqlq(id.password);
    if (entitled) {
      stmts.push(`INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Cleartext-Password',':=','${pwd}');`);
      if (sub.expiresAt) {
        const exp = sqlq(radiusExpiry(sub.expiresAt));
        stmts.push(`INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Expiration',':=','${exp}');`);
      }
      const rl = sqlq(rateLimit(sub.package?.speedUpKbps, sub.package?.speedDownKbps));
      stmts.push(`INSERT INTO radreply (username, attribute, op, value) VALUES ('${u}','Mikrotik-Rate-Limit',':=','${rl}');`);
    } else if (walledGarden) {
      // Accept (no Expiration) but restrict: low rate + dartbit-expired address-list.
      stmts.push(`INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Cleartext-Password',':=','${pwd}');`);
      stmts.push(`INSERT INTO radreply (username, attribute, op, value) VALUES ('${u}','Mikrotik-Rate-Limit',':=','512k/512k');`);
      stmts.push(`INSERT INTO radreply (username, attribute, op, value) VALUES ('${u}','Mikrotik-Address-List',':=','dartbit-expired');`);
    }
    // else: cleared (rejected) — admin-disabled, or expired hotspot.
  }

  try {
    await radiusPsql(stmts.join(' '));
    const state = entitled ? 'wrote' : (walledGarden ? 'walled-garden' : 'cleared');
    console.log(`[radius] ${state} ${sub.username} (${identities.map(i => i.name).join(', ')})${sub.expiresAt && entitled ? ` exp=${radiusExpiry(sub.expiresAt)}` : ''}`);
  } catch (e) {
    console.error(`[radius] psql FAILED for ${sub.username}:`, e instanceof Error ? e.message : e);
    throw e;
  }

  // Kick any live session so the NEW reply applies on the immediate reconnect:
  // - not entitled  → reconnect lands in the walled garden (PPPoE) or is rejected (hotspot)
  // - entitled + kickToApply (payment/edit cleared the walled garden) → reconnect with full service
  // CoA first (instant where the router honours it), then the RELIABLE command-queue kick as the
  // real workhorse — CoA on PPPoE is finicky, so we don't depend on it. For HOTSPOT we kick ONLY by
  // username, never by MAC: a co-located voucher session shares the device MAC and must not be torn
  // down by this subscriber's expiry.
  if (sub.routerId && (!entitled || opts?.kickToApply)) {
    await disconnectSession(sub, identities.map(i => i.name)).catch(() => { /* best-effort */ });
    try {
      const { enqueueCommand } = await import('./commandQueue');
      if (sub.service === 'PPPOE') {
        await enqueueCommand(sub.routerId, `:foreach a in=[/ppp active find name="${sub.username}"] do={ /ppp active remove $a }`);
      } else {
        await enqueueCommand(sub.routerId, `:foreach a in=[/ip hotspot active find where user="${sub.username}"] do={ /ip hotspot active remove $a }`);
      }
    } catch { /* best-effort */ }
  }
}

// Remove a subscriber from RADIUS entirely (on delete) and kick the session. Clears every identity
// (D-name + MAC for hotspot).
export async function removeSubscriberFromRadius(sub: RadiusSub): Promise<void> {
  if (!radiusConfigured()) return;
  if (sub.service !== 'PPPOE' && sub.service !== 'HOTSPOT') return;
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

function voucherRows(name: string, password: string, seconds: number, upKbps?: number | null, downKbps?: number | null, expiresAt?: Date | null): string[] {
  const u = sqlq(name);
  const pw = sqlq(password);
  const rl = sqlq(rateLimit(upKbps, downKbps));
  // IMPORTANT: only use attributes that work with a stock FreeRADIUS install. The earlier
  // `Max-All-Session` (needs the dartbit_uptime sqlcounter) and `Simultaneous-Use` (needs the
  // session module) check items caused Access-Reject ("invalid username or password") when those
  // modules weren't installed. We enforce the voucher's time limit with `Session-Timeout` (a reply
  // attribute every NAS honours) plus, once redeemed, an `Expiration` check (same mechanism PPPoE
  // uses successfully) so the code can't be re-used after its window.
  const rows = [
    `DELETE FROM radcheck WHERE username='${u}';`,
    `DELETE FROM radreply WHERE username='${u}';`,
    `INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Cleartext-Password',':=','${pw}');`,
    `INSERT INTO radreply (username, attribute, op, value) VALUES ('${u}','Mikrotik-Rate-Limit',':=','${rl}');`,
    `INSERT INTO radreply (username, attribute, op, value) VALUES ('${u}','Session-Timeout',':=','${Math.max(60, Math.floor(seconds))}');`,
  ];
  if (expiresAt) {
    rows.splice(3, 0, `INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Expiration',':=','${sqlq(radiusExpiry(expiresAt))}');`);
  }
  return rows;
}

// Write a voucher into RADIUS at REDEMPTION time — guarantees the radcheck row exists (even if the
// generation-time sync never ran) and is clean, right before the captive portal logs the device in.
// `remainingSeconds` caps the session; `expiresAt` blocks re-use after the validity window.
export async function redeemVoucherInRadius(code: string, remainingSeconds: number, expiresAt: Date | null, upKbps?: number | null, downKbps?: number | null, mac?: string | null): Promise<void> {
  if (!radiusConfigured()) { console.log(`[voucher-radius] skip ${code}: RADIUS not configured (DARTBIT_RADIUS_ENABLED / SSH)`); return; }
  const stmts = voucherRows(code, code, remainingSeconds, upKbps, downKbps, expiresAt);
  // Also key the voucher to the redeeming device's MAC, so when the device drops and reconnects the
  // hotspot's MAC auto-login (mac-as-username) authenticates it automatically — no need to re-enter
  // the code. This mirrors how subscriber/package logins get a MAC identity row.
  const m = normMac(mac);
  if (m) stmts.push(...voucherRows(m, m, remainingSeconds, upKbps, downKbps, expiresAt));
  try {
    await radiusPsql(stmts.join(' '));
    const n = (await radiusPsql(`SELECT count(*) FROM radcheck WHERE username IN ('${sqlq(code)}'${m ? `,'${sqlq(m)}'` : ''});`)).trim();
    console.log(`[voucher-radius] wrote ${code}${m ? ` + mac ${m}` : ''} (radcheck rows: ${n}, timeout=${Math.max(60, Math.floor(remainingSeconds))}s${expiresAt ? `, exp=${radiusExpiry(expiresAt)}` : ''})`);
  } catch (e) {
    console.error(`[voucher-radius] FAILED for ${code}:`, e instanceof Error ? e.message : e);
    throw e;
  }

  // Fix the MAC clash: a same-MAC HOTSPOT subscriber (the "D-number") shares this device's MAC row in
  // radcheck. If that subscriber expires before the voucher, its expiry-sync DELETEs the shared MAC
  // row (killing this voucher's auto-login) and the watcher kicks the MAC — tearing down a valid
  // session. So when a MAC activates a voucher, push that subscriber's expiry out to match the
  // voucher: it stays entitled, keeps the shared MAC row alive, and is never kicked while the voucher
  // is valid. (The MAC is only needed for auto-login, so aligning the two is safe.)
  if (m && expiresAt) {
    try {
      const subs = await prisma.subscriber.findMany({
        where: { service: 'HOTSPOT', macAddress: m, expiresAt: { lt: expiresAt } },
        select: { id: true },
      });
      for (const s of subs) {
        await prisma.subscriber.update({ where: { id: s.id }, data: { expiresAt, isActive: true } });
        await syncSubscriberToRadius(s.id).catch(() => { /* best-effort */ });
      }
      if (subs.length) console.log(`[voucher-radius] aligned ${subs.length} same-MAC subscriber(s) to voucher expiry for ${m}`);
    } catch (e) {
      console.error(`[voucher-radius] mac-subscriber align failed for ${m}:`, e instanceof Error ? e.message : e);
    }
  }
}

export interface RadiusActiveSession {
  username: string; nasIp: string; framedIp: string; mac: string;
  sessionSecs: number; inOctets: number; outOctets: number;
}

// Read currently-open sessions straight from FreeRADIUS accounting (radacct). This is the RADIUS-
// native replacement for the per-router 5s HTTP session reporter: one psql read on the backend,
// instead of every router polling the API. Open sessions = AcctStopTime IS NULL.
export async function getRadiusActiveSessions(): Promise<RadiusActiveSession[]> {
  if (!radiusConfigured()) return [];
  const sql = `SELECT username, COALESCE(nasipaddress::text,''), COALESCE(framedipaddress::text,''), COALESCE(callingstationid,''), GREATEST(0, EXTRACT(EPOCH FROM (now() - acctstarttime))::int), COALESCE(acctinputoctets,0), COALESCE(acctoutputoctets,0) FROM radacct WHERE acctstoptime IS NULL;`;
  const out = await radiusPsql(sql);
  const rows: RadiusActiveSession[] = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const p = t.split('|');
    if (p.length < 7) continue;
    rows.push({
      username: p[0], nasIp: p[1], framedIp: (p[2] || '').replace(/\/32$/, ''), mac: (p[3] || '').toUpperCase(),
      sessionSecs: parseInt(p[4] || '0', 10) || 0, inOctets: parseInt(p[5] || '0', 10) || 0, outOctets: parseInt(p[6] || '0', 10) || 0,
    });
  }
  return rows;
}

// Write one voucher into RADIUS (on generate/edit). Gated on the router being RADIUS-managed.
export async function syncVoucherToRadius(voucherId: string): Promise<void> {
  if (!radiusConfigured()) return;
  const v = await prisma.voucher.findUnique({ where: { id: voucherId }, include: { package: true } });
  if (!v || v.batchId === 'MPESA') return;
  const seconds = Math.max(60, v.durationMinutes * 60);
  await radiusPsql(voucherRows(v.code, v.code, seconds, v.package?.speedUpKbps, v.package?.speedDownKbps).join(' '));
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
  // RADIUS is governed by the env master switch (radiusConfigured), so all routed vouchers sync —
  // matching the PPPoE bulk behaviour. MPESA receipts are still skipped (handled via subscriber MAC).
  const stmts: string[] = [];
  let synced = 0, skipped = 0;
  for (const v of vouchers) {
    if (v.batchId === 'MPESA') { skipped++; continue; }
    const seconds = Math.max(60, v.durationMinutes * 60);
    stmts.push(...voucherRows(v.code, v.code, seconds, v.package?.speedUpKbps, v.package?.speedDownKbps));
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
  const now = new Date();
  const stmts: string[] = [];
  let synced = 0, skipped = 0;
  for (const sub of subs) {
    if (!sub.routerId) { skipped++; continue; }
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

export function radiusClientName(routerId: string): string {
  return 'dartbit_' + routerId.replace(/[^A-Za-z0-9]/g, '').slice(-16);
}

export async function registerRadiusClient(routerId: string, wgIp: string, secret: string): Promise<void> {
  if (!radiusConfigured()) return;
  if (!wgIp || !secret) { console.warn(`[radius-client] skip ${routerId}: missing ${!wgIp ? 'wgIp' : 'secret'}`); return; }
  // All privileged work goes through the sudo-allowed dartbit-radius-client helper (the SSH user is
  // 'dartbit', which only has NOPASSWD sudo for that helper — not for raw tee/systemctl). The helper's
  // `set` subcommand writes an ID-keyed clients.d/dartbit_<id>.conf (IP inside), clears any legacy
  // IP-named file, and restarts FreeRADIUS. So renames/IP changes never orphan a client.
  await dropletExec(`sudo dartbit-radius-client set ${shq(routerId)} ${shq(wgIp)} ${shq(secret)}`);
}

export async function unregisterRadiusClient(routerId: string): Promise<void> {
  if (!radiusConfigured()) return;
  await dropletExec(`sudo dartbit-radius-client del ${shq(routerId)}`).catch(() => {});
}

// Restart FreeRADIUS if it isn't running (duplicate client file, OOM on the small droplet, etc.) so
// recovery is automatic. Routed through the helper, since the SSH user can't sudo systemctl directly.
export async function ensureFreeradiusUp(): Promise<void> {
  if (!radiusConfigured()) return;
  await dropletExec('sudo dartbit-radius-client ensure-up').catch(() => {});
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
