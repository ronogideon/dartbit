'use client';
import { useEffect, useState, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { getTenantInfo } from '@/lib/api';
import Sidebar from '@/components/layout/Sidebar';
import TopBar from '@/components/layout/TopBar';
import AnnouncementBanner from '@/components/AnnouncementBanner';
import ForcePasswordChange from '@/components/ForcePasswordChange';
import TrialBanner from '@/components/ui/TrialBanner';
import PayNowBanner from '@/components/ui/PayNowBanner';
import Paywall from '@/components/ui/Paywall';
import PaymentVerifier from '@/components/ui/PaymentVerifier';

interface TenantInfo { billingStatus?: string; }

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

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

  const verifier = isTenantAdmin ? (
    <Suspense fallback={null}>
      <PaymentVerifier enabled={isTenantAdmin} />
    </Suspense>
  ) : null;

  const t = tenant as TenantInfo | undefined;
  const isOverdue = isTenantAdmin && t?.billingStatus === 'OVERDUE';
  if (isOverdue) {
    return (<>{verifier}<Paywall /></>);
  }

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950 overflow-hidden">
      {verifier}
      <ForcePasswordChange />
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar onMenuClick={() => setMobileOpen(true)} />
        {isTenantAdmin && <TrialBanner />}
        {isTenantAdmin && <PayNowBanner />}
        <main className="flex-1 overflow-auto">
          <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full">
            <AnnouncementBanner />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
