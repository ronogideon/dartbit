'use client';
import { useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { getTenantInfo, billingVerify } from '@/lib/api';
import Sidebar from '@/components/layout/Sidebar';
import TrialBanner from '@/components/ui/TrialBanner';
import PayNowBanner from '@/components/ui/PayNowBanner';
import Paywall from '@/components/ui/Paywall';
import toast from 'react-hot-toast';

interface TenantInfo { billingStatus?: string; }

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qc = useQueryClient();

  useEffect(() => {
    if (!isLoading && !user) router.push('/auth/login');
  }, [user, isLoading, router]);

  const { data: tenant } = useQuery({
    queryKey: ['tenant-info'],
    queryFn: getTenantInfo,
    staleTime: 60000,
    enabled: !!user && user.role === 'TENANT_ADMIN',
  });

  // Handle Paystack return (?verify=<ref>) at the layout level, so it works even
  // when the paywall is active (an overdue tenant paying to regain access).
  const verifyRef = searchParams.get('verify');
  useEffect(() => {
    if (!verifyRef || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await billingVerify(verifyRef);
        if (cancelled) return;
        if (result.paid || result.alreadyPaid) toast.success('Payment confirmed — thank you!');
        else toast.error('Payment not completed.');
        qc.invalidateQueries({ queryKey: ['billing-current'] });
        qc.invalidateQueries({ queryKey: ['billing-history'] });
        qc.invalidateQueries({ queryKey: ['tenant-info'] });
        window.history.replaceState({}, '', '/settings?tab=billing');
      } catch {
        if (!cancelled) toast.error('Could not verify payment.');
      }
    })();
    return () => { cancelled = true; };
  }, [verifyRef, user, qc]);

  if (isLoading) return (
    <div className="flex items-center justify-center h-screen bg-gray-50 dark:bg-gray-950">
      <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
    </div>
  );

  if (!user) return null;

  // Hard paywall: if the tenant is OVERDUE, lock the entire dashboard behind the invoice.
  // Superadmins are exempt. The paywall replaces all page content.
  const t = tenant as TenantInfo | undefined;
  const isOverdue = user.role === 'TENANT_ADMIN' && t?.billingStatus === 'OVERDUE';
  if (isOverdue) {
    return <Paywall />;
  }

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950 overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        {user.role === 'TENANT_ADMIN' && <TrialBanner />}
        {user.role === 'TENANT_ADMIN' && <PayNowBanner />}
        <main className="flex-1 overflow-auto">
          <div className="p-6 max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
