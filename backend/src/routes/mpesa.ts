import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../utils/prisma';
import { enqueueCommand } from '../utils/commandQueue';
import { decryptDarajaCreds, centralDarajaCreds, stkPush, normalizePhone, b2cPayout, isB2cConfigured, normalizeBackendUrl } from '../utils/daraja';
import { sendNotification } from '../utils/notifications';
import { resolveTemplate, renderTemplate } from '../utils/messageTemplates';
import { creditWallet, getWalletBalance, getSmsRate } from '../utils/smsWallet';
import { recordExpense } from './expenses';

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
// Daraja callback base URL is normalized to https via the shared util (normalizeBackendUrl).
const BACKEND_URL = normalizeBackendUrl();

function genCreds() {
  const num = crypto.randomBytes(3).toString('hex'); // 6 hex chars for username uniqueness
  // 4-digit numeric password (1000–9999) — easy for customers to type on the Account tab.
  const pwd = String(1000 + (crypto.randomBytes(2).readUInt16BE(0) % 9000));
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

    // Branch by purpose: an SMS wallet top-up credits the tenant's SMS wallet instead of
    // provisioning a hotspot user.
    if (tx.purpose === 'SMS_TOPUP') {
      await prisma.mpesaTransaction.update({
        where: { id: txId },
        data: { status: 'PAID', mpesaReceipt: receipt || null, resultDesc: 'Success' },
      });
      try {
        await creditWallet(tx.tenantId, tx.amount, receipt || txId, `SMS top-up • ${tx.phone || ''}`);
      } catch (e) {
        console.error('[wallet] credit on callback failed:', e instanceof Error ? e.message : e);
      }
      // Record the top-up as a tenant expense (SMS category).
      await recordExpense({
        tenantId: tx.tenantId,
        amount: tx.amount,
        category: 'SMS',
        description: 'SMS wallet top-up',
        paymentMode: 'M-Pesa',
        reference: receipt || txId,
        source: 'AUTO',
      });
      return;
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
  // Normalize the captured device MAC to uppercase so client lookup-by-MAC, stored macAddress,
  // and the RouterOS commands (which use uppercase) all match consistently.
  if (tx.clientMac) tx.clientMac = tx.clientMac.toUpperCase();
  const pkg = tx.packageId ? await prisma.package.findUnique({ where: { id: tx.packageId } }) : null;
  const tenant = await prisma.tenant.findUnique({ where: { id: tx.tenantId } });

  // A hotspot client is identified by phone + device MAC together. The same phone number can
  // own multiple accounts — one per device — each with its own username. So we only reuse an
  // existing subscriber when BOTH the phone and the device MAC match; a payment from a new MAC
  // (even with the same phone) becomes a separate client with a new D-number. If no MAC was
  // captured we fall back to matching by phone alone (best effort for that edge case).
  const existingSub = tx.phone
    ? (tx.clientMac
        ? await prisma.subscriber.findFirst({ where: { tenantId: tx.tenantId, service: 'HOTSPOT', phone: tx.phone, macAddress: tx.clientMac } })
        : await prisma.subscriber.findFirst({ where: { tenantId: tx.tenantId, service: 'HOTSPOT', phone: tx.phone } }))
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

  // PRIMARY login user: the display name (D1, D2…) with a 4-digit password. This is what
  // shows on the subscriber detail page and works on the portal Account tab. On a repeat
  // purchase by the same phone we reuse the existing 4-digit secret so the customer's
  // password doesn't change under them.
  const password = existingSub?.secret && /^\d{4}$/.test(existingSub.secret) ? existingSub.secret : genCreds().password;
  const loginUser = displayName;

  // The M-Pesa receipt (uppercased alphanumeric) is also added as its OWN hotspot user
  // (username=password=receipt) so the receipt works as a voucher via the Voucher tab.
  const receiptCode = (receipt || '').toUpperCase().trim().replace(/[^A-Z0-9]/g, '');

  const sessionSec = tx.durationMinutes * 60;
  const expiresAt = new Date(Date.now() + tx.durationMinutes * 60 * 1000);
  const profileName = pkg ? `db-h-${pkg.id.substring(0, 8)}` : 'dartbit-default';
  // RouterOS rate-limit is "rx/tx" = "upload/download" from the ROUTER's perspective. The
  // customer's DOWNLOAD is the router's TX, and their UPLOAD is the router's RX. So the string
  // must be `${upload}/${download}` = `${speedUpKbps}k/${speedDownKbps}k`.
  const upK = pkg?.speedUpKbps || 5120;
  const downK = pkg?.speedDownKbps || 5120;
  const speed = `${upK}k/${downK}k`;

  // MAC binding is the primary login mechanism. The hotspot user is bound to the paying device's
  // MAC, and the backend pushes the "log this MAC in" go-ahead below. shared-users=1 keeps it to
  // one device. MikroTik stores MACs uppercase, so we normalize to avoid a case mismatch that
  // would silently block the MAC-bound login.
  const macUC = (tx.clientMac || '').toUpperCase();
  const macBind = macUC ? ` mac-address=${macUC}` : '';
  const cmds: string[] = [];
  // Create-or-update the profile (carries the package rate-limit), verifying it exists before
  // adding users (a brand-new package's profile has never existed on this router).
  cmds.push(`:if ([:len [/ip hotspot user profile find name="${profileName}"]] = 0) do={ /ip hotspot user profile add name=${profileName} address-pool=dhcp-pool }`);
  cmds.push(`/ip hotspot user profile set [find name="${profileName}"] rate-limit="${speed}" shared-users=1 add-mac-cookie=yes address-pool=dhcp-pool`);
  // Primary user (D-name + 4-digit pwd), bound to the paying device's MAC. Recreate fresh.
  cmds.push(`:foreach u in=[/ip hotspot user find name="${loginUser}"] do={ /ip hotspot user remove \$u }`);
  cmds.push(`/ip hotspot user add name=${loginUser} password=${password} profile=${profileName} limit-uptime=${sessionSec}s${macBind} comment="Dbm:${displayName}"`);
  // Immediately create the MAC-named auth user so login-by=mac works on the very next reconnect,
  // without waiting for the 60s sync. This is the device's silent auto-login identity (the MAC is
  // never shown in the UI; sessions resolve back to the D-number). Password matches the profile's
  // mac-auth-password ("dartbit").
  if (macUC) {
    cmds.push(`:foreach u in=[/ip hotspot user find name="${macUC}"] do={ /ip hotspot user remove \$u }`);
    cmds.push(`/ip hotspot user add name=${macUC} password=dartbit mac-address=${macUC} profile=${profileName} comment="DbMac:${displayName}"`);
  }
  // NOTE: The M-Pesa receipt code is ALSO a valid login for this same device — but we do NOT
  // create a separate hotspot user for it here. It's registered as a voucher (below) tagged
  // batchId="MPESA", and the voucher sync creates it under the SAME profile + same MAC + same
  // expiry as this subscriber, so the receipt code, the username/password, and the MAC all act
  // as one identity sharing one session end. Creating it twice (here + sync, under different
  // profiles) was what left the code in limbo (shown active but no traffic / no redirect).

  // Auto-login the paid MAC: the router receives this go-ahead on its next ~5s poll and logs the
  // device in as a REAL session under the rate-limited profile (so it's speed-capped, tracked,
  // and shows in active users). CRITICAL FIRST STEP: remove any leftover type=bypassed binding
  // for this MAC from older versions — a bypassed device skips the hotspot entirely (full
  // bandwidth, no session), which silently overrides the login. We also clear any stale active
  // session, then run the login in a self-removing one-shot script (proper scope + retries).
  if (macUC) {
    const ipArg = tx.clientIp ? ` ip=${tx.clientIp}` : '';
    cmds.push(`:foreach b in=[/ip hotspot ip-binding find mac-address="${macUC}"] do={ /ip hotspot ip-binding remove \$b }`);
    cmds.push(`:foreach a in=[/ip hotspot active find mac-address="${macUC}"] do={ /ip hotspot active remove \$a }`);
    const body =
      `:delay 2s; ` +
      `:local done false; ` +
      `:for i from=1 to=6 do={ :if (\\$done = false) do={ :do { /ip hotspot active login user=${loginUser}${ipArg} mac-address=${macUC}; :set done true } on-error={ :delay 2s } } }; ` +
      `:if (\\$done) do={ :log info \\"Dartbit: login ok ${loginUser}\\" } else={ :log warning \\"Dartbit: login retry exhausted ${loginUser}\\" }; ` +
      `/system scheduler remove [find name=\\"db-login\\"]; ` +
      `/system script remove [find name=\\"db-login\\"]`;
    cmds.push(`:foreach s in=[/system scheduler find name="db-login"] do={ /system scheduler remove \$s }`);
    cmds.push(`:foreach s in=[/system script find name="db-login"] do={ /system script remove \$s }`);
    cmds.push(`/system script add name=db-login policy=read,write,test source="${body}"`);
    cmds.push(`/system scheduler add name=db-login interval=3s on-event="/system script run db-login" comment="Dartbit auto-login"`);
  }

  if (tx.routerId) await enqueueCommand(tx.routerId, cmds.join('\n'));

  await prisma.mpesaTransaction.update({
    where: { id: txId },
    data: { status: 'PAID', mpesaReceipt: receipt || null, username: displayName, password, expiresAt, resultDesc: 'Success' },
  });

  // Record the M-Pesa receipt as a VOUCHER (code = receipt) bound to this device's MAC, so
  // redeeming the receipt on the Voucher tab logs the same device back in.
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
          usedByMac: macUC || null,
          usedByIp: tx.clientIp || null,
          expiresAt,
          // Tag so the voucher sync creates this code under the SAME hotspot profile/MAC/expiry
          // as the subscriber (one unified identity), instead of a separate db-v- profile user.
          batchId: 'MPESA',
          notes: `M-Pesa ${receiptCode} • ${displayName} • ${tx.phone || ''}`,
        },
        update: { expiresAt, usedByMac: macUC || null, batchId: 'MPESA', packageId: tx.packageId || undefined },
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
          packageId: pkg?.id || null,
          subscriberId,
          tenantId: tx.tenantId,
        },
      });
    } catch (e) {
      console.error('payment record (hotspot) error:', e instanceof Error ? e.message : e);
    }
  }

  // Send notification SMS to the customer: a payment receipt (with login creds) every
  // purchase; plus a welcome SMS on the first ever purchase from this phone. Both respect
  // the tenant's NotificationConfig toggles. Dedup via Message.dedupKey so retries don't
  // double-send.
  if (tx.phone && tenant) {
    try {
      const ncfg = await prisma.notificationConfig.findUnique({ where: { tenantId: tx.tenantId }, select: { templates: true } });
      const overrides = (ncfg?.templates as Record<string, string> | null) || null;
      const login = `${displayName} / ${password}`;
      // Welcome: only when this is a NEW subscriber (no existingSub at provision-start).
      if (!existingSub) {
        const welcome = renderTemplate(resolveTemplate('hotspot_welcome', overrides), {
          tenant: tenant.name, username: displayName, name: tx.phone || '', phone: tx.phone || '',
        });
        await sendNotification({
          tenantId: tx.tenantId,
          phone: tx.phone,
          body: welcome,
          category: 'WELCOME',
          dedupKey: `WELCOME:${tx.tenantId}:${tx.phone}`,
          subscriberId,
          username: displayName,
        }).catch(err => console.error('welcome SMS error:', err instanceof Error ? err.message : err));
      }
      // Receipt: per transaction. Includes login (D-name + 4-digit pwd) and amount.
      const receiptBody = renderTemplate(resolveTemplate('hotspot_receipt', overrides), {
        tenant: tenant.name, amount: tx.amount, package: pkg?.name || `${tx.durationMinutes}min`,
        login, receipt: receipt || txId.slice(-6), username: displayName,
      });
      await sendNotification({
        tenantId: tx.tenantId,
        phone: tx.phone,
        body: receiptBody,
        category: 'RECEIPT',
        dedupKey: `RECEIPT:${txId}`,
        subscriberId,
        username: displayName,
      }).catch(err => console.error('receipt SMS error:', err instanceof Error ? err.message : err));
    } catch (e) {
      console.error('notification SMS error:', e instanceof Error ? e.message : e);
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
