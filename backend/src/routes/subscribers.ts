import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { radiusConfigured } from '../utils/radius';

const router = Router();
router.use(authenticate);

const subscriberSchema = z.object({
  username: z.string().min(2),
  secret: z.string().min(4),
  fullName: z.string().min(2),
  phone: z.string().optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  service: z.enum(['PPPOE', 'HOTSPOT', 'STATIC']).default('PPPOE'),
  packageId: z.string().optional().or(z.literal('')),
  routerId: z.string().optional().or(z.literal('')),
  expiresAt: z.string().optional().or(z.literal('')),
  isActive: z.boolean().optional(),
  ipAddress: z.string().optional().or(z.literal('')),
  macAddress: z.string().optional().or(z.literal('')),
});

// Strip empty strings - converts "" to undefined so they're treated as "don't update"
function cleanForUpdate<T extends Record<string, unknown>>(data: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === '' || v === undefined || v === null) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};

    const subscribers = await prisma.subscriber.findMany({
      where,
      include: { package: true, router: true },
      orderBy: [
        { isActive: 'desc' },
        { lastOnlineAt: 'desc' },
      ],
    });

    // Sort: active first, expired last
    const now = new Date();
    const sorted = subscribers.sort((a, b) => {
      const aExpired = a.expiresAt ? a.expiresAt < now : false;
      const bExpired = b.expiresAt ? b.expiresAt < now : false;
      if (aExpired !== bExpired) return aExpired ? 1 : -1;
      return 0;
    });

    // Online status: a subscriber is online if a current OnlineSession exists for them.
    const online = await prisma.onlineSession.findMany({
      where: tenantId ? { tenantId } : {},
      select: { subscriberId: true, username: true },
    });
    const onlineIds = new Set(online.map(o => o.subscriberId).filter(Boolean) as string[]);
    const onlineNames = new Set(online.map(o => o.username));
    const withOnline = sorted.map(s => ({
      ...s,
      isOnline: onlineIds.has(s.id) || onlineNames.has(s.username),
    }));

    sendSuccess(res, withOnline);
  } catch {
    sendError(res, 'Failed to fetch subscribers', 500);
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = subscriberSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);

    const { expiresAt, ...rest } = parsed.data;
    const subscriber = await prisma.subscriber.create({
      data: {
        ...rest,
        tenantId,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      },
      include: { package: true },
    });

    // RADIUS pilot: if this subscriber is on a RADIUS-enabled router, write it into FreeRADIUS too
    // (PPPoE and HOTSPOT). syncSubscriberToRadius internally no-ops for non-RADIUS routers, so this
    // is safe to call unconditionally. Best-effort + parallel to the legacy flow.
    try {
      const { radiusConfigured, syncSubscriberToRadius } = await import('../utils/radius');
      if (radiusConfigured() && (subscriber.service === 'PPPOE' || subscriber.service === 'HOTSPOT')) {
        await syncSubscriberToRadius(subscriber.id);
      }
    } catch (e) {
      console.error('radius sync (create) failed:', e instanceof Error ? e.message : e);
    }

    sendSuccess(res, subscriber, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to create subscriber';
    sendError(res, msg, 500);
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;

    // Strip empty strings BEFORE validation so they're treated as "don't change"
    const cleanedBody = cleanForUpdate(req.body || {});

    const parsed = subscriberSchema.partial().safeParse(cleanedBody);
    if (!parsed.success) return sendError(res, parsed.error.errors[0].message, 400);

    // Verify ownership
    const existing = await prisma.subscriber.findUnique({ where: { id: req.params.id } });
    if (!existing) return sendError(res, 'Subscriber not found', 404);
    if (tenantId && existing.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);

    const { expiresAt, ...rest } = parsed.data;
    const updateData: Record<string, unknown> = { ...rest };
    if (expiresAt !== undefined) {
      updateData.expiresAt = expiresAt ? new Date(expiresAt) : null;
    }

    const subscriber = await prisma.subscriber.update({
      where: { id: req.params.id },
      data: updateData,
      include: { package: true, router: true },
    });

    // Push the change to the router immediately (applied within ~2s by the cmd poller) so a manual
    // edit takes effect at once: if the subscriber is now expired/inactive/without a package, the
    // helper emits removal + session-kick commands (the device is thrown out); if still entitled, it
    // (re)creates the users. Covers the case of an admin setting expiry to the past to disconnect.
    // When RADIUS is the active auth system we do NOT push local users to the router at all — the
    // radcheck sync above is authoritative. Local pushes only happen in legacy (non-RADIUS) mode.
    if (subscriber.routerId && subscriber.service === 'HOTSPOT' && !radiusConfigured()) {
      try {
        const { pushSubscriberToRouter } = await import('../utils/pushSubscriber');
        await pushSubscriberToRouter(subscriber.id);
      } catch (e) {
        console.error('update: router push failed (continuing):', e instanceof Error ? e.message : e);
      }
    } else if (subscriber.routerId && subscriber.service !== 'HOTSPOT' && !radiusConfigured()) {
      // PPPoE/static: toggle the secret enable/disable + kick active session to match new state.
      try {
        const { enqueueCommand } = await import('../utils/commandQueue');
        const now = new Date();
        const expired = subscriber.expiresAt ? subscriber.expiresAt <= now : false;
        const entitled = subscriber.isActive && !expired;
        if (entitled) {
          await enqueueCommand(subscriber.routerId, `:foreach s in=[/ppp secret find name="${subscriber.username}"] do={ /ppp secret set $s disabled=no }`);
        } else {
          await enqueueCommand(subscriber.routerId,
            `:foreach s in=[/ppp secret find name="${subscriber.username}"] do={ /ppp secret set $s disabled=yes }\n` +
            `:foreach a in=[/ppp active find name="${subscriber.username}"] do={ /ppp active remove $a }`);
        }
      } catch (e) {
        console.error('update: ppp router push failed (continuing):', e instanceof Error ? e.message : e);
      }
    }

    // RADIUS: reflect edits into FreeRADIUS + CoA-kick if now unentitled (PPPoE and HOTSPOT).
    try {
      const { radiusConfigured, syncSubscriberToRadius } = await import('../utils/radius');
      if (radiusConfigured() && (subscriber.service === 'PPPOE' || subscriber.service === 'HOTSPOT')) {
        // kickToApply: drop the live session so the new state takes effect immediately — into the
        // walled garden if it just expired, or back to full service if the expiry was pushed out.
        await syncSubscriberToRadius(subscriber.id, { kickToApply: true });
      }
    } catch (e) {
      console.error('radius sync (update) failed:', e instanceof Error ? e.message : e);
    }

    sendSuccess(res, subscriber);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update subscriber';
    console.error('Update subscriber error:', msg);
    sendError(res, msg, 500);
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const sub = await prisma.subscriber.findUnique({ where: { id: req.params.id }, include: { router: { select: { radiusEnabled: true } } } });
    if (!sub) return sendError(res, 'Subscriber not found', 404);
    // Tenant scoping: a tenant admin can only delete their own subscribers.
    if (req.user?.tenantId && sub.tenantId !== req.user.tenantId) {
      return sendError(res, 'Not authorized', 403);
    }

    // Remove from the router immediately so they're kicked off (within ~2s via the cmd poller).
    // Use the shared helper so the MAC auto-login user + session/cookie/host are all cleared too.
    if (sub.routerId) {
      try {
        if (sub.service === 'HOTSPOT') {
          // RADIUS clears radcheck + CoA-kicks below. Local removal only in legacy mode.
          if (!radiusConfigured()) {
            const { pushSubscriberRemoval } = await import('../utils/pushSubscriber');
            await pushSubscriberRemoval(sub.routerId, sub.username, sub.macAddress);
          }
        } else if (!radiusConfigured()) {
          const { enqueueCommand } = await import('../utils/commandQueue');
          await enqueueCommand(sub.routerId,
            `:foreach a in=[/ppp active find name="${sub.username}"] do={ /ppp active remove $a }\n` +
            `:foreach s in=[/ppp secret find name="${sub.username}"] do={ /ppp secret remove $s }`);
        }
      } catch (e) {
        console.error('subscriber delete: router cleanup failed (continuing):', e instanceof Error ? e.message : e);
      }
    }

    // RADIUS: remove the user from FreeRADIUS + CoA-kick the live session (PPPoE and HOTSPOT).
    try {
      const { radiusConfigured, removeSubscriberFromRadius } = await import('../utils/radius');
      if (radiusConfigured() && (sub.service === 'PPPOE' || sub.service === 'HOTSPOT')) {
        await removeSubscriberFromRadius(sub as never);
      }
    } catch (e) {
      console.error('radius removal (delete) failed:', e instanceof Error ? e.message : e);
    }

    // Remove the subscriber AND their session/usage data to keep server storage low.
    // OnlineSession (live) + SessionRecord (history + data usage) are deleted; Payment rows are
    // financial records, so we keep them but unlink the subscriber. Done in one transaction.
    await prisma.$transaction([
      prisma.onlineSession.deleteMany({ where: { subscriberId: req.params.id } }),
      prisma.onlineSession.deleteMany({ where: { tenantId: sub.tenantId, username: sub.username } }),
      prisma.sessionRecord.deleteMany({ where: { subscriberId: req.params.id } }),
      prisma.sessionRecord.deleteMany({ where: { tenantId: sub.tenantId, username: sub.username } }),
      prisma.payment.updateMany({ where: { subscriberId: req.params.id }, data: { subscriberId: null } }),
      prisma.subscriber.delete({ where: { id: req.params.id } }),
    ]);
    sendSuccess(res, { deleted: true });
  } catch (err) {
    console.error('Delete subscriber error:', err instanceof Error ? err.message : err);
    sendError(res, err instanceof Error ? `Failed to delete subscriber: ${err.message}` : 'Failed to delete subscriber', 500);
  }
});

