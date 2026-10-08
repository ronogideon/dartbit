// Per-tenant app icons at the exact sizes installers require.
//   /app-icon/192, /app-icon/512  — home-screen icons (Android / desktop)
//   /app-icon/512?maskable=1      — Android adaptive icon (content kept inside the 80% safe zone)
//   /app-icon/180                 — apple-touch-icon (iOS ignores transparency, so always opaque)
//
// Tenant logos are stored as base64 data URLs of any shape and size, so they can't be listed in a
// manifest directly — Chrome refuses to install when a declared icon size doesn't match. Here the
// logo is fitted onto a square canvas. No usable logo -> the tenant's initial on their colour.
import { ImageResponse } from 'next/og';
import { getPwaBrand, DEFAULT_THEME, type PwaBrand } from '@/lib/pwaBrand';

export const dynamic = 'force-dynamic';

const SIZES = new Set([180, 192, 512]);

/** Satori renders PNG/JPEG/GIF reliably. Anything else (WebP, SVG data URLs) uses the initial. */
function usableLogo(url: string | null): string | null {
  if (!url) return null;
  if (/^data:image\/(png|jpe?g|gif);base64,/i.test(url)) return url;
  if (/^https:\/\/.+\.(png|jpe?g|gif)(\?.*)?$/i.test(url)) return url;
  return null;
}

function initialIcon(brand: PwaBrand, size: number, inset: number) {
  const letter = (brand.name.trim()[0] || 'D').toUpperCase();
  return (
    <div
      style={{
        width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: brand.themeColor || DEFAULT_THEME,
      }}
    >
      <div style={{ fontSize: Math.round((size - inset * 2) * 0.62), fontWeight: 700, color: '#ffffff', lineHeight: 1 }}>
        {letter}
      </div>
    </div>
  );
}

function logoIcon(logo: string, size: number, inset: number) {
  const box = size - inset * 2;
  return (
    <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#ffffff' }}>
      {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
      <img src={logo} width={box} height={box} style={{ objectFit: 'contain' }} />
    </div>
  );
}

async function render(node: React.ReactElement, size: number): Promise<ArrayBuffer> {
  // Buffer the whole image: ImageResponse renders lazily, so a decode failure would otherwise
  // surface mid-stream as a broken icon instead of an error we can recover from.
  return new ImageResponse(node, { width: size, height: size }).arrayBuffer();
}

export async function GET(req: Request, { params }: { params: { size: string } }) {
  const size = Number.parseInt(params.size, 10);
  if (!SIZES.has(size)) return new Response('Not found', { status: 404 });

  const url = new URL(req.url);
  const maskable = url.searchParams.get('maskable') === '1';
  const brand = await getPwaBrand(req.headers.get('x-forwarded-host') || req.headers.get('host'));

  // Maskable icons get cropped to a circle/squircle by Android, so keep content well inside.
  const inset = Math.round(size * (maskable ? 0.2 : 0.12));
  const logo = usableLogo(brand.logoUrl);

  let png: ArrayBuffer;
  try {
    png = await render(logo ? logoIcon(logo, size, inset) : initialIcon(brand, size, inset), size);
  } catch (err) {
    console.error('[app-icon] logo render failed, using initial:', err instanceof Error ? err.message : err);
    png = await render(initialIcon(brand, size, inset), size);
  }

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      // URLs carry ?v=<brand hash>, so a rebrand changes the URL; safe to cache for a day.
      'Cache-Control': 'public, max-age=86400',
      Vary: 'Host, X-Forwarded-Host',
    },
  });
}
