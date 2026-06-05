// TalkSasa (bulksms.talksasa.com) SMS gateway client. Implements the same SmsCreds/SendSmsResult
// shape as the BlessedTexts client so the unified gateway dispatcher can use either provider.
// Auth: Bearer {api_token}. Send: POST /api/v3/sms/send. Balance: the v3 API does not expose a
// balance via GET /api/v3/balance.
import https from 'https';
import type { SmsCreds, SendSmsResult } from './blessedtexts';

const BASE_HOST = 'bulksms.talksasa.com';

function request<T = unknown>(method: 'POST' | 'GET', path: string, token: string, body?: Record<string, unknown>): Promise<{ status: number; json: T }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = https.request({ host: BASE_HOST, path, method, headers, timeout: 15000 }, (res) => {
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
    req.on('timeout', () => { req.destroy(new Error('TalkSasa request timeout')); });
    if (body) req.write(payload);
    req.end();
  });
}

// Send a single SMS via TalkSasa. creds.apiKey holds the Bearer token; creds.senderId the sender.
export async function sendSmsTalkSasa(creds: SmsCreds, phone: string, message: string): Promise<SendSmsResult> {
  const { status, json } = await request<Record<string, unknown>>('POST', '/api/v3/sms/send', creds.apiKey, {
    recipient: phone,
    sender_id: creds.senderId,
    type: 'plain',
    message,
  });
  const ok = status >= 200 && status < 300 && String(json?.status ?? '').toLowerCase() === 'success';
  // TalkSasa returns { status, data } on success or { status:'error', message } on failure.
  // It doesn't return a per-message id or cost in a documented field, so we synthesize sensibly.
  const messageId = (() => {
    const d = json?.data as unknown;
    if (d && typeof d === 'object') {
      const uid = (d as Record<string, unknown>).uid || (d as Record<string, unknown>).id;
      if (uid) return String(uid);
    }
    return undefined;
  })();
  return {
    ok,
    statusCode: ok ? '1000' : 'error',
    statusDesc: ok ? 'success' : String(json?.message ?? json?.status ?? 'send failed'),
    messageId,
    cost: 0, // TalkSasa v3 send response has no documented cost field
    raw: json,
  };
}

// TalkSasa v3 has no documented credit-balance endpoint; balance is not retrievable via API.
// TalkSasa balance via GET /api/v3/balance. Returns { status, data } where data holds the SMS
// unit info. The exact shape of `data` isn't strictly documented (described as "sms unit with all
// details"), so we parse defensively: accept a number, a numeric string, or an object with a
// balance/units/credit/sms field.
export async function getSmsBalanceTalkSasa(token: string): Promise<{ ok: boolean; balance: number | null; raw: unknown }> {
  const { status, json } = await request<Record<string, unknown>>('GET', '/api/v3/balance', token);
  const ok = status >= 200 && status < 300 && String(json?.status ?? '').toLowerCase() === 'success';
  if (!ok) return { ok: false, balance: null, raw: json };

  const data = json?.data as unknown;
  let balance: number | null = null;
  const toNum = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
      // Strip currency prefixes/labels like "Ksh150", "KES 150", "150 SMS".
      const n = Number(v.replace(/[^\d.]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  if (typeof data === 'number' || typeof data === 'string') {
    balance = toNum(data);
  } else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    // TalkSasa returns { remaining_balance: "Ksh150" }. Also accept common alternatives.
    const cand = o.remaining_balance ?? o.balance ?? o.units ?? o.sms_unit ?? o.sms_units ?? o.credit ?? o.sms ?? o.amount;
    balance = toNum(cand);
  }
  return { ok: true, balance, raw: json };
}
