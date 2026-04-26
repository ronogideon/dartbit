import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { signToken } from '../utils/jwt';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid input', 400);

    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return sendError(res, 'Invalid credentials', 401);

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return sendError(res, 'Invalid credentials', 401);

    const token = signToken({
      userId: user.id,
      role: user.role,
      tenantId: user.tenantId || undefined,
    });

    sendSuccess(res, {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
      },
    });
  } catch (err) {
    sendError(res, 'Login failed', 500);
  }
});

// Subscriber login for customer portal
const subscriberLoginSchema = z.object({
  username: z.string(),
  password: z.string(),
  tenantId: z.string(),
});

router.post('/subscriber-login', async (req: Request, res: Response) => {
  try {
    const parsed = subscriberLoginSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid input', 400);

    const { username, password, tenantId } = parsed.data;
    const subscriber = await prisma.subscriber.findFirst({
      where: { username, tenantId },
      include: { package: true },
    });

    if (!subscriber) return sendError(res, 'Invalid credentials', 401);
    if (subscriber.secret !== password) return sendError(res, 'Invalid credentials', 401);

    const token = signToken({
      userId: subscriber.id,
      role: 'SUBSCRIBER',
      tenantId: subscriber.tenantId,
    });

    sendSuccess(res, { token, subscriber });
  } catch {
    sendError(res, 'Login failed', 500);
  }
});

export default router;
