import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { sendNotification } from '../utils/notifications';
import { renderTemplate } from '../utils/messageTemplates';

const router = Router();
router.use(authenticate);

const messageSchema = z.object({
  type: z.enum(['SMS', 'EMAIL']).default('SMS'),
  recipient: z.string(),
  body: z.string(),
  // Set when the tenant picked a subscriber from the searchable dropdown rather than typing a raw
  // number. Gives an exact subscriber for placeholder rendering (instead of a fuzzy phone match)
  // and links the Message row so the Messages list can hyperlink the username.
  subscriberId: z.string().optional(),
});

// Broadcast a manual SMS to a group of subscribers, with placeholder support.
// Group selectors (all optional; combined with AND):
//   scope: 'ALL' (system-wide for this tenant) — default
//   routerIds: string[] — limit to subscribers on these MikroTik routers
//   services: ('PPPOE'|'STATIC'|'HOTSPOT')[] — limit to these user types
//   statuses: ('ACTIVE'|'EXPIRED')[] — limit by subscription status
const audienceSchema = {
  routerIds: z.array(z.string()).optional(),
  services: z.array(z.enum(['PPPOE', 'STATIC', 'HOTSPOT'])).optional(),
  statuses: z.array(z.enum(['ACTIVE', 'EXPIRED'])).optional(),
  // Limit to subscribers currently on these packages.
  packageIds: z.array(z.string()).optional(),
  // Only subscribers whose subscription lapses within EXPIRING_SOON_DAYS (and hasn't already).
  expiringSoon: z.boolean().optional(),
};

// "Expiring soon" means 4 days or less remaining, matching the renewal-reminder window.
const EXPIRING_SOON_DAYS = 4;

type AudienceFilters = {
  routerIds?: string[];
  services?: string[];
  statuses?: string[];
  packageIds?: string[];
  expiringSoon?: boolean;
};

// Single source of truth for who a broadcast targets, shared by the live recipient count and the
// actual send. If these two ever diverged, the tenant would be shown one number and bill for
// another — so both callers must go through here.
function buildAudienceWhere(tenantId: string, f: AudienceFilters): Record<string, unknown> {
  const where: Record<string, unknown> = { tenantId, phone: { not: null } };
  const and: object[] = [];

  if (f.routerIds?.length) where.routerId = { in: f.routerIds };
  if (f.services?.length) where.service = { in: f.services };
  if (f.packageIds?.length) where.packageId = { in: f.packageIds };

  const now = new Date();
  if (f.statuses?.length) {
    const conds: object[] = [];
    if (f.statuses.includes('ACTIVE')) conds.push({ isActive: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
    if (f.statuses.includes('EXPIRED')) conds.push({ OR: [{ isActive: false }, { expiresAt: { lte: now } }] });
    if (conds.length) and.push({ OR: conds });
  }

  if (f.expiringSoon) {
    const cutoff = new Date(now.getTime() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000);
    // Not already expired, and lapsing inside the window.
    and.push({ expiresAt: { gt: now, lte: cutoff } });
  }

  // Combined with AND so status and expiring-soon can't clobber each other's OR clause.
  if (and.length) where.AND = and;
  return where;
}

// POST /broadcast/count — how many subscribers the current filter selection would reach. Drives the
// live recipient count in the compose UI so the tenant sees the blast radius BEFORE sending.
const countSchema = z.object(audienceSchema);
router.post('/broadcast/count', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const parsed = countSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.errors[0]?.message || 'Invalid input', 400);
    const where = buildAudienceWhere(tenantId, parsed.data);
    const count = await prisma.subscriber.count({ where: where as never });
    sendSuccess(res, { count });
  } catch {
    sendError(res, 'Failed to count recipients', 500);
  }
});

const broadcastSchema = z.object({
  body: z.string().min(1).max(1000),
  ...audienceSchema,
});

