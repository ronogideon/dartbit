'use client';
import { useQuery } from '@tanstack/react-query';
import { getTenantInfo } from '@/lib/api';
import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface TenantInfo {
  status: string;
  billingDueDate?: string;
  billingStatus?: string;
  name: string;
}

export default function PayNowBanner() {
  const [dismissed, setDismissed] = useState(false);
  const router = useRouter();

  const { data: tenant } = useQuery({
    queryKey: ['tenant-info'],
    queryFn: getTenantInfo,
    staleTime: 60000,
  });

  if (!tenant || dismissed) return null;
  const t = tenant as TenantInfo;

  // Only relevant once a billing due date is set (i.e. tenant is on a paid plan).
  if (!t.billingDueDate) return null;
  // If already overdue, the paywall handles it — no banner needed here.
  if (t.billingStatus === 'OVERDUE') return null;

  const daysLeft = Math.ceil((new Date(t.billingDueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  // Show the banner only within 5 days of the due date.
  if (daysLeft > 5) return null;

  const urgent = daysLeft <= 2;
  const goToBilling = () => router.push('/settings?tab=billing');

  return (
    <div className={`flex items-center justify-between px-4 py-2 text-sm ${urgent ? 'bg-red-600' : 'bg-blue-600'} text-white`}>
      <div className="flex items-center gap-2">
        {urgent && <AlertTriangle size={14} />}
        <span>
          {daysLeft <= 0
            ? `⚠️ Payment due today. `
            : urgent
              ? `⚠️ Payment due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}! `
              : `💳 Payment due in ${daysLeft} days. `}
          <span className="opacity-80 text-xs">Pay now to avoid service interruption.</span>
        </span>
        <button
          onClick={goToBilling}
          className="ml-2 px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 text-xs font-medium transition-colors"
        >
          Pay Now
        </button>
      </div>
      <button onClick={() => setDismissed(true)} className="opacity-70 hover:opacity-100 transition-opacity ml-4">
        <X size={14} />
      </button>
    </div>
  );
}
