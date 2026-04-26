import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());

// Routes
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

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'dartbit-backend', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Dartbit backend running on port ${PORT}`);
});

export default app;
