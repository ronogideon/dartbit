'use client';
import { useEffect, useState } from 'react';
import { tenantSubdomainFromHost, resolveSubdomain, type SubdomainResolution } from '@/lib/api';

// Enforces strict subdomain routing on the client:
//  - Apex / www / no-subdomain host  → render children (marketing/signup/app as usual).
//  - A tenant subdomain               → validate it against the backend first. Only a real,
//    active tenant subdomain renders the app; anything else shows a "portal not found" screen
//    and never exposes a login or customer portal.
// This is the application-layer half of enforcement; see deploy notes for the DNS/cert half.
export default function SubdomainGuard({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'ok' | 'invalid' | 'suspended'>('checking');
  const [info, setInfo] = useState<SubdomainResolution | null>(null);

  useEffect(() => {
    const s = tenantSubdomainFromHost();
    if (!s) { setState('ok'); return; } // apex / reserved host — nothing to enforce here
    let cancelled = false;
    resolveSubdomain(s)
      .then(r => {
        if (cancelled) return;
        setInfo(r);
        if (!r.valid) {
          // Nonexistent subdomain → send to the apex marketing/signup page.
          const base = process.env.NEXT_PUBLIC_PORTAL_BASE_DOMAIN || 'dartbittech.com';
          if (typeof window !== 'undefined') {
            const target = `${window.location.protocol}//${base}/`;
            // Avoid a redirect loop if we're somehow already on the base host.
            if (window.location.hostname !== base) { window.location.replace(target); return; }
          }
          setState('invalid');
        } else if (r.usable === false) {
          setState('suspended');
        } else {
          setState('ok');
        }
      })
      .catch(() => {
        // On resolve failure, treat as unknown → apex marketing.
        if (cancelled) return;
        const base = process.env.NEXT_PUBLIC_PORTAL_BASE_DOMAIN || 'dartbittech.com';
        if (typeof window !== 'undefined' && window.location.hostname !== base) {
          window.location.replace(`${window.location.protocol}//${base}/`);
          return;
        }
        setState('invalid');
      });
    return () => { cancelled = true; };
  }, []);

  if (state === 'checking' || state === 'invalid') {
    // 'invalid' is transient — we redirect to the apex marketing page; show the spinner meanwhile.
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950">
        <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (state === 'suspended') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-950 text-white p-6">
        <div className="max-w-md text-center">
          <div className="text-5xl mb-4">⏸️</div>
          <h1 className="text-2xl font-bold mb-2">{info?.name || 'This portal'} is unavailable</h1>
          <p className="text-gray-400">
            This portal is currently {info?.status === 'SUSPENDED' ? 'suspended' : 'inactive'}. Please contact your internet provider.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
