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

const BACKEND_URL = process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app';

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

  const { username, password } = genCreds();
  const sessionSec = tx.durationMinutes * 60;
  const expiresAt = new Date(Date.now() + tx.durationMinutes * 60 * 1000);
  const profileName = pkg ? `db-h-${pkg.id.substring(0, 8)}` : 'dartbit-default';
  const speed = pkg ? `${pkg.speedDownKbps || 5120}k/${pkg.speedUpKbps || 5120}k` : '5120k/5120k';

  // Build router commands: ensure profile, add the user, then auto-login the MAC if we have it.
  const cmds: string[] = [];
  cmds.push(`:if ([:len [/ip hotspot user profile find name="${profileName}"]] = 0) do={ /ip hotspot user profile add name=${profileName} }`);
  cmds.push(`/ip hotspot user profile set [find name="${profileName}"] rate-limit="${speed}" shared-users=1 add-mac-cookie=yes`);
  cmds.push(`:if ([:len [/ip hotspot user find name="${username}"]] = 0) do={ /ip hotspot user add name=${username} password=${password} profile=${profileName} limit-uptime=${sessionSec}s comment="Dbm:${txId.slice(-8)}" }`);
  // Auto-connect: log the captured MAC straight into the hotspot so the customer is online
  // without manually signing in. Falls back to username/password if MAC missing/changed.
  if (tx.clientMac) {
    cmds.push(`:do { /ip hotspot active login user=${username} mac-address=${tx.clientMac} } on-error={}`);
  }

  if (tx.routerId) await enqueueCommand(tx.routerId, cmds.join('\n'));

  await prisma.mpesaTransaction.update({
    where: { id: txId },
    data: { status: 'PAID', mpesaReceipt: receipt || null, username, password, expiresAt, resultDesc: 'Success' },
  });

  // Add the customer to the subscribers list automatically (HOTSPOT service type),
  // so M-Pesa hotspot buyers appear alongside PPPoE subscribers in the dashboard.
  // Keyed by username (unique per purchase). If somehow it exists, update it.
  try {
    const existing = await prisma.subscriber.findFirst({ where: { tenantId: tx.tenantId, username } });
    if (!existing) {
      await prisma.subscriber.create({
        data: {
          tenantId: tx.tenantId,
          routerId: tx.routerId || undefined,
          packageId: tx.packageId || undefined,
          username,
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
    } else {
      await prisma.subscriber.update({
        where: { id: existing.id },
        data: { secret: password, expiresAt, isActive: true, packageId: tx.packageId || undefined },
      });
    }
  } catch (e) {
    // Non-fatal: provisioning + payment already succeeded; subscriber listing is secondary.
    console.error('subscriber create (hotspot) error:', e instanceof Error ? e.message : e);
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
        // Payout failed/not enabled — leave as PENDING for manual settlement, log it.
        console.error('B2C payout error:', e instanceof Error ? e.message : e);
        await prisma.mpesaTransaction.update({
          where: { id: txId },
          data: { payoutStatus: isB2cConfigured() ? 'FAILED' : 'PENDING' },
        });
      }
    } else {
      // No B2C configured — mark payout PENDING so it can be settled manually/periodically.
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