router.post('/broadcast', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const parsed = broadcastSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.errors[0]?.message || 'Invalid input', 400);
    const { body } = parsed.data;

    const where = buildAudienceWhere(tenantId, parsed.data);

    const subs = await prisma.subscriber.findMany({
      where: where as never,
      select: {
        id: true, fullName: true, phone: true, username: true, service: true,
        expiresAt: true, package: { select: { name: true } },
      },
      take: 5000,
    });
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });

    const recipients = subs.filter(s => s.phone);
    if (recipients.length === 0) return sendError(res, 'No subscribers match the selected groups', 400);

    // Send to each, rendering placeholders per-subscriber. Run sequentially-ish with a cap to
    // avoid hammering the gateway; collect a summary.
    let sent = 0, failed = 0;
    const fmtExpiry = (d: Date | null) => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    for (const s of recipients) {
      const text = renderTemplate(body, {
        tenant: tenant?.name || '', name: s.fullName || '', username: s.username,
        login: s.username, package: s.package?.name || '', expiry: fmtExpiry(s.expiresAt),
        phone: s.phone || '',
      });
      const r = await sendNotification({ tenantId, phone: s.phone as string, body: text, category: 'MANUAL' })
        .catch(() => ({ ok: false } as { ok: boolean }));
      if (r.ok) sent++; else failed++;
    }

    sendSuccess(res, { matched: recipients.length, sent, failed }, 201);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Broadcast failed', 500);
  }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};
    const messages = await prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    sendSuccess(res, messages);
  } catch {
    sendError(res, 'Failed to fetch messages', 500);
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);

    if (parsed.data.type === 'SMS') {
      // Render any {placeholders} in the manual message. If the recipient phone matches a
      // subscriber, fill from their details; otherwise unknown placeholders are dropped.
      // Prefer the explicitly chosen subscriber; fall back to a phone match for raw-number sends.
      const sub = parsed.data.subscriberId
        ? await prisma.subscriber.findFirst({
            where: { tenantId, id: parsed.data.subscriberId },
            select: { id: true, fullName: true, username: true, expiresAt: true, package: { select: { name: true } } },
          })
        : await prisma.subscriber.findFirst({
            where: { tenantId, phone: parsed.data.recipient },
            select: { id: true, fullName: true, username: true, expiresAt: true, package: { select: { name: true } } },
          });
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      const body = renderTemplate(parsed.data.body, {
        tenant: tenant?.name || '', name: sub?.fullName || '', username: sub?.username || '',
        login: sub?.username || '', package: sub?.package?.name || '',
        expiry: sub?.expiresAt ? sub.expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '',
        phone: parsed.data.recipient,
      });
      // Route SMS through the configured gateway; Messages row is created/updated by
      // sendNotification with phone, cost, delivery status, and gateway message id.
      const result = await sendNotification({
        tenantId,
        phone: parsed.data.recipient,
        body,
        category: 'MANUAL',
      });
      if (!result.ok) return sendError(res, result.reason || 'Send failed', 400);
      const latest = await prisma.message.findFirst({
        where: { tenantId, gatewayMsgId: result.messageId },
        orderBy: { createdAt: 'desc' },
      });
      // Stamp the subscriber link/username so the Messages list can open the profile pane.
      if (latest && sub) {
        try {
          await prisma.message.update({
            where: { id: latest.id },
            data: { subscriberId: sub.id, username: sub.username },
          });
          (latest as { subscriberId?: string | null }).subscriberId = sub.id;
          (latest as { username?: string | null }).username = sub.username;
        } catch { /* display-only linkage; never fail the send over it */ }
      }
      sendSuccess(res, latest, 201);
    } else {
      // EMAIL not yet wired to a provider — record as PENDING for now.
      const message = await prisma.message.create({
        data: { ...parsed.data, tenantId, status: 'PENDING' },
      });
      sendSuccess(res, message, 201);
    }
  } catch {
    sendError(res, 'Failed to send message', 500);
  }
});

export default router;
