import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../utils/prisma';
import { enqueueCommand } from '../utils/commandQueue';
import { decryptDarajaCreds, centralDarajaCreds, stkPush, normalizePhone, b2cPayout, isB2cConfigured } from '../utils/daraja';

const router = Router();

// Permissive CORS for captive-portal calls (STK push, status polling). The portal
// is served from the router's hotspot gateway, whose origin isn't predictable, so we
// allow any origin here. Runs before the global CORS check. WITHOUT this, the STK
// request from the portal has no Access-Control-Allow-Origin and the browser blocks
// it — surfacing as "Cannot reach Server" on the portal.
router.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// Backend base URL for Daraja callbacks. Daraja REQUIRES a fully-qualified https URL —
// if BACKEND_URL is set without a protocol (just the hostname), the callback comes out
// schemeless and Safaricom rejects it as "Invalid Callback URL". Normalize to https.
function normalizeBackendUrl(): string {
  let u = process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app';
  u = u.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (u.includes('localhost') || u.includes('127.0.0.1')) u = 'dartbit-production.up.railway.app';
  return 'https://' + u;
}
const BACKEND_URL = normalizeBackendUrl();

function genCreds() {
  const num = crypto.randomBytes(3).toString('hex'); // 6 hex chars
  const pwd = crypto.randomBytes(3).toString('hex');
  return { username: `hs${num}`, password: pwd };
}

