import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma';
import { decryptDarajaCreds, centralDarajaCreds, stkPush, normalizePhone } from '../utils/daraja';
import { resolveTenantBySubdomain } from '../utils/tenantResolve';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dartbit-dev-secret';

// Daraja requires a fully-qualified https callback URL. Normalize in case BACKEND_URL
// is set without a protocol (which Safaricom rejects as "Invalid Callback URL").
function normalizeBackendUrl(): string {
  let u = process.env.BACKEND_URL || 'https://api.dartbittech.com';
  u = u.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (u.includes('localhost') || u.includes('127.0.0.1')) u = 'api.dartbittech.com';
  return 'https://' + u;
}

// Resolve the tenant from the request (subdomain, ?t=, or header).
async function resolveTenant(req: Request) {
  return resolveTenantBySubdomain(req);
}

function signSubscriberToken(payload: { sid: string; tid: string; kind: 'PPPOE' | 'HOTSPOT' }): string {
  return jwt.sign({ ...payload, scope: 'subscriber' }, JWT_SECRET, { expiresIn: '2d' });
}

interface SubReq extends Request { sub?: { sid: string; tid: string; kind: string } }

function authSubscriber(req: SubReq, res: Response, next: () => void) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const p = jwt.verify(h.split(' ')[1], JWT_SECRET) as { sid: string; tid: string; kind: string; scope: string };
    if (p.scope !== 'subscriber') return res.status(401).json({ success: false, error: 'Invalid token' });
    req.sub = { sid: p.sid, tid: p.tid, kind: p.kind };
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

// GET /portal/tenant — public: returns tenant branding for the login page + portal
router.get('/tenant', async (req: Request, res: Response) => {
  const t = await resolveTenant(req);
  if (!t) return res.status(404).json({ success: false, error: 'Unknown portal' });
  res.json({
    success: true,
    tenant: {
      name: t.name,
      subdomain: t.subdomain,
      logoUrl: t.logoUrl || null,
      themeColor: t.themeColor || null,
      fontFamily: t.fontFamily || null,
      // Support number to display on the portal; defaults to the registered phone.
      supportPhone: t.supportPhone || t.phone || null,
    },
  });
});

