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

// GET /hotspot/portal — public captive portal page (renders a voucher login form)
// This is what the user sees when MikroTik redirects them. The page is served
// from Dartbit (whitelisted in walled garden).
router.get('/portal', async (req: Request, res: Response) => {
  const tenantSubdomain = String(req.query.tenant || '');
  const routerApiKey = String(req.query.apiKey || '');

  // Build a minimal HTML captive portal page
  // The MikroTik hotspot redirects: http://<gateway>/login?...
  // We're serving the portal at the backend so we don't need html-directory on MikroTik
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WiFi Login</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #667eea, #764ba2); padding: 20px; }
  .card { background: white; border-radius: 16px; padding: 32px; max-width: 400px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,0.2); }
  h1 { margin: 0 0 8px; color: #333; font-size: 28px; }
  p { color: #666; margin: 0 0 24px; font-size: 14px; }
  input { width: 100%; padding: 14px 16px; border: 2px solid #e5e7eb; border-radius: 10px; font-size: 18px; letter-spacing: 4px; text-transform: uppercase; text-align: center; outline: none; transition: border 0.2s; }
  input:focus { border-color: #667eea; }
  button { width: 100%; margin-top: 16px; padding: 14px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
  button:hover { opacity: 0.9; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .status { margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 14px; display: none; }
  .status.error { background: #fee; color: #c00; display: block; }
  .status.success { background: #efe; color: #060; display: block; }
  .logo { text-align: center; font-size: 24px; font-weight: 800; color: #667eea; margin-bottom: 8px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">DARTBIT WIFI</div>
  <h1>Enter Voucher Code</h1>
  <p>Type the code printed on your voucher to access the internet.</p>
  <form id="f">
    <input id="code" name="code" placeholder="XXXXXXXX" maxlength="16" autocomplete="off" autocapitalize="characters" required>
    <button type="submit" id="btn">Connect to Internet</button>
  </form>
  <div id="status" class="status"></div>
</div>
<script>
  const f = document.getElementById('f');
  const btn = document.getElementById('btn');
  const status = document.getElementById('status');
  const input = document.getElementById('code');

  // MikroTik passes these via the redirect URL — when running on the actual hotspot
  const params = new URLSearchParams(window.location.search);
  const mac = params.get('mac') || '';
  const ip = params.get('ip') || '';
  const linkLogin = params.get('link-login') || params.get('link-login-only') || '';
  const apiKey = ${JSON.stringify(routerApiKey)} || params.get('apiKey') || '';

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Connecting...';
    status.className = 'status'; status.textContent = '';
    const code = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');

    try {
      const r = await fetch('${process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app'}/hotspot/redeem', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, routerApiKey: apiKey, mac, ip })
      });
      const data = await r.json();
      if (!data.success) {
        status.className = 'status error'; status.textContent = data.error || 'Failed';
        btn.disabled = false; btn.textContent = 'Try again';
        return;
      }
      status.className = 'status success';
      status.textContent = 'Voucher accepted! Activating session...';

      // Wait for MikroTik to pick up the command (~30s), then submit hotspot login form
      let waited = 0;
      const tryLogin = () => {
        if (waited >= 35) {
          status.textContent = 'Setup complete. Click below to log in.';
          btn.disabled = false; btn.textContent = 'Log in now';
          btn.onclick = doLogin;
          return;
        }
        status.textContent = 'Activating... ' + (35 - waited) + 's';
        waited += 2;
        setTimeout(tryLogin, 2000);
      };
      tryLogin();

      function doLogin() {
        if (linkLogin) {
          // Build hotspot login form submission
          const form = document.createElement('form');
          form.method = 'POST';
          form.action = linkLogin;
          [['username', data.username], ['password', data.password], ['dst', '/'], ['popup', 'true']].forEach(([n,v]) => {
            const inp = document.createElement('input'); inp.type = 'hidden'; inp.name = n; inp.value = v; form.appendChild(inp);
          });
          document.body.appendChild(form);
          form.submit();
        } else {
          status.textContent = 'Username: ' + data.username + '. Use this on the hotspot login page.';
        }
      }
    } catch (err) {
      status.className = 'status error'; status.textContent = 'Network error — try again';
      btn.disabled = false; btn.textContent = 'Try again';
    }
  });
</script>
</body>
</html>`;

  res.type('text/html').send(html);
});

export default router;
