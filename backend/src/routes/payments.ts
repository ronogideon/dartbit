import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

const paymentSchema = z.object({
  subscriberId: z.string(),
  amount: z.number().min(0),
  method: z.string().default('MANUAL'),
  reference: z.string().optional(),
  mpesaCode: z.string().optional(),
  notes: z.string().optional(),
  // Which kind of payment this is. PACKAGE = payment for an internet package: the chosen package
  // is assigned to the subscriber and expiry is extended by THAT package's validity. OTHER = any
  // non-package payment (installation, equipment, support call-out...) — it never touches expiry
  // and requires `notes` to record the reason.
  kind: z.enum(['PACKAGE', 'OTHER']).default('PACKAGE'),
  // The package actually paid for. Only meaningful when kind === 'PACKAGE'.
  packageId: z.string().optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};
    const payments = await prisma.payment.findMany({
      where,
      include: { subscriber: true },
      orderBy: { createdAt: 'desc' },
    });
    sendSuccess(res, payments);
  } catch {
    sendError(res, 'Failed to fetch payments', 500);
  }
});

// GET /payments/summary — tenant earnings tiles (mirrors the expenses page):
//   earnedToday       total received today, all services (PPPoE + hotspot + static)
//   todayHotspot      received today from HOTSPOT service only
//   thisWeek          total received since Monday 00:00 (week starts Monday), all services
//   thisMonth         total received since the 1st of the month 00:00, all services
// A payment's service is derived from its subscriber (falling back to its package); payments with
// neither resolvable are still counted in the all-service totals but never in the hotspot-only tile.
router.get('/summary', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);

    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    // Week starts Monday: getDay() is 0=Sun..6=Sat; days back to Monday = (day + 6) % 7.
    const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - ((now.getDay() + 6) % 7));

    // One query covers all tiles: everything from the earliest boundary (month start) forward,
    // with the service resolvable so the hotspot-only tile can be computed in-process.
    const since = monthStart < weekStart ? monthStart : weekStart;
    const rows = await prisma.payment.findMany({
      where: { tenantId, createdAt: { gte: since } },
      select: {
        amount: true,
        createdAt: true,
        subscriber: { select: { service: true } },
        package: { select: { service: true } },
      },
    });

    let earnedToday = 0, todayHotspot = 0, thisWeek = 0, thisMonth = 0;
    for (const p of rows) {
      const amt = p.amount || 0;
      const svc = p.subscriber?.service ?? p.package?.service ?? null;
      if (p.createdAt >= monthStart) thisMonth += amt;
      if (p.createdAt >= weekStart) thisWeek += amt;
      if (p.createdAt >= todayStart) {
        earnedToday += amt;
        if (svc === 'HOTSPOT') todayHotspot += amt;
      }
    }

    sendSuccess(res, { earnedToday, todayHotspot, thisWeek, thisMonth });
  } catch {
    sendError(res, 'Failed to fetch payments summary', 500);
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);

    // Fetch subscriber and package to extend expiry
    const subscriber = await prisma.subscriber.findUnique({
      where: { id: parsed.data.subscriberId },
      include: { package: true },
    });

    if (!subscriber) return sendError(res, 'Subscriber not found', 404);

    const { kind, packageId: paidPackageId, ...paymentFields } = parsed.data;

    // A non-package payment (installation, equipment, support...) must say what it was for —
    // otherwise the ledger fills with unexplained amounts that nobody can reconcile later.
    if (kind === 'OTHER' && !paymentFields.notes?.trim()) {
      return sendError(res, 'A reason is required for payments that are not for a package', 400);
    }

    // Resolve the package actually being paid for. Previously this always used the subscriber's
    // CURRENTLY ASSIGNED package, so paying for a 30-day plan while still assigned a 1-day one
    // extended expiry by a single day. Now the package chosen at payment time wins, and it is only
    // consulted for PACKAGE payments.
    let paidPackage = null as { id: string; validityMinutes: number } | null;
    if (kind === 'PACKAGE') {
      if (paidPackageId) {
        const pkg = await prisma.package.findFirst({
          where: { id: paidPackageId, tenantId },
          select: { id: true, validityMinutes: true },
        });
        if (!pkg) return sendError(res, 'Package not found', 404);
        paidPackage = pkg;
      } else if (subscriber.package) {
        paidPackage = { id: subscriber.package.id, validityMinutes: subscriber.package.validityMinutes };
      } else {
        return sendError(res, 'Select a package for this payment, or record it as an other payment with a reason', 400);
      }
    }

    const payment = await prisma.payment.create({
      data: {
        ...paymentFields,
        source: 'MANUAL',
        // OTHER payments are deliberately not attributed to a package so income-by-package
        // analytics stay honest.
        packageId: kind === 'PACKAGE' ? (paidPackage?.id ?? null) : null,
        tenantId,
      },
    });

    // Extend expiry only for package payments, by the validity of the package that was paid for.
    if (kind === 'PACKAGE' && paidPackage) {
      const now = new Date();
      const currentExpiry = subscriber.expiresAt && subscriber.expiresAt > now
        ? subscriber.expiresAt
        : now;
      const newExpiry = new Date(currentExpiry.getTime() + paidPackage.validityMinutes * 60 * 1000);

      await prisma.subscriber.update({
        where: { id: subscriber.id },
        data: {
          expiresAt: newExpiry,
          isActive: true,
          // Paying for a package makes it the subscriber's current plan, so renewals and the
          // router-side profile follow what they actually bought.
          packageId: paidPackage.id,
        },
      });

      // Mirror the new expiry into RADIUS so gateway-managed routers enforce the extended window.
      try {
        const { radiusConfigured, syncSubscriberToRadius } = await import('../utils/radius');
        if (radiusConfigured() && (subscriber.service === 'PPPOE' || subscriber.service === 'HOTSPOT')) {
          await syncSubscriberToRadius(subscriber.id);
        }
      } catch (e) {
        console.error('payment: radius sync failed (continuing):', e instanceof Error ? e.message : e);
      }
    }

    sendSuccess(res, payment, 201);
  } catch {
    sendError(res, 'Failed to create payment', 500);
  }
});

