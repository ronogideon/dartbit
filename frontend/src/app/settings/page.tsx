'use client';
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSettings, updateSettings, getBillingCurrent, getBillingHistory } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import toast from 'react-hot-toast';
import { Settings as SettingsIcon, CreditCard, Users } from 'lucide-react';

type Tab = 'general' | 'billing' | 'users';

interface Settings {
  currency?: string; timezone?: string; backendUrl?: string;
  smsSenderId?: string; smsApiKey?: string; emailFromAddress?: string;
}

function fmtKES(n: number): string {
  return 'KES ' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('general');

  return (
    <AppLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Manage your account, billing, and team</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-800 mb-6">
        <TabButton active={tab === 'general'} onClick={() => setTab('general')} icon={<SettingsIcon size={16} />} label="General" />
        <TabButton active={tab === 'billing'} onClick={() => setTab('billing')} icon={<CreditCard size={16} />} label="Billing" />
        <TabButton active={tab === 'users'} onClick={() => setTab('users')} icon={<Users size={16} />} label="System Users" />
      </div>

      {tab === 'general' && <GeneralTab />}
      {tab === 'billing' && <BillingTab />}
      {tab === 'users' && <UsersTab />}
    </AppLayout>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-blue-600 text-blue-600'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
      }`}
    >
      {icon} {label}
    </button>
  );
}

/* ---------------- General ---------------- */
function GeneralTab() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  const [form, setForm] = useState<Settings>({
    currency: 'KES', timezone: 'Africa/Nairobi', backendUrl: '', smsSenderId: '', smsApiKey: '', emailFromAddress: '',
  });
  useEffect(() => { if (settings) setForm(settings as Settings); }, [settings]);

  const updateMut = useMutation({
    mutationFn: updateSettings,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); toast.success('Settings saved'); },
    onError: () => toast.error('Failed to save settings'),
  });

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading...</div>;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="card p-6">
        <h2 className="font-semibold mb-4">Regional</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Currency</label>
            <input className="input" value={form.currency || ''} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))} />
          </div>
          <div>
            <label className="label">Timezone</label>
            <input className="input" value={form.timezone || ''} onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))} />
          </div>
        </div>
      </div>

      <div className="card p-6">
        <h2 className="font-semibold mb-4">SMS Configuration</h2>
        <div className="space-y-4">
          <div>
            <label className="label">SMS Sender ID</label>
            <input className="input" value={form.smsSenderId || ''} onChange={e => setForm(f => ({ ...f, smsSenderId: e.target.value }))} placeholder="DARTBIT" />
          </div>
          <div>
            <label className="label">SMS API Key</label>
            <input className="input" type="password" value={form.smsApiKey || ''} onChange={e => setForm(f => ({ ...f, smsApiKey: e.target.value }))} placeholder="Your SMS provider API key" />
          </div>
        </div>
      </div>

      <button onClick={() => updateMut.mutate(form)} disabled={updateMut.isPending} className="btn-primary w-full">
        {updateMut.isPending ? 'Saving...' : 'Save Settings'}
      </button>
    </div>
  );
}

/* ---------------- Billing ---------------- */
function BillingTab() {
  const { data, isLoading } = useQuery({ queryKey: ['billing-current'], queryFn: getBillingCurrent });
  const { data: history } = useQuery({ queryKey: ['billing-history'], queryFn: getBillingHistory });

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading...</div>;
  if (!data) return <div className="text-center py-8 text-red-500">Failed to load billing</div>;

  const b = data.breakdown;

  return (
    <div className="max-w-3xl space-y-6">
      {/* Current invoice */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">Current Invoice</h2>
          <span className="text-xs text-gray-500">
            {fmtDate(b.periodStart)} – {fmtDate(b.periodEnd)}
          </span>
        </div>

        <div className="space-y-3">
          <Row label={`Active PPPoE customers (${b.pppoeCount} × KES 20)`} value={fmtKES(b.pppoeCharge)} />
          <Row label={`Hotspot income (${fmtKES(b.hotspotIncome)} × 3%)`} value={fmtKES(b.hotspotCharge)} />
          <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
            <Row label="Computed total" value={fmtKES(b.computed)} muted />
            <Row label="Minimum fee" value={fmtKES(b.minFee)} muted />
          </div>
          <div className="border-t-2 border-gray-300 dark:border-gray-600 pt-3 flex items-center justify-between">
            <span className="font-semibold text-lg">Amount Due</span>
            <span className="font-bold text-2xl text-blue-600">{fmtKES(b.appliedCharge)}</span>
          </div>
          <p className="text-xs text-gray-400">
            Billed as the greater of the minimum fee or (PPPoE charge + 3% of hotspot income).
          </p>
        </div>

        <div className="mt-5 flex items-center justify-between">
          <div className="text-sm text-gray-500">
            Due date: <span className="font-medium text-gray-700 dark:text-gray-200">{fmtDate(data.tenant.billingDueDate)}</span>
          </div>
          <button
            className="btn-primary"
            onClick={() => toast('Paystack checkout coming in the next update', { icon: '⏳' })}
          >
            Pay Now
          </button>
        </div>
      </div>

      {/* Payment history */}
      <div className="card p-6">
        <h2 className="font-semibold mb-4">Payment History</h2>
        {!history || history.length === 0 ? (
          <div className="text-sm text-gray-400 text-center py-6">No payments yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200 dark:border-gray-800">
                  <th className="py-2 font-medium">Date</th>
                  <th className="py-2 font-medium">Period</th>
                  <th className="py-2 font-medium">Amount</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((p: {
                  id: string; createdAt: string; periodStart: string; periodEnd: string;
                  amount: number; status: string;
                }) => (
                  <tr key={p.id} className="border-b border-gray-100 dark:border-gray-800/50">
                    <td className="py-2.5">{fmtDate(p.createdAt)}</td>
                    <td className="py-2.5 text-gray-500">{fmtDate(p.periodStart)} – {fmtDate(p.periodEnd)}</td>
                    <td className="py-2.5 font-medium">{fmtKES(p.amount)}</td>
                    <td className="py-2.5">
                      <span className={
                        p.status === 'PAID' ? 'badge-green' : p.status === 'FAILED' ? 'badge-red' : 'badge-blue'
                      }>{p.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? 'text-sm text-gray-500' : 'text-sm text-gray-700 dark:text-gray-300'}>{label}</span>
      <span className={muted ? 'text-sm text-gray-500' : 'font-medium'}>{value}</span>
    </div>
  );
}

/* ---------------- System Users ---------------- */
function UsersTab() {
  return (
    <div className="max-w-2xl">
      <div className="card p-6">
        <h2 className="font-semibold mb-2">System Users</h2>
        <p className="text-sm text-gray-500">
          Manage additional users who can access this ISP account. User management is coming in the next update.
        </p>
      </div>
    </div>
  );
}