// POST /hotspot/stk — initiate STK push for a hotspot package purchase (tenant-own Daraja).
// Body: { apiKey, packageId, phone, mac, ip }
router.post('/stk', async (req: Request, res: Response) => {
  try {
    const { apiKey, packageId, phone, mac, ip } = req.body || {};
    if (!apiKey || !packageId || !phone) return res.status(400).json({ success: false, error: 'Missing fields' });

    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return res.status(404).json({ success: false, error: 'Router not found' });

    const pkg = await prisma.package.findUnique({ where: { id: packageId } });
    if (!pkg || pkg.tenantId !== r.tenantId) return res.status(404).json({ success: false, error: 'Package not found' });

    const cfg = await prisma.paymentConfig.findUnique({ where: { tenantId: r.tenantId } });
    if (!cfg) return res.status(400).json({ success: false, error: 'Payments are not set up for this provider yet.' });

    // Pick the collecting credentials based on the tenant's chosen method:
    //   DARAJA_API           -> tenant's own Daraja (money direct to them, no fee)
    //   TILL_MANUAL/PHONE    -> Dartbit's central Daraja (collect, then disburse minus 1%)
    let creds: ReturnType<typeof decryptDarajaCreds> = null;
    let collectedVia: 'TENANT' | 'DARTBIT' = 'TENANT';

    if (cfg.method === 'DARAJA_API') {
      creds = decryptDarajaCreds(cfg);
      collectedVia = 'TENANT';
      if (!creds) return res.status(400).json({ success: false, error: 'Payment credentials incomplete' });
    } else if (cfg.method === 'TILL_MANUAL' || cfg.method === 'PHONE_MANUAL') {
      creds = centralDarajaCreds();
      collectedVia = 'DARTBIT';
      if (!creds) return res.status(503).json({ success: false, error: 'Central payment service unavailable. Contact support.' });
    } else {
      // KOPOKOPO_API not handled by this STK endpoint
      return res.status(400).json({ success: false, error: 'Selected payment method does not support STK push here.' });
    }

    const durationMinutes = pkg.validityMinutes || 60;

    // Compute fee for Dartbit-collected payments: 1% rounded UP to next whole KES.
    const platformFee = collectedVia === 'DARTBIT' ? Math.ceil(pkg.price * 0.01) : 0;
    const netToTenant = collectedVia === 'DARTBIT' ? Math.max(0, pkg.price - platformFee) : pkg.price;

    // Create the pending transaction first so the callback can find it
    const tx = await prisma.mpesaTransaction.create({
      data: {
        tenantId: r.tenantId, routerId: r.id, packageId: pkg.id,
        phone: normalizePhone(phone), amount: pkg.price, status: 'PENDING',
        clientMac: mac || null, clientIp: ip || null,
        durationMinutes,
        collectedVia, platformFee, netToTenant,
      },
    });

    try {
      const result = await stkPush({
        creds,
        phone,
        amount: pkg.price,
        accountRef: 'Dartbit',
        description: 'Internet',
        callbackUrl: `${BACKEND_URL}/hotspot/stk-callback/${tx.id}`,
      });
      await prisma.mpesaTransaction.update({
        where: { id: tx.id },
        data: { checkoutRequestId: result.checkoutRequestId, merchantRequestId: result.merchantRequestId },
      });
      return res.json({ success: true, transactionId: tx.id, checkoutRequestId: result.checkoutRequestId });
    } catch (e) {
      await prisma.mpesaTransaction.update({ where: { id: tx.id }, data: { status: 'FAILED', resultDesc: e instanceof Error ? e.message : 'STK failed' } });
      return res.status(502).json({ success: false, error: e instanceof Error ? e.message : 'STK push failed' });
    }
  } catch (err) {
    console.error('stk error:', err);
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// POST /hotspot/stk-callback/:txId — Daraja calls this with the payment result.
router.post('/stk-callback/:txId', async (req: Request, res: Response) => {
  // Always 200 so Daraja doesn't retry forever
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const txId = req.params.txId;
    const tx = await prisma.mpesaTransaction.findUnique({ where: { id: txId } });
    if (!tx || tx.status !== 'PENDING') return;

    const cb = req.body?.Body?.stkCallback;
    if (!cb) return;
    const resultCode = cb.ResultCode;

    if (resultCode !== 0) {
      await prisma.mpesaTransaction.update({
        where: { id: txId },
        data: { status: 'FAILED', resultDesc: cb.ResultDesc || 'Payment failed' },
      });
      return;
    }

    // Extract M-Pesa receipt from callback metadata
    let receipt = '';
    const items = cb.CallbackMetadata?.Item || [];
    for (const it of items) {
      if (it.Name === 'MpesaReceiptNumber') receipt = String(it.Value);
    }

    await provisionFromTransaction(txId, receipt);
  } catch (err) {
    console.error('stk-callback error:', err instanceof Error ? err.message : err);
  }
});

// Shared: on successful payment, generate credentials, push the hotspot user to the
// router, and auto-connect the captured MAC. Marks the transaction PAID.
export async function provisionFromTransaction(txId: string, receipt: string) {
  const tx = await prisma.mpesaTransaction.findUnique({ where: { id: txId } });
  if (!tx || tx.status === 'PAID') return;
  const pkg = tx.packageId ? await prisma.package.findUnique({ where: { id: tx.packageId } }) : null;
  const tenant = await prisma.tenant.findUnique({ where: { id: tx.tenantId } });

  // Reuse an existing HOTSPOT subscriber for the SAME phone number (no duplicates). On a
  // repeat purchase we keep their original display name (D1/D2…) and just extend the
  // subscription, rather than creating a new D-number each time.
  const existingSub = tx.phone
    ? await prisma.subscriber.findFirst({ where: { tenantId: tx.tenantId, service: 'HOTSPOT', phone: tx.phone } })
    : null;

  let displayName: string;
  if (existingSub) {
    displayName = existingSub.username;
  } else {
    // New phone → assign first letter of tenant name (uppercased) + next number, e.g. D1, D2.
    const prefix = (tenant?.name?.trim()?.[0] || 'H').toUpperCase().replace(/[^A-Z0-9]/, 'H');
    let seq = await prisma.subscriber.count({ where: { tenantId: tx.tenantId, service: 'HOTSPOT' } }) + 1;
    displayName = `${prefix}${seq}`;
    for (let i = 0; i < 50; i++) {
      const clash = await prisma.subscriber.findFirst({ where: { tenantId: tx.tenantId, username: displayName } });
      if (!clash) break;
      seq++;
      displayName = `${prefix}${seq}`;
    }
  }

  // The ROUTER hotspot user is named after the M-Pesa receipt (uppercased alphanumeric),
  // with password = same receipt. This lets the SAME receipt act as a voucher: the
  // /redeem flow returns username=code,password=code and logs the device back in against
  // this exact user. If no receipt (shouldn't happen on success), fall back to a random code.
  const receiptCode = (receipt || '').toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
  const loginUser = receiptCode && receiptCode.length >= 4 ? receiptCode : genCreds().username.toUpperCase();
  const password = loginUser;

  const sessionSec = tx.durationMinutes * 60;
  const expiresAt = new Date(Date.now() + tx.durationMinutes * 60 * 1000);
  const profileName = pkg ? `db-h-${pkg.id.substring(0, 8)}` : 'dartbit-default';
  const speed = pkg ? `${pkg.speedDownKbps || 5120}k/${pkg.speedUpKbps || 5120}k` : '5120k/5120k';

  // Build router commands. CRITICAL FIXES for "no internet":
  // 1. The package profile MUST have address-pool=dhcp-pool (without it the client gets
  //    no routable IP after login → connected but no internet). The previous code created
  //    the profile with a bare `add name=X` and never set address-pool.
  // 2. Create the user FIRST in its own command, then do the active-login in a SEPARATE
  //    command so the user definitely exists when we log it in (avoids the timing race).
  const cmds: string[] = [];
  cmds.push(`:if ([:len [/ip hotspot user profile find name="${profileName}"]] = 0) do={ /ip hotspot user profile add name=${profileName} address-pool=dhcp-pool }`);
  cmds.push(`/ip hotspot user profile set [find name="${profileName}"] rate-limit="${speed}" shared-users=1 add-mac-cookie=yes address-pool=dhcp-pool`);
  cmds.push(`:if ([:len [/ip hotspot user find name="${loginUser}"]] = 0) do={ /ip hotspot user add name=${loginUser} password=${password} profile=${profileName} limit-uptime=${sessionSec}s comment="Dbm:${displayName}" }`);

  if (tx.routerId) await enqueueCommand(tx.routerId, cmds.join('\n'));

  // Auto-login the captured MAC in a SEPARATE queued command so it runs after the user
  // creation above has been imported (the poller imports each queued command in order).
  // This makes the customer go online automatically after payment.
  if (tx.routerId && tx.clientMac) {
    const loginCmds = [
      `:do { /ip hotspot active login user=${loginUser} mac-address=${tx.clientMac} } on-error={}`,
      `:log info "Dartbit: auto-login ${loginUser} (${displayName})"`,
    ];
    await enqueueCommand(tx.routerId, loginCmds.join('\n'));
  }

  await prisma.mpesaTransaction.update({
    where: { id: txId },
    data: { status: 'PAID', mpesaReceipt: receipt || null, username: displayName, password, expiresAt, resultDesc: 'Success' },
  });

  // Record the M-Pesa receipt as a VOUCHER (code = receipt) bound to this device's MAC.
  // Since the router hotspot user is named after the receipt, redeeming the receipt on the
  // Voucher tab logs the same device back in (the /redeem flow returns username=code).
  if (receiptCode) {
    try {
      await prisma.voucher.upsert({
        where: { code: receiptCode },
        create: {
          tenantId: tx.tenantId,
          code: receiptCode,
          packageId: tx.packageId || undefined,
          routerId: tx.routerId || undefined,
          durationMinutes: tx.durationMinutes,
          isUsed: true,
          usedAt: new Date(),
          usedByMac: tx.clientMac || null,
          usedByIp: tx.clientIp || null,
          expiresAt,
          notes: `M-Pesa ${receiptCode} • ${displayName} • ${tx.phone || ''}`,
        },
        update: { expiresAt, usedByMac: tx.clientMac || null },
      });
    } catch (e) {
      console.error('voucher-from-receipt error:', e instanceof Error ? e.message : e);
    }
  }

  // Add/refresh the customer in the subscribers list (HOTSPOT). Reuse the existing record
  // for this phone (found above) so we never create a duplicate for the same number.
  let subscriberId: string | null = null;
  try {
    if (!existingSub) {
      const created = await prisma.subscriber.create({
        data: {
          tenantId: tx.tenantId,
          routerId: tx.routerId || undefined,
          packageId: tx.packageId || undefined,
          username: displayName,
          secret: password,
          fullName: tx.phone || 'Hotspot Customer',
          phone: tx.phone || null,
          service: 'HOTSPOT',
          isActive: true,
          expiresAt,
          macAddress: tx.clientMac || null,
          ipAddress: tx.clientIp || null,
        },
      });
      subscriberId = created.id;
    } else {
      await prisma.subscriber.update({
        where: { id: existingSub.id },
        data: {
          secret: password,
          expiresAt,
          isActive: true,
          packageId: tx.packageId || undefined,
          macAddress: tx.clientMac || existingSub.macAddress,
          ipAddress: tx.clientIp || existingSub.ipAddress,
        },
      });
      subscriberId = existingSub.id;
    }
  } catch (e) {
    console.error('subscriber create (hotspot) error:', e instanceof Error ? e.message : e);
  }

  // Record a Payment row so the purchase shows on the Payments tab (which reads the
  // Payment table, not MpesaTransaction). Linked to the subscriber created above.
  if (subscriberId) {
    try {
      await prisma.payment.create({
        data: {
          amount: tx.amount,
          method: 'MPESA',
          reference: receipt || tx.checkoutRequestId || txId,
          mpesaCode: receipt || null,
          notes: `Hotspot ${pkg?.name || 'package'} • ${tx.phone || ''}`,
          subscriberId,
          tenantId: tx.tenantId,
        },
      });
    } catch (e) {
      console.error('payment record (hotspot) error:', e instanceof Error ? e.message : e);
    }
  }

  // For Dartbit-collected (manual) methods, disburse the tenant's net share via B2C.
  if (tx.collectedVia === 'DARTBIT' && tx.netToTenant > 0) {
    const cfg = await prisma.paymentConfig.findUnique({ where: { tenantId: tx.tenantId } });
    const isPhone = cfg?.method === 'PHONE_MANUAL';
    const dest = isPhone ? cfg?.payoutPhone : cfg?.payoutTill;
    if (dest && isB2cConfigured()) {
      await prisma.mpesaTransaction.update({ where: { id: txId }, data: { payoutStatus: 'PENDING' } });
      try {
        const result = await b2cPayout({
          amount: tx.netToTenant,
          partyB: dest,
          isPhone: !!isPhone,
          remarks: `Dartbit payout ${txId.slice(-8)}`,
          resultUrl: `${BACKEND_URL}/hotspot/b2c-result/${txId}`,
        });
        await prisma.mpesaTransaction.update({
          where: { id: txId },
          data: { payoutStatus: 'PENDING', payoutRef: result.conversationId },
        });
      } catch (e) {
        console.error('B2C payout error:', e instanceof Error ? e.message : e);
        await prisma.mpesaTransaction.update({
          where: { id: txId },
          data: { payoutStatus: isB2cConfigured() ? 'FAILED' : 'PENDING' },
        });
      }
    } else {
      await prisma.mpesaTransaction.update({ where: { id: txId }, data: { payoutStatus: 'PENDING' } });
    }
  }
}

// GET /hotspot/stk-status/:txId — portal polls this to know when payment completed.
router.get('/stk-status/:txId', async (req: Request, res: Response) => {
  try {
    const tx = await prisma.mpesaTransaction.findUnique({
      where: { id: req.params.txId },
      select: { status: true, username: true, password: true, clientMac: true, resultDesc: true },
    });
    if (!tx) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({
      success: true,
      status: tx.status,
      username: tx.status === 'PAID' ? tx.username : undefined,
      password: tx.status === 'PAID' ? tx.password : undefined,
      autoConnected: tx.status === 'PAID' && !!tx.clientMac,
      message: tx.resultDesc,
    });
  } catch {
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// POST /hotspot/b2c-result/:txId — Daraja B2C payout result callback.
router.post('/b2c-result/:txId', async (req: Request, res: Response) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const txId = req.params.txId;
    const result = req.body?.Result;
    if (!result) return;
    const ok = result.ResultCode === 0;
    await prisma.mpesaTransaction.update({
      where: { id: txId },
      data: {
        payoutStatus: ok ? 'PAID' : 'FAILED',
        payoutAt: ok ? new Date() : null,
      },
    });
  } catch (err) {
    console.error('b2c-result error:', err instanceof Error ? err.message : err);
  }
});

export default router;
