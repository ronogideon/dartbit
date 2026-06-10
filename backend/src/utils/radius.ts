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
  package?: { speedUpKbps: number; speedDownKbps: number } | null;
}

// Write (upsert) a PPPoE subscriber into RADIUS: password check item, rate-limit reply, expiry.
// Idempotent — clears prior rows for this username first, then inserts current state.
export async function syncSubscriberToRadius(subscriberId: string): Promise<void> {
  if (!radiusConfigured()) return;
  const sub = await prisma.subscriber.findUnique({
    where: { id: subscriberId },
    include: { package: true },
  }) as RadiusSub | null;
  if (!sub || sub.service !== 'PPPOE') return;

  const u = sqlq(sub.username);
  const now = new Date();
  const expired = sub.expiresAt ? sub.expiresAt <= now : false;
  const entitled = sub.isActive && !expired;

  // Always clear existing rows for a clean upsert.
  let sql = `DELETE FROM radcheck WHERE username='${u}'; DELETE FROM radreply WHERE username='${u}';`;

  if (entitled) {
    const pwd = sqlq(sub.secret);
    sql += `INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Cleartext-Password',':=','${pwd}');`;
    if (sub.expiresAt) {
      const exp = sqlq(radiusExpiry(sub.expiresAt));
      sql += `INSERT INTO radcheck (username, attribute, op, value) VALUES ('${u}','Expiration',':=','${exp}');`;
    }
    const rl = sqlq(rateLimit(sub.package?.speedUpKbps, sub.package?.speedDownKbps));
    sql += `INSERT INTO radreply (username, attribute, op, value) VALUES ('${u}','Mikrotik-Rate-Limit',':=','${rl}');`;
  }

  await radiusPsql(sql);

  // If the subscriber is no longer entitled, kick any live session immediately via CoA-Disconnect.
  if (!entitled && sub.routerId) {
    await disconnectSession(sub).catch(() => { /* best-effort */ });
  }
}

// Remove a subscriber from RADIUS entirely (on delete) and kick the session.
export async function removeSubscriberFromRadius(sub: RadiusSub): Promise<void> {
  if (!radiusConfigured() || sub.service !== 'PPPOE') return;
  const u = sqlq(sub.username);
  await radiusPsql(`DELETE FROM radcheck WHERE username='${u}'; DELETE FROM radreply WHERE username='${u}';`).catch(() => {});
  await disconnectSession(sub).catch(() => {});
}

// Send a CoA Disconnect-Request to the router so the live PPPoE session drops at once. Uses the
// router's VPN IP + the NAS shared secret. radclient runs on the droplet (it has FreeRADIUS tools).
async function disconnectSession(sub: RadiusSub): Promise<void> {
  if (!sub.routerId) return;
  const router = await prisma.mikrotikRouter.findUnique({ where: { id: sub.routerId }, select: { wgIp: true, radiusSecret: true } as any });
  const wgIp = (router as any)?.wgIp;
  const secret = (router as any)?.radiusSecret;
  if (!wgIp || !secret) return;
  // echo the attributes into radclient: target is <routerVpnIp>:3799, type disconnect.
  const attrs = `User-Name=${sub.username}`;
  const cmd = `echo ${shq(attrs)} | radclient -x ${shq(`${wgIp}:${COA_PORT}`)} disconnect ${shq(secret)}`;
  await dropletExec(cmd).catch((e) => { throw e; });
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
