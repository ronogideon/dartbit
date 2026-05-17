import { Router, Request, Response } from 'express';
import prisma from '../utils/prisma';
import { enqueueCommand } from '../utils/commandQueue';

const router = Router();

// Public endpoint — NO auth. Captive portal calls this when user submits a voucher.
// POST /hotspot/redeem
// body: { code: string, routerApiKey: string, mac?: string, ip?: string }
// Returns: { username, password, success } — captive portal uses these to do
// the actual MikroTik hotspot login form submission
router.post('/redeem', async (req: Request, res: Response) => {
  try {
    const { code, routerApiKey, mac, ip } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ success: false, error: 'code required' });
    }
    if (!routerApiKey || typeof routerApiKey !== 'string') {
      return res.status(400).json({ success: false, error: 'routerApiKey required' });
    }

    // Look up router
    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey: routerApiKey } });
    if (!r) return res.status(404).json({ success: false, error: 'Router not found' });

    // Look up voucher
    const cleanCode = code.toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
    const voucher = await prisma.voucher.findUnique({
      where: { code: cleanCode },
      include: { package: true },
    });
    if (!voucher) return res.status(404).json({ success: false, error: 'Invalid voucher code' });
    if (voucher.tenantId !== r.tenantId) return res.status(403).json({ success: false, error: 'Voucher not valid for this router' });
    if (voucher.isUsed) return res.status(400).json({ success: false, error: 'Voucher already used' });
    if (voucher.expiresAt && voucher.expiresAt < new Date()) {
      return res.status(400).json({ success: false, error: 'Voucher expired' });
    }

    // Mark as used and capture session info
    const now = new Date();
    const sessionExpiresAt = new Date(now.getTime() + voucher.durationMinutes * 60 * 1000);
    const usedMac = typeof mac === 'string' ? mac.replace(/[^A-Fa-f0-9:.\-]/g, '').substring(0, 20) : null;
    const usedIp = typeof ip === 'string' ? ip.replace(/[^0-9.]/g, '').substring(0, 16) : null;

    await prisma.voucher.update({
      where: { id: voucher.id },
      data: {
        isUsed: true,
        usedAt: now,
        usedByMac: usedMac,
        usedByIp: usedIp,
        expiresAt: sessionExpiresAt, // session-end time
      },
    });

    // Username = code, password = code (simple for voucher-style)
    const username = cleanCode;
    const password = cleanCode;
    const speed = voucher.package
      ? `${voucher.package.speedUpKbps}k/${voucher.package.speedDownKbps}k`
      : '10M/10M';
    const profileName = voucher.package
      ? `dartbit-vch-${voucher.package.id.substring(0, 8)}`
      : 'dartbit-default';

    // Push hotspot user to MikroTik via the command channel.
    // The user is created with session-timeout=<duration> so MikroTik
    // auto-disconnects when time expires.
    const sessionTimeoutSeconds = voucher.durationMinutes * 60;
    const commands = [
      `:if ([:len [/ip hotspot user profile find name="${profileName}"]] = 0) do={ /ip hotspot user profile add name=${profileName} rate-limit=${speed} shared-users=1 mac-cookie-timeout=0s session-timeout=${sessionTimeoutSeconds}s comment="Dartbit voucher profile" }`,
      `:if ([:len [/ip hotspot user find name="${username}"]] = 0) do={ /ip hotspot user add name=${username} password=${password} profile=${profileName} limit-uptime=${sessionTimeoutSeconds}s comment="Dartbit-voucher:${voucher.id}" } else={ /ip hotspot user set [find name="${username}"] password=${password} profile=${profileName} limit-uptime=${sessionTimeoutSeconds}s disabled=no }`,
      `:log info "Dartbit: voucher ${cleanCode} redeemed, valid ${voucher.durationMinutes}min"`,
    ];

    enqueueCommand(r.id, commands.join('\n'));

    return res.json({
      success: true,
      username,
      password,
      durationMinutes: voucher.durationMinutes,
      package: voucher.package?.name,
      message: 'Voucher accepted — please wait ~30 seconds for credentials to activate, then click Login on the captive portal',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed';
    console.error('Voucher redeem error:', msg);
    res.status(500).json({ success: false, error: msg });
  }
});

