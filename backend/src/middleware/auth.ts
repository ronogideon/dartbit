import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../utils/jwt';
import { sendError } from '../utils/response';

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return sendError(res, 'Unauthorized', 401);
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch {
    return sendError(res, 'Invalid or expired token', 401);
  }
};

export const requireSuperAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'SUPERADMIN') {
    return sendError(res, 'Forbidden: Superadmin only', 403);
  }
  next();
};

// Read access for analytics: full superadmins AND view-only superadmin team members.
export const requireSuperAdminRead = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!['SUPERADMIN', 'SUPERADMIN_VIEWER'].includes(req.user?.role || '')) {
    return sendError(res, 'Forbidden: Superadmin only', 403);
  }
  next();
};

export const requireTenantAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!['SUPERADMIN', 'TENANT_ADMIN'].includes(req.user?.role || '')) {
    return sendError(res, 'Forbidden', 403);
  }
  next();
};
