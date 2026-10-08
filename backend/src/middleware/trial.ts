import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import prisma from '../utils/prisma';
import { sendError } from '../utils/response';

export const checkTrial = async (req: AuthRequest, res: Response, next: NextFunction) => {
  // Skip for superadmin
  if (req.user?.role === 'SUPERADMIN') return next();

  const tenantId = req.user?.tenantId;
  if (!tenantId) return next();

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, trialEndsAt: true, isActive: true, billingStatus: true },
    });

    if (!tenant) return sendError(res, 'Tenant not found', 404);
    if (!tenant.isActive) return sendError(res, 'Account suspended. Please contact support.', 403);

    // Overdue invoice: block the operational dashboard for EVERY role, not just admins. This list
    // of routes is the dashboard only — /billing, /tenants, /settings, /users, the subscriber
    // portal, M-Pesa callbacks and router endpoints are mounted without this middleware, so
    // admins can still pay and subscribers stay online and can still pay for internet.
    if (tenant.billingStatus === 'OVERDUE') {
      return sendError(res, 'This account has an overdue invoice. Features are disabled until it is paid.', 402);
    }

    // Check trial expiry
    if (tenant.status === 'TRIAL' && tenant.trialEndsAt) {
      if (new Date() > tenant.trialEndsAt) {
        return sendError(res, 'Your 14-day free trial has expired. Please upgrade to continue.', 402);
      }
    }

    next();
  } catch {
    next(); // Don't block on error
  }
};
