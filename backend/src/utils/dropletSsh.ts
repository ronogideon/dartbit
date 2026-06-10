// Shared SSH helper for running commands on the Dartbit droplet (the box hosting WireGuard +
// FreeRADIUS + Postgres). Both the WireGuard peer provisioning and the RADIUS user management use
// this. Reuses the DARTBIT_WG_SSH_* credentials (one droplet, one access path).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ssh2: any = require('ssh2');
const SshClient: any = ssh2.Client;

const SSH_HOST = process.env.DARTBIT_WG_SSH_HOST || '';
const SSH_USER = process.env.DARTBIT_WG_SSH_USER || 'dartbit';

function normalizeKey(raw: string): string {
  let k = raw || '';
  if (!k.includes('\n')) {
    k = k.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
  }
  k = k.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!k.endsWith('\n')) k += '\n';
  return k;
}
const SSH_KEY = normalizeKey(process.env.DARTBIT_WG_SSH_KEY || '');

export function dropletSshConfigured(): boolean {
  return !!(SSH_HOST && SSH_KEY);
}

// Run one command on the droplet over SSH, returning stdout. Times out so a dead droplet never
// hangs a request.
export function dropletExec(command: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!dropletSshConfigured()) return reject(new Error('Droplet SSH not configured'));
    const conn = new SshClient();
    let out = '';
    let err = '';
    const timer = setTimeout(() => { conn.end(); reject(new Error('SSH timeout')); }, timeoutMs);
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
    conn.connect({ host: SSH_HOST, port: 22, username: SSH_USER, privateKey: SSH_KEY });
  });
}

// Quote a value for safe use inside a single-quoted shell argument.
export function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Quote/escape a value for safe inclusion in a single-quoted SQL string literal (doubles quotes).
export function sqlq(s: string): string {
  return String(s).replace(/'/g, `''`);
}
