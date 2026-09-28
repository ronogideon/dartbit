import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Dartbit - ISP Management',
  description: 'ISP Billing & MikroTik Management Platform',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

// Applies the saved theme before paint to avoid a light/dark flash on load.
const themeInit = `(function(){try{var t=localStorage.getItem('dartbit_theme');var d=t?t==='dark':window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('dark');}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        {/* Preconnect only. The tenant's single chosen font (if any) is loaded at runtime by
            BrandProvider — default/system-font tenants download no webfonts at all. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      {/* min-h-[100dvh], NOT min-h-screen and NOT overflow-hidden.
            - min-h-screen is 100vh: when browser chrome makes dvh smaller than vh, the body grows
              past the viewport and the DOCUMENT gets a scrollbar on top of <main>'s, which is the
              double-scrollbar on the admin pages. Matching dvh to AppLayout's own h-[100dvh] means
              the body is exactly viewport height, so it never scrolls.
            - overflow-hidden here would be wrong: the customer portal and /t pages do NOT use
              AppLayout, so they have no inner scroll container and clipping the body left them
              unscrollable. Scrolling containment belongs to AppLayout, not to every page. */}
      <body className="bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 min-h-[100dvh]">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
