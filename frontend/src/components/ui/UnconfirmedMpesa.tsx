'use client';
// M-Pesa payments that haven't been confirmed yet, or were confirmed but are still being set up.
// Dartbit checks these with Safaricom automatically; this panel makes them visible and lets an admin
// ask Safaricom right now when a customer is standing there saying "I paid". Hidden when empty.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getUnconfirmedMpesa, recheckMpesa, type UnconfirmedMpesa as Row } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import toast from 'react-hot-toast';
import { RefreshCw, Clock } from 'lucide-react';

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function label(r: Row): string {
  if (r.status === 'PAID') return 'Paid — reconnecting the customer (retrying)';
  if (r.status === 'PROCESSING') return 'Paid — finishing setup';
  if (r.status === 'FAILED') return 'Phone didn’t respond — rechecking history';
  return r.resultDesc || 'Waiting for M-Pesa';
}

export default function UnconfirmedMpesa() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canRecheck = user?.role === 'TENANT_ADMIN';
  const { data } = useQuery({ queryKey: ['mpesa-unconfirmed'], queryFn: getUnconfirmedMpesa, refetchInterval: 30_000 });

  const recheck = useMutation({
    mutationFn: recheckMpesa,
    onSuccess: (r) => {
      if (r.status === 'PAID' && r.served) toast.success(`Paid${r.receipt ? ` (${r.receipt})` : ''} — customer is set up and reconnecting`);
      else if (r.status === 'PAID') toast('Payment is recorded, but the customer couldn\u2019t be reconnected yet — Dartbit keeps retrying. Check the router is online.', { duration: 8000 });
      else if (r.status === 'FAILED') toast(`M-Pesa says: ${r.message || 'not paid'}`);
      else if (r.outcome === 'needs-review') toast('Several possible matches in M-Pesa history — check the customer’s M-Pesa message for the code.', { duration: 8000 });
      else toast('M-Pesa hasn’t confirmed it yet. Dartbit keeps checking automatically.');
      qc.invalidateQueries({ queryKey: ['mpesa-unconfirmed'] });
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['subscribers'] });
    },
    onError: (e: { response?: { data?: { error?: string } } }) => toast.error(e?.response?.data?.error || 'Could not reach M-Pesa'),
  });

  if (!data?.length) return null;
  return (
    <div className="card p-4 mb-6 border border-amber-200 dark:border-amber-900/60">
      <div className="flex items-center gap-2 mb-1">
        <Clock size={16} className="text-amber-600" />
        <h3 className="font-semibold text-sm">M-Pesa payments needing attention ({data.length})</h3>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Dartbit keeps working on these automatically: confirming them with Safaricom, or getting paid customers back online. If a customer says they paid, tap Recheck.
      </p>
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {data.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">
                KES {r.amount.toLocaleString()} · {r.phone}{r.username ? ` · ${r.username}` : ''}
              </p>
              <p className="text-xs text-gray-500 truncate">{label(r)} · {ago(r.createdAt)}</p>
            </div>
            {canRecheck && (
              <button
                onClick={() => recheck.mutate(r.id)}
                disabled={recheck.isPending && recheck.variables === r.id}
                className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5 shrink-0"
              >
                <RefreshCw size={13} className={recheck.isPending && recheck.variables === r.id ? 'animate-spin' : ''} />
                Recheck
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
