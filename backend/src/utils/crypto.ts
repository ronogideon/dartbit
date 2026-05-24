import crypto from 'crypto';

// Symmetric encryption for sensitive credentials at rest (Daraja/KopoKopo secrets).
// Uses AES-256-GCM. The key comes from CREDENTIAL_ENCRYPTION_KEY (32-byte hex) env var.
// If not set, falls back to a key derived from JWT_SECRET so the app still runs in dev,
// but you should set a dedicated key in production.

function getKey(): Buffer {
  const envKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (envKey && envKey.length >= 64) {
    return Buffer.from(envKey.slice(0, 64), 'hex');
  }
  // Derive a 32-byte key from JWT_SECRET as a fallback
  const secret = process.env.JWT_SECRET || 'dartbit-dev-secret';
  return crypto.createHash('sha256').update(secret).digest();
}

export function encrypt(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store iv:tag:ciphertext, all hex
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(payload: string): string {
  if (!payload || !payload.includes(':')) return '';
  try {
    const [ivHex, tagHex, dataHex] = payload.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return '';
  }
}

// Mask a secret for display (show last 4 chars only)
export function mask(value: string | null | undefined): string {
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return '••••' + value.slice(-4);
}
