// Dartbit WireGuard provisioning. Auto-assigns a VPN IP to each router, generates its keypair,
// registers the peer on the droplet over SSH, and produces the MikroTik config the router runs
// once to join the management VPN. Reaching a router's Winbox is then: connect your laptop to the
// same VPN and Winbox to the router's 10.8.0.x — no keys needed at connect time.
import crypto from 'crypto';
// ssh2 ships without bundled types; import via require with an explicit any to keep strict tsc happy
// without needing @types/ssh2 at build time.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ssh2: any = require('ssh2');
const SshClient: any = ssh2.Client;
import prisma from './prisma';
import { encryptApiKey, decryptApiKey } from './blessedtexts'; // reuse CREDENTIAL_ENCRYPTION_KEY

const WG_HOST = process.env.DARTBIT_WG_SSH_HOST || '';
const WG_USER = process.env.DARTBIT_WG_SSH_USER || 'dartbit';
// Normalize the SSH key: Railway (and copy/paste) often mangle multi-line secrets. Handle keys
// stored with literal "\n", escaped "\\n", or CRLF, and ensure a trailing newline (ssh2/OpenSSL
// are picky about the final newline on PEM blocks).
function normalizeKey(raw: string): string {
  let k = raw || '';
  if (!k.includes('\n')) {
    k = k.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
  }
  k = k.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!k.endsWith('\n')) k += '\n';
  return k;
}
const WG_KEY = normalizeKey(process.env.DARTBIT_WG_SSH_KEY || '');
const WG_SERVER_PUBKEY = process.env.DARTBIT_WG_SERVER_PUBKEY || '';
const WG_ENDPOINT = process.env.DARTBIT_WG_ENDPOINT || 'vpn.dartbittech.com:1198';
// Optional: the droplet's global IPv6 address (address only, no brackets/port — the port is taken
// from WG_ENDPOINT). When set, provisioning configures IPv6 on the router's WAN and prefers the v6
// endpoint for WireGuard, escaping Starlink/CGNAT entirely; v4 remains the automatic fallback.
const WG_ENDPOINT6 = (process.env.DARTBIT_WG_ENDPOINT6 || '').trim();
const WG_SUBNET = process.env.DARTBIT_WG_SUBNET || '10.8.0.0/24';

export function wgConfigured(): boolean {
  return !!(WG_HOST && WG_KEY && WG_SERVER_PUBKEY);
}

// Generate a WireGuard keypair (raw 32-byte X25519, base64) using Node's native crypto.
export function generateWgKeypair(): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return {
    privateKey: privDer.subarray(privDer.length - 32).toString('base64'),
    publicKey: pubDer.subarray(pubDer.length - 32).toString('base64'),
  };
}

// Run a single command on the droplet over SSH, returning stdout. Times out so a dead droplet
// never hangs a request.
function sshExec(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let out = '';
    let err = '';
    const timer = setTimeout(() => { conn.end(); reject(new Error('SSH timeout')); }, 15000);
    conn.on('ready', () => {
      conn.exec(command, (e: Error | undefined, stream: any) => {
        if (e) { clearTimeout(timer); conn.end(); return reject(e); }
        stream.on('close', (code: number) => {
          clearTimeout(timer); conn.end();
          if (code === 0) resolve(out.trim());
          else reject(new Error(`SSH cmd exit ${code}: ${err.trim() || out.trim()}`));
        });
        stream.on('data', (d: Buffer) => { out += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      });
    });
    conn.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    conn.connect({ host: WG_HOST, port: 22, username: WG_USER, privateKey: WG_KEY });
  });
}

// Pick the next free VPN IP. .1 = server, .2–.10 reserved for admin/laptop peers, routers from .11.
async function nextFreeWgIp(): Promise<string> {
  const taken = new Set<string>();
  const rows = await prisma.mikrotikRouter.findMany({ where: { wgIp: { not: null } }, select: { wgIp: true } });
  for (const r of rows) if (r.wgIp) taken.add(r.wgIp);
  const base = WG_SUBNET.split('/')[0].split('.').slice(0, 3).join('.'); // e.g. 10.8.0
  for (let i = 11; i <= 254; i++) {
    const ip = `${base}.${i}`;
    if (!taken.has(ip)) return ip;
  }
  throw new Error('No free WireGuard IPs left in subnet');
}

// Quote a string safely for a single-quoted shell argument.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Public host tenants connect Winbox to (the droplet), e.g. "vpn.dartbittech.com".
export const winboxHost = WG_ENDPOINT.split(':')[0] || 'vpn.dartbittech.com';

