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
import OverdueNotice from '@/components/ui/OverdueNotice';
import PaymentVerifier from '@/components/ui/PaymentVerifier';

interface TenantInfo { billingStatus?: string; name?: string; phone?: string | null; supportPhone?: string | null; }

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!isLoading && !user) router.push('/auth/login');
  }, [user, isLoading, router]);

  // Every tenant user needs this, not just admins: the paywall applies to all roles, and the
  // backend now returns 402 on dashboard routes for an overdue tenant regardless of role.
  const { data: tenant, isLoading: tenantLoading } = useQuery({
    queryKey: ['tenant-info'],
    queryFn: getTenantInfo,
    staleTime: 60000,
    enabled: !!user && !!user.tenantId,
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-[100dvh] bg-gray-50 dark:bg-gray-950">
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

  // Hold the page until billing status is known, so an overdue tenant doesn't flash broken pages
  // (every dashboard request 402s) before the paywall appears. Only on the first load — cached after.
  if (user.tenantId && tenantLoading) return (
    <div className="flex items-center justify-center h-[100dvh] bg-gray-50 dark:bg-gray-950">
      <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
    </div>
  );

  const t = tenant as TenantInfo | undefined;
  if (t?.billingStatus === 'OVERDUE') {
    // Admins get the invoice and can pay. Everyone else gets an explanation and a number to call.
    return isTenantAdmin
      ? (<>{verifier}<Paywall /></>)
      : <OverdueNotice name={t.name} phone={t.phone || t.supportPhone} />;
  }

  // 100dvh, not 100vh: vh ignores browser chrome (Chrome promo bars, the mobile URL bar), so the
  // app container ends up taller than the visible viewport and the whole page scrolls, leaving dead
  // space below the content. dvh tracks the ACTUAL viewport and collapses that gap.
  return (
    <div className="flex h-[100dvh] bg-gray-50 dark:bg-gray-950 overflow-hidden">
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
