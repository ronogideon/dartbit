import { Router, Request, Response } from 'express';
import prisma from '../utils/prisma';

const router = Router();

// GET /hotspot-html/login?apiKey=xxx
// Returns the login.html content that MikroTik serves as the captive portal.
// It's a tiny page that redirects to our hosted portal (passing along $(mac), $(ip), $(link-login))
router.get('/login', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || '');
    if (!apiKey) return res.status(400).type('text/plain').send('# missing apiKey');

    const r = await prisma.mikrotikRouter.findUnique({ where: { apiKey } });
    if (!r) return res.status(404).type('text/plain').send('# router not found');

    let backendUrl = process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app';
    if (backendUrl.startsWith('http://') && backendUrl.includes('railway.app')) {
      backendUrl = backendUrl.replace('http://', 'https://');
    }

    // RouterOS templates use $(variable) — these get expanded by MikroTik when serving.
    // We pass the user's MAC, IP, and link-login (the URL MikroTik wants the POST submitted to)
    // along to the Dartbit portal page so it can submit credentials back to MikroTik.
    const portalUrl = `${backendUrl}/hotspot/portal?apiKey=${apiKey}`;
    const html = `<html>
<head>
<title>Dartbit WiFi</title>
<meta http-equiv="refresh" content="0;url=${portalUrl}&mac=$(mac)&ip=$(ip)&link-login=$(link-login-only)&link-orig=$(link-orig-esc)">
<style>body{font-family:sans-serif;text-align:center;padding:40px}</style>
</head>
<body>
<h2>Connecting to Dartbit WiFi...</h2>
<p>Redirecting to login. <a href="${portalUrl}&mac=$(mac)&ip=$(ip)&link-login=$(link-login-only)">Tap here if not redirected</a></p>
</body>
</html>`;
    res.type('text/html').send(html);
  } catch (err) {
    res.status(500).type('text/plain').send('# error: ' + (err instanceof Error ? err.message : 'unknown'));
  }
});

export default router;
