import * as dgram from 'dgram';
import { PrismaClient } from '@prisma/client';

// Dartbit filtering DNS resolver — runs at dns.dartbittech.com as an OPTIONAL second layer.
//
// The primary enforcement lives on each MikroTik (static DNS + firewall drop, pushed via the
// command queue) and does not depend on this server being up. This resolver exists so a tenant can
// additionally point a router's DNS at dns.dartbittech.com and get:
//   • central filtering — any domain on ANY of that context's blocklists is answered 0.0.0.0
//   • a clean upstream for everything else (forwarded to a public resolver)
//
// It is deliberately simple: A/AAAA queries for blocked names return a dead answer; everything else
// is forwarded. It caches the blocklist in memory and refreshes periodically so a hot query path
// never hits the database.

const PORT = Number(process.env.DNS_PORT || 53);
const UPSTREAM = process.env.DNS_UPSTREAM || '1.1.1.1';
const REFRESH_MS = 60_000;

const prisma = new PrismaClient();
let blockedSet = new Set<string>();

async function refreshBlocklist() {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT domain FROM "RouterBlockedDomain" bd
       JOIN "RouterFirewall" f ON f."routerId" = bd."routerId"
       WHERE f.enabled = true`) as { domain: string }[];
    blockedSet = new Set(rows.map(r => r.domain.toLowerCase()));
    console.log(`[dns] blocklist refreshed: ${blockedSet.size} domain(s)`);
  } catch (e) {
    console.error('[dns] blocklist refresh failed:', e instanceof Error ? e.message : e);
  }
}

// Is this qname blocked? Matches the domain itself and any subdomain of it.
function isBlocked(qname: string): boolean {
  const name = qname.toLowerCase().replace(/\.$/, '');
  if (blockedSet.has(name)) return true;
  for (const b of blockedSet) if (name === b || name.endsWith('.' + b)) return true;
  return false;
}

// Parse the QNAME out of a DNS query packet (RFC 1035 label sequence starting at byte 12).
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

// Build a response that answers the query with 0.0.0.0 (A) or :: (AAAA) — a dead address.
function buildBlockedResponse(query: Buffer, qtype: number): Buffer {
  const header = Buffer.from(query.slice(0, 12));
  header.writeUInt16BE(0x8180, 2); // QR=1, RD=1, RA=1, rcode=0
  header.writeUInt16BE(1, 6);      // ANCOUNT = 1
  // Question section: from byte 12 to end of qname+qtype+qclass
  let qEnd = 12;
  while (query[qEnd] !== 0 && qEnd < query.length) qEnd += query[qEnd] + 1;
  qEnd += 5; // null byte + qtype(2) + qclass(2)
  const question = query.slice(12, qEnd);
  const isAAAA = qtype === 28;
  const rdata = isAAAA ? Buffer.alloc(16, 0) : Buffer.from([0, 0, 0, 0]);
  const answer = Buffer.concat([
    Buffer.from([0xc0, 0x0c]),                                   // name pointer to question
    Buffer.from([0x00, isAAAA ? 0x1c : 0x01]),                   // TYPE A/AAAA
    Buffer.from([0x00, 0x01]),                                   // CLASS IN
    Buffer.from([0x00, 0x00, 0x00, 0x1e]),                       // TTL 30s
    Buffer.from([(rdata.length >> 8) & 0xff, rdata.length & 0xff]),
    rdata,
  ]);
  return Buffer.concat([header, question, answer]);
}

function start() {
  const server = dgram.createSocket('udp4');

  server.on('message', (msg, rinfo) => {
    const parsed = parseQName(msg);
    // Block A (1) and AAAA (28) for names on the list.
    if (parsed && (parsed.qtype === 1 || parsed.qtype === 28) && isBlocked(parsed.name)) {
      const resp = buildBlockedResponse(msg, parsed.qtype);
      server.send(resp, rinfo.port, rinfo.address);
      return;
    }
    // Otherwise forward to the upstream resolver and relay the answer back.
    const fwd = dgram.createSocket('udp4');
    let settled = false;
    const done = () => { if (!settled) { settled = true; try { fwd.close(); } catch { /* noop */ } } };
    fwd.on('message', (resp) => { server.send(resp, rinfo.port, rinfo.address); done(); });
    fwd.on('error', done);
    setTimeout(done, 5000);
    try { fwd.send(msg, 53, UPSTREAM); } catch { done(); }
  });

  server.on('error', (err) => { console.error('[dns] server error:', err); server.close(); });
  server.bind(PORT, () => console.log(`[dns] Dartbit filtering resolver listening on udp/${PORT}, upstream ${UPSTREAM}`));
}

refreshBlocklist();
setInterval(refreshBlocklist, REFRESH_MS);
start();
