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
});

// Broadcast a manual SMS to a group of subscribers, with placeholder support.
// Group selectors (all optional; combined with AND):
//   scope: 'ALL' (system-wide for this tenant) — default
//   routerIds: string[] — limit to subscribers on these MikroTik routers
//   services: ('PPPOE'|'STATIC'|'HOTSPOT')[] — limit to these user types
//   statuses: ('ACTIVE'|'EXPIRED')[] — limit by subscription status
const broadcastSchema = z.object({
  body: z.string().min(1).max(1000),
  routerIds: z.array(z.string()).optional(),
  services: z.array(z.enum(['PPPOE', 'STATIC', 'HOTSPOT'])).optional(),
  statuses: z.array(z.enum(['ACTIVE', 'EXPIRED'])).optional(),
});

router.post('/broadcast', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);
    const parsed = broadcastSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.errors[0]?.message || 'Invalid input', 400);
    const { body, routerIds, services, statuses } = parsed.data;

    // Build the subscriber filter from the selected groups.
    const where: Record<string, unknown> = { tenantId, phone: { not: null } };
    if (routerIds && routerIds.length) where.routerId = { in: routerIds };
    if (services && services.length) where.service = { in: services };
    if (statuses && statuses.length) {
      const now = new Date();
      const conds: object[] = [];
      if (statuses.includes('ACTIVE')) conds.push({ isActive: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
      if (statuses.includes('EXPIRED')) conds.push({ OR: [{ isActive: false }, { expiresAt: { lte: now } }] });
      if (conds.length) where.OR = conds;
    }

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
      const sub = await prisma.subscriber.findFirst({
        where: { tenantId, phone: parsed.data.recipient },
        select: { fullName: true, username: true, expiresAt: true, package: { select: { name: true } } },
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
