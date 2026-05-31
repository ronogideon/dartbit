// Per-tenant notification settings + SMS balance/topup + test send.
import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest, requireTenantAdmin } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { dartbitDefaultCreds, decryptApiKey, encryptApiKey, getSmsBalance, topupSms, normalizeKenyanPhone } from '../utils/blessedtexts';
import { resolveSmsCreds, sendNotification } from '../utils/notifications';
import { getWalletBalance, getSmsRate } from '../utils/smsWallet';
import { centralDarajaCreds, stkPush, normalizeBackendUrl } from '../utils/daraja';
import { mask } from '../utils/crypto';
import { allTemplatesWithDefaults, defaultTemplate } from '../utils/messageTemplates';

const router = Router();
router.use(authenticate);

// Default reminder offsets in minutes: 5 days (7200), 3 days (4320), 4 hours (240).
const DEFAULT_OFFSETS = [7200, 4320, 240];

const configSchema = z.object({
  gateway: z.enum(['DARTBIT', 'CUSTOM']).default('DARTBIT'),
  apiKey: z.string().optional().nullable(),   // only used when gateway=CUSTOM. Plain text from UI.
  senderId: z.string().optional().nullable(),
  sendWelcome: z.boolean().default(true),
  sendPaymentReceipt: z.boolean().default(true),
  sendExpiryReminders: z.boolean().default(true),
  reminderOffsets: z.array(z.number().int().min(1).max(60 * 24 * 30)).max(8).optional(),
  // Editable templates: map of templateKey -> body. Blank/absent => default used.
  templates: z.record(z.string(), z.string()).optional(),
  // System alerts
  alertPhones: z.array(z.string()).max(10).optional(),
  routerOfflineAlert: z.boolean().optional(),
  lowBalanceAlert: z.boolean().optional(),
  lowBalanceThreshold: z.number().min(0).max(100000).optional(),
});

