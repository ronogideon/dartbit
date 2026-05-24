'use client';
import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSettings, updateSettings, getBillingCurrent, getBillingHistory, billingCheckout, getSystemUsers, createSystemUser, updateSystemUser, resetSystemUserPassword, deleteSystemUser, getPaymentConfig, updatePaymentConfig } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import toast from 'react-hot-toast';
import { Settings as SettingsIcon, CreditCard, Users, Plus, Trash2, KeyRound, Copy, Check, Wallet } from 'lucide-react';

type Tab = 'general' | 'billing' | 'payments' | 'users';

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
  return (
    <Suspense fallback={<AppLayout><div className="text-center py-8 text-gray-400">Loading...</div></AppLayout>}>
      <SettingsContent />
    </Suspense>
  );
}

function SettingsContent() {
  const searchParams = useSearchParams();
  const initialTab = (searchParams.get('tab') as Tab) || 'general';
  const [tab, setTab] = useState<Tab>(['general', 'billing', 'payments', 'users'].includes(initialTab) ? initialTab : 'general');

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
        <TabButton active={tab === 'payments'} onClick={() => setTab('payments')} icon={<Wallet size={16} />} label="Payments" />
        <TabButton active={tab === 'users'} onClick={() => setTab('users')} icon={<Users size={16} />} label="System Users" />
      </div>

      {tab === 'general' && <GeneralTab />}
      {tab === 'billing' && <BillingTab />}
      {tab === 'payments' && <PaymentsTab />}
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
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['billing-current'], queryFn: getBillingCurrent });
  const { data: history } = useQuery({ queryKey: ['billing-history'], queryFn: getBillingHistory });

  const checkoutMut = useMutation({
    mutationFn: billingCheckout,
    onSuccess: (res: { authorizationUrl: string }) => {
      // Redirect the browser to Paystack's hosted checkout
      window.location.href = res.authorizationUrl;
    },
    onError: (e: { response?: { data?: { error?: string } } }) => {
      toast.error(e?.response?.data?.error || 'Could not start checkout');
    },
  });

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
          {data.canPayNow ? (
            <button
              className="btn-primary"
              onClick={() => checkoutMut.mutate()}
              disabled={checkoutMut.isPending}
            >
              {checkoutMut.isPending ? 'Starting…' : 'Pay Now'}
            </button>
          ) : (
            <div className="text-right">
              <button className="btn-primary opacity-50 cursor-not-allowed" disabled>Pay Now</button>
              <div className="text-xs text-gray-400 mt-1">
                Opens {fmtDate(data.windowOpensAt)}
              </div>
            </div>
          )}
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