// Open a DNAT on the droplet so the public port forwards to <wgIp>:8291 (RouterOS Winbox). The
// dartbit-winbox-port helper (installed at /usr/local/bin, allowed in sudoers) adds the PREROUTING
// DNAT + POSTROUTING SNAT (so the router's replies return through the droplet) + a FORWARD accept.
export async function openWinboxPort(port: number, wgIp: string): Promise<void> {
  if (!wgConfigured()) throw new Error('VPN not configured (DARTBIT_WG_* env)');
  await sshExec(`sudo dartbit-winbox-port set ${Number(port)} ${shq(wgIp)}`);
}

// Remove the DNAT for a port (best-effort).
export async function closeWinboxPort(port: number): Promise<void> {
  if (!wgConfigured()) return;
  await sshExec(`sudo dartbit-winbox-port del ${Number(port)}`).catch(() => { /* best-effort */ });
}

export interface WgProvisionResult {
  wgIp: string;
  publicKey: string;
  serverPublicKey: string;
  endpoint: string;
  subnet: string;
}

// Provision (or re-provision) a router's VPN peer. Generates keys if missing, assigns an IP if
// missing, and registers the peer on the droplet. Stores everything on the router row (private key
// encrypted). Idempotent: re-running updates the same peer.
export async function provisionRouterWg(routerId: string): Promise<WgProvisionResult> {
  if (!wgConfigured()) throw new Error('WireGuard not configured on the backend (missing env vars)');
  const router = await prisma.mikrotikRouter.findUnique({ where: { id: routerId } });
  if (!router) throw new Error('Router not found');

  let wgIp = router.wgIp || (await nextFreeWgIp());
  let publicKey = router.wgPublicKey || '';
  let privateKeyPlain = '';

  if (!router.wgPrivateKey || !publicKey) {
    const kp = generateWgKeypair();
    privateKeyPlain = kp.privateKey;
    publicKey = kp.publicKey;
  } else {
    privateKeyPlain = decryptApiKey(router.wgPrivateKey);
  }

  // Register the peer on the droplet (idempotent — helper replaces any prior block for this key).
  const label = `router-${(router.name || router.id).replace(/[^A-Za-z0-9_-]/g, '_').substring(0, 24)}`;
  await sshExec(`sudo dartbit-add-peer ${shq(publicKey)} ${shq(`${wgIp}/32`)} ${shq(label)}`);

  await prisma.mikrotikRouter.update({
    where: { id: routerId },
    data: {
      wgIp,
      wgPublicKey: publicKey,
      wgPrivateKey: encryptApiKey(privateKeyPlain),
      wgPeerAdded: true,
    },
  });

  return { wgIp, publicKey, serverPublicKey: WG_SERVER_PUBKEY, endpoint: WG_ENDPOINT, subnet: WG_SUBNET };
}

// Remove a router's VPN peer from the droplet (on router delete or unlink).
export async function deprovisionRouterWg(routerId: string): Promise<void> {
  if (!wgConfigured()) return;
  const router = await prisma.mikrotikRouter.findUnique({ where: { id: routerId } });
  if (!router?.wgPublicKey) return;
  try {
    await sshExec(`sudo dartbit-remove-peer ${shq(router.wgPublicKey)}`);
  } catch (e) {
    console.error('[wg] remove peer failed:', e instanceof Error ? e.message : e);
  }
  await prisma.mikrotikRouter.update({
    where: { id: routerId },
    data: { wgPeerAdded: false },
  }).catch(() => {});
}

