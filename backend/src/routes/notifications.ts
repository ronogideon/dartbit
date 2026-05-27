// Per-tenant notification settings + SMS balance/topup + test send.
import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest, requireTenantAdmin } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { dartbitDefaultCreds, decryptApiKey, encryptApiKey, getSmsBalance, topupSms, normalizeKenyanPhone } from '../utils/blessedtexts';
import { resolveSmsCreds, sendNotification } from '../utils/notifications';
import { mask } from '../utils/crypto';

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
});

// GET /notifications/config — returns the tenant's settings (with apiKey masked).
router.get('/config', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId } });
    if (!cfg) {
      // Return the defaults so the UI can render even before save.
      return sendSuccess(res, {
        gateway: 'DARTBIT', apiKey: null, apiKeyMasked: null, senderId: null,
        sendWelcome: true, sendPaymentReceipt: true, sendExpiryReminders: true,
        reminderOffsets: DEFAULT_OFFSETS,
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

    const updateData: Record<string, unknown> = {
      gateway: d.gateway,
      sendWelcome: d.sendWelcome,
      sendPaymentReceipt: d.sendPaymentReceipt,
      sendExpiryReminders: d.sendExpiryReminders,
      reminderOffsets: d.reminderOffsets || DEFAULT_OFFSETS,
    };
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
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /notifications/balance — fetch live SMS credit balance from the active gateway.
router.get('/balance', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const creds = await resolveSmsCreds(tenantId);
    if (!creds) return sendError(res, 'No SMS gateway configured', 400);
    const result = await getSmsBalance({ apiKey: creds.apiKey });
    sendSuccess(res, { balance: result.balance, ok: result.ok });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /notifications/topup — start an STK push to refill SMS credit.
// Body: { amount: number, phoneNumber?: string }
router.post('/topup', requireTenantAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount < 1) return sendError(res, 'amount must be >= 1', 400);
    const phoneRaw = req.body?.phoneNumber ? String(req.body.phoneNumber) : undefined;
    const phone = phoneRaw ? (normalizeKenyanPhone(phoneRaw) || undefined) : undefined;

    const creds = await resolveSmsCreds(tenantId);
    if (!creds) return sendError(res, 'No SMS gateway configured', 400);

    const result = await topupSms(creds.apiKey, Math.round(amount), phone);
    if (!result.ok) return sendError(res, result.statusDesc || 'Topup failed', 400);
    sendSuccess(res, { message: result.statusDesc });
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
