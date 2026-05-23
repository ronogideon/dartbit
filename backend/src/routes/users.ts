import { Router, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

// Only TENANT_ADMIN (or SUPERADMIN) may manage system users.
function requireTenantAdmin(req: AuthRequest, res: Response): boolean {
  const role = req.user?.role;
  if (role !== 'TENANT_ADMIN' && role !== 'SUPERADMIN') {
    sendError(res, 'Only admins can manage system users', 403);
    return false;
  }
  return true;
}

// Generate a readable temporary password (e.g. "Dbt-7F3K9A2X")
function genTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += chars[bytes[i] % chars.length];
  return `Dbt-${s}`;
}

// GET /users — list system users for this tenant
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);
    const users = await prisma.user.findMany({
      where: { tenantId, role: { in: ['TENANT_ADMIN', 'TENANT_VIEWER'] } },
      select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    sendSuccess(res, users);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

const createSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  role: z.enum(['TENANT_ADMIN', 'TENANT_VIEWER']),
});

// POST /users — create a system user with a generated temp password (returned once)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!requireTenantAdmin(req, res)) return;
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'No tenant', 400);

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.errors[0].message, 400);
    const { name, email, role } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return sendError(res, 'A user with that email already exists', 409);

    const tempPassword = genTempPassword();
    const hashed = await bcrypt.hash(tempPassword, 10);
    const user = await prisma.user.create({
      data: { name, email, role, tenantId, password: hashed, isActive: true },
      select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
    });

    // Return the temp password ONCE so the admin can share it. Never stored in plain text.
    sendSuccess(res, { user, tempPassword });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  role: z.enum(['TENANT_ADMIN', 'TENANT_VIEWER']).optional(),
  isActive: z.boolean().optional(),
});

// PUT /users/:id — update name/role/active (within same tenant)
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (!requireTenantAdmin(req, res)) return;
    const tenantId = req.user?.tenantId;
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || target.tenantId !== tenantId) return sendError(res, 'User not found', 404);

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.errors[0].message, 400);

    // Don't allow demoting/deactivating yourself (avoid locking yourself out)
    if (target.id === req.user?.userId && (parsed.data.role === 'TENANT_VIEWER' || parsed.data.isActive === false)) {
      return sendError(res, 'You cannot change your own role or deactivate yourself', 400);
    }

    const user = await prisma.user.update({
      where: { id: target.id },
      data: parsed.data,
      select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
    });
    sendSuccess(res, user);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// POST /users/:id/reset-password — generate a new temp password (returned once)
router.post('/:id/reset-password', async (req: AuthRequest, res: Response) => {
  try {
    if (!requireTenantAdmin(req, res)) return;
    const tenantId = req.user?.tenantId;
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || target.tenantId !== tenantId) return sendError(res, 'User not found', 404);

    const tempPassword = genTempPassword();
    const hashed = await bcrypt.hash(tempPassword, 10);
    await prisma.user.update({ where: { id: target.id }, data: { password: hashed } });
    sendSuccess(res, { tempPassword });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

// DELETE /users/:id — remove a system user (cannot delete yourself)
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (!requireTenantAdmin(req, res)) return;
    const tenantId = req.user?.tenantId;
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || target.tenantId !== tenantId) return sendError(res, 'User not found', 404);
    if (target.id === req.user?.userId) return sendError(res, 'You cannot delete yourself', 400);

    await prisma.user.delete({ where: { id: target.id } });
    sendSuccess(res, { ok: true });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed', 500);
  }
});

export default router;
