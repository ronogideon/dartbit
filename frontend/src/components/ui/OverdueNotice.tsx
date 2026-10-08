'use client';
import { AlertTriangle, Phone } from 'lucide-react';

// Shown to NON-admin staff when the tenant's invoice is OVERDUE. They can't pay, so instead of
// an invoice they get a plain explanation and the ISP's phone number to call. Admins see the
// full Paywall with the invoice and pay button instead.
export default function OverdueNotice({ name, phone }: { name?: string | null; phone?: string | null }) {
  const isp = name?.trim() || 'your ISP';
  const tel = phone?.replace(/[^\d+]/g, '');
  return (
    <div className="min-h-[100dvh] bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="card p-8 text-center">
          <div className="w-14 h-14 rounded-full bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center text-amber-600 mx-auto mb-5">
            <AlertTriangle size={26} />
          </div>
          <h1 className="text-xl font-bold mb-2">There&apos;s an issue with this account</h1>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            The dashboard is unavailable right now. Please contact {isp} to get it restored.
          </p>
          <p className="text-xs text-gray-500 mt-3">
            Customers are not affected — they stay online and can still pay for internet.
          </p>

          {tel ? (
            <a
              href={`tel:${tel}`}
              className="mt-7 flex items-center justify-center gap-2 w-full rounded-lg border border-gray-200 dark:border-gray-700 py-3 text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <Phone size={16} />
              {phone}
            </a>
          ) : (
            <p className="mt-7 text-sm text-gray-500">Contact your account administrator.</p>
          )}
        </div>
      </div>
    </div>
  );
}
