'use client';
import { useEffect, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { getTenantInfo } from '@/lib/api';
import Sidebar from '@/components/layout/Sidebar';
import TrialBanner from '@/components/ui/TrialBanner';
import PayNowBanner from '@/components/ui/PayNowBanner';
import Paywall from '@/components/ui/Paywall';
import PaymentVerifier from '@/components/ui/PaymentVerifier';

interface TenantInfo { billingStatus?: string; }

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) router.push('/auth/login');
  }, [user, isLoading, router]);

  const { data: tenant } = useQuery({
    queryKey: ['tenant-info'],
    queryFn: getTenantInfo,
    staleTime: 60000,
    enabled: !!user && user.role === 'TENANT_ADMIN',
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-screen bg-gray-50 dark:bg-gray-950">
      <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
    </div>
  );

  if (!user) return null;

  const isTenantAdmin = user.role === 'TENANT_ADMIN';

  // Handle Paystack return (?verify=<ref>) — isolated + Suspense-wrapped so it doesn't
  // force every page into client-side-only rendering. Works even behind the paywall.
  const verifier = isTenantAdmin ? (
    <Suspense fallback={null}>
      <PaymentVerifier enabled={isTenantAdmin} />
    </Suspense>
  ) : null;

  // Hard paywall: if the tenant is OVERDUE, lock the entire dashboard behind the invoice.
  const t = tenant as TenantInfo | undefined;
  const isOverdue = isTenantAdmin && t?.billingStatus === 'OVERDUE';
  if (isOverdue) {
    return (<>{verifier}<Paywall /></>);
  }

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950 overflow-hidden">
      {verifier}
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        {isTenantAdmin && <TrialBanner />}
        {isTenantAdmin && <PayNowBanner />}
        <main className="flex-1 overflow-auto">
          <div className="p-6 max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
