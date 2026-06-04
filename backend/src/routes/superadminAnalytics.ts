import { Router, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest, requireSuperAdmin, requireSuperAdminRead } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { getSmsBalance } from '../utils/blessedtexts';
import { getSmsRate, setSmsRate } from '../utils/smsWallet';

const router = Router();
router.use(authenticate);

function genTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const b = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += chars[b[i] % chars.length];
  return `Sa-${s}`;
}

// ===== ANALYTICS (read — full + viewer superadmins) =====

// GET /superadmin/overview — high-level platform metrics
router.get('/overview', requireSuperAdminRead, async (_req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [tenantCount, activeTenants, subscriberCount, routerCount,
           trialTenants, overdueTenants, dueSoonTenants, suspendedTenants,
           renewedTenants] = await Promise.all([
      prisma.tenant.count(),
      prisma.tenant.count({ where: { status: 'ACTIVE' } }),
      prisma.subscriber.count(),
      prisma.mikrotikRouter.count(),
      prisma.tenant.count({ where: { status: 'TRIAL' } }),
      prisma.tenant.count({ where: { billingStatus: 'OVERDUE' } }),
      prisma.tenant.count({ where: { billingStatus: 'DUE_SOON' } }),
      prisma.tenant.count({ where: { status: 'SUSPENDED' } }),
      // Renewed = tenants whose Dartbit subscription is paid up.
      prisma.tenant.count({ where: { billingStatus: 'PAID' } }),
    ]);
    const notRenewedTenants = Math.max(0, tenantCount - renewedTenants);

    // Dartbit subscription revenue (what tenants pay Dartbit via Paystack)
    const paidPlatform = await prisma.tenantPayment.findMany({
      where: { status: 'PAID' },
      select: { amount: true, paidAt: true },
    });
    const subsRevenueAll = paidPlatform.reduce((s, p) => s + p.amount, 0);
    const subsRevenueMonth = paidPlatform.filter(p => p.paidAt && p.paidAt >= monthStart).reduce((s, p) => s + p.amount, 0);

    // Central-API collection (Dartbit-collected hotspot payments)
    const centralTx = await prisma.mpesaTransaction.findMany({
      where: { collectedVia: 'DARTBIT', status: 'PAID' },
      select: { tenantId: true, amount: true, platformFee: true, netToTenant: true, payoutStatus: true },
    });
    const collectedTotal = centralTx.reduce((s, t) => s + t.amount, 0);
    const feeTotal = centralTx.reduce((s, t) => s + t.platformFee, 0);
    const owedTotal = centralTx.reduce((s, t) => s + t.netToTenant, 0);
    const disbursed = centralTx.filter(t => t.payoutStatus === 'PAID').reduce((s, t) => s + t.netToTenant, 0);
    const pendingPayout = centralTx.filter(t => t.payoutStatus !== 'PAID').reduce((s, t) => s + t.netToTenant, 0);

    // Disbursement record: for each tenant, the NET amount still to be settled to them from
    // central collections (funded by the collected money; Dartbit keeps the 1% fee). Grouped so
    // the superadmin sees exactly who is owed how much.
    const pendingMap = new Map<string, { net: number; fee: number; count: number }>();
    for (const t of centralTx) {
      if (t.payoutStatus === 'PAID') continue;
      const cur = pendingMap.get(t.tenantId) || { net: 0, fee: 0, count: 0 };
      cur.net += t.netToTenant; cur.fee += t.platformFee; cur.count += 1;
      pendingMap.set(t.tenantId, cur);
    }
    const pendingTenantIds = Array.from(pendingMap.keys());
    const pendingTenants = pendingTenantIds.length
      ? await prisma.tenant.findMany({ where: { id: { in: pendingTenantIds } }, select: { id: true, name: true } })
      : [];
    const tenantNameById = new Map(pendingTenants.map(t => [t.id, t.name]));
    const disbursementRecord = pendingTenantIds
      .map(id => ({
        tenantId: id,
        tenantName: tenantNameById.get(id) || 'Unknown',
        amountDue: pendingMap.get(id)!.net,
        feeRetained: pendingMap.get(id)!.fee,
        transactions: pendingMap.get(id)!.count,
      }))
      .sort((a, b) => b.amountDue - a.amountDue);

    // Dartbit shared SMS gateway balance left (live from BlessedTexts). The balance endpoint
    // only needs the API key, so we read it directly rather than via dartbitDefaultCreds()
    // (which also requires a sender ID and would return null if only that is unset).
    let smsBalance: number | null = null;
    let smsBalanceError: string | null = null;
    try {
      const apiKey = process.env.BLESSEDTEXTS_API_KEY;
      if (!apiKey) {
        smsBalanceError = 'BLESSEDTEXTS_API_KEY not set on backend';
      } else {
        const bal = await getSmsBalance({ apiKey });
        if (bal.ok) {
          smsBalance = bal.balance;
        } else {
          smsBalanceError = 'gateway returned non-success';
          console.error('[superadmin] SMS balance fetch not ok:', JSON.stringify(bal.raw));
        }
      }
    } catch (e) {
      smsBalanceError = e instanceof Error ? e.message : 'balance fetch failed';
      console.error('[superadmin] SMS balance error:', smsBalanceError);
    }

    // SMS sent platform-wide via the Dartbit gateway (count + cost), all-time and this month.
    const smsAgg = await prisma.message.aggregate({
      where: { gateway: 'BLESSEDTEXTS', status: { in: ['SENT', 'DELIVERED'] } },
      _count: { _all: true }, _sum: { cost: true },
    });
    const smsMonthAgg = await prisma.message.aggregate({
      where: { gateway: 'BLESSEDTEXTS', status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: monthStart } },
      _count: { _all: true }, _sum: { cost: true },
    });

    // 6-month trend for charts: subscription revenue + central fee income per month.
    const trend: { month: string; subscriptionRevenue: number; feeIncome: number; newTenants: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const mStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const label = mStart.toLocaleString('en-US', { month: 'short' });
      const subRev = paidPlatform.filter(p => p.paidAt && p.paidAt >= mStart && p.paidAt < mEnd).reduce((s, p) => s + p.amount, 0);
      const newT = await prisma.tenant.count({ where: { createdAt: { gte: mStart, lt: mEnd } } });
      trend.push({ month: label, subscriptionRevenue: subRev, feeIncome: 0, newTenants: newT });
    }

    sendSuccess(res, {
      tenants: {
        total: tenantCount, active: activeTenants, trial: trialTenants,
        overdue: overdueTenants, dueSoon: dueSoonTenants, suspended: suspendedTenants,
        renewed: renewedTenants, notRenewed: notRenewedTenants,
      },
      subscribers: subscriberCount,
      routers: routerCount,
      sms: {
        gatewayBalance: smsBalance,
        gatewayBalanceError: smsBalanceError,
        sentAllTime: smsAgg._count._all,
        costAllTime: smsAgg._sum.cost || 0,
        sentThisMonth: smsMonthAgg._count._all,
        costThisMonth: smsMonthAgg._sum.cost || 0,
      },
      subscriptionRevenue: { allTime: subsRevenueAll, thisMonth: subsRevenueMonth },
      centralCollection: {
        collectedTotal,
        feeRetained: feeTotal,
        owedToTenants: owedTotal,
        disbursed,
        pendingPayout,
        leftover: collectedTotal - disbursed - pendingPayout,
      },
      // Total 1% fees Dartbit has retained across all central collections, and the per-tenant
      // record of net amounts still to be settled out of collected funds.
      totalRetainedFees: feeTotal,
      disbursementRecord,
      trend,
    });
  } catch (err) {
    console.error('overview error:', err);
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /superadmin/tenants — all tenants with per-tenant rollups
router.get('/tenants', requireSuperAdminRead, async (_req: AuthRequest, res: Response) => {
  try {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, subdomain: true, status: true,
        billingStatus: true, billingDueDate: true, createdAt: true,
        _count: { select: { subscribers: true, routers: true } },
      },
    });

    // Per-tenant central collection + payout rollups
    const txGroups = await prisma.mpesaTransaction.groupBy({
      by: ['tenantId'],
      where: { collectedVia: 'DARTBIT', status: 'PAID' },
      _sum: { amount: true, netToTenant: true, platformFee: true },
    });
    const txByTenant: Record<string, { collected: number; net: number; fee: number }> = {};
    for (const g of txGroups) {
      txByTenant[g.tenantId] = {
        collected: g._sum.amount || 0,
        net: g._sum.netToTenant || 0,
        fee: g._sum.platformFee || 0,
      };
    }

    // Pending payout per tenant
    const pendingGroups = await prisma.mpesaTransaction.groupBy({
      by: ['tenantId'],
      where: { collectedVia: 'DARTBIT', status: 'PAID', NOT: { payoutStatus: 'PAID' } },
      _sum: { netToTenant: true },
    });
    const pendingByTenant: Record<string, number> = {};
    for (const g of pendingGroups) pendingByTenant[g.tenantId] = g._sum.netToTenant || 0;

    const result = tenants.map(t => ({
      id: t.id, name: t.name, subdomain: t.subdomain, status: t.status,
      billingStatus: t.billingStatus, billingDueDate: t.billingDueDate,
      subscribers: t._count.subscribers, routers: t._count.routers,
      collected: txByTenant[t.id]?.collected || 0,
      owed: txByTenant[t.id]?.net || 0,
      feeFromTenant: txByTenant[t.id]?.fee || 0,
      pendingPayout: pendingByTenant[t.id] || 0,
    }));

    sendSuccess(res, result);
  } catch (err) {
    console.error('superadmin/tenants error:', err);
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /superadmin/payouts — disbursement ledger (recent central transactions)
router.get('/payouts', requireSuperAdminRead, async (_req: AuthRequest, res: Response) => {
  try {
    const txs = await prisma.mpesaTransaction.findMany({
      where: { collectedVia: 'DARTBIT', status: 'PAID' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true, tenantId: true, phone: true, amount: true,
        platformFee: true, netToTenant: true, payoutStatus: true,
        payoutAt: true, mpesaReceipt: true, createdAt: true,
      },
    });
    const tenantNames: Record<string, string> = {};
    const tids = [...new Set(txs.map(t => t.tenantId))];
    const ts = await prisma.tenant.findMany({ where: { id: { in: tids } }, select: { id: true, name: true } });
    for (const t of ts) tenantNames[t.id] = t.name;

    sendSuccess(res, txs.map(t => ({ ...t, tenantName: tenantNames[t.tenantId] || '—' })));
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// ===== TEAM MANAGEMENT (write — full superadmin only) =====

// GET /superadmin/team — list superadmin team members
router.get('/team', requireSuperAdminRead, async (_req: AuthRequest, res: Response) => {
  try {
    const team = await prisma.user.findMany({
      where: { role: { in: ['SUPERADMIN', 'SUPERADMIN_VIEWER'] } },
      select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    sendSuccess(res, team);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

const createSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  role: z.enum(['SUPERADMIN', 'SUPERADMIN_VIEWER']),
});

// POST /superadmin/team — add a team member (full superadmin only)
router.post('/team', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.errors[0].message, 400);
    const { name, email, role } = parsed.data;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return sendError(res, 'A user with that email already exists', 409);

    const tempPassword = genTempPassword();
    const hashed = await bcrypt.hash(tempPassword, 10);
    const user = await prisma.user.create({
      data: { name, email, role, password: hashed, isActive: true, tenantId: null },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
    sendSuccess(res, { user, tempPassword });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

const updateSchema = z.object({
  role: z.enum(['SUPERADMIN', 'SUPERADMIN_VIEWER']).optional(),
  isActive: z.boolean().optional(),
});

// PUT /superadmin/team/:id — change role / active (full superadmin only)
router.put('/team/:id', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || !['SUPERADMIN', 'SUPERADMIN_VIEWER'].includes(target.role)) return sendError(res, 'Not found', 404);
    if (target.id === req.user?.userId) return sendError(res, 'You cannot change your own role or status', 400);

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.errors[0].message, 400);

    const user = await prisma.user.update({
      where: { id: target.id }, data: parsed.data,
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
    sendSuccess(res, user);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /superadmin/team/:id/reset-password
router.post('/team/:id/reset-password', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || !['SUPERADMIN', 'SUPERADMIN_VIEWER'].includes(target.role)) return sendError(res, 'Not found', 404);
    const tempPassword = genTempPassword();
    await prisma.user.update({ where: { id: target.id }, data: { password: await bcrypt.hash(tempPassword, 10) } });
    sendSuccess(res, { tempPassword });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// DELETE /superadmin/team/:id
router.delete('/team/:id', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || !['SUPERADMIN', 'SUPERADMIN_VIEWER'].includes(target.role)) return sendError(res, 'Not found', 404);
    if (target.id === req.user?.userId) return sendError(res, 'You cannot delete yourself', 400);
    await prisma.user.delete({ where: { id: target.id } });
    sendSuccess(res, { ok: true });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /superadmin/sms-rate — current per-SMS charge rate (KES).
router.get('/sms-rate', requireSuperAdminRead, async (_req: AuthRequest, res: Response) => {
  try {
    const rate = await getSmsRate();
    sendSuccess(res, { rate });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// PUT /superadmin/sms-rate — set the per-SMS charge rate. Body: { rate }.
router.put('/sms-rate', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const rate = Number(req.body?.rate);
    if (!Number.isFinite(rate) || rate < 0) return sendError(res, 'rate must be >= 0', 400);
    await setSmsRate(rate);
    sendSuccess(res, { rate });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export default router;