// POST /portal/login — authenticate a subscriber.
// Body: { username, password, subdomain? }
// Tries PPPoE/static subscriber creds first, then hotspot auto-generated creds.
router.post('/login', async (req: Request, res: Response) => {
  try {
    const t = await resolveTenant(req);
    if (!t) return res.status(404).json({ success: false, error: 'Unknown portal' });
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, error: 'Enter username and password' });

    // 1. PPPoE / static subscriber (username + secret)
    const subscriber = await prisma.subscriber.findFirst({
      where: { tenantId: t.id, username: String(username) },
    });
    if (subscriber && subscriber.secret === String(password)) {
      const token = signSubscriberToken({ sid: subscriber.id, tid: t.id, kind: 'PPPOE' });
      return res.json({ success: true, token, kind: 'PPPOE' });
    }

    // 2. Hotspot auto-generated creds (from a paid MpesaTransaction)
    const tx = await prisma.mpesaTransaction.findFirst({
      where: { tenantId: t.id, username: String(username), status: 'PAID' },
      orderBy: { createdAt: 'desc' },
    });
    if (tx && tx.password === String(password)) {
      const token = signSubscriberToken({ sid: tx.id, tid: t.id, kind: 'HOTSPOT' });
      return res.json({ success: true, token, kind: 'HOTSPOT' });
    }

    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  } catch (err) {
    console.error('portal/login error:', err);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

function fmtBytes(n: bigint): string {
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  if (b < 1099511627776) return `${(b / 1073741824).toFixed(2)} GB`;
  return `${(b / 1099511627776).toFixed(2)} TB`;
}

// GET /portal/account — subscriber's account info + 30-day usage + recent sessions
router.get('/account', authSubscriber, async (req: SubReq, res: Response) => {
  try {
    const { sid, tid, kind } = req.sub!;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    if (kind === 'PPPOE') {
      const s = await prisma.subscriber.findUnique({ where: { id: sid }, include: { package: true } });
      if (!s || s.tenantId !== tid) return res.status(404).json({ success: false, error: 'Not found' });

      const records = await prisma.sessionRecord.findMany({
        where: { tenantId: tid, subscriberId: sid, startedAt: { gte: thirtyDaysAgo } },
        orderBy: { startedAt: 'desc' }, take: 50,
      });
      let up = 0n, down = 0n;
      const sessions = records.map(r => { up += r.rxBytes; down += r.txBytes; return {
        startedAt: r.startedAt, endedAt: r.endedAt, active: !r.endedAt,
        download: fmtBytes(r.txBytes), upload: fmtBytes(r.rxBytes),
      }; });

      return res.json({ success: true, account: {
        kind: 'PPPOE',
        name: s.fullName, username: s.username,
        package: s.package?.name, isActive: s.isActive,
        expiresAt: s.expiresAt, lastOnlineAt: s.lastOnlineAt,
        usage30d: { download: fmtBytes(down), upload: fmtBytes(up) },
        sessions,
      }});
    } else {
      // Hotspot account = the MpesaTransaction
      const tx = await prisma.mpesaTransaction.findUnique({ where: { id: sid } });
      if (!tx || tx.tenantId !== tid) return res.status(404).json({ success: false, error: 'Not found' });
      const pkg = tx.packageId ? await prisma.package.findUnique({ where: { id: tx.packageId } }) : null;
      const expired = tx.expiresAt ? tx.expiresAt < new Date() : false;
      return res.json({ success: true, account: {
        kind: 'HOTSPOT',
        name: tx.phone, username: tx.username,
        package: pkg?.name, isActive: !expired,
        expiresAt: tx.expiresAt, lastOnlineAt: null,
        usage30d: null, sessions: [],
      }});
    }
  } catch (err) {
    console.error('portal/account error:', err);
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// GET /portal/packages — packages available for renewal/purchase for this tenant
router.get('/packages', authSubscriber, async (req: SubReq, res: Response) => {
  try {
    const { tid, sid } = req.sub!;
    // Show only packages matching the subscriber's account type. Hotspot accounts see HOTSPOT
    // packages; PPPoE/Static accounts see wired packages (PPPOE + STATIC) — never cross-type.
    const sub = await prisma.subscriber.findUnique({ where: { id: sid }, select: { service: true } });
    const allowedServices = sub?.service === 'HOTSPOT' ? ['HOTSPOT'] : ['PPPOE', 'STATIC'];
    const pkgs = await prisma.package.findMany({
      where: { tenantId: tid, isActive: true, service: { in: allowedServices as ('PPPOE' | 'STATIC' | 'HOTSPOT')[] } },
      select: { id: true, name: true, price: true, validityMinutes: true, speedDownKbps: true, speedUpKbps: true, service: true },
      orderBy: { price: 'asc' },
    });
    res.json({ success: true, packages: pkgs });
  } catch {
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// POST /portal/renew — subscriber initiates an STK push to renew/buy a package.
// Body: { packageId, phone }
router.post('/renew', authSubscriber, async (req: SubReq, res: Response) => {
  try {
    const { tid } = req.sub!;
    const { packageId, phone } = req.body || {};
    if (!packageId || !phone) return res.status(400).json({ success: false, error: 'Package and phone required' });

    const pkg = await prisma.package.findUnique({ where: { id: packageId } });
    if (!pkg || pkg.tenantId !== tid) return res.status(404).json({ success: false, error: 'Package not found' });

    const cfg = await prisma.paymentConfig.findUnique({ where: { tenantId: tid } });
    if (!cfg) return res.status(400).json({ success: false, error: 'Payments not set up for this provider' });

    // Pick collecting credentials (tenant own vs Dartbit central)
    let creds: ReturnType<typeof decryptDarajaCreds> = null;
    let collectedVia: 'TENANT' | 'DARTBIT' = 'TENANT';
    if (cfg.method === 'DARAJA_API') {
      creds = decryptDarajaCreds(cfg); collectedVia = 'TENANT';
      if (!creds) return res.status(400).json({ success: false, error: 'Payment credentials incomplete' });
    } else if (cfg.method === 'TILL_MANUAL' || cfg.method === 'PHONE_MANUAL') {
      creds = centralDarajaCreds(); collectedVia = 'DARTBIT';
      if (!creds) return res.status(503).json({ success: false, error: 'Central payment service unavailable' });
    } else {
      return res.status(400).json({ success: false, error: 'Payment method not supported here' });
    }

    const durationMinutes = pkg.validityMinutes || 60;
    const platformFee = collectedVia === 'DARTBIT' ? Math.ceil(pkg.price * 0.01) : 0;
    const netToTenant = collectedVia === 'DARTBIT' ? Math.max(0, pkg.price - platformFee) : pkg.price;

    // Find the subscriber's router (for provisioning) — use their assigned one, else first tenant router
    let routerId: string | null = null;
    let subUsername: string | null = null;
    const { sid, kind } = req.sub!;
    {
      const s = await prisma.subscriber.findUnique({ where: { id: sid }, select: { routerId: true, username: true } });
      subUsername = s?.username || null;
      if (kind === 'PPPOE') routerId = s?.routerId || null;
    }
    if (!routerId) {
      const firstRouter = await prisma.mikrotikRouter.findFirst({ where: { tenantId: tid }, select: { id: true } });
      routerId = firstRouter?.id || null;
    }

    const tx = await prisma.mpesaTransaction.create({
      data: {
        tenantId: tid, routerId, packageId: pkg.id,
        // payer phone may be ANY number — the renewal is bound to the subscriber, not the phone.
        phone: normalizePhone(phone), amount: pkg.price, status: 'PENDING',
        durationMinutes, collectedVia, platformFee, netToTenant,
        subscriberId: sid, username: subUsername,
      } as never,
    });

    try {
      const result = await stkPush({
        creds, phone, amount: pkg.price,
        accountRef: 'Dartbit', description: 'Renewal',
        callbackUrl: `${normalizeBackendUrl()}/hotspot/stk-callback/${tx.id}`,
      });
      await prisma.mpesaTransaction.update({ where: { id: tx.id }, data: { checkoutRequestId: result.checkoutRequestId, merchantRequestId: result.merchantRequestId } });
      res.json({ success: true, transactionId: tx.id });
    } catch (e) {
      await prisma.mpesaTransaction.update({ where: { id: tx.id }, data: { status: 'FAILED', resultDesc: e instanceof Error ? e.message : 'STK failed' } });
      res.status(502).json({ success: false, error: e instanceof Error ? e.message : 'Payment failed to start' });
    }
  } catch (err) {
    console.error('portal/renew error:', err);
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// GET /portal/renew-status/:txId — poll renewal payment status
router.get('/renew-status/:txId', authSubscriber, async (req: SubReq, res: Response) => {
  try {
    const tx = await prisma.mpesaTransaction.findUnique({
      where: { id: req.params.txId },
      select: { status: true, tenantId: true, resultDesc: true },
    });
    if (!tx || tx.tenantId !== req.sub!.tid) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, status: tx.status, message: tx.resultDesc });
  } catch {
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

export default router;
