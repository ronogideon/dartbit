'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import PortalApp from '@/components/PortalApp';
import { tenantSubdomainFromHost } from '@/lib/api';

function PortalInner() {
  const sp = useSearchParams();
  // Prefer an explicit ?t= / ?subdomain= param; otherwise derive it from the host
  // (e.g. acme.dartbittech.com -> "acme").
  const subdomain = sp.get('t') || sp.get('subdomain') || tenantSubdomainFromHost();
  return <PortalApp subdomain={subdomain} />;
}

export default function PortalPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-950" />}>
      <PortalInner />
    </Suspense>
  );
}
