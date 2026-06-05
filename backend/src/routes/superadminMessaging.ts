// Superadmin messaging dashboard: per-tenant SMS units + sent counts, the Dartbit gateway
// balance, and platform-default message templates (the defaults tenants later override).
import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, requireSuperAdmin, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { getDefaultProvider, setDefaultProvider, dartbitCredsFor, balanceViaProvider, type SmsProvider } from '../utils/smsGateway';
import { getSmsRate } from '../utils/smsWallet';
import { allTemplatesForPlatform, codeDefaultTemplate, setPlatformDefaults } from '../utils/messageTemplates';

const router = Router();
router.use(authenticate);

const PLATFORM_TEMPLATE_PREFIX = 'default_template:';

// Load platform-default template overrides from PlatformSetting into the in-memory cache so the
// notification layer uses them as the baseline. Call at boot and after any change.
export async function loadPlatformDefaults() {
  try {
    const settings = await prisma.platformSetting.findMany({ where: { key: { startsWith: PLATFORM_TEMPLATE_PREFIX } } });
    const map: Record<string, string> = {};
    for (const s of settings) map[s.key.slice(PLATFORM_TEMPLATE_PREFIX.length)] = s.value;
    setPlatformDefaults(map);
  } catch (e) {
    console.error('[messaging] loadPlatformDefaults failed:', e instanceof Error ? e.message : e);
  }
}

// Superadmin (full or read) gate — reuse the simple role check.
function requireSuperRead(req: AuthRequest, res: Response, next: () => void) {
  if (req.user?.role === 'SUPERADMIN' || req.user?.role === 'SUPERADMIN_VIEWER') return next();
  return sendError(res, 'Not authorized', 403);
}


// GET /superadmin/messaging/overview — gateway balance, totals, and per-tenant breakdown.
router.get('/overview', requireSuperRead, async (_req: AuthRequest, res: Response) => {
  try {
    const rate = await getSmsRate();

    // Dartbit gateway balance for the CURRENT default provider. TalkSasa has no balance API so it
    // returns null (UI shows "—"); BlessedTexts returns a number.
    const defaultProvider = await getDefaultProvider();
    let gatewayBalance: number | null = null;
    const dartbitCreds = dartbitCredsFor(defaultProvider);
    if (dartbitCreds) {
      const bal = await balanceViaProvider(defaultProvider, dartbitCreds).catch(() => ({ ok: false, balance: null as number | null }));
      if (bal.ok) gatewayBalance = bal.balance;
    }

    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const [tenants, wallets, sentLifetimeRows, sentMonthRows] = await Promise.all([
      prisma.tenant.findMany({ select: { id: true, name: true, subdomain: true } }),
      prisma.smsWallet.findMany({ select: { tenantId: true, balance: true, spent: true } }),
      prisma.message.groupBy({ by: ['tenantId'], where: { type: 'SMS', status: { in: ['SENT', 'DELIVERED'] } }, _count: { _all: true } }),
      prisma.message.groupBy({ by: ['tenantId'], where: { type: 'SMS', status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: monthStart } }, _count: { _all: true } }),
    ]);

    const walletByTenant = new Map<string, { balance: number; spent: number }>(
      wallets.map(w => [w.tenantId, { balance: w.balance, spent: w.spent }])
    );
    const lifeByTenant = new Map(sentLifetimeRows.map(r => [r.tenantId, r._count._all]));
    const monthByTenant = new Map(sentMonthRows.map(r => [r.tenantId, r._count._all]));

    const rows = tenants.map(t => {
      const w = walletByTenant.get(t.id);
      const balanceKes = w?.balance || 0;
      return {
        tenantId: t.id,
        name: t.name,
        subdomain: t.subdomain,
        balanceKes,
        units: rate > 0 ? Math.floor(balanceKes / rate) : 0,
        spentKes: w?.spent || 0,
        sentThisMonth: monthByTenant.get(t.id) || 0,
        sentLifetime: lifeByTenant.get(t.id) || 0,
      };
    }).sort((a, b) => b.sentLifetime - a.sentLifetime);

    const totals = {
      sentThisMonth: rows.reduce((s, r) => s + r.sentThisMonth, 0),
      sentLifetime: rows.reduce((s, r) => s + r.sentLifetime, 0),
      totalUnits: rows.reduce((s, r) => s + r.units, 0),
      totalBalanceKes: rows.reduce((s, r) => s + r.balanceKes, 0),
    };

    sendSuccess(res, { rate, gatewayBalance, defaultProvider, totals, tenants: rows });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /superadmin/messaging/templates — platform-default templates (overrides applied over code defaults).
router.get('/templates', requireSuperRead, async (_req: AuthRequest, res: Response) => {
  try {
    const settings = await prisma.platformSetting.findMany({ where: { key: { startsWith: PLATFORM_TEMPLATE_PREFIX } } });
    const overrides: Record<string, string> = {};
    for (const s of settings) overrides[s.key.slice(PLATFORM_TEMPLATE_PREFIX.length)] = s.value;
    sendSuccess(res, { templates: allTemplatesForPlatform(overrides) });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// PUT /superadmin/messaging/templates/:key — set a platform-default template. Body: { body }.
const tplSchema = z.object({ body: z.string().max(800) });
router.put('/templates/:key', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const key = req.params.key;
    const parsed = tplSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid body', 400);
    // Validate the key is a known template.
    if (codeDefaultTemplate(key) === '') return sendError(res, 'Unknown template key', 400);
    const settingKey = PLATFORM_TEMPLATE_PREFIX + key;
    const body = parsed.data.body.trim();
    if (!body) {
      // Empty = reset to code default.
      await prisma.platformSetting.deleteMany({ where: { key: settingKey } });
    } else {
      await prisma.platformSetting.upsert({
        where: { key: settingKey },
        create: { key: settingKey, value: body },
        update: { value: body },
      });
    }
    await loadPlatformDefaults(); // refresh the in-memory baseline used by notifications
    sendSuccess(res, { key, body });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /superadmin/messaging/provider — current Dartbit default SMS provider.
router.get('/provider', requireSuperRead, async (_req: AuthRequest, res: Response) => {
  try {
    const provider = await getDefaultProvider();
    // Report which providers have central creds configured (so the UI can warn).
    sendSuccess(res, {
      provider,
      configured: {
        BLESSEDTEXTS: !!dartbitCredsFor('BLESSEDTEXTS'),
        TALKSASA: !!dartbitCredsFor('TALKSASA'),
      },
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// PUT /superadmin/messaging/provider — switch the Dartbit default SMS gateway. Body: { provider }.
const provSchema = z.object({ provider: z.enum(['BLESSEDTEXTS', 'TALKSASA']) });
router.put('/provider', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = provSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid provider', 400);
    await setDefaultProvider(parsed.data.provider as SmsProvider);
    sendSuccess(res, { provider: parsed.data.provider });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export default router;
