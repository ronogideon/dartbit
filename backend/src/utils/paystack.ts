import https from 'https';
import crypto from 'crypto';

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_BASE = 'api.paystack.co';

if (!PAYSTACK_SECRET) {
  console.warn('⚠️  PAYSTACK_SECRET_KEY not set — Paystack payments will fail until configured.');
}

interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

// Low-level HTTPS request to Paystack
function paystackRequest<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<PaystackResponse<T>> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        hostname: PAYSTACK_BASE,
        port: 443,
        path,
        method,
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Invalid Paystack response'));
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Initialize a transaction. amount is in KES; Paystack expects the subunit (kobo/cents),
// so we multiply by 100. Returns the checkout URL + reference.
export async function initializeTransaction(params: {
  email: string;
  amountKES: number;
  reference: string;
  callbackUrl: string;
  metadata?: object;
}): Promise<{ authorizationUrl: string; reference: string }> {
  const resp = await paystackRequest<{ authorization_url: string; reference: string; access_code: string }>(
    'POST',
    '/transaction/initialize',
    {
      email: params.email,
      amount: Math.round(params.amountKES * 100), // to subunit
      currency: 'KES',
      reference: params.reference,
      callback_url: params.callbackUrl,
      metadata: params.metadata,
    }
  );
  if (!resp.status) throw new Error(resp.message || 'Paystack initialize failed');
  return { authorizationUrl: resp.data.authorization_url, reference: resp.data.reference };
}

// Verify a transaction by reference. Returns whether it succeeded + amount paid (KES).
export async function verifyTransaction(reference: string): Promise<{ success: boolean; amountKES: number; status: string }> {
  const resp = await paystackRequest<{ status: string; amount: number }>(
    'GET',
    `/transaction/verify/${encodeURIComponent(reference)}`
  );
  if (!resp.status) return { success: false, amountKES: 0, status: 'failed' };
  return {
    success: resp.data.status === 'success',
    amountKES: (resp.data.amount || 0) / 100,
    status: resp.data.status,
  };
}

// Verify the webhook signature Paystack sends in the x-paystack-signature header.
// It's an HMAC-SHA512 of the raw request body using the secret key.
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  if (!PAYSTACK_SECRET || !signature) return false;
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(rawBody).digest('hex');
  return hash === signature;
}

export const isPaystackConfigured = () => !!PAYSTACK_SECRET;
