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

    const payment = await prisma.payment.create({
      data: { ...parsed.data, source: 'MANUAL', packageId: subscriber.packageId || null, tenantId },
    });

    // Extend expiry automatically if subscriber has a package
    if (subscriber.package) {
      const now = new Date();
      const currentExpiry = subscriber.expiresAt && subscriber.expiresAt > now
        ? subscriber.expiresAt
        : now;
      const newExpiry = new Date(currentExpiry.getTime() + subscriber.package.validityMinutes * 60 * 1000);

      await prisma.subscriber.update({
        where: { id: subscriber.id },
        data: { expiresAt: newExpiry, isActive: true },
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

    const pkg = sub.package;
    const amount = Number(req.body?.amount ?? pkg?.price ?? 0);
    if (!amount || amount <= 0) {
      return sendError(res, pkg ? 'Package price is zero — enter an amount' : 'This subscriber has no package — enter an amount', 400);
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

    const durationMinutes = pkg?.validityMinutes || 60;
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
      } as never,
    });

    try {
      const result = await stkPush({
        creds, phone: phoneRaw, amount,
        accountRef: 'Dartbit', description: 'Subscription',
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
