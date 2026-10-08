// Per-tenant web app manifest. acme.dartbittech.com installs as "Acme ISP" with Acme's colour and
// logo; the apex installs as Dartbit. Resolved from the Host header on every request.
import { getPwaBrand, brandVersion, APP_BACKGROUND } from '@/lib/pwaBrand';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const brand = await getPwaBrand(req.headers.get('x-forwarded-host') || req.headers.get('host'));
  const v = brandVersion(brand);

  const manifest = {
    // Stable identity: reinstalling or rebranding updates the same app instead of adding a second.
    id: '/',
    name: brand.name,
    short_name: brand.shortName,
    description: brand.subdomain ? `${brand.name} — account and internet` : 'Dartbit ISP management',
    // /portal is the single sign-in for staff and customers. A signed-in admin is sent straight
    // on to the dashboard, a signed-in customer straight to their account.
    start_url: brand.subdomain ? '/portal?source=pwa' : '/?source=pwa',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: APP_BACKGROUND,
    theme_color: brand.themeColor,
    icons: [
      { src: `/app-icon/192?v=${v}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/app-icon/512?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/app-icon/512?v=${v}&maskable=1`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };

  return new Response(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      // Per-host content: never let a shared cache hand one tenant's manifest to another.
      'Cache-Control': 'public, max-age=300',
      Vary: 'Host, X-Forwarded-Host',
    },
  });
}
