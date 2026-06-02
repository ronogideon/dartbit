import { Router, Response } from 'express';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { initializeTransaction, verifyTransaction, isPaystackConfigured } from '../utils/paystack';
import { recordExpense } from './expenses';

const router = Router();
const MIN_FEE = 500;            // KES floor
const PPPOE_RATE = 20;          // KES per active PPPoE user
const HOTSPOT_RATE = 0.03;      // 3% of hotspot income

export interface BillingBreakdown {
  pppoeCount: number;
  pppoeCharge: number;
  hotspotIncome: number;
  hotspotCharge: number;
  computed: number;     // pppoeCharge + hotspotCharge
  appliedCharge: number; // max(MIN_FEE, computed)
  minFee: number;
  periodStart: Date;
  periodEnd: Date;
}

// Compute the bill for a tenant over a given month (defaults to current calendar month).
export async function computeTenantBill(tenantId: string, monthStart?: Date): Promise<BillingBreakdown> {
  const now = new Date();
  const periodStart = monthStart ?? new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 1);

  // Active PPPoE customers seen online at any point during the month.
  // We use SessionRecord (any session that started in the period) UNION subscribers
  // whose lastOnlineAt falls in the period, to be robust.
  const pppoeSubs = await prisma.subscriber.findMany({
    where: { tenantId, service: 'PPPOE' },
    select: { id: true, lastOnlineAt: true },
  });
  const pppoeIds = pppoeSubs.map(s => s.id);

  // Distinct PPPoE subscribers with a session in the period
  const sessionSubs = await prisma.sessionRecord.findMany({
    where: {
      tenantId,
      service: 'PPPOE',
      subscriberId: { in: pppoeIds.length ? pppoeIds : ['__none__'] },
      startedAt: { gte: periodStart, lt: periodEnd },
    },
    select: { subscriberId: true },
    distinct: ['subscriberId'],
  });
  const activeFromSessions = new Set(sessionSubs.map(s => s.subscriberId).filter(Boolean) as string[]);
  // Also count subs whose lastOnlineAt is in the period (covers sessions that predate tracking)
  for (const s of pppoeSubs) {
    if (s.lastOnlineAt && s.lastOnlineAt >= periodStart && s.lastOnlineAt < periodEnd) {
      activeFromSessions.add(s.id);
    }
  }
  const pppoeCount = activeFromSessions.size;
  const pppoeCharge = pppoeCount * PPPOE_RATE;

  // Hotspot income = voucher sales + portal purchases recorded in the period.
  // Vouchers that were used in the period, valued at their package price.
  const usedVouchers = await prisma.voucher.findMany({
    where: { tenantId, isUsed: true, usedAt: { gte: periodStart, lt: periodEnd } },
    include: { package: true },
  });
  let hotspotIncome = 0;
  for (const v of usedVouchers) {
    hotspotIncome += v.package?.price ?? 0;
  }
  const hotspotCharge = hotspotIncome * HOTSPOT_RATE;

  const computed = pppoeCharge + hotspotCharge;
  const appliedCharge = Math.max(MIN_FEE, computed);

  return {
    pppoeCount, pppoeCharge,
    hotspotIncome, hotspotCharge,
    computed, appliedCharge, minFee: MIN_FEE,
    periodStart, periodEnd,
  };
}

