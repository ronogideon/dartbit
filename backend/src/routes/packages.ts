import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

const packageSchema = z.object({
  name: z.string().min(2),
  service: z.enum(['PPPOE', 'HOTSPOT', 'STATIC']).default('PPPOE'),
  speedUpKbps: z.number().int().min(1),
  speedDownKbps: z.number().int().min(1),
  validityMinutes: z.number().int().min(1),
  price: z.number().min(0),
  isTrial: z.boolean().optional().default(false),
  routerIds: z.array(z.string()).optional().default([]), // empty = offered on all routers
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};
    const packages = await prisma.package.findMany({ where, orderBy: { price: 'asc' } });
    sendSuccess(res, packages);
  } catch {
    sendError(res, 'Failed to fetch packages', 500);
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = packageSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);

    const pkg = await prisma.package.create({ data: { ...parsed.data, tenantId } });
    sendSuccess(res, pkg, 201);
  } catch {
    sendError(res, 'Failed to create package', 500);
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = packageSchema.partial().safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);
    const pkg = await prisma.package.update({ where: { id: req.params.id }, data: parsed.data });
    sendSuccess(res, pkg);
  } catch {
    sendError(res, 'Failed to update package', 500);
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.package.delete({ where: { id: req.params.id } });
    sendSuccess(res, { deleted: true });
  } catch {
    sendError(res, 'Failed to delete package', 500);
  }
});

export default router;
