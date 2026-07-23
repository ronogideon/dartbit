import { Router, Response } from 'express';
import crypto from 'crypto';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

// Network map + plant inventory. Elements (OLT, dome enclosures, FAT/splitters, patch cords,
// MikroTiks, customer premises) with GPS positions, cables between them (length, core count,
// power readings), maintenance records requiring admin confirmation, and inventory totals.
// Raw SQL throughout so a stale Prisma client on deploy can never break it.

const router = Router();
router.use(authenticate);

const ELEMENT_TYPES = ['OLT', 'DOME', 'FAT', 'PATCH_CORD', 'MIKROTIK', 'CUSTOMER'];
const uid = () => crypto.randomUUID();
const num = (v: unknown): number | null => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? null : Number(v));
const clean = (v: unknown, max = 500): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

interface ElementRow { id: string; type: string; name: string; lat: number; lng: number; meta: string | null; parentId: string | null; createdAt: Date }
const parseMeta = (meta: string | null): Record<string, unknown> => {
  if (!meta) return {};
  try { const o = JSON.parse(meta); return o && typeof o === 'object' ? o as Record<string, unknown> : {}; } catch { return {}; }
};
// "1x16" -> 16
const ratioPorts = (ratio: string): number => {
  const m = /^1\s*[xX*]\s*(\d+)$/.exec((ratio || '').trim());
  const n = m ? Number(m[1]) : 0;
  return n > 0 && n <= 64 ? n : 0;
};
// Field photos arrive as downscaled JPEG data URLs; cap the size so a table row stays sane.
const cleanPhoto = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(s)) return null;
  return s.length > 700_000 ? null : s;
};

// GET /network — the whole map: elements, cables, pending maintenance (admins see the queue).
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const elements = await prisma.$queryRawUnsafe(
      `SELECT id, type, name, lat, lng, meta, photo, "parentId", "createdAt" FROM "NetworkElement" WHERE "tenantId"=$1 ORDER BY "createdAt" ASC`, tenantId);
    const cables = await prisma.$queryRawUnsafe(
      `SELECT id, "fromId", "toId", "toLat", "toLng", "lengthM", cores, "powerStartDbm", "powerEndDbm", "isDrop", label, status, "createdAt" FROM "NetworkCable" WHERE "tenantId"=$1 ORDER BY "createdAt" ASC`, tenantId);
    const isAdmin = req.user?.role === 'TENANT_ADMIN' || req.user?.role === 'SUPERADMIN';
    const maintenance = await prisma.$queryRawUnsafe(
      `SELECT m.id, m."cableId", m."elementId", m.kind, m.note, m."newLengthM", m.status, m."createdAt", u.name AS "createdByName"
       FROM "NetworkMaintenance" m LEFT JOIN "User" u ON u.id = m."createdBy"
       WHERE m."tenantId"=$1 ${isAdmin ? '' : `AND m.status='PENDING'`} ORDER BY m."createdAt" DESC LIMIT 100`, tenantId);

    const els = elements as ElementRow[];
    const cbls = cables as { fromId: string }[];

    // Splitter/FAT port occupancy: ports come from the split ratio (1xN), used = cables leaving it.
    const outCount: Record<string, number> = {};
    for (const c of cbls) outCount[c.fromId] = (outCount[c.fromId] || 0) + 1;

    // Plot linked subscribers: a CUSTOMER element can carry meta.subscriberId — attach that
    // subscriber's live status so the map can colour the premise (online / offline / expired).
    const subIds: string[] = [];
    for (const el of els) {
      const m = parseMeta(el.meta);
      if (el.type === 'CUSTOMER' && typeof m.subscriberId === 'string') subIds.push(m.subscriberId);
    }
    const subStatus: Record<string, { username: string; fullName: string; expiresAt: Date | null; isActive: boolean; online: boolean }> = {};
    if (subIds.length) {
      const subs = await prisma.subscriber.findMany({
        where: { id: { in: subIds }, tenantId },
        select: { id: true, username: true, fullName: true, expiresAt: true, isActive: true },
      });
      const online = await prisma.onlineSession.findMany({
        where: { tenantId, username: { in: subs.map(s => s.username) } },
        select: { username: true },
      });
      const onlineSet = new Set(online.map(o => o.username));
      for (const s of subs) subStatus[s.id] = { ...s, online: onlineSet.has(s.username) };
    }

    const enriched = els.map(el => {
      const m = parseMeta(el.meta);
      const extra: Record<string, unknown> = {};
      if (el.type === 'FAT') {
        const ports = ratioPorts(typeof m.ratio === 'string' ? m.ratio : '');
        if (ports) extra.ports = { total: ports, used: outCount[el.id] || 0, free: Math.max(0, ports - (outCount[el.id] || 0)) };
      }
      if (el.type === 'CUSTOMER' && typeof m.subscriberId === 'string') {
        const st = subStatus[m.subscriberId];
        if (st) extra.subscriber = { id: m.subscriberId, username: st.username, fullName: st.fullName, online: st.online, expired: !!(st.expiresAt && st.expiresAt <= new Date()), isActive: st.isActive };
      }
      return { ...el, ...extra };
    });

    sendSuccess(res, { elements: enriched, cables, maintenance });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /network/elements — place equipment at a GPS position. Technicians allowed.