// GET /billing/current — current invoice (computed live) + breakdown + status
router.get('/current', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return sendError(res, 'Tenant not found', 404);

    const breakdown = await computeTenantBill(tenantId);

    // Is there an unpaid invoice already issued?
    const pending = await prisma.tenantPayment.findFirst({
      where: { tenantId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });

    // Payment window: open within 5 days before due date, or anytime once overdue.
    // If no due date yet (fresh/trial), allow payment to start the first cycle.
    const now = Date.now();
    const FIVE_DAYS = 5 * 24 * 60 * 60 * 1000;
    let canPayNow = true;
    let windowOpensAt: Date | null = null;
    if (tenant.billingDueDate) {
      const due = tenant.billingDueDate.getTime();
      windowOpensAt = new Date(due - FIVE_DAYS);
      canPayNow = now >= due - FIVE_DAYS;
    }

    sendSuccess(res, {
      tenant: {
        name: tenant.name,
        status: tenant.status,
        trialEndsAt: tenant.trialEndsAt,
        billingDueDate: tenant.billingDueDate,
        billingStatus: tenant.billingStatus,
      },
      breakdown,
      pendingInvoice: pending,
      canPayNow,
      windowOpensAt,
    });
  } catch (err) {
    console.error('billing/current error:', err);
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /billing/history — past tenant payments
router.get('/history', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const payments = await prisma.tenantPayment.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    sendSuccess(res, payments);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /billing/checkout — create a pending invoice + initialize Paystack, return checkout URL.
router.post('/checkout', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.userId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    if (!isPaystackConfigured()) return sendError(res, 'Payments are not configured. Contact support.', 503);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return sendError(res, 'Tenant not found', 404);

    // Payment window: only allow paying within 5 days before the due date (or once overdue).
    // This prevents paying months in advance and keeps the cycle predictable.
    if (tenant.billingDueDate) {
      const now = Date.now();
      const due = tenant.billingDueDate.getTime();
      const FIVE_DAYS = 5 * 24 * 60 * 60 * 1000;
      const windowOpens = due - FIVE_DAYS;
      if (now < windowOpens) {
        const opensDate = new Date(windowOpens);
        return sendError(
          res,
          `Payment opens 5 days before your due date (from ${opensDate.toDateString()}).`,
          400
        );
      }
    }

    const user = userId ? await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }) : null;
    const userEmail = user?.email;

    const breakdown = await computeTenantBill(tenantId);
    const amount = breakdown.appliedCharge;

    // Reuse an existing pending invoice if present, else create one.
    let invoice = await prisma.tenantPayment.findFirst({
      where: { tenantId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const dueDate = tenant.billingDueDate ?? periodEnd;

    if (!invoice) {
      invoice = await prisma.tenantPayment.create({
        data: {
          tenantId, amount, status: 'PENDING',
          periodStart: breakdown.periodStart, periodEnd: breakdown.periodEnd,
          dueDate,
          pppoeCount: breakdown.pppoeCount, pppoeCharge: breakdown.pppoeCharge,
          hotspotIncome: breakdown.hotspotIncome, hotspotCharge: breakdown.hotspotCharge,
        },
      });
    } else {
      // Refresh the amount/breakdown in case usage changed
      invoice = await prisma.tenantPayment.update({
        where: { id: invoice.id },
        data: {
          amount,
          pppoeCount: breakdown.pppoeCount, pppoeCharge: breakdown.pppoeCharge,
          hotspotIncome: breakdown.hotspotIncome, hotspotCharge: breakdown.hotspotCharge,
        },
      });
    }

    // Unique Paystack reference tied to this invoice
    const reference = `dartbit_${invoice.id}_${Date.now()}`;
    const frontendUrl = process.env.FRONTEND_URL || 'https://accomplished-patience-production-dd5a.up.railway.app';
    const callbackUrl = `${frontendUrl}/settings?tab=billing&verify=${reference}`;

    const { authorizationUrl } = await initializeTransaction({
      email: userEmail || `billing+${tenantId}@dartbit.local`,
      amountKES: amount,
      reference,
      callbackUrl,
      metadata: { tenantId, invoiceId: invoice.id },
    });

    await prisma.tenantPayment.update({
      where: { id: invoice.id },
      data: { paystackRef: reference, paystackUrl: authorizationUrl },
    });

    sendSuccess(res, { authorizationUrl, reference, amount });
  } catch (err) {
    console.error('billing/checkout error:', err);
    sendError(res, err instanceof Error ? err.message : 'Checkout failed', 500);
  }
});

// GET /billing/verify/:reference — verify a transaction after the user returns from Paystack.
// On success: mark invoice PAID, advance due date by one month, set tenant CURRENT/PAID.
router.get('/verify/:reference', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const reference = req.params.reference;

    const invoice = await prisma.tenantPayment.findUnique({ where: { paystackRef: reference } });
    if (!invoice || invoice.tenantId !== tenantId) return sendError(res, 'Invoice not found', 404);

    if (invoice.status === 'PAID') {
      return sendSuccess(res, { status: 'PAID', alreadyPaid: true });
    }

    const result = await verifyTransaction(reference);
    if (!result.success) {
      return sendSuccess(res, { status: result.status, paid: false });
    }

    await markInvoicePaid(invoice.id, tenantId, invoice.dueDate);
    sendSuccess(res, { status: 'PAID', paid: true });
  } catch (err) {
    console.error('billing/verify error:', err);
    sendError(res, err instanceof Error ? err.message : 'Verify failed', 500);
  }
});

// Shared: mark an invoice paid and advance the tenant's billing cycle.
// Next due date = 30 days from the payment date (now). Also moves the tenant off
// TRIAL (so the trial banner disappears) and clears trialEndsAt.
async function markInvoicePaid(invoiceId: string, tenantId: string, _currentDue: Date) {
  const paidAt = new Date();
  const nextDue = new Date(paidAt.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days from payment

  await prisma.$transaction([
    prisma.tenantPayment.update({
      where: { id: invoiceId },
      data: { status: 'PAID', paidAt },
    }),
    prisma.tenant.update({
      where: { id: tenantId },
      data: {
        billingStatus: 'PAID',
        billingDueDate: nextDue,
        status: 'ACTIVE',     // off the trial — trial banner will stop showing
        trialEndsAt: null,    // clear trial end so TrialBanner returns null
      },
    }),
  ]);

  // Record the tenancy payment as a tenant expense (TENANCY category).
  try {
    const inv = await prisma.tenantPayment.findUnique({ where: { id: invoiceId }, select: { amount: true, paystackRef: true } });
    if (inv) {
      await recordExpense({
        tenantId,
        amount: inv.amount,
        category: 'TENANCY',
        description: 'Dartbit subscription',
        paymentMode: 'Card',
        reference: inv.paystackRef || invoiceId,
        source: 'AUTO',
      });
    }
  } catch (e) {
    console.error('[expense] tenancy record failed:', e instanceof Error ? e.message : e);
  }
}

export { markInvoicePaid };

export default router;
