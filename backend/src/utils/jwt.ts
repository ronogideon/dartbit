import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dartbit-secret';

export interface JwtPayload {
  userId: string;
  role: string;
  tenantId?: string;
}

export const signToken = (payload: JwtPayload): string => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
};

export const verifyToken = (token: string): JwtPayload => {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
};