/* ---------------- Payments ---------------- */
function PaymentsTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['payment-config'], queryFn: getPaymentConfig });
  const [form, setForm] = useState<Record<string, string>>({});
  const [method, setMethod] = useState('TILL_MANUAL');

  useEffect(() => {
    if (data) {
      setMethod(data.method || 'TILL_MANUAL');
      setForm({
        payoutTill: data.payoutTill || '',
        payoutPhone: data.payoutPhone || '',
        darajaShortcode: data.darajaShortcode || '',
        darajaType: data.darajaType || 'TILL',
        darajaConsumerKey: data.darajaConsumerKey || '',
        darajaConsumerSecret: data.darajaConsumerSecret || '',
        darajaPasskey: data.darajaPasskey || '',
        kopoTillNumber: data.kopoTillNumber || '',
        kopoClientId: data.kopoClientId || '',
        kopoClientSecret: data.kopoClientSecret || '',
        kopoApiKey: data.kopoApiKey || '',
      });
    }
  }, [data]);

  const saveMut = useMutation({
    mutationFn: updatePaymentConfig,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payment-config'] }); toast.success('Payment settings saved'); },
    onError: (e: { response?: { data?: { error?: string } } }) => toast.error(e?.response?.data?.error || 'Failed to save'),
  });

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  const save = () => saveMut.mutate({ method, ...form });

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading...</div>;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="card p-6">
        <h2 className="font-semibold mb-1">Collection Method</h2>
        <p className="text-sm text-gray-500 mb-4">How you collect payments from your customers.</p>

        <div className="grid grid-cols-1 gap-2">
          <MethodOption value="TILL_MANUAL" current={method} onSelect={setMethod}
            title="Till (Managed by Dartbit)"
            desc="Dartbit collects via M-Pesa and pays out to your till. 1% transaction fee." />
          <MethodOption value="PHONE_MANUAL" current={method} onSelect={setMethod}
            title="Phone Number (Managed by Dartbit)"
            desc="Dartbit collects via M-Pesa and pays out to your phone. 1% transaction fee." />
          <MethodOption value="DARAJA_API" current={method} onSelect={setMethod}
            title="M-Pesa Daraja API (Your own)"
            desc="Money goes directly to your Till/PayBill. No fee. Requires your Daraja API keys." />
          <MethodOption value="KOPOKOPO_API" current={method} onSelect={setMethod}
            title="KopoKopo API (Your own)"
            desc="Money goes directly to your KopoKopo account. No fee. Requires KopoKopo API keys." />
        </div>
      </div>

      {/* Method-specific fields */}
      <div className="card p-6">
        <h2 className="font-semibold mb-4">Details</h2>
        {method === 'TILL_MANUAL' && (
          <div>
            <label className="label">Your Till Number (for payouts)</label>
            <input className="input" value={form.payoutTill || ''} onChange={e => set('payoutTill', e.target.value)} placeholder="e.g. 123456" />
            <p className="text-xs text-gray-400 mt-2">Dartbit collects customer payments and disburses to this till, less a 1% fee (rounded up).</p>
          </div>
        )}
        {method === 'PHONE_MANUAL' && (
          <div>
            <label className="label">Your Phone Number (for payouts)</label>
            <input className="input" value={form.payoutPhone || ''} onChange={e => set('payoutPhone', e.target.value)} placeholder="e.g. 0712345678" />
            <p className="text-xs text-gray-400 mt-2">Dartbit collects customer payments and disburses to this number, less a 1% fee (rounded up).</p>
          </div>
        )}
        {method === 'DARAJA_API' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Shortcode (Till / PayBill)</label>
                <input className="input" value={form.darajaShortcode || ''} onChange={e => set('darajaShortcode', e.target.value)} placeholder="e.g. 174379" />
              </div>
              <div>
                <label className="label">Type</label>
                <select className="input" value={form.darajaType || 'TILL'} onChange={e => set('darajaType', e.target.value)}>
                  <option value="TILL">Till (Buy Goods)</option>
                  <option value="PAYBILL">PayBill</option>
                </select>
              </div>
            </div>
            <div>
              <label className="label">Consumer Key</label>
              <input className="input" value={form.darajaConsumerKey || ''} onChange={e => set('darajaConsumerKey', e.target.value)} placeholder="Your Daraja consumer key" />
            </div>
            <div>
              <label className="label">Consumer Secret</label>
              <input className="input" type="password" value={form.darajaConsumerSecret || ''} onChange={e => set('darajaConsumerSecret', e.target.value)} placeholder="Your Daraja consumer secret" />
            </div>
            <div>
              <label className="label">Passkey (for STK Push)</label>
              <input className="input" type="password" value={form.darajaPasskey || ''} onChange={e => set('darajaPasskey', e.target.value)} placeholder="Your STK passkey" />
            </div>
            <p className="text-xs text-gray-400">Credentials are encrypted at rest. Leave masked fields unchanged to keep existing values.</p>
          </div>
        )}
        {method === 'KOPOKOPO_API' && (
          <div className="space-y-3">
            <div>
              <label className="label">Till Number</label>
              <input className="input" value={form.kopoTillNumber || ''} onChange={e => set('kopoTillNumber', e.target.value)} placeholder="Your KopoKopo till" />
            </div>
            <div>
              <label className="label">Client ID</label>
              <input className="input" value={form.kopoClientId || ''} onChange={e => set('kopoClientId', e.target.value)} placeholder="KopoKopo client ID" />
            </div>
            <div>
              <label className="label">Client Secret</label>
              <input className="input" type="password" value={form.kopoClientSecret || ''} onChange={e => set('kopoClientSecret', e.target.value)} placeholder="KopoKopo client secret" />
            </div>
            <div>
              <label className="label">API Key</label>
              <input className="input" type="password" value={form.kopoApiKey || ''} onChange={e => set('kopoApiKey', e.target.value)} placeholder="KopoKopo API key" />
            </div>
            <p className="text-xs text-gray-400">Credentials are encrypted at rest. Leave masked fields unchanged to keep existing values.</p>
          </div>
        )}

        <button onClick={save} disabled={saveMut.isPending} className="btn-primary w-full mt-5">
          {saveMut.isPending ? 'Saving…' : 'Save Payment Settings'}
        </button>
      </div>
    </div>
  );
}