// Public — list HOTSPOT packages available at this router (for the buy flow)
// GET /hotspot/packages?apiKey=xxx
router.get('/packages', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || '');
    if (!apiKey) return res.status(400).json({ success: false, error: 'apiKey required' });
    const r = await prisma.mikrotikRouter.findUnique({
      where: { apiKey },
      include: { tenant: true },
    });
    if (!r) return res.status(404).json({ success: false, error: 'Router not found' });

    const packages = await prisma.package.findMany({
      where: { tenantId: r.tenantId, service: 'HOTSPOT', isActive: true },
      select: { id: true, name: true, speedUpKbps: true, speedDownKbps: true, validityMinutes: true, price: true },
      orderBy: { price: 'asc' },
    });
    res.json({
      success: true,
      tenantName: r.tenant.name,
      packages,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Failed' });
  }
});

// Public — purchase a package (creates a one-off voucher and returns the code)
// POST /hotspot/purchase { packageId, routerApiKey, phone?, mac?, ip? }
// In a real deployment this would integrate with M-Pesa STK push or other payment.
// For now it just creates a voucher immediately and returns the code (treat as "pay later" or test mode).
router.post('/purchase', async (req: Request, res: Response) => {
  try {
    const { packageId, routerApiKey, phone, mac, ip } = req.body || {};
    if (!packageId || !routerApiKey) {
      return res.status(400).json({ success: false, error: 'packageId and routerApiKey required' });
    }

    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey: String(routerApiKey) } });
    if (!r) return res.status(404).json({ success: false, error: 'Router not found' });

    const pkg = await prisma.package.findUnique({ where: { id: String(packageId) } });
    if (!pkg) return res.status(404).json({ success: false, error: 'Package not found' });
    if (pkg.tenantId !== r.tenantId) return res.status(403).json({ success: false, error: 'Package not available here' });
    if (pkg.service !== 'HOTSPOT') return res.status(400).json({ success: false, error: 'Only hotspot packages can be purchased here' });

    // Generate a single voucher
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];

    const voucher = await prisma.voucher.create({
      data: {
        code,
        tenantId: r.tenantId,
        packageId: pkg.id,
        routerId: r.id,
        durationMinutes: pkg.validityMinutes,
        notes: `Purchased via portal${phone ? ` (${String(phone).substring(0, 20)})` : ''}`,
      },
    });

    // Note: We don't create a Payment record here because the Payment model
    // requires a subscriberId. Voucher itself tracks the transaction (with notes).
    // In a real deployment, M-Pesa STK push integration would create a payment first
    // and only generate the voucher after confirmation.

    // Push the voucher onto the router immediately
    const profileName = `dartbit-hspkg-${pkg.id.substring(0, 8)}`;
    const speed = `${pkg.speedUpKbps}k/${pkg.speedDownKbps}k`;
    const sessionSec = pkg.validityMinutes * 60;
    const commands = [
      `:if ([:len [/ip hotspot user profile find name="${profileName}"]] = 0) do={ /ip hotspot user profile add name=${profileName} rate-limit=${speed} shared-users=1 mac-cookie-timeout=0s comment="Dartbit voucher profile" }`,
      `:if ([:len [/ip hotspot user find name="${code}"]] = 0) do={ /ip hotspot user add name=${code} password=${code} profile=${profileName} limit-uptime=${sessionSec}s comment="Dartbit-voucher:${voucher.id}" }`,
      `:log info "Dartbit: purchased voucher ${code} for package ${pkg.name}"`,
    ];
    enqueueCommand(r.id, commands.join('\n'));

    res.json({
      success: true,
      code,
      packageName: pkg.name,
      durationMinutes: pkg.validityMinutes,
      price: pkg.price,
      message: 'Voucher created. It will be active on the router within 30 seconds. Use the code to log in.',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Failed' });
  }
});

