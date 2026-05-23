'use client';
import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { billingVerify } from '@/lib/api';
import toast from 'react-hot-toast';

// Isolated component that reads ?verify=<ref> from the URL and confirms the payment.
// Kept separate (and Suspense-wrapped by its parent) so useSearchParams doesn't force
// the entire AppLayout — and therefore every page — into client-side bailout during
// Next.js static generation.
export default function PaymentVerifier({ enabled }: { enabled: boolean }) {
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const verifyRef = searchParams.get('verify');

  useEffect(() => {
    if (!verifyRef || !enabled) return;
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
  }, [verifyRef, enabled, qc]);

  return null;
}