function MethodOption({ value, current, onSelect, title, desc }: { value: string; current: string; onSelect: (v: string) => void; title: string; desc: string }) {
  const active = value === current;
  return (
    <button
      onClick={() => onSelect(value)}
      className={`text-left p-3 rounded-lg border-2 transition-colors ${active ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'}`}
    >
      <div className="flex items-center gap-2">
        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${active ? 'border-blue-600' : 'border-gray-300'}`}>
          {active && <div className="w-2 h-2 rounded-full bg-blue-600" />}
        </div>
        <span className="font-medium text-sm">{title}</span>
      </div>
      <p className="text-xs text-gray-500 mt-1 ml-6">{desc}</p>
    </button>
  );
}

/* ---------------- System Users ---------------- */
function UsersTab() {
  const qc = useQueryClient();
  const { data: users, isLoading } = useQuery({ queryKey: ['system-users'], queryFn: getSystemUsers });
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', role: 'TENANT_VIEWER' });
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['system-users'] });

  const createMut = useMutation({
    mutationFn: createSystemUser,
    onSuccess: (res: { user: { email: string }; tempPassword: string }) => {
      invalidate();
      setShowAdd(false);
      setForm({ name: '', email: '', role: 'TENANT_VIEWER' });
      setTempPassword({ email: res.user.email, password: res.tempPassword });
    },
    onError: (e: { response?: { data?: { error?: string } } }) => toast.error(e?.response?.data?.error || 'Failed to create user'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { role?: string; isActive?: boolean } }) => updateSystemUser(id, data),
    onSuccess: () => { invalidate(); toast.success('Updated'); },
    onError: (e: { response?: { data?: { error?: string } } }) => toast.error(e?.response?.data?.error || 'Failed'),
  });

  const resetMut = useMutation({
    mutationFn: resetSystemUserPassword,
    onSuccess: (res: { tempPassword: string }, id: string) => {
      const u = (users || []).find((x: { id: string }) => x.id === id);
      setTempPassword({ email: u?.email || 'user', password: res.tempPassword });
    },
    onError: () => toast.error('Failed to reset password'),
  });

  const deleteMut = useMutation({
    mutationFn: deleteSystemUser,
    onSuccess: () => { invalidate(); toast.success('User removed'); },
    onError: (e: { response?: { data?: { error?: string } } }) => toast.error(e?.response?.data?.error || 'Failed'),
  });

  const copyPassword = () => {
    if (!tempPassword) return;
    navigator.clipboard.writeText(tempPassword.password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-semibold">System Users</h2>
            <p className="text-sm text-gray-500">Manage who can access this ISP account.</p>
          </div>
          <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-1.5 text-sm">
            <Plus size={16} /> Add User
          </button>
        </div>

        {isLoading ? (
          <div className="text-center py-6 text-gray-400">Loading...</div>
        ) : !users || users.length === 0 ? (
          <div className="text-center py-6 text-gray-400">No users yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200 dark:border-gray-800">
                  <th className="py-2 font-medium">Name</th>
                  <th className="py-2 font-medium">Email</th>
                  <th className="py-2 font-medium">Role</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u: { id: string; name: string; email: string; role: string; isActive: boolean }) => (
                  <tr key={u.id} className="border-b border-gray-100 dark:border-gray-800/50">
                    <td className="py-3 font-medium">{u.name}</td>
                    <td className="py-3 text-gray-500">{u.email}</td>
                    <td className="py-3">
                      <select
                        value={u.role}
                        onChange={(e) => updateMut.mutate({ id: u.id, data: { role: e.target.value } })}
                        className="bg-transparent border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-xs"
                      >
                        <option value="TENANT_ADMIN">Admin</option>
                        <option value="TENANT_VIEWER">Viewer</option>
                      </select>
                    </td>
                    <td className="py-3">
                      <button
                        onClick={() => updateMut.mutate({ id: u.id, data: { isActive: !u.isActive } })}
                        className={u.isActive ? 'badge-green' : 'badge-red'}
                      >
                        {u.isActive ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => resetMut.mutate(u.id)} title="Reset password" className="p-1.5 text-gray-400 hover:text-blue-600">
                          <KeyRound size={15} />
                        </button>
                        <button onClick={() => { if (confirm(`Remove ${u.name}?`)) deleteMut.mutate(u.id); }} title="Remove user" className="p-1.5 text-gray-400 hover:text-red-600">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-gray-400 mt-4">
          <span className="font-medium">Admin</span> has full access. <span className="font-medium">Viewer</span> can see data but not make changes.
        </p>
      </div>

      {/* Add user inline form */}
      {showAdd && (
        <div className="card p-6">
          <h3 className="font-semibold mb-4">Add System User</h3>
          <div className="space-y-3">
            <div>
              <label className="label">Full Name</label>
              <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Jane Doe" />
            </div>
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="jane@example.com" />
            </div>
            <div>
              <label className="label">Role</label>
              <select className="input" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                <option value="TENANT_VIEWER">Viewer (read-only)</option>
                <option value="TENANT_ADMIN">Admin (full access)</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={() => createMut.mutate(form)} disabled={createMut.isPending || !form.name || !form.email} className="btn-primary">
              {createMut.isPending ? 'Creating…' : 'Create User'}
            </button>
            <button onClick={() => setShowAdd(false)} className="btn-secondary">Cancel</button>
          </div>
        </div>
      )}

      {/* Temp password reveal (shown once) */}
      {tempPassword && (
        <div className="card p-6 border-2 border-blue-200 dark:border-blue-800">
          <h3 className="font-semibold mb-1">Temporary Password</h3>
          <p className="text-sm text-gray-500 mb-3">
            Share this with <span className="font-medium">{tempPassword.email}</span>. It won&apos;t be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-gray-100 dark:bg-gray-800 px-3 py-2 rounded font-mono text-sm">{tempPassword.password}</code>
            <button onClick={copyPassword} className="btn-secondary flex items-center gap-1.5">
              {copied ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy</>}
            </button>
          </div>
          <button onClick={() => setTempPassword(null)} className="text-sm text-gray-400 hover:text-gray-600 mt-3">Done</button>
        </div>
      )}
    </div>
  );
}
