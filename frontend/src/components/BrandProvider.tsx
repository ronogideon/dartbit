'use client';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { getBranding } from '@/lib/api';
import { fontStack } from '@/lib/fonts';

// Applies the tenant's chosen theme colour + font across the admin app at runtime. Because the
// app's Tailwind classes bake in blue at build time, we inject a <style> block that re-points the
// key "primary" surfaces (btn-primary, badge-blue, focus rings, and common blue utilities used
// for branding) at the tenant's colour via a CSS variable. Superadmins are skipped (they keep
// Dartbit blue). This is intentionally scoped to brand surfaces, not every blue in the UI.
function hexToRgb(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '37, 99, 235';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
function darken(hex: string, amt = 0.12): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.max(0, Math.round(((n >> 16) & 255) * (1 - amt)));
  const g = Math.max(0, Math.round(((n >> 8) & 255) * (1 - amt)));
  const b = Math.max(0, Math.round((n & 255) * (1 - amt)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export default function BrandProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const isSuper = user?.role === 'SUPERADMIN' || user?.role === 'SUPERADMIN_VIEWER';

  const { data } = useQuery({
    queryKey: ['branding-theme'],
    queryFn: getBranding,
    enabled: !!user && !isSuper,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  useEffect(() => {
    const styleId = 'tenant-brand-style';
    let el = document.getElementById(styleId) as HTMLStyleElement | null;
    // Superadmin or no custom branding → remove any injected overrides (back to default blue).
    const color = data?.themeColor;
    const font = data?.fontFamily;

    if (isSuper || (!color && !font)) {
      if (el) el.remove();
      document.documentElement.style.removeProperty('--brand-font');
      return;
    }

    if (!el) { el = document.createElement('style'); el.id = styleId; document.head.appendChild(el); }
    const c = color && /^#[0-9a-f]{6}$/i.test(color) ? color : '#2563eb';
    const cDark = darken(c);
    const rgb = hexToRgb(c);
    const stack = fontStack(font);

    document.documentElement.style.setProperty('--brand', c);
    document.documentElement.style.setProperty('--brand-font', stack);

    // Override the brand surfaces. Kept deliberately specific.
    el.textContent = `
      :root { --brand: ${c}; }
      body { font-family: ${stack}; }
      .btn-primary { background-color: ${c} !important; }
      .btn-primary:hover { background-color: ${cDark} !important; }
      .badge-blue { background-color: rgba(${rgb}, 0.12) !important; color: ${c} !important; }
      .input:focus { box-shadow: 0 0 0 2px rgba(${rgb}, 0.45) !important; border-color: ${c} !important; }
      .bg-blue-600 { background-color: ${c} !important; }
      .hover\\:bg-blue-700:hover { background-color: ${cDark} !important; }
      .text-blue-600 { color: ${c} !important; }
      .border-blue-600 { border-color: ${c} !important; }
      .ring-blue-500 { --tw-ring-color: ${c} !important; }
    `;
  }, [data, isSuper]);

  return <>{children}</>;
}