// POST /subscribers/:id/extend — add time to a subscriber's expiry. Body: { minutes }.
// Adds to the CURRENT expiry if still in the future, otherwise from now (so extending an
// already-expired subscriber starts their new window from the moment of extension).
router.post('/:id/extend', async (req: AuthRequest, res: Response) => {
  try {
    const minutes = Number(req.body?.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return sendError(res, 'minutes must be > 0', 400);

    const sub = await prisma.subscriber.findUnique({ where: { id: req.params.id } });
    if (!sub) return sendError(res, 'Subscriber not found', 404);
    if (req.user?.tenantId && sub.tenantId !== req.user.tenantId) return sendError(res, 'Not authorized', 403);

    const now = new Date();
    const base = sub.expiresAt && sub.expiresAt > now ? sub.expiresAt : now;
    const newExpiry = new Date(base.getTime() + minutes * 60 * 1000);

    const updated = await prisma.subscriber.update({
      where: { id: sub.id },
      data: { expiresAt: newExpiry, isActive: true },
    });

    // RADIUS-managed routers enforce expiry from the radcheck `Expiration` item, so the new expiry
    // MUST be written there — otherwise RADIUS keeps enforcing the old window. syncSubscriberToRadius
    // no-ops for non-RADIUS routers, so this is safe to call unconditionally. (This was the gap that
    // made frontend expiry changes not take effect on RADIUS.)
    try {
      const { radiusConfigured, syncSubscriberToRadius } = await import('../utils/radius');
      if (radiusConfigured() && (sub.service === 'PPPOE' || sub.service === 'HOTSPOT')) {
        await syncSubscriberToRadius(sub.id);
      }
    } catch (e) {
      console.error('extend: radius sync failed (continuing):', e instanceof Error ? e.message : e);
    }

    // Keep the unified identity in lockstep: if this hotspot device has a linked M-Pesa voucher
    // (the receipt code), update its expiry to the SAME session end so the code, username/password
    // and MAC all expire together. Matched by the device MAC within this tenant.
    if (sub.service === 'HOTSPOT' && sub.macAddress) {
      try {
        await prisma.voucher.updateMany({
          where: { tenantId: sub.tenantId, batchId: 'MPESA', usedByMac: sub.macAddress.toUpperCase() },
          data: { expiresAt: newExpiry },
        });
      } catch (e) {
        console.error('extend: voucher expiry sync failed (continuing):', e instanceof Error ? e.message : e);
      }
    }

    // Push the change to the router (re-enable + update) via a sync so the user isn't kicked.
    // Legacy mode only — under RADIUS the radcheck Expiration written above is authoritative.
    if (sub.routerId && !radiusConfigured()) {
      try {
        const { enqueueCommand } = await import('../utils/commandQueue');
        if (sub.service === 'HOTSPOT') {
          await enqueueCommand(sub.routerId, `:foreach u in=[/ip hotspot user find name="${sub.username}"] do={ /ip hotspot user set $u disabled=no }`);
        } else {
          await enqueueCommand(sub.routerId, `:foreach s in=[/ppp secret find name="${sub.username}"] do={ /ppp secret set $s disabled=no }`);
        }
      } catch (e) {
        console.error('extend: router update failed (continuing):', e instanceof Error ? e.message : e);
      }
    }

    sendSuccess(res, { id: updated.id, expiresAt: updated.expiresAt });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed to extend', 500);
  }
});

// GET /subscribers/:id/detail — full subscriber info + 30-day usage + session history
router.get('/:id/detail', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const sub = await prisma.subscriber.findUnique({
      where: { id: req.params.id },
      include: { package: true, router: true },
    });
    if (!sub) return sendError(res, 'Subscriber not found', 404);
    if (tenantId && sub.tenantId !== tenantId) return sendError(res, 'Not authorized', 403);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Session history for the past 30 days (most recent first)
    const records = await prisma.sessionRecord.findMany({
      where: {
        tenantId: sub.tenantId,
        subscriberId: sub.id,
        startedAt: { gte: thirtyDaysAgo },
      },
      orderBy: { startedAt: 'desc' },
      take: 500,
    });

    // Totals over the 30-day window
    // Byte semantics (subscriber POV):
    //   SessionRecord.rxBytes = counter the MikroTik RECEIVES from client = subscriber UPLOAD
    //   SessionRecord.txBytes = counter the MikroTik SENDS to client    = subscriber DOWNLOAD
    let totalUpload = 0n, totalDownload = 0n;
    const sessions = records.map(rec => {
      totalUpload += rec.rxBytes;
      totalDownload += rec.txBytes;
      const durationMs = (rec.endedAt ?? rec.lastSeenAt).getTime() - rec.startedAt.getTime();
      return {
        id: rec.id,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        active: !rec.endedAt,
        durationSeconds: Math.max(0, Math.round(durationMs / 1000)),
        ipAddress: rec.ipAddress,
        downloadBytes: rec.txBytes.toString(),
        uploadBytes: rec.rxBytes.toString(),
      };
    });

    const payments = await prisma.payment.findMany({
      where: { tenantId: sub.tenantId, subscriberId: sub.id },
      orderBy: { createdAt: 'desc' }, take: 200,
      include: { package: { select: { name: true } } },
    });
    const lifetimeValue = payments.reduce((s, p) => s + (p.amount || 0), 0);
    const messages = await prisma.message.findMany({
      where: { tenantId: sub.tenantId, OR: [{ subscriberId: sub.id }, ...(sub.phone ? [{ recipient: sub.phone }] : [])] },
      orderBy: { createdAt: 'desc' }, take: 200,
    });

    sendSuccess(res, {
      subscriber: {
        id: sub.id, username: sub.username, fullName: sub.fullName,
        phone: sub.phone, email: sub.email, service: sub.service,
        password: sub.secret,
        isActive: sub.isActive, expiresAt: sub.expiresAt,
        lastOnlineAt: sub.lastOnlineAt, ipAddress: sub.ipAddress,
        macAddress: sub.macAddress, createdAt: sub.createdAt,
        package: sub.package ? { id: sub.package.id, name: sub.package.name,
          speedUpKbps: sub.package.speedUpKbps, speedDownKbps: sub.package.speedDownKbps } : null,
        router: sub.router ? { id: sub.router.id, name: sub.router.name } : null,
      },
      usage30d: {
        totalDownloadBytes: totalDownload.toString(),
        totalUploadBytes: totalUpload.toString(),
        totalBytes: (totalDownload + totalUpload).toString(),
        sessionCount: records.length,
      },
      sessions,
      payments: payments.map(p => ({
        id: p.id, amount: p.amount, method: p.method, source: p.source,
        reference: p.reference, mpesaCode: p.mpesaCode, packageName: p.package?.name || null,
        createdAt: p.createdAt,
      })),
      lifetimeValue,
      messages: messages.map(m => ({
        id: m.id, recipient: m.recipient, body: m.body, status: m.status,
        category: m.category, createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    console.error('Subscriber detail error:', err);
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export default router;
