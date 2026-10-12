'use client';
// Transaction-history recovery for tenants who collect through their own Daraja app. With it on,
// Dartbit can find payments in the shortcode's M-Pesa history even when Safaricom's confirmation
// never arrived. Needs a one-time registration with the number Safaricom nominated for the shortcode.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMpesaHistoryStatus, registerMpesaHistory } from '@/lib/api';
import toast from 'react-hot-toast';
import { CheckCircle2, History } from 'lucide-react';

export default function MpesaHistorySetup() {
  const qc = useQueryClient();
  const [number, setNumber] = useState('');
  const { data, isLoading, refetch, isFetching } = useQuery({ queryKey: ['mpesa-history-status'], queryFn: getMpesaHistoryStatus, staleTime: 60_000 });
  const reg = useMutation({
    mutationFn: registerMpesaHistory,
    onSuccess: (r) => {
      toast.success(r.alreadyRegistered ? 'Shortcode was already registered' : 'Registered with M-Pesa');
      qc.invalidateQueries({ queryKey: ['mpesa-history-status'] });
    },
    onError: (e: { response?: { data?: { error?: string } } }) => toast.error(e?.response?.data?.error || 'Registration failed'),
  });

  if (isLoading || !data?.applicable) return null;
  return (
    <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-800">
      <div className="flex items-center gap-2 mb-1">
        <History size={16} />
        <h3 className="font-semibold">Missed-payment recovery</h3>
      </div>
      <p className="text-sm text-gray-500 mb-3">
        Dartbit already asks Safaricom about any payment whose confirmation doesn&apos;t arrive. Turning on transaction history also lets it
        find payments where even that isn&apos;t possible, and record their M-Pesa codes.
      </p>
      {data.available ? (
        <p className="text-sm text-green-700 dark:text-green-400 flex items-center gap-2"><CheckCircle2 size={16} /> Transaction history is on{data.label ? ` (${data.label})` : ''}.</p>
      ) : (
        <>
          <p className="text-xs text-gray-500 mb-3">{data.message}</p>
          <label className="label">Safaricom number nominated for this shortcode</label>
          <div className="flex gap-2">
            <input className="input flex-1" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="07XX XXX XXX" inputMode="tel" />
            <button type="button" onClick={() => reg.mutate(number)} disabled={reg.isPending || number.replace(/\D/g, '').length < 9} className="btn-secondary shrink-0">
              {reg.isPending ? 'Registering…' : 'Register'}
            </button>
          </div>
          <button type="button" onClick={() => refetch()} disabled={isFetching} className="text-xs text-blue-600 mt-2">
            {isFetching ? 'Checking…' : 'Check again'}
          </button>
          <p className="text-xs text-gray-400 mt-2">Your Daraja app also needs the Pull Transactions product enabled on the Safaricom developer portal.</p>
        </>
      )}
    </div>
  );
}