// Build the RouterOS commands a router runs ONCE to join the VPN. The router keeps its own private
// key; it dials the droplet endpoint and gets its fixed 10.8.0.x address.
export function buildMikrotikWgConfig(opts: { wgIp: string; privateKey: string; wanInterface?: string }): string {
  const serverHost = WG_ENDPOINT.split(':')[0];
  const serverPort = WG_ENDPOINT.split(':')[1] || '51820';
  // Start on the RELIABLE IPv4 endpoint. Prefer a v4 literal (the SSH host, when it's a bare IPv4)
  // so DNS can't hand us a dead AAAA and strand the tunnel; fall back to the hostname otherwise.
  // WireGuard is router-initiated/outbound, so v4 establishes even through CGNAT — which means a
  // reprovision always comes back up on v4 within seconds, regardless of v6 state. The failover
  // script below then PROMOTES to the preferred IPv6 only once it is proven to carry the tunnel,
  // and flips back to v4 the instant the v6 handshake goes stale. (Previously the peer started on
  // v6; a router whose v6 pinged but couldn't carry WireGuard was stranded offline on every
  // reprovision — the exact failure this rewrite removes.)
  const v4Endpoint = /^\d{1,3}(\.\d{1,3}){3}$/.test(WG_HOST) ? WG_HOST : serverHost;
  const initialEndpoint = v4Endpoint;
  const lines = [
    `/interface wireguard add name=dartbit-vpn private-key="${opts.privateKey}" listen-port=13231`,
    `/ip address add address=${opts.wgIp}/24 interface=dartbit-vpn comment="Dartbit VPN"`,
    `/interface wireguard peers add interface=dartbit-vpn public-key="${WG_SERVER_PUBKEY}" endpoint-address=${initialEndpoint} endpoint-port=${serverPort} allowed-address=${WG_SUBNET} persistent-keepalive=25s comment="Dartbit VPN"`,
    `/ip firewall filter add chain=input src-address=${WG_SUBNET} action=accept comment="Dartbit VPN mgmt" place-before=0`,
  ];
  if (WG_ENDPOINT6) {
    const wan = opts.wanInterface || 'ether1';
    // Enable IPv6 + DHCPv6 on the WAN (harmless no-ops where the uplink has no v6), then install the
    // v4/v6 failover script. It runs every minute and decides on the ONE thing that actually matters:
    // is the WireGuard handshake fresh? (i.e. is the tunnel really passing traffic on the current
    // endpoint) — NOT whether the address merely pings. This is the core fix: the old script fell
    // back only when the v6 address stopped PINGING, so a v6 path that pinged but couldn't carry the
    // tunnel stranded the router offline on v6 forever. Now:
    //   * FAILOVER (guaranteed): if the handshake is stale (>3m) on the current endpoint, flip to the
    //     other family immediately. Works both directions, so the tunnel converges on whichever family
    //     is actually up. If both are down it harmlessly alternates until one recovers, then sticks.
    //   * PROMOTE to preferred v6: only when the tunnel is healthy on v4, a cooldown has elapsed, and
    //     the v6 endpoint pings. If v6 then fails to carry the tunnel, the failover rule pulls back to
    //     v4 within ~3m and arms a 30-min cooldown — so a bad v6 path costs at most ~3m per 30m instead
    //     of the old flap-every-5m. A working tunnel is never disturbed.
    // The peer starts on v4 (see initialEndpoint), so bring-up and every reprovision recover on v4 in
    // seconds; promotion to v6 happens on the next healthy cycle.
    lines.push(
      `:do { /ipv6 settings set disable-ipv6=no accept-router-advertisements=yes } on-error={}`,
      `:do { :if ([:len [/ipv6 dhcp-client find interface="${wan}"]] = 0) do={ /ipv6 dhcp-client add interface=${wan} request=address,prefix pool-name=dartbit6 pool-prefix-length=64 add-default-route=yes comment="Dartbit v6 uplink" } } on-error={}`,
      `:foreach s in=[/system script find name="dartbit-wg6"] do={ /system script remove \$s }`,
      `:foreach s in=[/system scheduler find name="dartbit-wg6"] do={ /system scheduler remove \$s }`,
      `/system script add name=dartbit-wg6 policy=read,write,test source={:global dartbitWgCd; :do { :local v6 "${WG_ENDPOINT6}"; :local v4 "${v4Endpoint}"; :local peer [/interface wireguard peers find comment="Dartbit VPN"]; :if ([:len \$peer] = 0) do={ :error "no peer" }; :local cur [/interface wireguard peers get \$peer endpoint-address]; :local fresh false; :do { :local hs [/interface wireguard peers get \$peer last-handshake]; :if ([:typeof \$hs] = "time" && \$hs < 3m) do={ :set fresh true } } on-error={}; :if ([:typeof \$dartbitWgCd] != "num") do={ :set dartbitWgCd 0 }; :if (\$dartbitWgCd > 0) do={ :set dartbitWgCd (\$dartbitWgCd - 1) }; :if (\$fresh = false) do={ :if (\$cur = \$v6) do={ /interface wireguard peers set \$peer endpoint-address=\$v4; :set dartbitWgCd 30; :log warning "Dartbit WG: IPv6 handshake stale -> failover to IPv4" } else={ /interface wireguard peers set \$peer endpoint-address=\$v6; :log warning "Dartbit WG: IPv4 handshake stale -> failover to IPv6" } } else={ :if (\$cur = \$v4 && \$dartbitWgCd = 0) do={ :local v6ping false; :do { :if ([/ping \$v6 count=2 interval=1s] > 0) do={ :set v6ping true } } on-error={}; :if (\$v6ping = true) do={ /interface wireguard peers set \$peer endpoint-address=\$v6; :log info "Dartbit WG: promoting to preferred IPv6" } } } } on-error={}}`,
      `/system scheduler add name=dartbit-wg6 interval=1m on-event="/system script run dartbit-wg6" comment="Dartbit WG v4/v6 failover"`,
    );
  }
  return lines.join('\n');
}

