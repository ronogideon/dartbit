import { Router, Response } from 'express';
import crypto from 'crypto';
import prisma from '../utils/prisma';
import { authenticate, requireSuperAdmin, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

// Tenant-facing: active, non-expired announcements for the banner.
router.get('/', authenticate, async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, title, body, level, "createdAt" FROM "Announcement"
       WHERE active = true AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
       ORDER BY "createdAt" DESC LIMIT 10`,
    );
    sendSuccess(res, rows);
  } catch (err) { sendError(res, err instanceof Error ? err.message : 'Failed', 500); }
});

// Superadmin: list everything (incl. inactive/expired) for management.
router.get('/all', authenticate, requireSuperAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, title, body, level, active, "createdAt", "expiresAt" FROM "Announcement" ORDER BY "createdAt" DESC LIMIT 100`,
    );
    sendSuccess(res, rows);
  } catch (err) { sendError(res, err instanceof Error ? err.message : 'Failed', 500); }
});

// Superadmin: create.
router.post('/', authenticate, requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { title, body, level, expiresAt } = req.body || {};
    if (!title || !body) return sendError(res, 'Title and body are required', 400);
    const lvl = ['INFO', 'WARNING', 'CRITICAL'].includes(level) ? level : 'INFO';
    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Announcement" (id, title, body, level, active, "expiresAt", "createdAt")
       VALUES ($1,$2,$3,$4,true,$5,NOW())`,
      id, String(title).slice(0, 200), String(body).slice(0, 2000), lvl, expiresAt ? new Date(expiresAt) : null,
    );
    sendSuccess(res, { id });
  } catch (err) { sendError(res, err instanceof Error ? err.message : 'Failed', 500); }
});

// Superadmin: toggle active on/off.
router.patch('/:id', authenticate, requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.$executeRawUnsafe(`UPDATE "Announcement" SET active=$1 WHERE id=$2`, !!req.body?.active, req.params.id);
    sendSuccess(res, { ok: true });
  } catch (err) { sendError(res, err instanceof Error ? err.message : 'Failed', 500); }
});

// Superadmin: delete.
router.delete('/:id', authenticate, requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "Announcement" WHERE id=$1`, req.params.id);
    sendSuccess(res, { ok: true });
  } catch (err) { sendError(res, err instanceof Error ? err.message : 'Failed', 500); }
});

export default router;
