// Dartbit WireGuard provisioning. Auto-assigns a VPN IP to each router, generates its keypair,
// registers the peer on the droplet over SSH, and produces the MikroTik config the router runs
// once to join the management VPN. Reaching a router's Winbox is then: connect your laptop to the
// same VPN and Winbox to the router's 10.8.0.x — no keys needed at connect time.
import crypto from 'crypto';
import { Client } from 'ssh2';
import prisma from './prisma';
import { encryptApiKey, decryptApiKey } from './blessedtexts'; // reuse CREDENTIAL_ENCRYPTION_KEY

const WG_HOST = process.env.DARTBIT_WG_SSH_HOST || '';
const WG_USER = process.env.DARTBIT_WG_SSH_USER || 'dartbit';
const WG_KEY = (process.env.DARTBIT_WG_SSH_KEY || '').replace(/\\n/g, '\n'); // tolerate escaped newlines
const WG_SERVER_PUBKEY = process.env.DARTBIT_WG_SERVER_PUBKEY || '';
const WG_ENDPOINT = process.env.DARTBIT_WG_ENDPOINT || 'vpn.dartbittech.com:51820';
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
    const conn = new Client();
    let out = '';
    let err = '';
    const timer = setTimeout(() => { conn.end(); reject(new Error('SSH timeout')); }, 15000);
    conn.on('ready', () => {
      conn.exec(command, (e, stream) => {
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
    conn.on('error', (e) => { clearTimeout(timer); reject(e); });
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
export function buildMikrotikWgConfig(opts: { wgIp: string; privateKey: string }): string {
  const serverHost = WG_ENDPOINT.split(':')[0];
  const serverPort = WG_ENDPOINT.split(':')[1] || '51820';
  return [
    `# Dartbit management VPN — run once on the router`,
    `/interface wireguard add name=dartbit-vpn private-key="${opts.privateKey}" listen-port=13231`,
    `/ip address add address=${opts.wgIp}/24 interface=dartbit-vpn`,
    `/interface wireguard peers add interface=dartbit-vpn public-key="${WG_SERVER_PUBKEY}" endpoint-address=${serverHost} endpoint-port=${serverPort} allowed-address=${WG_SUBNET} persistent-keepalive=25s`,
    `# Allow management (Winbox/SSH/API) over the VPN only`,
    `/ip firewall filter add chain=input src-address=${WG_SUBNET} action=accept comment="Dartbit VPN mgmt" place-before=0`,
  ].join('\n');
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
