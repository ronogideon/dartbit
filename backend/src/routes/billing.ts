import { Router, Response } from 'express';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

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

export default router;
