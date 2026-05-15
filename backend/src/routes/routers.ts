import { Router, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

const routerSchema = z.object({
  name: z.string().min(2),
  host: z.string().optional().default('auto'),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const where = tenantId ? { tenantId } : {};
    const routers = await prisma.mikrotikRouter.findMany({
      where,
      include: { interfaces: true, provConfig: true },
      orderBy: { createdAt: 'desc' },
    });
    sendSuccess(res, routers);
  } catch {
    sendError(res, 'Failed to fetch routers', 500);
  }
});

router.post('/link', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = routerSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant required', 400);

    const apiKey = uuidv4();
    let backendUrl = process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app';

    // Force HTTPS for Railway URLs (Railway redirects HTTP -> HTTPS but MikroTik /tool fetch doesn't follow redirects)
    if (backendUrl.startsWith('http://') && backendUrl.includes('railway.app')) {
      backendUrl = backendUrl.replace('http://', 'https://');
    }
    // If localhost is detected, use Railway URL instead (MikroTik can't reach localhost from the internet)
    if (backendUrl.includes('localhost') || backendUrl.includes('127.0.0.1')) {
      backendUrl = 'https://dartbit-production.up.railway.app';
    }

    const mikrotikRouter = await prisma.mikrotikRouter.create({
      data: {
        ...parsed.data,
        apiKey,
        tenantId,
        status: 'UNKNOWN',
      },
    });

    // Build bootstrap with proper HTTPS flags so MikroTik handles Railway's TLS correctly
    const isHttps = backendUrl.startsWith('https://');
    const fetchFlags = isHttps ? ' mode=https check-certificate=no' : '';
    const bootstrapCommand = `/tool fetch url="${backendUrl}/router/ztp-script?apiKey=${apiKey}" dst-path=dartbit-ztp.rsc${fetchFlags}; /import file-name=dartbit-ztp.rsc`;

    sendSuccess(res, {
      routerId: mikrotikRouter.id,
      apiKey,
      bootstrapCommand,
    }, 201);
  } catch {
    sendError(res, 'Failed to link router', 500);
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = routerSchema.partial().safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.message, 400);
    const r = await prisma.mikrotikRouter.update({
      where: { id: req.params.id },
      data: parsed.data,
    });
    sendSuccess(res, r);
  } catch {
    sendError(res, 'Failed to update router', 500);
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.mikrotikRouter.delete({ where: { id: req.params.id } });
    sendSuccess(res, { deleted: true });
  } catch {
    sendError(res, 'Failed to delete router', 500);
  }
});

export default router;
