// Tenant expense ledger. Auto-recorded expenses (SMS top-ups, tenancy payments) plus manual
// entries. Powers the Expenses tab and the dashboard expense/profit cards.
import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, requireTenantAdmin, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

// Helper used by other modules to auto-record an expense. Best-effort: never throws.
export async function recordExpense(params: {
  tenantId: string;
  amount: number;
  category: 'SMS' | 'TENANCY' | 'OTHER';
  description?: string;
  paymentMode?: string;
  reference?: string;
  source?: 'AUTO' | 'MANUAL';
}): Promise<void> {
  try {
    if (!params.tenantId || !params.amount || params.amount <= 0) return;
    // De-dupe AUTO expenses by reference so a retried callback doesn't double-record.
    if ((params.source || 'AUTO') === 'AUTO' && params.reference) {
      const existing = await prisma.expense.findFirst({
        where: { tenantId: params.tenantId, category: params.category, reference: params.reference },
        select: { id: true },
      });
      if (existing) return;
    }
    await prisma.expense.create({
      data: {
        tenantId: params.tenantId,
        amount: params.amount,
        category: params.category,
        description: params.description || null,
        paymentMode: params.paymentMode || null,
        reference: params.reference || null,
        source: params.source || 'AUTO',
      },
    });
  } catch (e) {
    console.error('[expense] record failed:', e instanceof Error ? e.message : e);
  }
}

// GET /expenses — list this tenant's expenses (most recent first).
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const expenses = await prisma.expense.findMany({
      where: { tenantId },
      orderBy: { incurredAt: 'desc' },
    });
    sendSuccess(res, expenses);
  } catch {
    sendError(res, 'Failed to fetch expenses', 500);
  }
});

// GET /expenses/summary — totals (all-time + this month) and by-category breakdown.
router.get('/summary', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const expenses = await prisma.expense.findMany({
      where: { tenantId },
      select: { amount: true, category: true, incurredAt: true },
    });
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const thisMonth = expenses.filter(e => e.incurredAt >= monthStart).reduce((s, e) => s + e.amount, 0);
    const byCategory: Record<string, number> = {};
    for (const e of expenses) byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;

    // Money earned this month (all payments since the 1st), computed server-side so profit is
    // consistent and can never exceed earnings. Profit = earned this month − expenses this month.
    const monthPayments = await prisma.payment.aggregate({
      where: { tenantId, createdAt: { gte: monthStart } },
      _sum: { amount: true },
    });
    const earnedThisMonth = monthPayments._sum.amount || 0;
    const profitThisMonth = earnedThisMonth - thisMonth;

    sendSuccess(res, { total, thisMonth, byCategory, count: expenses.length, earnedThisMonth, profitThisMonth });
  } catch {
    sendError(res, 'Failed to fetch summary', 500);
  }
});

// POST /expenses — manually add an expense. Tenant-admin only.
const createSchema = z.object({
  amount: z.number().positive('Amount must be greater than 0'),
  description: z.string().max(200).optional(),
  paymentMode: z.string().max(40).optional(),
  reference: z.string().max(80).optional(),
  incurredAt: z.string().datetime().optional(),
});
router.post('/', requireTenantAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.errors[0]?.message || 'Invalid input', 400);
    const d = parsed.data;
    const expense = await prisma.expense.create({
      data: {
        tenantId,
        amount: d.amount,
        category: 'OTHER',
        description: d.description || null,
        paymentMode: d.paymentMode || null,
        reference: d.reference || null,
        source: 'MANUAL',
        incurredAt: d.incurredAt ? new Date(d.incurredAt) : new Date(),
      },
    });
    sendSuccess(res, expense);
  } catch {
    sendError(res, 'Failed to add expense', 500);
  }
});

// DELETE /expenses/:id — remove a manual expense (auto entries are protected). Tenant-admin only.
router.delete('/:id', requireTenantAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const exp = await prisma.expense.findFirst({ where: { id: req.params.id, tenantId } });
    if (!exp) return sendError(res, 'Expense not found', 404);
    if (exp.source === 'AUTO') return sendError(res, 'Automatic expenses cannot be deleted', 400);
    await prisma.expense.delete({ where: { id: exp.id } });
    sendSuccess(res, { deleted: true });
  } catch {
    sendError(res, 'Failed to delete expense', 500);
  }
});

export default router;