// PATCH /:id — edit a MANUAL payment's amount and/or notes. Automatic (gateway) records are
// immutable — they're the financial source of truth from M-Pesa and must not be altered.
const editSchema = z.object({
  amount: z.number().min(0).optional(),
  notes: z.string().optional(),
});
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const existing = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!existing) return sendError(res, 'Payment not found', 404);
    if (tenantId && existing.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);
    if ((existing as { source?: string }).source === 'AUTOMATIC') {
      return sendError(res, 'Automatic (gateway) payments cannot be edited', 403);
    }
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);
    const data: Record<string, unknown> = {};
    if (parsed.data.amount !== undefined) data.amount = parsed.data.amount;
    if (parsed.data.notes !== undefined) data.notes = parsed.data.notes || null;
    const updated = await prisma.payment.update({ where: { id: req.params.id }, data });
    sendSuccess(res, updated);
  } catch {
    sendError(res, 'Failed to update payment', 500);
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const existing = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!existing) return sendError(res, 'Payment not found', 404);
    if (tenantId && existing.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);
    // Automatic (gateway) payments are an immutable financial record — never deletable.
    if ((existing as { source?: string }).source === 'AUTOMATIC') {
      return sendError(res, 'Automatic (gateway) payments cannot be deleted', 403);
    }
    await prisma.payment.delete({ where: { id: req.params.id } });
    sendSuccess(res, { deleted: true });
  } catch {
    sendError(res, 'Failed to delete payment', 500);
  }
});



