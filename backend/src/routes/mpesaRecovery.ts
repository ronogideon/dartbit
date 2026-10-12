// M-Pesa recovery tools for staff.
//
//   GET  /mpesa-recovery/unconfirmed        payments still waiting for M-Pesa, or confirmed but not yet set up
//   POST /mpesa-recovery/recheck/:txId      ask Safaricom right now what happened to one payment
//   GET  /mpesa-recovery/history-status     can the transaction-history fallback be used for these credentials?
//   POST /mpesa-recovery/history-register   one-time registration of the shortcode for transaction history
//
// The background checker does all of this automatically; these exist so a staff member facing a
// customer who says "I paid" can get an answer immediately, and so the history fallback can be
// switched on.
import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { centralDarajaCreds, decryptDarajaCreds, pullTransactions, pullRegister, normalizeBackendUrl, PullUnavailableError, type DarajaCreds } from '../utils/daraja';
import { probeTransaction, NO_RESPONSE_DESC } from '../utils/mpesaSettle';

const router = Router();
router.use(authenticate);

const isSuper = (req: AuthRequest) => req.user?.role === 'SUPERADMIN';
const isAdmin = (req: AuthRequest) => req.user?.role === 'TENANT_ADMIN' || isSuper(req);

/** The credentials this caller manages: the tenant's own Daraja app, or Dartbit's for a superadmin. */
async function callerCreds(req: AuthRequest): Promise<{ creds: DarajaCreds | null; label: string; reason?: string }> {
  if (isSuper(req)) return { creds: centralDarajaCreds(), label: 'Dartbit central' };
  const tenantId = req.user?.tenantId;
  if (!tenantId) return { creds: null, label: '', reason: 'No tenant' };
  const cfg = await prisma.paymentConfig.findUnique({ where: { tenantId } });
  if (cfg?.method !== 'DARAJA_API') {
    return { creds: null, label: '', reason: 'Payments are collected by Dartbit for your account, so Dartbit manages transaction history.' };
  }
  const creds = decryptDarajaCreds(cfg);
  return creds ? { creds, label: `Shortcode ${creds.shortcode}` } : { creds: null, label: '', reason: 'Your Daraja credentials are incomplete.' };
}

router.get('/unconfirmed', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId && !isSuper(req)) return sendError(res, 'No tenant', 400);
    const since = new Date(Date.now() - 48 * 3600_000);
    const rows = await prisma.mpesaTransaction.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        createdAt: { gt: since },
        OR: [{ status: 'PENDING' }, { status: 'PROCESSING' }, { status: 'FAILED', resultDesc: NO_RESPONSE_DESC }],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, phone: true, amount: true, status: true, resultDesc: true, purpose: true, username: true, mpesaReceipt: true, createdAt: true, checkoutRequestId: true },
    });
    sendSuccess(res, rows.map((row: { checkoutRequestId: string | null } & Record<string, unknown>) => {
      const { checkoutRequestId, ...r } = row;
      return { ...r, canQuery: !!checkoutRequestId };
    }));
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

router.post('/recheck/:txId', async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) return sendError(res, 'Only admins can recheck payments', 403);
    const tx = await prisma.mpesaTransaction.findUnique({ where: { id: req.params.txId }, select: { tenantId: true } });
    if (!tx || (!isSuper(req) && tx.tenantId !== req.user?.tenantId)) return sendError(res, 'Not found', 404);
    const outcome = await probeTransaction(req.params.txId, 'recheck');
    const after = await prisma.mpesaTransaction.findUnique({ where: { id: req.params.txId }, select: { status: true, resultDesc: true, mpesaReceipt: true } });
    sendSuccess(res, { outcome, status: after?.status, message: after?.resultDesc, receipt: after?.mpesaReceipt });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Recheck failed', 500);
  }
});

router.get('/history-status', async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) return sendError(res, 'Not authorized', 403);
    const { creds, label, reason } = await callerCreds(req);
    if (!creds) return sendSuccess(res, { applicable: false, available: false, message: reason });
    try {
      await pullTransactions(creds, new Date(Date.now() - 15 * 60_000), new Date());
      sendSuccess(res, { applicable: true, available: true, label, message: 'Transaction history is working.' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendSuccess(res, {
        applicable: true, available: false, label,
        message: e instanceof PullUnavailableError
          ? `Not available yet: ${msg}. Register the shortcode below, and make sure the Daraja app has the Pull Transactions product enabled.`
          : `Could not reach M-Pesa: ${msg}`,
      });
    }
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

const registerSchema = z.object({ nominatedNumber: z.string().min(9).max(15) });
router.post('/history-register', async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) return sendError(res, 'Not authorized', 403);
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Enter the Safaricom number nominated for this shortcode', 400);
    const { creds, label, reason } = await callerCreds(req);
    if (!creds) return sendError(res, reason || 'No credentials', 400);
    const r = await pullRegister(creds, parsed.data.nominatedNumber, `${normalizeBackendUrl()}/hotspot/pull-callback`);
    console.log(`[mpesa] transaction history registration for ${label}: ${r.code} ${r.message}`);
    if (!r.ok) return sendError(res, `M-Pesa refused the registration: ${r.message}`, 400);
    sendSuccess(res, { registered: true, alreadyRegistered: r.code === '1001', message: r.message });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Registration failed', 500);
  }
});

export default router;
