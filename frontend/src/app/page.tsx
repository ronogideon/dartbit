'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { tenantSubdomainFromHost } from '@/lib/api';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    // On a tenant subdomain → the unified login (admin or customer).
    // On the apex / www → the marketing + signup page.
    const sub = tenantSubdomainFromHost();
    router.replace(sub ? '/auth/login' : '/signup');
  }, [router]);
  return (
    <div className="flex items-center justify-center h-screen bg-gray-950">
      <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
    </div>
  );
}