// GET /notifications/config — returns the tenant's settings (with apiKey masked).
router.get('/config', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const tenantRow = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { phone: true } });
    const signupPhone = tenantRow?.phone || null;
    const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId } });
    if (!cfg) {
      // Return the defaults so the UI can render even before save.
      return sendSuccess(res, {
        gateway: 'DARTBIT', apiKey: null, apiKeyMasked: null, senderId: null,
        sendWelcome: true, sendPaymentReceipt: true, sendExpiryReminders: true,
        reminderOffsets: DEFAULT_OFFSETS,
        templates: allTemplatesWithDefaults(null),
        alertPhones: [], routerOfflineAlert: true, lowBalanceAlert: true, lowBalanceThreshold: 50,
        signupPhone,
        dartbitAvailable: !!dartbitDefaultCreds(),
      });
    }
    sendSuccess(res, {
      gateway: cfg.gateway,
      apiKey: null,                                   // never return the plain key
      apiKeyMasked: cfg.apiKey ? mask(decryptApiKey(cfg.apiKey)) : null,
      senderId: cfg.senderId,
      sendWelcome: cfg.sendWelcome,
      sendPaymentReceipt: cfg.sendPaymentReceipt,
      sendExpiryReminders: cfg.sendExpiryReminders,
      reminderOffsets: cfg.reminderOffsets?.length ? cfg.reminderOffsets : DEFAULT_OFFSETS,
      templates: allTemplatesWithDefaults((cfg.templates as Record<string, string> | null) || null),
      alertPhones: cfg.alertPhones || [],
      routerOfflineAlert: cfg.routerOfflineAlert,
      lowBalanceAlert: cfg.lowBalanceAlert,
      lowBalanceThreshold: cfg.lowBalanceThreshold,
      signupPhone,
      dartbitAvailable: !!dartbitDefaultCreds(),
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// PUT /notifications/config — save settings. Requires tenant admin.
router.put('/config', requireTenantAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);
    const d = parsed.data;

    if (d.gateway === 'CUSTOM' && (!d.apiKey || !d.senderId)) {
      // Allow saving without re-entering apiKey if one is already stored.
      const existing = await prisma.notificationConfig.findUnique({ where: { tenantId } });
      if (!existing?.apiKey && !d.apiKey) return sendError(res, 'apiKey required for CUSTOM gateway', 400);
      if (!d.senderId && !existing?.senderId) return sendError(res, 'senderId required for CUSTOM gateway', 400);
    }

    // Only persist template entries that differ from the built-in default (and are non-empty),
    // so defaults stay dynamic. An empty string means "revert to default".
    let templatesToStore: Record<string, string> | undefined;
    if (d.templates) {
      templatesToStore = {};
      for (const [k, v] of Object.entries(d.templates)) {
        if (v && v.trim() && v.trim() !== defaultTemplate(k)) templatesToStore[k] = v.trim();
      }
    }

    const updateData: Record<string, unknown> = {
      gateway: d.gateway,
      sendWelcome: d.sendWelcome,
      sendPaymentReceipt: d.sendPaymentReceipt,
      sendExpiryReminders: d.sendExpiryReminders,
      reminderOffsets: d.reminderOffsets || DEFAULT_OFFSETS,
    };
    if (templatesToStore !== undefined) updateData.templates = templatesToStore;
    if (d.alertPhones !== undefined) updateData.alertPhones = d.alertPhones.filter(p => p && p.trim());
    if (d.routerOfflineAlert !== undefined) updateData.routerOfflineAlert = d.routerOfflineAlert;
    if (d.lowBalanceAlert !== undefined) updateData.lowBalanceAlert = d.lowBalanceAlert;
    if (d.lowBalanceThreshold !== undefined) updateData.lowBalanceThreshold = d.lowBalanceThreshold;
    if (d.gateway === 'CUSTOM') {
      if (d.apiKey) updateData.apiKey = encryptApiKey(d.apiKey);
      if (d.senderId) updateData.senderId = d.senderId;
    } else {
      // Switching back to DARTBIT — clear stored custom creds.
      updateData.apiKey = null;
      updateData.senderId = null;
    }

    const cfg = await prisma.notificationConfig.upsert({
      where: { tenantId },
      create: {
        tenantId,
        gateway: d.gateway,
        apiKey: d.gateway === 'CUSTOM' && d.apiKey ? encryptApiKey(d.apiKey) : null,
        senderId: d.gateway === 'CUSTOM' ? d.senderId || null : null,
        sendWelcome: d.sendWelcome,
        sendPaymentReceipt: d.sendPaymentReceipt,
        sendExpiryReminders: d.sendExpiryReminders,
        reminderOffsets: d.reminderOffsets || DEFAULT_OFFSETS,
        templates: templatesToStore || undefined,
        alertPhones: d.alertPhones?.filter(p => p && p.trim()) || [],
        routerOfflineAlert: d.routerOfflineAlert ?? true,
        lowBalanceAlert: d.lowBalanceAlert ?? true,
        lowBalanceThreshold: d.lowBalanceThreshold ?? 50,
      },
      update: updateData,
    });
    sendSuccess(res, {
      gateway: cfg.gateway,
      apiKeyMasked: cfg.apiKey ? mask(decryptApiKey(cfg.apiKey)) : null,
      senderId: cfg.senderId,
      sendWelcome: cfg.sendWelcome,
      sendPaymentReceipt: cfg.sendPaymentReceipt,
      sendExpiryReminders: cfg.sendExpiryReminders,
      reminderOffsets: cfg.reminderOffsets,
      templates: allTemplatesWithDefaults((cfg.templates as Record<string, string> | null) || null),
      alertPhones: cfg.alertPhones || [],
      routerOfflineAlert: cfg.routerOfflineAlert,
      lowBalanceAlert: cfg.lowBalanceAlert,
      lowBalanceThreshold: cfg.lowBalanceThreshold,
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /notifications/balance — fetch live SMS credit balance from the active gateway.
// GET /notifications/balance — returns the tenant's prepaid SMS wallet (for Dartbit gateway)
// or their own gateway's credit balance (for CUSTOM gateway).
router.get('/balance', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId }, select: { gateway: true } });
    const usesDartbit = !cfg || cfg.gateway === 'DARTBIT';

    if (usesDartbit) {
      // Prepaid wallet model: balance in KES + how many SMS that buys at the current rate.
      const [walletBal, rate] = await Promise.all([getWalletBalance(tenantId), getSmsRate()]);
      const smsRemaining = rate > 0 ? Math.floor(walletBal / rate) : 0;
      return sendSuccess(res, { mode: 'WALLET', balanceKES: walletBal, rate, smsRemaining, balance: smsRemaining });
    }
    // CUSTOM gateway: show the tenant's own provider balance.
    const creds = await resolveSmsCreds(tenantId);
    if (!creds) return sendError(res, 'No SMS gateway configured', 400);
    const result = await getSmsBalance({ apiKey: creds.apiKey });
    sendSuccess(res, { mode: 'CUSTOM', balance: result.balance, ok: result.ok });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /notifications/wallet/ledger — recent wallet transactions.
router.get('/wallet/ledger', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const txns = await prisma.smsWalletTxn.findMany({
      where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 100,
    });
    sendSuccess(res, txns);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /notifications/topup — start an M-Pesa STK push to Dartbit to top up the SMS wallet.
// Body: { amount: number (KES), phone: string }. Wallet is credited on the STK callback.
router.post('/topup', requireTenantAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const amount = Math.round(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount < 1) return sendError(res, 'amount must be >= 1', 400);
    const phone = normalizeKenyanPhone(String(req.body?.phone || ''));
    if (!phone) return sendError(res, 'A valid M-Pesa phone number is required', 400);

    // Use Dartbit's central Daraja to collect the top-up.
    const creds = centralDarajaCreds();
    if (!creds) return sendError(res, 'SMS top-up is not available right now (gateway not configured)', 503);

    // Create a pending MpesaTransaction tagged as an SMS top-up.
    const tx = await prisma.mpesaTransaction.create({
      data: {
        tenantId, amount, phone, status: 'PENDING',
        purpose: 'SMS_TOPUP', collectedVia: 'DARTBIT', durationMinutes: 0,
      },
    });

    const backendUrl = normalizeBackendUrl();
    const result = await stkPush({
      creds,
      phone,
      amount,
      accountRef: 'SMS Wallet',
      description: 'Dartbit SMS top-up',
      callbackUrl: `${backendUrl}/hotspot/stk-callback/${tx.id}`,
    });
    await prisma.mpesaTransaction.update({
      where: { id: tx.id },
      data: { checkoutRequestId: result.checkoutRequestId, merchantRequestId: result.merchantRequestId },
    });
    sendSuccess(res, { transactionId: tx.id, checkoutRequestId: result.checkoutRequestId, message: 'Check your phone for the M-Pesa prompt' });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Top-up failed', 500);
  }
});

// GET /notifications/topup-status/:txId — poll whether the wallet top-up completed.
router.get('/topup-status/:txId', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const tx = await prisma.mpesaTransaction.findUnique({ where: { id: req.params.txId }, select: { status: true, tenantId: true, amount: true } });
    if (!tx || tx.tenantId !== tenantId) return sendError(res, 'Not found', 404);
    sendSuccess(res, { status: tx.status, amount: tx.amount });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /notifications/test — send a one-off SMS to the given number, using current settings.
router.post('/test', requireTenantAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const phone = String(req.body?.phone || '');
    const message = String(req.body?.message || 'Test SMS from Dartbit');
    if (!phone) return sendError(res, 'phone required', 400);
    const result = await sendNotification({ tenantId, phone, body: message, category: 'MANUAL' });
    if (!result.ok) return sendError(res, result.reason || 'Send failed', 400);
    sendSuccess(res, { messageId: result.messageId, cost: result.cost });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export default router;
