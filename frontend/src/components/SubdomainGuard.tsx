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
  const [sub, setSub] = useState('');

  useEffect(() => {
    const s = tenantSubdomainFromHost();
    setSub(s);
    if (!s) { setState('ok'); return; } // apex / reserved host — nothing to enforce here
    let cancelled = false;
    resolveSubdomain(s)
      .then(r => {
        if (cancelled) return;
        setInfo(r);
        if (!r.valid) setState('invalid');
        else if (r.usable === false) setState('suspended');
        else setState('ok');
      })
      .catch(() => { if (!cancelled) setState('invalid'); });
    return () => { cancelled = true; };
  }, []);

  if (state === 'checking') {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950">
        <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (state === 'invalid') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-950 text-white p-6">
        <div className="max-w-md text-center">
          <div className="text-5xl mb-4">🔍</div>
          <h1 className="text-2xl font-bold mb-2">Portal not found</h1>
          <p className="text-gray-400 mb-6">
            <span className="font-mono text-gray-300">{sub}</span> isn&apos;t a Dartbit portal. Check the address and try again.
          </p>
          <a href={`https://${process.env.NEXT_PUBLIC_PORTAL_BASE_DOMAIN || 'dartbittech.com'}`}
             className="inline-block px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 font-medium">
            Go to Dartbit
          </a>
        </div>
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
