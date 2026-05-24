'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import PortalApp from '@/components/PortalApp';

function PortalInner() {
  const sp = useSearchParams();
  const subdomain = sp.get('t') || sp.get('subdomain') || '';
  return <PortalApp subdomain={subdomain} />;
}

export default function PortalPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-950" />}>
      <PortalInner />
    </Suspense>
  );
}
