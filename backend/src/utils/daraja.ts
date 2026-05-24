import https from 'https';
import { decrypt } from './crypto';

// M-Pesa Daraja integration. Works with a tenant's OWN credentials (decrypted from
// PaymentConfig) for the direct-to-tenant flow. Supports both Till (Buy Goods) and PayBill.

const DARAJA_ENV = process.env.DARAJA_ENV || 'sandbox'; // 'sandbox' | 'production'
const DARAJA_HOST = DARAJA_ENV === 'production' ? 'api.safaricom.co.ke' : 'sandbox.safaricom.co.ke';

interface DarajaCreds {
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
  shortcode: string;       // Till or PayBill number
  type: 'TILL' | 'PAYBILL';
}

// Decrypt a tenant's stored Daraja credentials from their PaymentConfig row.
export function decryptDarajaCreds(cfg: {
  darajaConsumerKey?: string | null;
  darajaConsumerSecret?: string | null;
  darajaPasskey?: string | null;
  darajaShortcode?: string | null;
  darajaType?: string | null;
}): DarajaCreds | null {
  if (!cfg.darajaConsumerKey || !cfg.darajaConsumerSecret || !cfg.darajaShortcode) return null;
  return {
    consumerKey: decrypt(cfg.darajaConsumerKey),
    consumerSecret: decrypt(cfg.darajaConsumerSecret),
    passkey: cfg.darajaPasskey ? decrypt(cfg.darajaPasskey) : '',
    shortcode: cfg.darajaShortcode,
    type: (cfg.darajaType as 'TILL' | 'PAYBILL') || 'TILL',
  };
}

function httpsRequest(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: DARAJA_HOST, port: 443, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode || 0, json: JSON.parse(data || '{}') }); }
          catch { resolve({ status: res.statusCode || 0, json: { raw: data } }); }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// OAuth token from Daraja using a tenant's consumer key/secret.
async function getAccessToken(creds: DarajaCreds): Promise<string> {
  const auth = Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64');
  const { json } = await httpsRequest('GET', '/oauth/v1/generate?grant_type=client_credentials', {
    Authorization: `Basic ${auth}`,
  });
  const token = json.access_token as string | undefined;
  if (!token) throw new Error('Failed to get Daraja access token');
  return token;
}

// yyyyMMddHHmmss timestamp in EAT
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Normalize a Kenyan phone to 2547XXXXXXXX
export function normalizePhone(phone: string): string {
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  else if (p.startsWith('254')) { /* ok */ }
  return p;
}

// Initiate an STK Push. For Till (Buy Goods) the transaction type is
// CustomerBuyGoodsOnline; for PayBill it's CustomerPayBillOnline.
export async function stkPush(params: {
  creds: DarajaCreds;
  phone: string;
  amount: number;
  accountRef: string;
  description: string;
  callbackUrl: string;
}): Promise<{ checkoutRequestId: string; merchantRequestId: string; responseCode: string }> {
  const token = await getAccessToken(params.creds);
  const ts = timestamp();
  const password = Buffer.from(`${params.creds.shortcode}${params.creds.passkey}${ts}`).toString('base64');
  const transactionType = params.creds.type === 'PAYBILL' ? 'CustomerPayBillOnline' : 'CustomerBuyGoodsOnline';
  const phone = normalizePhone(params.phone);

  const payload = JSON.stringify({
    BusinessShortCode: params.creds.shortcode,
    Password: password,
    Timestamp: ts,
    TransactionType: transactionType,
    Amount: Math.round(params.amount),
    PartyA: phone,
    PartyB: params.creds.shortcode,
    PhoneNumber: phone,
    CallBackURL: params.callbackUrl,
    AccountReference: params.accountRef.slice(0, 12),
    TransactionDesc: params.description.slice(0, 13),
  });

  const { json } = await httpsRequest('POST', '/mpesa/stkpush/v1/processrequest', {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }, payload);

  if (!json.CheckoutRequestID) {
    throw new Error((json.errorMessage as string) || (json.ResponseDescription as string) || 'STK push failed');
  }
  return {
    checkoutRequestId: json.CheckoutRequestID as string,
    merchantRequestId: json.MerchantRequestID as string,
    responseCode: json.ResponseCode as string,
  };
}
