import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { encrypt, mask, decrypt } from '../utils/crypto';

const router = Router();
router.use(authenticate);

function requireTenantAdmin(req: AuthRequest, res: Response): boolean {
  const role = req.user?.role;
  if (role !== 'TENANT_ADMIN' && role !== 'SUPERADMIN') {
    sendError(res, 'Only admins can change payment settings', 403);
    return false;
  }
  return true;
}

// GET /payment-config — returns the tenant's payment method + non-sensitive fields,
// with secrets masked (never returns raw credentials).
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const cfg = await prisma.paymentConfig.findUnique({ where: { tenantId } });
    if (!cfg) {
      return sendSuccess(res, { method: 'TILL_MANUAL', configured: false });
    }
    sendSuccess(res, {
      method: cfg.method,
      configured: cfg.configured,
      payoutTill: cfg.payoutTill,
      payoutPhone: cfg.payoutPhone,
      payoutCadence: cfg.payoutCadence ?? 'INSTANT',
      payoutEnabled: cfg.payoutEnabled ?? false,
      darajaShortcode: cfg.darajaShortcode,
      darajaType: cfg.darajaType,
      // secrets masked
      darajaConsumerKey: mask(cfg.darajaConsumerKey ? decrypt(cfg.darajaConsumerKey) : ''),
      darajaConsumerSecret: mask(cfg.darajaConsumerSecret ? decrypt(cfg.darajaConsumerSecret) : ''),
      darajaPasskey: mask(cfg.darajaPasskey ? decrypt(cfg.darajaPasskey) : ''),
      kopoTillNumber: cfg.kopoTillNumber,
      kopoClientId: mask(cfg.kopoClientId ? decrypt(cfg.kopoClientId) : ''),
      kopoClientSecret: mask(cfg.kopoClientSecret ? decrypt(cfg.kopoClientSecret) : ''),
      kopoApiKey: mask(cfg.kopoApiKey ? decrypt(cfg.kopoApiKey) : ''),
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

const schema = z.object({
  method: z.enum(['TILL_MANUAL', 'PHONE_MANUAL', 'DARAJA_API', 'KOPOKOPO_API']),
  payoutTill: z.string().optional(),
  payoutPhone: z.string().optional(),
  payoutCadence: z.enum(['INSTANT', 'MIN15', 'MIN30', 'HOURLY']).optional(),
  payoutEnabled: z.boolean().optional(),
  darajaShortcode: z.string().optional(),
  darajaType: z.enum(['TILL', 'PAYBILL']).optional(),
  darajaConsumerKey: z.string().optional(),
  darajaConsumerSecret: z.string().optional(),
  darajaPasskey: z.string().optional(),
  kopoTillNumber: z.string().optional(),
  kopoClientId: z.string().optional(),
  kopoClientSecret: z.string().optional(),
  kopoApiKey: z.string().optional(),
});

// PUT /payment-config — set method + credentials. Secrets are encrypted before storage.
// A masked value (starts with ••••) means "unchanged" — we keep the existing encrypted value.
router.put('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!requireTenantAdmin(req, res)) return;
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.errors[0].message, 400);
    const d = parsed.data;

    const existing = await prisma.paymentConfig.findUnique({ where: { tenantId } });

    // Helper: if incoming value is masked/empty, keep existing; else encrypt the new value.
    const enc = (incoming: string | undefined, current: string | null | undefined): string | null => {
      if (incoming === undefined || incoming === '') return current ?? null;
      if (incoming.startsWith('••••')) return current ?? null;
      return encrypt(incoming);
    };

    // Validate required fields per method
    if (d.method === 'TILL_MANUAL' && !d.payoutTill) return sendError(res, 'Payout till is required', 400);
    if (d.method === 'PHONE_MANUAL' && !d.payoutPhone) return sendError(res, 'Payout phone is required', 400);
    if (d.method === 'DARAJA_API') {
      if (!d.darajaShortcode) return sendError(res, 'Shortcode is required', 400);
      const hasKey = d.darajaConsumerKey || existing?.darajaConsumerKey;
      if (!hasKey) return sendError(res, 'Daraja consumer key is required', 400);
    }
    if (d.method === 'KOPOKOPO_API') {
      const hasId = d.kopoClientId || existing?.kopoClientId;
      if (!hasId) return sendError(res, 'KopoKopo client ID is required', 400);
    }

    const data = {
      method: d.method,
      payoutTill: d.payoutTill ?? existing?.payoutTill ?? null,
      payoutPhone: d.payoutPhone ?? existing?.payoutPhone ?? null,
      darajaShortcode: d.darajaShortcode ?? existing?.darajaShortcode ?? null,
      darajaType: d.darajaType ?? existing?.darajaType ?? null,
      darajaConsumerKey: enc(d.darajaConsumerKey, existing?.darajaConsumerKey),
      darajaConsumerSecret: enc(d.darajaConsumerSecret, existing?.darajaConsumerSecret),
      darajaPasskey: enc(d.darajaPasskey, existing?.darajaPasskey),
      kopoTillNumber: d.kopoTillNumber ?? existing?.kopoTillNumber ?? null,
      kopoClientId: enc(d.kopoClientId, existing?.kopoClientId),
      kopoClientSecret: enc(d.kopoClientSecret, existing?.kopoClientSecret),
      kopoApiKey: enc(d.kopoApiKey, existing?.kopoApiKey),
      configured: true,
    };

    const cfg = await prisma.paymentConfig.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
    });

    // Write the disbursement-cadence columns via raw SQL so this works even if the Prisma client
    // wasn't regenerated on deploy. Only applies to pooled manual methods.
    if (d.payoutCadence !== undefined || d.payoutEnabled !== undefined) {
      await prisma.$executeRawUnsafe(
        `UPDATE "PaymentConfig" SET "payoutCadence"=COALESCE($1,"payoutCadence"), "payoutEnabled"=COALESCE($2,"payoutEnabled") WHERE "tenantId"=$3`,
        d.payoutCadence ?? null, d.payoutEnabled ?? null, tenantId,
      );
    }

    sendSuccess(res, { method: cfg.method, configured: cfg.configured });
  } catch (err) {
    console.error('payment-config error:', err);
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export default router;
