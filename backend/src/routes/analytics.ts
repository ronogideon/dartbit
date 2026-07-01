// Tenant-facing analytics for the dashboard. Aggregates payments, package popularity/income,
// most-active users (by data), and total data per service type. Supports a period filter:
// day | week | month | year | all.
import { Router, Response } from 'express';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

type Period = 'day' | 'week' | 'month' | 'year' | 'all';

function periodStart(period: Period): Date {
  const now = new Date();
  const d = new Date(now);
  switch (period) {
    case 'day': d.setHours(0, 0, 0, 0); return d;
    case 'week': d.setDate(d.getDate() - 7); return d;
    case 'month': d.setMonth(d.getMonth() - 1); return d;
    case 'year': d.setFullYear(d.getFullYear() - 1); return d;
    case 'all': default: return new Date(0);
  }
}

// Build the time buckets for the payment trend chart, based on the period.
function trendBuckets(period: Period): { label: string; start: Date; end: Date }[] {
  const now = new Date();
  const buckets: { label: string; start: Date; end: Date }[] = [];
  if (period === 'day') {
    // hourly for the last 24h
    for (let i = 23; i >= 0; i--) {
      const end = new Date(now.getTime() - i * 3600 * 1000);
      const start = new Date(end.getTime() - 3600 * 1000);
      buckets.push({ label: `${start.getHours()}:00`, start, end });
    }
  } else if (period === 'week') {
    for (let i = 6; i >= 0; i--) {
      const day = new Date(now); day.setDate(day.getDate() - i); day.setHours(0, 0, 0, 0);
      const end = new Date(day); end.setDate(end.getDate() + 1);
      buckets.push({ label: day.toLocaleDateString('en-US', { weekday: 'short' }), start: day, end });
    }
  } else if (period === 'month') {
    // daily for the last 30 days
    for (let i = 29; i >= 0; i--) {
      const day = new Date(now); day.setDate(day.getDate() - i); day.setHours(0, 0, 0, 0);
      const end = new Date(day); end.setDate(end.getDate() + 1);
      buckets.push({ label: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), start: day, end });
    }
  } else if (period === 'year') {
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({ label: start.toLocaleString('en-US', { month: 'short' }), start, end });
    }
  } else {
    // all — last 12 months
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({ label: start.toLocaleString('en-US', { month: 'short' }), start, end });
    }
  }
  return buckets;
}

router.get('/overview', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const period = (String(req.query.period || 'month') as Period);
    const start = periodStart(period);

    // ---- Payment trend ----
    const payments = await prisma.payment.findMany({
      where: { tenantId, createdAt: { gte: start } },
      select: { amount: true, createdAt: true, packageId: true, subscriber: { select: { service: true } } },
    });
    const buckets = trendBuckets(period);
    const paymentTrend = buckets.map(b => {
      const inB = payments.filter(p => p.createdAt >= b.start && p.createdAt < b.end);
      const total = inB.reduce((s, p) => s + p.amount, 0);
      const hotspot = inB.filter(p => p.subscriber?.service === 'HOTSPOT').reduce((s, p) => s + p.amount, 0);
      // Everything not tied to a HOTSPOT subscriber (PPPoE + manual/no-subscriber) rolls into PPPoE
      // so the two stacks always sum to the bucket total.
      const pppoe = total - hotspot;
      return { label: b.label, amount: total, hotspot, pppoe, count: inB.length };
    });
    const totalRevenue = payments.reduce((s, p) => s + p.amount, 0);

    // ---- Packages: most users + most income ----
    const packages = await prisma.package.findMany({ where: { tenantId }, select: { id: true, name: true, price: true } });
    const pkgName = new Map(packages.map(p => [p.id, p.name]));
    // income per package (from payments in period)
    const incomeByPkg = new Map<string, number>();
    for (const p of payments) {
      if (!p.packageId) continue;
      incomeByPkg.set(p.packageId, (incomeByPkg.get(p.packageId) || 0) + p.amount);
    }
    // user count per package (current subscribers)
    const subsByPkg = await prisma.subscriber.groupBy({
      by: ['packageId'],
      where: { tenantId, packageId: { not: null } },
      _count: { _all: true },
    });
    const topByUsers = subsByPkg
      .map(s => ({ name: pkgName.get(s.packageId as string) || 'Unknown', value: s._count._all }))
      .sort((a, b) => b.value - a.value).slice(0, 6);
    const topByIncome = Array.from(incomeByPkg.entries())
      .map(([id, amount]) => ({ name: pkgName.get(id) || 'Unknown', value: amount }))
      .sort((a, b) => b.value - a.value).slice(0, 6);

    // ---- Most active users by data (rx+tx) in period ----
    const records = await prisma.sessionRecord.findMany({
      where: { tenantId, startedAt: { gte: start } },
      select: { subscriberId: true, username: true, rxBytes: true, txBytes: true, service: true },
    });
    const usageByUser = new Map<string, { username: string; up: number; down: number }>();
    const dataByService: Record<string, number> = { PPPOE: 0, STATIC: 0, HOTSPOT: 0 };
    for (const r of records) {
      // From the router's perspective: rx-byte / bytes-in = data the router RECEIVED from the
      // client = the client's UPLOAD. tx-byte / bytes-out = data the router SENT to the client
      // = the client's DOWNLOAD.
      const up = Number(r.rxBytes);
      const down = Number(r.txBytes);
      dataByService[r.service] = (dataByService[r.service] || 0) + down + up;
      const key = r.subscriberId || r.username;
      const cur = usageByUser.get(key) || { username: r.username, up: 0, down: 0 };
      cur.up += up; cur.down += down;
      usageByUser.set(key, cur);
    }
    const topUsers = Array.from(usageByUser.values())
      .map(u => ({ username: u.username, up: u.up, down: u.down, total: u.up + u.down }))
      .sort((a, b) => b.total - a.total).slice(0, 8);

    sendSuccess(res, {
      period,
      totalRevenue,
      paymentTrend,
      topByUsers,
      topByIncome,
      topUsers,
      dataByService: {
        PPPOE: dataByService.PPPOE || 0,
        STATIC: dataByService.STATIC || 0,
        HOTSPOT: dataByService.HOTSPOT || 0,
      },
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export default router;