// Public — verify a subscriber username/password
// POST /hotspot/verify { username, password, routerApiKey, mac, ip }
router.post('/verify', async (req: Request, res: Response) => {
  try {
    const { username, password, routerApiKey, mac, ip } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, error: 'username and password required' });
    if (!routerApiKey) return res.status(400).json({ success: false, error: 'routerApiKey required' });

    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey: String(routerApiKey) } });
    if (!r) return res.status(404).json({ success: false, error: 'Router not found' });

    // Look up subscriber. Service must be HOTSPOT.
    const sub = await prisma.subscriber.findFirst({
      where: { tenantId: r.tenantId, username: String(username), service: 'HOTSPOT' },
    });
    if (!sub) return res.status(401).json({ success: false, error: 'Invalid username or password' });
    if (sub.secret !== String(password)) return res.status(401).json({ success: false, error: 'Invalid username or password' });
    if (!sub.isActive) return res.status(403).json({ success: false, error: 'Account inactive' });
    if (sub.expiresAt && sub.expiresAt < new Date()) return res.status(403).json({ success: false, error: 'Account expired' });

    // Update last seen
    await prisma.subscriber.update({
      where: { id: sub.id },
      data: {
        lastOnlineAt: new Date(),
        ipAddress: typeof ip === 'string' ? ip.replace(/[^0-9.]/g, '').substring(0, 16) : undefined,
        macAddress: typeof mac === 'string' ? mac.replace(/[^A-Fa-f0-9:.\-]/g, '').substring(0, 20) : undefined,
        routerId: r.id,
      },
    });

    return res.json({
      success: true,
      username: sub.username,
      password: sub.secret,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Failed' });
  }
});

