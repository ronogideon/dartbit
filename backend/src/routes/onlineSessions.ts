import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

// How long has a session actually been up?
//
// Two sources, in order of trustworthiness:
//  1. `uptime` as reported by the router itself — the real session age. RouterOS sends compound
//     durations ("45s", "3m12s", "1h23m45s", "2d3h", "1w2d3h4m5s"); the RADIUS watcher sends a
//     plain seconds count ("3600"); hotspot bypass devices send the literal "bypass".
//  2. `startedAt` — when Dartbit FIRST saw the session. Only a fallback, because it is not the
//     true session age: rows backfilled by the migration all share one timestamp (so they tie and
//     order arbitrarily), and it resets if a session momentarily drops out of a poll.
function sessionSeconds(uptime: string | null | undefined, startedAt: Date | null | undefined, now: number): number {
  const u = (uptime || '').trim();
  if (u && u !== 'bypass') {
    // Plain seconds count (RADIUS path).
    if (/^\d+$/.test(u)) return Number(u);
    // RouterOS compound duration.
    const mult: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
    const re = /(\d+)([wdhms])/g;
    let total = 0, matched = false, m: RegExpExecArray | null;
    while ((m = re.exec(u)) !== null) { total += Number(m[1]) * mult[m[2]]; matched = true; }
    if (matched) return total;
  }
  if (startedAt) return Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  return Number.MAX_SAFE_INTEGER; // unknown duration sorts last
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};
    const sessions = await prisma.onlineSession.findMany({
      where,
      // package is needed for the FUP status dot (fupEnabled / fupPeriod drive the period key).
      include: { subscriber: { include: { package: true } }, router: true },
    });
    // Hide expired subscribers from the active page. Expired PPPoE/static devices are deliberately
    // kept connected (portal-only) so they can reach tenant.dartbittech.com to renew — but they
    // are NOT "active" customers, so they should not clutter the active-users view.
    const now = Date.now();
    // A router that has stopped reporting takes all of its sessions with it. OnlineSession rows are
    // only ever refreshed BY the router, so when one goes offline its last-known rows freeze and
    // every customer behind it keeps showing as online — with a frozen uptime, which is why they all
    // read the same duration. Clients behind a dead router are offline by definition, so drop them.
    // Threshold matches startRouterOfflineWatcher's 90s so the two views can't disagree; lastSeenAt
    // is checked directly as well, since the watcher only runs periodically and would otherwise
    // leave a window where the router is stale but not yet flagged.
    const ROUTER_STALE_MS = 90 * 1000;
    const visible = sessions.filter(s => {
      const r = s.router as { status?: string; lastSeenAt?: Date | null } | null;
      if (r) {
        const seen = r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : 0;
        if (r.status === 'OFFLINE' || now - seen > ROUTER_STALE_MS) return false;
      }
      const sub = s.subscriber;
      if (!sub) return true; // unidentified sessions still shown
      const expired = sub.expiresAt ? new Date(sub.expiresAt).getTime() <= now : false;
      return sub.isActive && !expired;
    });
    // Shortest online time first (just-connected at the top), longest at the bottom. Ties break on
    // id so the order is deterministic between polls — otherwise equal-duration rows would swap
    // places on every refresh and the table would look like it was shuffling itself.
    const sorted = visible
      .map(s => ({ s, secs: sessionSeconds(s.uptime, (s as { startedAt?: Date }).startedAt, now) }))
      .sort((a, b) => (a.secs - b.secs) || a.s.id.localeCompare(b.s.id))
      .map(x => ({ ...x.s, onlineSeconds: x.secs === Number.MAX_SAFE_INTEGER ? null : x.secs }));

    // Same computed status as the subscribers list, from the same helper — these two pages render
    // the identical dot, so they must not derive it independently.
    const subsForStatus = sorted
      .filter(r => r.subscriber)
      .map(r => ({
        id: r.subscriber!.id,
        expiresAt: r.subscriber!.expiresAt,
        service: r.subscriber!.service,
        package: (r.subscriber as unknown as { package?: unknown }).package ?? null,
      }));
    // Rows on this page are by definition live sessions, so everything here is online-or-throttled.
    const { fupStatusFor } = await import('../utils/fup');
    const statuses = await fupStatusFor(subsForStatus as never, () => true);
    const withStatus = sorted.map(r => ({
      ...r,
      fupStatus: r.subscriber ? (statuses.get(r.subscriber.id) || 'online') : 'online',
    }));
    sendSuccess(res, withStatus);
  } catch {
    sendError(res, 'Failed to fetch sessions', 500);
  }
});

// Router reports active sessions
const sessionSchema = z.object({
  apiKey: z.string(),
  sessions: z.array(z.object({
    username: z.string(),
    ipAddress: z.string().optional(),
    macAddress: z.string().optional(),
    uploadSpeed: z.number().optional(),
    downloadSpeed: z.number().optional(),
    uptime: z.string().optional(),
  })),
});

router.post('/sync', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = sessionSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid payload', 400);

    const mikrotikRouter = await prisma.mikrotikRouter.findUnique({
      where: { apiKey: parsed.data.apiKey },
    });
    if (!mikrotikRouter) return sendError(res, 'Router not found', 404);

    // Clear sessions no longer present in this payload; upsert the rest (not a blanket wipe — see
    // /router/sessions in routerZtp.ts, which current router scripts actually use, for why).
    const keys = parsed.data.sessions.map(s => s.macAddress || s.username).filter(Boolean);
    await prisma.onlineSession.deleteMany({
      where: { routerId: mikrotikRouter.id, sessionKey: keys.length ? { notIn: keys } : undefined },
    });

    // Insert/update sessions
    for (const s of parsed.data.sessions) {
      const subscriber = await prisma.subscriber.findFirst({
        where: { username: s.username, tenantId: mikrotikRouter.tenantId },
      });
      const sessionKey = s.macAddress || s.username;

      await prisma.onlineSession.upsert({
        where: { routerId_sessionKey: { routerId: mikrotikRouter.id, sessionKey } },
        update: {
          username: s.username, ipAddress: s.ipAddress, macAddress: s.macAddress,
          uploadSpeed: s.uploadSpeed, downloadSpeed: s.downloadSpeed, uptime: s.uptime,
          subscriberId: subscriber?.id,
        },
        create: {
          ...s, sessionKey,
          routerId: mikrotikRouter.id,
          subscriberId: subscriber?.id,
          tenantId: mikrotikRouter.tenantId,
        },
      });

      if (subscriber) {
        await prisma.subscriber.update({
          where: { id: subscriber.id },
          data: { lastOnlineAt: new Date() },
        });
      }
    }

    sendSuccess(res, { synced: parsed.data.sessions.length });
  } catch {
    sendError(res, 'Session sync failed', 500);
  }
});

export default router;