router.post('/elements', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const type = String(req.body?.type || '').toUpperCase();
    if (!ELEMENT_TYPES.includes(type)) return sendError(res, `Type must be one of ${ELEMENT_TYPES.join(', ')}`, 400);
    const lat = num(req.body?.lat), lng = num(req.body?.lng);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return sendError(res, 'A valid GPS position (lat, lng) is required', 400);
    const name = clean(req.body?.name, 120) || type;
    // meta carries type-specific fields: FAT/splitter → { ratio:'1x8', inputCore, inputPowerDbm, outputPowerDbm };
    // MIKROTIK → { routerId }; OLT → { ponPorts }; anything → { notes }
    const meta = req.body?.meta && typeof req.body.meta === 'object' ? JSON.stringify(req.body.meta).slice(0, 4000) : null;
    const parentId = clean(req.body?.parentId, 64);
    const id = uid();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "NetworkElement" (id, "tenantId", type, name, lat, lng, meta, photo, "parentId", "createdBy", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
      id, tenantId, type, name, lat, lng, meta, cleanPhoto(req.body?.photo), parentId, req.user?.userId || null);
    sendSuccess(res, { id });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// PATCH /network/elements/:id — edit name/position/meta.
router.patch('/elements/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const rows = await prisma.$queryRawUnsafe(`SELECT id, meta FROM "NetworkElement" WHERE id=$1 AND "tenantId"=$2`, req.params.id, tenantId) as { id: string }[];
    if (!rows.length) return sendError(res, 'Not found', 404);
    const lat = num(req.body?.lat), lng = num(req.body?.lng);
    const name = clean(req.body?.name, 120);
    const meta = req.body?.meta && typeof req.body.meta === 'object' ? JSON.stringify(req.body.meta).slice(0, 4000) : null;
    await prisma.$executeRawUnsafe(
      `UPDATE "NetworkElement" SET name=COALESCE($1,name), lat=COALESCE($2,lat), lng=COALESCE($3,lng), meta=COALESCE($4,meta), photo=COALESCE($5,photo) WHERE id=$6`,
      name, lat, lng, meta, cleanPhoto(req.body?.photo), req.params.id);
    sendSuccess(res, { ok: true });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// DELETE /network/elements/:id — admin only; detaches its cables.
router.delete('/elements/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    if (req.user?.role !== 'TENANT_ADMIN' && req.user?.role !== 'SUPERADMIN') return sendError(res, 'Only admins can delete equipment', 403);
    await prisma.$executeRawUnsafe(`DELETE FROM "NetworkCable" WHERE "tenantId"=$1 AND ("fromId"=$2 OR "toId"=$2)`, tenantId, req.params.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "NetworkElement" WHERE "tenantId"=$1 AND (id=$2 OR "parentId"=$2)`, tenantId, req.params.id);
    sendSuccess(res, { ok: true });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /network/cables — run a cable from an element to another element OR to a bare GPS point
// (customer drops). Records length, cores, and the power at both ends.
router.post('/cables', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const fromId = clean(req.body?.fromId, 64);
    if (!fromId) return sendError(res, 'Select the starting equipment for the cable', 400);
    const from = await prisma.$queryRawUnsafe(`SELECT id FROM "NetworkElement" WHERE id=$1 AND "tenantId"=$2`, fromId, tenantId) as { id: string }[];
    if (!from.length) return sendError(res, 'Starting equipment not found', 404);
    const toId = clean(req.body?.toId, 64);
    const toLat = num(req.body?.toLat), toLng = num(req.body?.toLng);
    if (!toId && (toLat === null || toLng === null)) return sendError(res, 'Give the cable an end: equipment or a GPS point', 400);
    const lengthM = num(req.body?.lengthM);
    if (lengthM === null || lengthM <= 0) return sendError(res, 'Cable length (meters) is required', 400);
    const cores = Math.round(num(req.body?.cores) ?? 0);
    if (!cores || cores < 1 || cores > 288) return sendError(res, 'Core count is required (1–288)', 400);
    const id = uid();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "NetworkCable" (id, "tenantId", "fromId", "toId", "toLat", "toLng", "lengthM", cores, "powerStartDbm", "powerEndDbm", "isDrop", label, status, "createdBy", "createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ACTIVE',$13,NOW())`,
      id, tenantId, fromId, toId, toLat, toLng, lengthM, cores,
      num(req.body?.powerStartDbm), num(req.body?.powerEndDbm),
      !!req.body?.isDrop, clean(req.body?.label, 160), req.user?.userId || null);
    sendSuccess(res, { id });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// DELETE /network/cables/:id — admin only.
router.delete('/cables/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    if (req.user?.role !== 'TENANT_ADMIN' && req.user?.role !== 'SUPERADMIN') return sendError(res, 'Only admins can delete cables', 403);
    await prisma.$executeRawUnsafe(`DELETE FROM "NetworkCable" WHERE "tenantId"=$1 AND id=$2`, tenantId, req.params.id);
    sendSuccess(res, { ok: true });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /network/maintenance — technician logs a cable rerun / router re-issue; admin confirms.
router.post('/maintenance', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const kind = String(req.body?.kind || '').toUpperCase();
    if (!['CABLE_RERUN', 'ROUTER_REISSUE', 'OTHER'].includes(kind)) return sendError(res, 'kind must be CABLE_RERUN, ROUTER_REISSUE or OTHER', 400);
    const cableId = clean(req.body?.cableId, 64);
    const elementId = clean(req.body?.elementId, 64);
    if (!cableId && !elementId) return sendError(res, 'Attach the maintenance to a cable or equipment', 400);
    const id = uid();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "NetworkMaintenance" (id, "tenantId", "cableId", "elementId", kind, note, "newLengthM", status, "createdBy", "createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,NOW())`,
      id, tenantId, cableId, elementId, kind, clean(req.body?.note, 1000), num(req.body?.newLengthM), req.user?.userId || null);
    sendSuccess(res, { id, message: 'Logged — waiting for admin confirmation.' });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// PATCH /network/maintenance/:id — admin confirms or rejects. Confirming a CABLE_RERUN with a
// new length updates the cable record (the rerun becomes the length of record).
router.patch('/maintenance/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    if (req.user?.role !== 'TENANT_ADMIN' && req.user?.role !== 'SUPERADMIN') return sendError(res, 'Only admins can confirm maintenance', 403);
    const status = String(req.body?.status || '').toUpperCase();
    if (!['CONFIRMED', 'REJECTED'].includes(status)) return sendError(res, 'status must be CONFIRMED or REJECTED', 400);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, "cableId", kind, "newLengthM" FROM "NetworkMaintenance" WHERE id=$1 AND "tenantId"=$2 AND status='PENDING'`,
      req.params.id, tenantId) as { id: string; cableId: string | null; kind: string; newLengthM: number | null }[];
    if (!rows.length) return sendError(res, 'Pending maintenance record not found', 404);
    const m = rows[0];
    await prisma.$executeRawUnsafe(`UPDATE "NetworkMaintenance" SET status=$1, "resolvedAt"=NOW() WHERE id=$2`, status, m.id);
    if (status === 'CONFIRMED' && m.kind === 'CABLE_RERUN' && m.cableId && m.newLengthM && m.newLengthM > 0) {
      await prisma.$executeRawUnsafe(`UPDATE "NetworkCable" SET "lengthM"=$1 WHERE id=$2 AND "tenantId"=$3`, m.newLengthM, m.cableId, tenantId);
    }
    sendSuccess(res, { ok: true });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// GET /network/inventory — plant totals: routers, OLTs, domes, FATs/splitters, patch cords,
// cable meters broken down by core count, customer drops, pending maintenance.
router.get('/inventory', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const elemCounts = await prisma.$queryRawUnsafe(
      `SELECT type, COUNT(*)::int AS count FROM "NetworkElement" WHERE "tenantId"=$1 GROUP BY type`, tenantId) as { type: string; count: number }[];
    const cableByCores = await prisma.$queryRawUnsafe(
      `SELECT cores, COUNT(*)::int AS runs, COALESCE(SUM("lengthM"),0)::float AS meters FROM "NetworkCable" WHERE "tenantId"=$1 GROUP BY cores ORDER BY cores`, tenantId) as { cores: number; runs: number; meters: number }[];
    const drops = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM("lengthM"),0)::float AS meters FROM "NetworkCable" WHERE "tenantId"=$1 AND "isDrop"=true`, tenantId) as { count: number; meters: number }[];
    const pending = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM "NetworkMaintenance" WHERE "tenantId"=$1 AND status='PENDING'`, tenantId) as { count: number }[];
    const routers = await prisma.mikrotikRouter.count({ where: { tenantId } });
    const of = (t: string) => elemCounts.find(e => e.type === t)?.count || 0;

    // Splitter capacity across the plant: how many FAT ports exist, how many are taken, and which
    // FATs are already full — the number an ISP needs before promising a new connection.
    const fatRows = await prisma.$queryRawUnsafe(
      `SELECT id, name, meta FROM "NetworkElement" WHERE "tenantId"=$1 AND type='FAT'`, tenantId) as { id: string; name: string; meta: string | null }[];
    const outRows = await prisma.$queryRawUnsafe(
      `SELECT "fromId", COUNT(*)::int AS used FROM "NetworkCable" WHERE "tenantId"=$1 GROUP BY "fromId"`, tenantId) as { fromId: string; used: number }[];
    const usedBy: Record<string, number> = {};
    for (const r of outRows) usedBy[r.fromId] = r.used;
    let portsTotal = 0, portsUsed = 0;
    const fullFats: { id: string; name: string }[] = [];
    for (const f of fatRows) {
      const ports = ratioPorts(String(parseMeta(f.meta).ratio || ''));
      if (!ports) continue;
      const used = Math.min(usedBy[f.id] || 0, ports);
      portsTotal += ports; portsUsed += used;
      if (used >= ports) fullFats.push({ id: f.id, name: f.name });
    }
    sendSuccess(res, {
      routers,                       // linked MikroTiks on the platform
      mikrotiksOnMap: of('MIKROTIK'),
      olts: of('OLT'),
      domes: of('DOME'),
      fats: of('FAT'),
      patchCords: of('PATCH_CORD'),
      customers: of('CUSTOMER'),
      cableByCores,
      totalCableMeters: cableByCores.reduce((s, c) => s + c.meters, 0),
      customerDrops: drops[0] || { count: 0, meters: 0 },
      pendingMaintenance: pending[0]?.count || 0,
      splitterPorts: { total: portsTotal, used: portsUsed, free: Math.max(0, portsTotal - portsUsed) },
      fullFats,
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export default router;