// GET /hotspot/portal — kept for backward compat but no longer used by MikroTik
router.get('/portal', async (req: Request, res: Response) => {
  const routerApiKey = String(req.query.apiKey || '');
  const linkLogin = String(req.query['link-login'] || '');
  const userMac = String(req.query.mac || '');
  const userIp = String(req.query.ip || '');
  const linkOrig = String(req.query['link-orig'] || '/');

  const backendUrl = process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app';

  // Build a clean portal page
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WiFi Login</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; }
  .card { background: white; border-radius: 20px; padding: 36px 28px; max-width: 420px; width: 100%; box-shadow: 0 25px 70px rgba(0,0,0,0.25); }
  .logo { text-align: center; font-size: 26px; font-weight: 900; color: #667eea; letter-spacing: 2px; margin-bottom: 4px; }
  .tagline { text-align: center; font-size: 13px; color: #999; margin-bottom: 28px; }
  h2 { font-size: 18px; color: #222; margin-bottom: 8px; }
  p.help { font-size: 14px; color: #666; margin-bottom: 20px; line-height: 1.5; }
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; background: #f3f4f6; padding: 4px; border-radius: 10px; }
  .tab { flex: 1; padding: 10px; text-align: center; font-size: 14px; font-weight: 600; color: #888; cursor: pointer; border-radius: 8px; transition: all 0.2s; }
  .tab.active { background: white; color: #667eea; box-shadow: 0 2px 6px rgba(0,0,0,0.08); }
  .panel { display: none; }
  .panel.active { display: block; }
  label { display: block; font-size: 12px; font-weight: 600; color: #555; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  input { width: 100%; padding: 14px 16px; border: 2px solid #e5e7eb; border-radius: 12px; font-size: 16px; outline: none; transition: border 0.2s; margin-bottom: 12px; }
  input.code { letter-spacing: 4px; text-transform: uppercase; text-align: center; font-weight: 700; font-size: 22px; }
  input:focus { border-color: #667eea; }
  button { width: 100%; padding: 14px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: 700; cursor: pointer; transition: opacity 0.2s, transform 0.05s; }
  button:hover { opacity: 0.95; }
  button:active { transform: translateY(1px); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .status { margin-top: 16px; padding: 12px 16px; border-radius: 10px; font-size: 14px; line-height: 1.4; display: none; }
  .status.error { background: #fef2f2; color: #b91c1c; border: 1px solid #fee2e2; display: block; }
  .status.success { background: #f0fdf4; color: #166534; border: 1px solid #dcfce7; display: block; }
  .status.info { background: #eff6ff; color: #1e40af; border: 1px solid #dbeafe; display: block; }
  .small { font-size: 11px; color: #aaa; text-align: center; margin-top: 18px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">DARTBIT</div>
  <div class="tagline">WiFi Login Portal</div>

  <div class="tabs">
    <div class="tab active" data-tab="voucher">Voucher Code</div>
    <div class="tab" data-tab="account">Username</div>
  </div>

  <div class="panel active" id="panel-voucher">
    <h2>Enter your voucher code</h2>
    <p class="help">Type the code printed on your ticket to access the WiFi.</p>
    <form id="voucher-form">
      <label>Voucher code</label>
      <input class="code" id="voucher-code" placeholder="XXXXXXXX" maxlength="16" autocomplete="off" autocapitalize="characters" required>
      <button type="submit" id="voucher-btn">Connect</button>
    </form>
  </div>

  <div class="panel" id="panel-account">
    <h2>Sign in with your account</h2>
    <p class="help">If you have an existing account, log in below.</p>
    <form id="account-form">
      <label>Username</label>
      <input id="account-username" placeholder="Your username" autocomplete="username" required>
      <label>Password</label>
      <input id="account-password" type="password" placeholder="Your password" autocomplete="current-password" required>
      <button type="submit" id="account-btn">Sign in</button>
    </form>
  </div>

  <div id="status" class="status"></div>
  <div class="small">Powered by Dartbit</div>
</div>

<script>
(function() {
  const params = new URLSearchParams(window.location.search);
  const apiKey = ${JSON.stringify(routerApiKey)};
  const linkLogin = ${JSON.stringify(linkLogin)} || params.get('link-login') || '';
  const mac = ${JSON.stringify(userMac)} || params.get('mac') || '';
  const ip = ${JSON.stringify(userIp)} || params.get('ip') || '';
  const backendUrl = ${JSON.stringify(backendUrl)};

  const status = document.getElementById('status');
  function showStatus(type, text) { status.className = 'status ' + type; status.textContent = text; }
  function clearStatus() { status.className = 'status'; status.textContent = ''; }

  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('panel-' + t.dataset.tab).classList.add('active');
      clearStatus();
    });
  });

  // Submit form to MikroTik's link-login endpoint to actually authenticate the session.
  // This must be a form POST (not fetch) because MikroTik responds with redirects.
  function submitToMikrotik(username, password) {
    if (!linkLogin) {
      showStatus('error', 'No login URL provided. Try refreshing the page.');
      return;
    }
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = linkLogin;
    [['username', username], ['password', password], ['dst', '/'], ['popup', 'true']].forEach(([n, v]) => {
      const inp = document.createElement('input');
      inp.type = 'hidden'; inp.name = n; inp.value = v;
      form.appendChild(inp);
    });
    document.body.appendChild(form);
    form.submit();
  }

  // === Voucher flow ===
  document.getElementById('voucher-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const btn = document.getElementById('voucher-btn');
    const code = document.getElementById('voucher-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    btn.disabled = true; btn.textContent = 'Checking...';
    clearStatus();

    try {
      const r = await fetch(backendUrl + '/hotspot/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, routerApiKey: apiKey, mac, ip })
      });
      const data = await r.json();
      if (!data.success) {
        showStatus('error', data.error || 'Invalid voucher');
        btn.disabled = false; btn.textContent = 'Connect';
        return;
      }
      showStatus('success', 'Voucher accepted! Logging you in...');
      // The voucher username/password are already on the router (synced).
      // Submit to MikroTik's hotspot login endpoint.
      setTimeout(() => submitToMikrotik(data.username, data.password), 800);
    } catch (err) {
      showStatus('error', 'Network error: ' + (err.message || 'unknown'));
      btn.disabled = false; btn.textContent = 'Connect';
    }
  });

  // === Account (subscriber) flow ===
  document.getElementById('account-form').addEventListener('submit', function(e) {
    e.preventDefault();
    const username = document.getElementById('account-username').value;
    const password = document.getElementById('account-password').value;
    showStatus('info', 'Signing in...');
    // For existing hotspot subscribers, credentials are already on the router via subscriber sync.
    // Just submit directly to MikroTik.
    submitToMikrotik(username, password);
  });
})();
</script>
</body>
</html>`;
  res.type('text/html').send(html);
});

export default router;
