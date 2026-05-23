'use client';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getBillingCurrent, billingCheckout } from '@/lib/api';
import { Lock, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';

function fmtKES(n: number): string {
  return 'KES ' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

// Full-screen invoice shown when the tenant's account is OVERDUE.
// Replaces all app content until payment is confirmed.
export default function Paywall() {
  const { data, isLoading } = useQuery({ queryKey: ['billing-current'], queryFn: getBillingCurrent });
  const checkoutMut = useMutation({
    mutationFn: billingCheckout,
    onSuccess: (res: { authorizationUrl: string }) => { window.location.href = res.authorizationUrl; },
    onError: (e: { response?: { data?: { error?: string } } }) => toast.error(e?.response?.data?.error || 'Could not start checkout'),
  });

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
      <div className="max-w-lg w-full">
        <div className="card p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/40 flex items-center justify-center text-red-600">
              <Lock size={22} />
            </div>
            <div>
              <h1 className="text-xl font-bold">Account Suspended</h1>
              <p className="text-sm text-gray-500">Payment required to restore access</p>
            </div>
          </div>

          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-6 flex items-start gap-2">
            <AlertTriangle size={16} className="text-red-600 mt-0.5 shrink-0" />
            <p className="text-sm text-red-700 dark:text-red-300">
              Your invoice is past due. Access to the dashboard is locked until payment is confirmed.
            </p>
          </div>

          {isLoading ? (
            <div className="text-center py-6 text-gray-400">Loading invoice...</div>
          ) : data ? (
            <>
              <div className="space-y-3 mb-6">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-300">Active PPPoE ({data.breakdown.pppoeCount} × KES 20)</span>
                  <span className="font-medium">{fmtKES(data.breakdown.pppoeCharge)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-300">Hotspot 3% ({fmtKES(data.breakdown.hotspotIncome)})</span>
                  <span className="font-medium">{fmtKES(data.breakdown.hotspotCharge)}</span>
                </div>
                <div className="border-t-2 border-gray-300 dark:border-gray-600 pt-3 flex items-center justify-between">
                  <span className="font-semibold">Amount Due</span>
                  <span className="font-bold text-2xl text-red-600">{fmtKES(data.breakdown.appliedCharge)}</span>
                </div>
                <div className="text-xs text-gray-400">
                  Due date: {fmtDate(data.tenant.billingDueDate)}
                </div>
              </div>

              <button
                className="btn-primary w-full"
                onClick={() => checkoutMut.mutate()}
                disabled={checkoutMut.isPending}
              >
                {checkoutMut.isPending ? 'Starting…' : `Pay ${fmtKES(data.breakdown.appliedCharge)} Now`}
              </button>
            </>
          ) : (
            <div className="text-center py-6 text-red-500">Failed to load invoice</div>
          )}

          <p className="text-xs text-gray-400 text-center mt-4">
            Need help? Contact support to resolve your billing.
          </p>
        </div>
      </div>
    </div>
  );
}
