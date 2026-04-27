import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth';
import subscriberRoutes from './routes/subscribers';
import packageRoutes from './routes/packages';
import paymentRoutes from './routes/payments';
import messageRoutes from './routes/messages';
import routerRoutes from './routes/routers';
import onlineSessionRoutes from './routes/onlineSessions';
import routerZtpRoutes from './routes/routerZtp';
import tenantRoutes from './routes/tenants';
import settingsRoutes from './routes/settings';
import signupRoutes from './routes/signup';
import adminRoutes from './routes/admin';

const app = express();
const PORT = process.env.PORT || 4000;

const allowedOrigins = [
  'https://dartbit-production.up.railway.app',
  'https://accomplished-patience-production-dd5a.up.railway.app',
  'http://localhost:3000',
  'http://localhost:3001',
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());

// ── Public routes (no auth) ─────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    service: 'Dartbit API', version: '1.2.0', status: 'running',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.2.0', timestamp: new Date().toISOString() });
});

app.use('/auth', authRoutes);
app.use('/signup', signupRoutes);
app.use('/admin', adminRoutes);
app.use('/router', routerZtpRoutes); // MikroTik calls this without auth

// ── Authenticated routes ─────────────────────────────────────
app.use('/subscribers', subscriberRoutes);
app.use('/packages', packageRoutes);
app.use('/payments', paymentRoutes);
app.use('/messages', messageRoutes);
app.use('/mikrotiks', routerRoutes);
app.use('/online-sessions', onlineSessionRoutes);
app.use('/tenants', tenantRoutes);
app.use('/settings', settingsRoutes);

app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Dartbit v1.2.0 running on port ${PORT}`);
  console.log(`   DB: ${process.env.DATABASE_URL ? '✓ connected' : '✗ DATABASE_URL missing!'}\n`);
});

export default app;
