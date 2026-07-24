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
  const lines = [
    `/interface wireguard add name=dartbit-vpn private-key="${opts.privateKey}" listen-port=13231`,
    `/ip address add address=${opts.wgIp}/24 interface=dartbit-vpn comment="Dartbit VPN"`,
    `/interface wireguard peers add interface=dartbit-vpn public-key="${WG_SERVER_PUBKEY}" endpoint-address=${serverHost} endpoint-port=${serverPort} allowed-address=${WG_SUBNET} persistent-keepalive=25s comment="Dartbit VPN"`,
    `/ip firewall filter add chain=input src-address=${WG_SUBNET} action=accept comment="Dartbit VPN mgmt" place-before=0`,
  ];
  if (WG_ENDPOINT6) {
    const wan = opts.wanInterface || 'ether1';
    // Enable IPv6 + DHCPv6 on the WAN (harmless no-ops where the uplink has no v6), then install a
    // failover script: prefer the v6 endpoint whenever the droplet is reachable over v6, fall back
    // to v4 when it isn't. Checked every 5 minutes and once immediately.
    lines.push(
      `:do { /ipv6 settings set disable-ipv6=no accept-router-advertisements=yes } on-error={}`,
      `:do { :if ([:len [/ipv6 dhcp-client find interface="${wan}"]] = 0) do={ /ipv6 dhcp-client add interface=${wan} request=address,prefix pool-name=dartbit6 pool-prefix-length=64 add-default-route=yes comment="Dartbit v6 uplink" } } on-error={}`,
      `:foreach s in=[/system script find name="dartbit-wg6"] do={ /system script remove \$s }`,
      `:foreach s in=[/system scheduler find name="dartbit-wg6"] do={ /system scheduler remove \$s }`,
      `/system script add name=dartbit-wg6 policy=read,write,test source={:do { :local v6 "${WG_ENDPOINT6}"; :local v4 "${serverHost}"; :local peer [/interface wireguard peers find comment="Dartbit VPN"]; :local cur [/interface wireguard peers get \$peer endpoint-address]; :local pingOk false; :do { :if ([/ping \$v6 count=2 interval=1s] > 0) do={ :set pingOk true } } on-error={}; :local hsOk false; :do { :local hs [/interface wireguard peers get \$peer last-handshake]; :if ([:typeof \$hs] = "time" && \$hs < 3m) do={ :set hsOk true } } on-error={}; :if (\$cur != \$v6 && \$pingOk = true) do={ /interface wireguard peers set \$peer endpoint-address=\$v6; :log info "Dartbit: WireGuard endpoint switched to IPv6" }; :if (\$cur = \$v6 && \$pingOk = false) do={ /interface wireguard peers set \$peer endpoint-address=\$v4; :log info "Dartbit: WireGuard endpoint fell back to IPv4 (v6 unreachable)" }; :if (\$cur = \$v6 && \$pingOk = true && \$hsOk = false) do={ /interface wireguard peers set \$peer endpoint-address=\$v4; :log info "Dartbit: WireGuard endpoint fell back to IPv4 (v6 reachable but handshake stale)" } } on-error={}}`,
      `/system scheduler add name=dartbit-wg6 interval=5m on-event="/system script run dartbit-wg6" comment="Dartbit WG IPv6 preference"`,
      `:do { /system script run dartbit-wg6 } on-error={}`,
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
  for (const line of dump.split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 5 && parts[0] && /^[A-Za-z0-9+/]{43}=$/.test(parts[0])) {
      const hs = parseInt(parts[4], 10);
      if (!isNaN(hs)) byKey.set(parts[0], hs);
    }
  }
  const routers = await prisma.mikrotikRouter.findMany({ where: { wgPublicKey: { not: null } }, select: { id: true, wgPublicKey: true } });
  for (const r of routers) {
    if (!r.wgPublicKey) continue;
    const hs = byKey.get(r.wgPublicKey);
    if (hs && hs > 0) {
      await prisma.mikrotikRouter.update({ where: { id: r.id }, data: { wgLastHandshake: new Date(hs * 1000) } }).catch(() => {});
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