// Fetch live VPN status (last handshake per peer) from the droplet and update routers.
export async function refreshWgStatus(): Promise<void> {
  if (!wgConfigured()) return;
  let dump = '';
  try { dump = await sshExec('sudo dartbit-list-peers'); }
  catch { return; }
  // `wg show wg0 dump` lines: pubkey<TAB>presharedkey<TAB>endpoint<TAB>allowed-ips<TAB>latest-handshake<TAB>rx<TAB>tx<TAB>keepalive
  const byKey = new Map<string, number>(); // pubkey -> handshake epoch (seconds)
  const epByKey = new Map<string, string>(); // pubkey -> endpoint the router connects FROM (addr:port)
  for (const line of dump.split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 5 && parts[0] && /^[A-Za-z0-9+/]{43}=$/.test(parts[0])) {
      const hs = parseInt(parts[4], 10);
      if (!isNaN(hs)) byKey.set(parts[0], hs);
      if (parts[2] && parts[2] !== '(none)') epByKey.set(parts[0], parts[2]);
    }
  }
  const routers = await prisma.mikrotikRouter.findMany({ where: { wgPublicKey: { not: null } }, select: { id: true, wgPublicKey: true } });
  for (const r of routers) {
    if (!r.wgPublicKey) continue;
    const hs = byKey.get(r.wgPublicKey);
    const ep = epByKey.get(r.wgPublicKey);
    // Family: a v6 endpoint is bracketed (`[2604:...]:port`) or has multiple colons; v4 is `a.b.c.d:port`.
    // We only trust the family when the handshake is recent — a stale endpoint tells us nothing live.
    const fresh = hs && hs > 0 && Date.now() - hs * 1000 < 3 * 60 * 1000;
    const via = ep ? (ep.includes('[') || (ep.match(/:/g) || []).length > 1 ? 'ipv6' : 'ipv4') : null;
    const data: { wgLastHandshake?: Date; wgEndpoint?: string | null; wgVia?: string | null } = {};
    if (hs && hs > 0) data.wgLastHandshake = new Date(hs * 1000);
    if (ep) data.wgEndpoint = ep;
    data.wgVia = fresh ? via : null;
    if (Object.keys(data).length) {
      await prisma.mikrotikRouter.update({ where: { id: r.id }, data }).catch(() => {});
    }
  }
}

export const wgEnv = { endpoint: WG_ENDPOINT, subnet: WG_SUBNET, serverPublicKey: WG_SERVER_PUBKEY };

// Diagnose the VPN provisioning chain so we can see exactly which link fails. Returns a structured
// report rather than throwing. Superadmin/owner use only.
export async function diagnoseWg(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    env: {
      DARTBIT_WG_SSH_HOST: WG_HOST || null,
      DARTBIT_WG_SSH_USER: WG_USER || null,
      DARTBIT_WG_SSH_KEY_present: !!WG_KEY,
      DARTBIT_WG_SSH_KEY_looksPEM: WG_KEY.includes('BEGIN') && WG_KEY.includes('PRIVATE KEY'),
      DARTBIT_WG_SSH_KEY_hasRealNewlines: WG_KEY.includes('\n'),
      DARTBIT_WG_SSH_KEY_length: WG_KEY.length,
      DARTBIT_WG_SERVER_PUBKEY: WG_SERVER_PUBKEY || null,
      DARTBIT_WG_ENDPOINT: WG_ENDPOINT,
      DARTBIT_WG_SUBNET: WG_SUBNET,
    },
    configured: wgConfigured(),
  };
  if (!wgConfigured()) { out.result = 'NOT_CONFIGURED'; return out; }
  // Try a harmless SSH command and capture the precise failure.
  try {
    const peers = await sshExec('sudo dartbit-list-peers');
    out.sshConnect = 'OK';
    out.listPeers = 'OK';
    out.peerCount = peers ? peers.split('\n').filter(Boolean).length : 0;
    out.result = 'OK';
  } catch (e) {
    out.sshConnect = 'FAILED';
    out.error = e instanceof Error ? e.message : String(e);
    out.result = 'SSH_FAILED';
  }
  return out;
}