// GET /payments/prompt-target/:subscriberId — what a prompt would charge and where it would go.
// Used to prefill the tenant's "Prompt payment" dialog before they confirm.
router.get('/prompt-target/:subscriberId', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const sub = await prisma.subscriber.findFirst({
      where: { id: req.params.subscriberId, tenantId },
      include: { package: true },
    });
    if (!sub) return sendError(res, 'Subscriber not found', 404);
    // The package on the subscriber IS the one they're on now, or — once expired — the one they
    // were on before expiry (expiry doesn't clear packageId), which is exactly what to re-charge.
    const pkg = sub.package;
    const expired = sub.expiresAt ? new Date(sub.expiresAt).getTime() <= Date.now() : false;
    sendSuccess(res, {
      subscriberId: sub.id,
      fullName: sub.fullName,
      username: sub.username,
      phone: sub.phone || '',
      expired,
      expiresAt: sub.expiresAt,
      packageId: pkg?.id || null,
      packageName: pkg?.name || null,
      amount: pkg?.price ?? null,
      hasPackage: !!pkg,
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /payments/prompt — tenant triggers an M-Pesa STK push at a subscriber's phone.
// Body: { subscriberId, phone?, amount? } — phone/amount default to the subscriber's saved number
// and their package price; the tenant may override either in the dialog before sending.
router.post('/prompt', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    if (req.user?.role === 'TENANT_VIEWER') return sendError(res, 'Technicians cannot request payments', 403);

    const { subscriberId } = req.body || {};
    if (!subscriberId) return sendError(res, 'Select a subscriber to prompt', 400);

    const sub = await prisma.subscriber.findFirst({
      where: { id: String(subscriberId), tenantId },
      include: { package: true },
    });
    if (!sub) return sendError(res, 'Subscriber not found', 404);

    const phoneRaw = String(req.body?.phone || sub.phone || '').trim();
    if (!phoneRaw) return sendError(res, 'No phone number for this subscriber — enter one to prompt', 400);

    // Which package is being paid for. The tenant may pick one explicitly in the dialog (including
    // for a subscriber who has none assigned yet); otherwise fall back to their current package.
    // Previously this ALWAYS used sub.package, so prompting for a different plan charged the new
    // price but renewed by the OLD plan's validity.
    let pkg = sub.package;
    const reqPackageId = req.body?.packageId ? String(req.body.packageId) : '';
    if (reqPackageId) {
      const chosen = await prisma.package.findFirst({ where: { id: reqPackageId, tenantId } });
      if (!chosen) return sendError(res, 'Package not found', 404);
      pkg = chosen;
    }

    // A manually-entered amount means this is NOT a package renewal (installation, equipment, a
    // support call-out...). It must carry a reason, and it must not silently renew anything.
    const notes = String(req.body?.notes || '').trim();
    const isOther = !reqPackageId && !!notes;
    if (isOther) pkg = null;

    const amount = Number(req.body?.amount ?? pkg?.price ?? 0);
    if (!amount || amount <= 0) {
      return sendError(res, pkg ? 'Package price is zero — enter an amount' : 'This subscriber has no package — enter an amount', 400);
    }
    if (!reqPackageId && !pkg && !notes) {
      return sendError(res, 'Enter a reason for this payment', 400);
    }

    const { decryptDarajaCreds, centralDarajaCreds, stkPush, normalizePhone, normalizeBackendUrl } = await import('../utils/daraja');

    const cfg = await prisma.paymentConfig.findUnique({ where: { tenantId } });
    if (!cfg) return sendError(res, 'Payments are not set up yet — configure them in Settings', 400);

    // Same collecting-credential rules as the subscriber portal, so money lands identically
    // whether the customer renews themselves or the tenant prompts them.
    let creds: ReturnType<typeof decryptDarajaCreds> = null;
    let collectedVia: 'TENANT' | 'DARTBIT' = 'TENANT';
    if (cfg.method === 'DARAJA_API') {
      creds = decryptDarajaCreds(cfg); collectedVia = 'TENANT';
      if (!creds) return sendError(res, 'Payment credentials are incomplete', 400);
    } else if (cfg.method === 'TILL_MANUAL' || cfg.method === 'PHONE_MANUAL') {
      creds = centralDarajaCreds(); collectedVia = 'DARTBIT';
      if (!creds) return sendError(res, 'Central payment service unavailable', 503);
    } else {
      return sendError(res, 'This payment method does not support prompting', 400);
    }

    // 0 for non-package payments so provisioning knows not to extend the subscription.
    const durationMinutes = isOther ? 0 : (pkg?.validityMinutes || 60);
    const platformFee = collectedVia === 'DARTBIT' ? Math.ceil(amount * 0.01) : 0;
    const netToTenant = collectedVia === 'DARTBIT' ? Math.max(0, amount - platformFee) : amount;

    let routerId: string | null = sub.routerId || null;
    if (!routerId) {
      const firstRouter = await prisma.mikrotikRouter.findFirst({ where: { tenantId }, select: { id: true } });
      routerId = firstRouter?.id || null;
    }

    // Bound to the subscriber, so provisionFromTransaction credits THIS account on success
    // (and unjails a lapsed PPPoE session) regardless of which phone actually pays.
    const tx = await prisma.mpesaTransaction.create({
      data: {
        tenantId, routerId, packageId: pkg?.id || null,
        phone: normalizePhone(phoneRaw), amount, status: 'PENDING',
        durationMinutes, collectedVia, platformFee, netToTenant,
        subscriberId: sub.id, username: sub.username,
        notes: notes || null,
      } as never,
    });

    try {
      const result = await stkPush({
        creds, phone: phoneRaw, amount,
        accountRef: sub.username || 'Dartbit', description: 'Subscription',
        callbackUrl: `${normalizeBackendUrl()}/hotspot/stk-callback/${tx.id}`,
      });
      await prisma.mpesaTransaction.update({
        where: { id: tx.id },
        data: { checkoutRequestId: result.checkoutRequestId, merchantRequestId: result.merchantRequestId },
      });
      sendSuccess(res, { transactionId: tx.id, phone: phoneRaw, amount, message: `Payment request sent to ${phoneRaw}` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'STK failed';
      await prisma.mpesaTransaction.update({ where: { id: tx.id }, data: { status: 'FAILED', resultDesc: msg } });
      sendError(res, msg, 502);
    }
  } catch (err) {
    console.error('payments/prompt error:', err);
    sendError(res, err instanceof Error ? err.message : 'Failed to send payment request', 500);
  }
});

// GET /payments/prompt-status/:txId — poll the outcome of a prompt.
router.get('/prompt-status/:txId', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const tx = await prisma.mpesaTransaction.findUnique({
      where: { id: req.params.txId },
      select: { status: true, tenantId: true, resultDesc: true, mpesaReceipt: true, amount: true },
    });
    if (!tx || (tenantId && tx.tenantId !== tenantId)) return sendError(res, 'Not found', 404);
    sendSuccess(res, { status: tx.status, message: tx.resultDesc, receipt: tx.mpesaReceipt, amount: tx.amount });
  } catch {
    sendError(res, 'Failed', 500);
  }
});

export default router;
