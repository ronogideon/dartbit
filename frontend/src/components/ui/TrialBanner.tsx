'use client';
import { useQuery } from '@tanstack/react-query';
import { getTenantInfo } from '@/lib/api';
import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';

interface TenantInfo {
  status: string;
  trialEndsAt?: string;
  name: string;
}

export default function TrialBanner() {
  const [dismissed, setDismissed] = useState(false);

  const { data: tenant } = useQuery({
    queryKey: ['tenant-info'],
    queryFn: getTenantInfo,
    staleTime: 60000,
  });

  if (!tenant || dismissed) return null;

  const t = tenant as TenantInfo;
  if (t.status !== 'TRIAL' || !t.trialEndsAt) return null;

  const daysLeft = Math.ceil((new Date(t.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (daysLeft <= 0) return null;

  const urgent = daysLeft <= 3;

  return (
    <div className={`flex items-center justify-between px-4 py-2 text-sm ${urgent ? 'bg-red-600' : 'bg-blue-600'} text-white`}>
      <div className="flex items-center gap-2">
        {urgent && <AlertTriangle size={14} />}
        <span>
          {urgent
            ? `⚠️ Your free trial expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}! `
            : `🎉 Free trial: ${daysLeft} days remaining. `}
          <span className="opacity-80 text-xs">Upgrade anytime to keep your data.</span>
        </span>
      </div>
      <button onClick={() => setDismissed(true)} className="opacity-70 hover:opacity-100 transition-opacity ml-4">
        <X size={14} />
      </button>
    </div>
  );
}
