// BlessedTexts SMS gateway client. Wraps the documented HTTPS endpoints for sending SMS,
// checking credit balance, and topping up credit. Each tenant can use Dartbit's shared
// API key (env: BLESSEDTEXTS_API_KEY) or their own (stored encrypted in NotificationConfig).
import https from 'https';
import { decrypt, encrypt } from './crypto';

const BASE_HOST = 'sms.blessedtexts.com';

export interface SmsCreds {
  apiKey: string;
  senderId: string;
}

export interface SendSmsResult {
  ok: boolean;
  statusCode: string;       // gateway status (1000 = success)
  statusDesc: string;
  messageId?: string;
  cost: number;
  raw: unknown;
}

// Normalize a phone number to 254XXXXXXXXX. Accepts 07XXXXXXXX, 254XXXXXXXXX, 7XXXXXXXX,
// or with leading +. Returns null if it doesn't look like a Kenyan mobile.
export function normalizeKenyanPhone(input: string): string | null {
  if (!input) return null;
  let p = String(input).trim().replace(/[\s\-()+]/g, '');
  if (p.startsWith('00')) p = p.substring(2);
  if (p.startsWith('254')) {
    // already in international format
  } else if (p.startsWith('0')) {
    p = '254' + p.substring(1);
  } else if (p.startsWith('7') || p.startsWith('1')) {
    p = '254' + p;
  }
  // Final shape: 254 + 9 digits
  if (!/^254[71]\d{8}$/.test(p)) return null;
  return p;
}

function postJson<T = unknown>(path: string, body: Record<string, unknown>): Promise<{ status: number; json: T }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host: BASE_HOST,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode || 0, json: parsed as T });
        } catch {
          resolve({ status: res.statusCode || 0, json: { raw: data } as unknown as T });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('BlessedTexts request timeout')); });
    req.write(payload);
    req.end();
  });
}

// Returns the central Dartbit creds from env, or null if not configured.
export function dartbitDefaultCreds(): SmsCreds | null {
  const apiKey = process.env.BLESSEDTEXTS_API_KEY;
  const senderId = process.env.BLESSEDTEXTS_SENDER_ID;
  if (!apiKey || !senderId) return null;
  return { apiKey, senderId };
}

// Encrypt the tenant-provided API key for storage. Reuses our AES-256-GCM utility.
export function encryptApiKey(plain: string): string { return encrypt(plain); }
export function decryptApiKey(encrypted: string): string { return decrypt(encrypted); }

// Send a single SMS. The endpoint returns an array of results (one per phone); we send
// one number at a time so the array has length 1 and we read [0].
export async function sendSms(creds: SmsCreds, phone: string, message: string): Promise<SendSmsResult> {
  const { status, json } = await postJson<unknown>('/api/sms/v1/sendsms', {
    api_key: creds.apiKey,
    sender_id: creds.senderId,
    message,
    phone,
  });

  // Per documentation the response is an array of per-recipient results, but the balance
  // endpoint and topup endpoint return objects — guard against either shape.
  const first = Array.isArray(json) ? (json[0] as Record<string, unknown>) : (json as Record<string, unknown>);
  const statusCode = String(first?.status_code ?? '');
  const statusDesc = String(first?.status_desc ?? '');
  const messageId = first?.message_id ? String(first.message_id) : undefined;
  const cost = first?.message_cost ? Number(first.message_cost) : 0;
  return {
    ok: status >= 200 && status < 300 && statusCode === '1000',
    statusCode,
    statusDesc,
    messageId,
    cost: Number.isFinite(cost) ? cost : 0,
    raw: json,
  };
}

// Get the API account's SMS credit balance.
export async function getSmsBalance(creds: { apiKey: string }): Promise<{ ok: boolean; balance: number; raw: unknown }> {
  const { status, json } = await postJson<Record<string, unknown>>('/api/sms/v1/credit-balance', {
    api_key: creds.apiKey,
  });
  const balance = json?.balance ? Number(json.balance) : 0;
  const ok = status >= 200 && status < 300 && String(json?.status_code ?? '') === '1000';
  return { ok, balance: Number.isFinite(balance) ? balance : 0, raw: json };
}

// Start a credit topup. Triggers an STK push to the provided phone via BlessedTexts.
export async function topupSms(apiKey: string, amount: number, phoneNumber?: string): Promise<{ ok: boolean; statusCode: string; statusDesc: string; raw: unknown }> {
  const body: Record<string, unknown> = { api_key: apiKey, amount };
  if (phoneNumber) body.phone_number = phoneNumber;
  const { status, json } = await postJson<Record<string, unknown>>('/api/credit/v1/topup', body);
  const statusCode = String(json?.status_code ?? '');
  return {
    ok: status >= 200 && status < 300 && statusCode === '1000',
    statusCode,
    statusDesc: String(json?.status_desc ?? ''),
    raw: json,
  };
}
