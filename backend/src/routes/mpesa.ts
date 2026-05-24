import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../utils/prisma';
import { enqueueCommand } from '../utils/commandQueue';
import { decryptDarajaCreds, stkPush, normalizePhone } from '../utils/daraja';

const router = Router();

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
    if (!cfg || cfg.method !== 'DARAJA_API') {
      return res.status(400).json({ success: false, error: 'This provider is not set up for direct M-Pesa payments.' });
    }
    const creds = decryptDarajaCreds(cfg);
    if (!creds) return res.status(400).json({ success: false, error: 'Payment credentials incomplete' });

    const durationMinutes = pkg.validityMinutes || 60;

    // Create the pending transaction first so the callback can find it
    const tx = await prisma.mpesaTransaction.create({
      data: {
        tenantId: r.tenantId, routerId: r.id, packageId: pkg.id,
        phone: normalizePhone(phone), amount: pkg.price, status: 'PENDING',
        clientMac: mac || null, clientIp: ip || null,
        durationMinutes,
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

  if (tx.routerId) enqueueCommand(tx.routerId, cmds.join('\n'));

  await prisma.mpesaTransaction.update({
    where: { id: txId },
    data: { status: 'PAID', mpesaReceipt: receipt || null, username, password, expiresAt, resultDesc: 'Success' },
  });
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

export default router;
