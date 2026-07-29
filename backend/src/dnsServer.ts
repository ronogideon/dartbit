import * as dgram from 'dgram';
import { PrismaClient } from '@prisma/client';

// Dartbit central filtering DNS resolver — runs at dns.dartbittech.com on the droplet (public IP,
// UDP 53). Every Dartbit router points its DNS here THROUGH the WireGuard tunnel, so each query
// arrives from that router's 10.8.0.x address. That source IP tells us WHICH router asked, so we
// apply that router's own blocklist:
//
//   • query for a domain blocked on the requesting router  -> answered 0.0.0.0 (dead), serves nothing
//   • everything else                                       -> forwarded to Cloudflare (1.1.1.1)
//
// Blocking is decided per-router server-side, so nothing on the MikroTik needs per-domain config —
// the router just forwards DNS here. The blocklist is cached in memory and refreshed periodically.

const PORT = Number(process.env.DNS_PORT || 53);
const UPSTREAM = process.env.DNS_UPSTREAM || '1.1.1.1'; // Cloudflare
const REFRESH_MS = 30_000;

const prisma = new PrismaClient();

// wgIp (10.8.0.x) -> Set of domains blocked on that router (only while its firewall is enabled).
let byRouterIp = new Map<string, Set<string>>();

async function refresh() {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT r."wgIp" AS ip, bd.domain AS domain
       FROM "RouterBlockedDomain" bd
       JOIN "RouterFirewall" f ON f."routerId" = bd."routerId"
       JOIN "MikrotikRouter" r ON r.id = bd."routerId"
       WHERE f.enabled = true AND r."wgIp" IS NOT NULL`) as { ip: string; domain: string }[];
    const next = new Map<string, Set<string>>();
    for (const row of rows) {
      const ip = row.ip.trim();
      if (!next.has(ip)) next.set(ip, new Set());
      next.get(ip)!.add(row.domain.toLowerCase());
    }
    byRouterIp = next;
    console.log(`[dns] refreshed: ${next.size} router(s) with blocks, ${rows.length} rule(s)`);
  } catch (e) {
    console.error('[dns] refresh failed:', e instanceof Error ? e.message : e);
  }
}

// Is `qname` blocked for the router at `srcIp`? Matches the domain and any subdomain of it.
function isBlockedFor(srcIp: string, qname: string): boolean {
  const set = byRouterIp.get(srcIp);
  if (!set || set.size === 0) return false;
  const name = qname.toLowerCase().replace(/\.$/, '');
  if (set.has(name)) return true;
  for (const b of set) if (name === b || name.endsWith('.' + b)) return true;
  return false;
}

function parseQName(msg: Buffer): { name: string; qtype: number } | null {
  try {
    let off = 12;
    const labels: string[] = [];
    while (off < msg.length) {
      const len = msg[off];
      if (len === 0) { off += 1; break; }
      labels.push(msg.slice(off + 1, off + 1 + len).toString('ascii'));
      off += 1 + len;
    }
    const qtype = msg.readUInt16BE(off);
    return { name: labels.join('.'), qtype };
  } catch { return null; }
}

function buildBlockedResponse(query: Buffer, qtype: number): Buffer {
  const header = Buffer.from(query.slice(0, 12));
  header.writeUInt16BE(0x8180, 2);
  let qEnd = 12;
  while (query[qEnd] !== 0 && qEnd < query.length) qEnd += query[qEnd] + 1;
  qEnd += 5;
  const question = query.slice(12, qEnd);
  const isA = qtype === 1, isAAAA = qtype === 28;
  if (!isA && !isAAAA) {
    header.writeUInt16BE(0, 6);
    return Buffer.concat([header, question]);
  }
  header.writeUInt16BE(1, 6);
  const rdata = isAAAA ? Buffer.alloc(16, 0) : Buffer.from([0, 0, 0, 0]);
  const answer = Buffer.concat([
    Buffer.from([0xc0, 0x0c]),
    Buffer.from([0x00, isAAAA ? 0x1c : 0x01]),
    Buffer.from([0x00, 0x01]),
    Buffer.from([0x00, 0x00, 0x00, 0x1e]),
    Buffer.from([(rdata.length >> 8) & 0xff, rdata.length & 0xff]),
    rdata,
  ]);
  return Buffer.concat([header, question, answer]);
}

function start() {
  const server = dgram.createSocket('udp4');
  server.on('message', (msg, rinfo) => {
    const parsed = parseQName(msg);
    if (parsed && isBlockedFor(rinfo.address, parsed.name)) {
      server.send(buildBlockedResponse(msg, parsed.qtype), rinfo.port, rinfo.address);
      return;
    }
    const fwd = dgram.createSocket('udp4');
    let settled = false;
    const done = () => { if (!settled) { settled = true; try { fwd.close(); } catch { /* noop */ } } };
    fwd.on('message', (resp) => { server.send(resp, rinfo.port, rinfo.address); done(); });
    fwd.on('error', done);
    setTimeout(done, 5000);
    try { fwd.send(msg, 53, UPSTREAM); } catch { done(); }
  });
  server.on('error', (err) => { console.error('[dns] server error:', err); });
  server.bind(PORT, () => console.log(`[dns] Dartbit filtering resolver on udp/${PORT}, upstream ${UPSTREAM} (Cloudflare)`));
}

refresh();
setInterval(refresh, REFRESH_MS);
start();
