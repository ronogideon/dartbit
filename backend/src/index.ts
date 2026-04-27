import dotenv from 'dotenv';
// Load .env FIRST before anything else imports prisma
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

const app = express();
const PORT = process.env.PORT || 4000;

const allowedOrigins = [
  'https://dartbit-production.up.railway.app',
  'http://localhost:3000',
  'http://localhost:3001',
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, MikroTik)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());

// ── Root route ──────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    service: 'Dartbit API',
    version: '1.1.4',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: [
      'POST /auth/login',
      'POST /auth/subscriber-login',
      'POST /auth/subscriber-login-hotspot',
      'GET  /health',
      'GET  /subscribers',
      'GET  /packages',
      'GET  /payments',
      'GET  /messages',
      'GET  /mikrotiks',
      'GET  /online-sessions',
      'GET  /router/ztp-script?apiKey=',
      'POST /router/heartbeat',
      'POST /router/interfaces',
      'POST /router/sessions',
      'GET  /tenants',
      'GET  /settings',
    ],
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'dartbit-backend', version: '1.1.4', timestamp: new Date().toISOString() });
});

// ── Routes ──────────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/subscribers', subscriberRoutes);
app.use('/packages', packageRoutes);
app.use('/payments', paymentRoutes);
app.use('/messages', messageRoutes);
app.use('/mikrotiks', routerRoutes);
app.use('/online-sessions', onlineSessionRoutes);
app.use('/router', routerZtpRoutes);
app.use('/tenants', tenantRoutes);
app.use('/settings', settingsRoutes);

// ── 404 handler ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log('');
  console.log('🚀 Dartbit v1.1.4 backend running');
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/health`);
  console.log(`   DB:      ${process.env.DATABASE_URL ? '✓ DATABASE_URL set' : '✗ DATABASE_URL missing!'}`);
  console.log('');
});

export default app;
