'use client';
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import * as API from '@/lib/api';
import { LayoutDashboard, Building2, Wallet, Users, LogOut, Plus, Trash2, KeyRound, Copy, Zap, MessageSquare, Save, RotateCcw, CreditCard, Power, MoreVertical } from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LabelList,
} from 'recharts';

function kes(n: number) { return 'KES ' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtDate(d?: string | null) { return d ? new Date(d).toLocaleDateString() : '—'; }

type Tab = 'overview' | 'tenants' | 'payments' | 'payouts' | 'team' | 'messaging';

export default function SuperadminPortal() {
  const [authed, setAuthed] = useState(false);
  const [role, setRole] = useState('');
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const tok = typeof window !== 'undefined' ? localStorage.getItem('dartbit_sa_token') : null;
    const r = typeof window !== 'undefined' ? localStorage.getItem('dartbit_sa_role') : null;
    if (tok && r && (r === 'SUPERADMIN' || r === 'SUPERADMIN_VIEWER')) { setAuthed(true); setRole(r); }
    setChecking(false);
  }, []);

  if (checking) return <div className="min-h-screen bg-gray-950" />;
  if (!authed) return <Login onAuthed={(r) => { setAuthed(true); setRole(r); }} />;
  return <Dashboard role={role} onLogout={() => { localStorage.removeItem('dartbit_sa_token'); localStorage.removeItem('dartbit_sa_role'); setAuthed(false); }} />;
}

function Login({ onAuthed }: { onAuthed: (role: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const data = await API.login(email, password);
      if (data.user.role !== 'SUPERADMIN' && data.user.role !== 'SUPERADMIN_VIEWER') {
        toast.error('This account is not a superadmin'); setLoading(false); return;
      }
      localStorage.setItem('dartbit_sa_token', data.token);
      localStorage.setItem('dartbit_sa_role', data.user.role);
      onAuthed(data.user.role);
    } catch (err) {
      // Distinguish the real cause instead of blaming the password for everything.
      const e = err as { response?: { status?: number; data?: { error?: string } }; message?: string };
      if (e.response) {
        // The request reached the backend and it responded with an error status.
        if (e.response.status === 401) toast.error('Invalid email or password');
        else toast.error(e.response.data?.error || `Server error (${e.response.status})`);
      } else {
        // No response = network/CORS failure (request blocked before/without a reply).
        toast.error(`Cannot reach the server (${e.message || 'network/CORS error'}). Check API URL and CORS.`);
      }
      setLoading(false);
    }
  };
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        {/* Branding — outside the card */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-600/30">
            <Zap size={28} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">Dartbit</h1>
          <p className="text-sm text-gray-400 mt-1">Superadmin</p>
        </div>

        {/* Form card */}
        <form onSubmit={submit} className="bg-gray-900 rounded-2xl p-6 border border-gray-800 shadow-xl">
          <h2 className="text-base font-semibold text-white mb-5">Sign in to your account</h2>
          <label className="block text-sm font-medium text-gray-300 mb-1.5">Email</label>
          <input className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white mb-3" placeholder="you@dartbit.local" value={email} onChange={e => setEmail(e.target.value)} />
          <label className="block text-sm font-medium text-gray-300 mb-1.5">Password</label>
          <input type="password" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white mb-4" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
          <button disabled={loading} className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2.5 font-medium disabled:opacity-50">{loading ? 'Signing in…' : 'Sign In'}</button>
        </form>
        <p className="text-[10px] text-gray-600 mt-4 text-center break-all">API: {process.env.NEXT_PUBLIC_API_URL || 'https://api.dartbittech.com'}</p>
      </div>
    </div>
  );
}

function Dashboard({ role, onLogout }: { role: string; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const isFull = role === 'SUPERADMIN';
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-4 sm:px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
            <Zap size={17} className="text-white" />
          </div>
          <h1 className="font-bold truncate">Dartbit <span className="text-gray-400 font-normal">Superadmin</span></h1>
          {!isFull && <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full shrink-0">View Only</span>}
        </div>
        <button onClick={onLogout} className="text-gray-400 hover:text-white flex items-center gap-1.5 text-sm shrink-0"><LogOut size={16} /> <span className="hidden sm:inline">Log out</span></button>
      </header>
      <div className="flex flex-col lg:flex-row">
        {/* Nav: horizontal scrollable tab bar on mobile, left sidebar on desktop */}
        <nav className="lg:w-52 lg:border-r border-b lg:border-b-0 border-gray-800 lg:min-h-[calc(100vh-65px)] p-2 lg:p-3 flex lg:flex-col gap-1 overflow-x-auto">
          <NavBtn active={tab === 'overview'} onClick={() => setTab('overview')} icon={<LayoutDashboard size={17} />} label="Overview" />
          <NavBtn active={tab === 'tenants'} onClick={() => setTab('tenants')} icon={<Building2 size={17} />} label="Tenants" />
          <NavBtn active={tab === 'payments'} onClick={() => setTab('payments')} icon={<CreditCard size={17} />} label="Payments" />
          <NavBtn active={tab === 'payouts'} onClick={() => setTab('payouts')} icon={<Wallet size={17} />} label="Payouts" />
          <NavBtn active={tab === 'messaging'} onClick={() => setTab('messaging')} icon={<MessageSquare size={17} />} label="Messaging" />
          <NavBtn active={tab === 'team'} onClick={() => setTab('team')} icon={<Users size={17} />} label="Team" />
        </nav>
        <main className="flex-1 p-4 sm:p-6 min-w-0 overflow-x-hidden">
          {tab === 'overview' && <Overview />}
          {tab === 'tenants' && <Tenants />}
          {tab === 'payments' && <Payments canEdit={isFull} />}
          {tab === 'payouts' && <Payouts />}
          {tab === 'messaging' && <Messaging canEdit={isFull} />}
          {tab === 'team' && <Team canEdit={isFull} />}
        </main>
      </div>
    </div>
  );
}

function NavBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={`shrink-0 lg:w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap ${active ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-900 hover:text-white'}`}>
      {icon} {label}
    </button>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

// Lets a superadmin view and change the per-SMS charge rate (KES) that tenant wallets are
// debited at. Stored in PlatformSetting so it applies platform-wide without a redeploy.
function SmsRateControl() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['sms-rate'], queryFn: API.getSmsRate });
  const [rate, setRate] = useState<string>('');
  useEffect(() => { if (data) setRate(String(data.rate)); }, [data]);

  const saveMut = useMutation({
    mutationFn: () => API.setSmsRate(Number(rate)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sms-rate'] }); toast.success('SMS rate updated'); },
    onError: (e: { response?: { data?: { error?: string } } }) => toast.error(e?.response?.data?.error || 'Failed'),
  });

  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800 flex flex-wrap items-end gap-3">
      <div>
        <div className="text-xs text-gray-400 mb-1">Per-SMS charge rate (KES)</div>
        <div className="flex items-center gap-2">
          <input
            type="number" step="0.01" min={0}
            value={rate}
            onChange={e => setRate(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm w-28 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || rate === '' || Number(rate) < 0}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
          >
            {saveMut.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <div className="text-xs text-gray-500 max-w-xs">
        Tenant SMS wallets are debited this amount per message sent via the Dartbit gateway.
        Tenants using their own gateway are not charged.
      </div>
    </div>
  );
}

function Overview() {
  const { data, isLoading } = useQuery({ queryKey: ['overview'], queryFn: API.getOverview, refetchInterval: 30000 });
  if (isLoading || !data) return <div className="text-gray-500">Loading…</div>;
  const c = data.centralCollection;
  const sms = data.sms || {};
  const tn = data.tenants || {};
  const trend = (data.trend || []) as { month: string; subscriptionRevenue: number; newTenants: number }[];

  // Renewed vs non-renewed tenants (by Dartbit subscription billing status) for the donut.
  const statusData = [
    { name: 'Renewed', value: tn.renewed || 0, color: '#22c55e' },
    { name: 'Not renewed', value: tn.notRenewed || 0, color: '#ef4444' },
  ].filter(s => s.value > 0);

  return (
    <div className="space-y-8">
      {/* Headline KPIs */}
      <div>
        <h2 className="text-lg font-bold mb-3">Platform Overview</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Card label="Total Tenants" value={String(tn.total)} sub={`${tn.active} active`} />
          <Card label="On Free Trial" value={String(tn.trial || 0)} sub="trial tenants" />
          <Card label="Not Renewed" value={String((tn.overdue || 0) + (tn.dueSoon || 0))} sub={`${tn.overdue || 0} overdue`} />
          <Card label="Earned (mo)" value={kes(data.subscriptionRevenue.thisMonth)} sub={`${kes(data.subscriptionRevenue.allTime)} all-time`} />
          <Card label="Fee Income (1%)" value={kes(c.feeRetained)} sub="from collections" />
          <Card label="SMS Left (gateway)" value={sms.gatewayBalance != null ? String(sms.gatewayBalance) : '—'} sub={`${sms.sentThisMonth || 0} sent this mo`} />
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Revenue trend */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h3 className="text-sm font-semibold mb-4 text-gray-300">Subscription Revenue (6 months)</h3>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={trend}>
              <defs>
                <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="month" stroke="#6b7280" tick={{ fill: "#cbd5e1" }} fontSize={12} />
              <YAxis stroke="#6b7280" tick={{ fill: "#cbd5e1" }} fontSize={12} />
              <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, color: '#fff' }} itemStyle={{ color: '#ffffff', fontWeight: 600 }} labelStyle={{ color: '#9ca3af' }} formatter={(v: number) => kes(v)} />
              <Area type="monotone" dataKey="subscriptionRevenue" stroke="#3b82f6" fill="url(#revGrad)" strokeWidth={2} name="Revenue" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* New tenants per month */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h3 className="text-sm font-semibold mb-4 text-gray-300">New Tenants (6 months)</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="month" stroke="#6b7280" tick={{ fill: "#cbd5e1" }} fontSize={12} />
              <YAxis stroke="#6b7280" tick={{ fill: "#cbd5e1" }} fontSize={12} allowDecimals={false} />
              <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, color: '#fff' }} itemStyle={{ color: '#ffffff', fontWeight: 600 }} labelStyle={{ color: '#9ca3af' }} />
              <Bar dataKey="newTenants" fill="#22c55e" radius={[4, 4, 0, 0]} name="New tenants" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Renewed vs non-renewed donut */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h3 className="text-sm font-semibold mb-4 text-gray-300">Tenant Renewals</h3>
          {statusData.length === 0 ? (
            <div className="text-gray-500 text-sm h-[240px] flex items-center justify-center">No tenants yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={2}
                  label={({ name, value }) => `${name}: ${value}`} labelLine={false}>
                  {statusData.map((s, i) => <Cell key={i} fill={s.color} stroke="#111827" strokeWidth={2} />)}
                </Pie>
                <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, color: '#fff' }} itemStyle={{ color: '#ffffff', fontWeight: 600 }} labelStyle={{ color: '#9ca3af' }} />
                <Legend wrapperStyle={{ fontSize: 12, color: '#e5e7eb' }} formatter={(val) => <span style={{ color: '#e5e7eb' }}>{val}</span>} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Money flow */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h3 className="text-sm font-semibold mb-4 text-gray-300">Central Collection Flow</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={[
              { name: 'Collected', value: c.collectedTotal, color: '#3b82f6' },
              { name: 'Disbursed', value: c.disbursed, color: '#22c55e' },
              { name: 'Pending', value: c.pendingPayout, color: '#f59e0b' },
              { name: 'Fee (Dartbit)', value: c.feeRetained, color: '#a855f7' },
            ]}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="name" stroke="#6b7280" tick={{ fill: "#cbd5e1" }} fontSize={11} />
              <YAxis stroke="#6b7280" tick={{ fill: "#cbd5e1" }} fontSize={12} />
              <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, color: '#fff' }} itemStyle={{ color: '#ffffff', fontWeight: 600 }} labelStyle={{ color: '#9ca3af' }} formatter={(v: number) => kes(v)} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {[0, 1, 2, 3].map(i => <Cell key={i} fill={['#3b82f6', '#22c55e', '#f59e0b', '#a855f7'][i]} />)}
                <LabelList dataKey="value" position="top" formatter={(v: number) => kes(v)} style={{ fill: '#ffffff', fontSize: 11, fontWeight: 600 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* SMS gateway + money detail cards */}
      <div>
        <h2 className="text-lg font-bold mb-3">Dartbit SMS Gateway</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card label="Balance Left" value={sms.gatewayBalance != null ? String(sms.gatewayBalance) : '—'} sub={sms.gatewayBalance != null ? 'shared gateway credits' : (sms.gatewayBalanceError || 'unavailable')} />
          <Card label="Sent (all-time)" value={String(sms.sentAllTime || 0)} />
          <Card label="Sent (this mo)" value={String(sms.sentThisMonth || 0)} />
          <Card label="SMS Cost (mo)" value={kes(sms.costThisMonth || 0)} sub={`${kes(sms.costAllTime || 0)} all-time`} />
        </div>
      </div>

      <div>
        <h2 className="text-lg font-bold mb-3">Central M-Pesa Collection</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Card label="Total Collected" value={kes(c.collectedTotal)} />
          <Card label="Disbursed (paid out)" value={kes(c.disbursed)} sub="settled to tenants" />
          <Card label="Retained Fees" value={kes(c.collectedTotal - c.disbursed)} sub="collected − disbursed" />
          <Card label="Owed to Tenants" value={kes(c.owedToTenants)} />
          <Card label="Pending Payout" value={kes(c.pendingPayout)} sub="awaiting settlement" />
          <Card label="Fee Margin (1%)" value={kes(c.feeRetained)} sub="Dartbit income on collections" />
        </div>
      </div>
    </div>
  );
}

type TenantRow = {
  id: string; name: string; subdomain: string; status: string; subscribers: number; routers: number;
  collected: number; owed: number; pendingPayout: number;
  smsGateway: string; smsProvider: string; smsSenderId: string | null; paymentMethod: string; paymentShortcode: string | null;
};
const PAY_LABEL: Record<string, string> = {
  TILL_MANUAL: 'Dartbit · Till payout', PHONE_MANUAL: 'Dartbit · Phone payout',
  DARAJA_API: 'Own Daraja', KOPOKOPO_API: 'KopoKopo',
};

function Tenants() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['sa-tenants'], queryFn: API.getTenants });
  const [search, setSearch] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<TenantRow | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACTIVE' | 'SUSPENDED' }) => API.setTenantStatus(id, status),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sa-tenants'] }); toast.success('Tenant updated'); setMenuId(null); },
    onError: () => toast.error('Failed to update tenant'),
  });
  const deleteMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => API.deleteTenant(id, name),
    onSuccess: (d: { name: string }) => { qc.invalidateQueries({ queryKey: ['sa-tenants'] }); toast.success(`Deleted ${d.name} and all its data`); setToDelete(null); setConfirmText(''); },
    onError: () => toast.error('Delete failed'),
  });

  if (isLoading || !data) return <div className="text-gray-500">Loading…</div>;
  const q = search.trim().toLowerCase();
  const rows: TenantRow[] = q
    ? (data as TenantRow[]).filter(t => (t.name || '').toLowerCase().includes(q) || (t.subdomain || '').toLowerCase().includes(q) || (t.status || '').toLowerCase().includes(q))
    : (data as TenantRow[]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <h2 className="text-lg font-bold">All Tenants</h2>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tenants…"
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm w-64 focus:outline-none focus:border-blue-500" />
      </div>
      <div className="overflow-x-auto bg-gray-900 rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-400 border-b border-gray-800">
            <th className="p-3">Name</th><th className="p-3">Status</th><th className="p-3">Subs</th><th className="p-3">Routers</th>
            <th className="p-3">SMS gateway</th><th className="p-3">Payment</th>
            <th className="p-3">Collected</th><th className="p-3">Pending</th><th className="p-3"></th>
          </tr></thead>
          <tbody>
            {rows.map(t => (
              <tr key={t.id} className="border-b border-gray-800/50">
                <td className="p-3"><div className="font-medium">{t.name}</div><div className="text-xs text-gray-500">{t.subdomain}</div></td>
                <td className="p-3"><span className={`text-xs px-2 py-0.5 rounded-full ${t.status === 'ACTIVE' ? 'bg-green-600/20 text-green-300' : t.status === 'SUSPENDED' ? 'bg-red-600/20 text-red-300' : 'bg-gray-800'}`}>{t.status}</span></td>
                <td className="p-3">{t.subscribers}</td><td className="p-3">{t.routers}</td>
                <td className="p-3">
                  {t.smsGateway === 'CUSTOM'
                    ? <span className="text-gray-200">Own · {t.smsProvider === 'TALKSASA' ? 'TalkSasa' : 'BlessedTexts'}{t.smsSenderId ? ` (${t.smsSenderId})` : ''}</span>
                    : <span className="text-gray-400">Dartbit shared</span>}
                </td>
                <td className="p-3 text-gray-300">{PAY_LABEL[t.paymentMethod] || t.paymentMethod}{t.paymentShortcode ? <span className="text-xs text-gray-500"> · {t.paymentShortcode}</span> : ''}</td>
                <td className="p-3">{kes(t.collected)}</td>
                <td className="p-3">{t.pendingPayout > 0 ? <span className="text-amber-400">{kes(t.pendingPayout)}</span> : '—'}</td>
                <td className="p-3 relative">
                  <button onClick={() => setMenuId(menuId === t.id ? null : t.id)} className="p-1.5 text-gray-400 hover:text-gray-200 rounded hover:bg-gray-800"><MoreVertical size={16} /></button>
                  {menuId === t.id && (
                    <div className="absolute right-3 top-10 z-20 w-44 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1">
                      <button onClick={() => statusMut.mutate({ id: t.id, status: t.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED' })}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2">
                        <Power size={14} className={t.status === 'SUSPENDED' ? 'text-green-400' : 'text-amber-400'} />
                        {t.status === 'SUSPENDED' ? 'Enable tenant' : 'Disable tenant'}
                      </button>
                      <button onClick={() => { setToDelete(t); setMenuId(null); setConfirmText(''); }}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2 text-red-400">
                        <Trash2 size={14} /> Delete tenant
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="p-6 text-center text-gray-500">No matching tenants</td></tr>}
          </tbody>
        </table>
      </div>

      {toDelete && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => !deleteMut.isPending && setToDelete(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-red-400 flex items-center gap-2"><Trash2 size={18} /> Delete tenant</h3>
            <p className="text-sm text-gray-300 mt-2">This permanently deletes <span className="font-semibold">{toDelete.name}</span> and <span className="text-red-300">all its data</span> — subscribers, routers, packages, vouchers, payments, messages and config. This cannot be undone.</p>
            <p className="text-xs text-gray-500 mt-3">Type the tenant name to confirm:</p>
            <input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder={toDelete.name}
              className="w-full mt-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-red-500" />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setToDelete(null)} disabled={deleteMut.isPending} className="px-3 py-2 rounded-lg text-sm border border-gray-700 text-gray-300">Cancel</button>
              <button onClick={() => deleteMut.mutate({ id: toDelete.id, name: toDelete.name })}
                disabled={deleteMut.isPending || confirmText !== toDelete.name}
                className="px-3 py-2 rounded-lg text-sm bg-red-600 text-white disabled:opacity-40 disabled:cursor-not-allowed">
                {deleteMut.isPending ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Payments({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: central } = useQuery({ queryKey: ['central-payments'], queryFn: API.getCentralPayments });
  const { data: stats, isLoading } = useQuery({ queryKey: ['payment-stats'], queryFn: API.getPaymentStats, refetchInterval: 30000 });
  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) => API.setCentralPayments(enabled),
    onSuccess: (d: { enabled: boolean }) => {
      qc.invalidateQueries({ queryKey: ['central-payments'] });
      qc.invalidateQueries({ queryKey: ['payment-stats'] });
      toast.success(`Central Dartbit payments turned ${d.enabled ? 'ON' : 'OFF'}`);
    },
    onError: () => toast.error('Failed to update'),
  });
  const enabled = central?.enabled ?? true;
  const at = stats?.allTime; const mo = stats?.thisMonth;

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-200 mb-4">Payments</h2>

      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 mb-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-gray-300">Central Dartbit collection</h3>
            <p className="text-xs text-gray-500 mt-1 max-w-xl">
              When ON, tenants on the shared Dartbit Daraja (Till/Phone payout methods) collect via Dartbit and Dartbit keeps the 1% fee. Turn OFF to immediately stop new central collections platform-wide — tenants using their own Daraja are unaffected.
            </p>
          </div>
          <button
            onClick={() => canEdit && toggleMut.mutate(!enabled)}
            disabled={!canEdit || toggleMut.isPending}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition ${enabled ? 'border-green-500 bg-green-600/20 text-green-300' : 'border-gray-600 bg-gray-800 text-gray-400'} ${!canEdit ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            <Power size={16} /> {enabled ? 'ON' : 'OFF'}
          </button>
        </div>
        {!enabled && <div className="mt-3 text-xs text-amber-400">Central collection is OFF — new STK pushes on shared-Dartbit methods are being rejected.</div>}
      </div>

      {isLoading || !stats ? (
        <div className="text-gray-500 text-sm">Loading income…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Card label="Fee income (1%) — all-time" value={kes(at.fee)} sub={`${at.count} collections`} />
            <Card label="Fee income — this month" value={kes(mo.fee)} sub={`${mo.count} collections`} />
            <Card label="Subscription income" value={kes(stats.subscriptionIncome)} sub="tenant platform fees" />
            <Card label="Total collected (central)" value={kes(at.collected)} sub="gross via Dartbit" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
            <Card label="Disbursed to tenants" value={kes(at.disbursed)} sub="settled" />
            <Card label="Pending payout" value={kes(at.pending)} sub="owed to tenants" />
            <Card label="Net Dartbit income" value={kes((at.fee || 0) + (stats.subscriptionIncome || 0))} sub="fees + subscriptions" />
          </div>

          <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Fee income — last 6 months</h3>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={stats.trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="month" stroke="#6b7280" fontSize={11} />
                <YAxis stroke="#6b7280" fontSize={11} />
                <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, color: '#fff' }} itemStyle={{ color: '#fff', fontWeight: 600 }} labelStyle={{ color: '#9ca3af' }} formatter={(v: number) => kes(v)} />
                <Bar dataKey="fee" fill="#3b82f6" radius={[4, 4, 0, 0]}>
                  <LabelList dataKey="fee" position="top" formatter={(v: number) => kes(v)} style={{ fill: '#fff', fontSize: 10 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}

function Payouts() {
  const { data, isLoading } = useQuery({ queryKey: ['sa-payouts'], queryFn: API.getPayouts });
  const [search, setSearch] = useState('');
  if (isLoading || !data) return <div className="text-gray-500">Loading…</div>;
  const q = search.trim().toLowerCase();
  const rows = q
    ? data.filter((t: { tenantName: string; mpesaReceipt: string | null; payoutStatus: string | null }) =>
        (t.tenantName || '').toLowerCase().includes(q) || (t.mpesaReceipt || '').toLowerCase().includes(q) || (t.payoutStatus || '').toLowerCase().includes(q))
    : data;
  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <h2 className="text-lg font-bold">Disbursement Ledger</h2>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by tenant, receipt, status…"
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm w-72 focus:outline-none focus:border-blue-500"
        />
      </div>
      <div className="overflow-x-auto bg-gray-900 rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-400 border-b border-gray-800">
            <th className="p-3">Date</th><th className="p-3">Tenant</th><th className="p-3">Amount</th>
            <th className="p-3">Fee</th><th className="p-3">Net</th><th className="p-3">Payout</th><th className="p-3">Receipt</th>
          </tr></thead>
          <tbody>
            {rows.map((t: { id: string; createdAt: string; tenantName: string; amount: number; platformFee: number; netToTenant: number; payoutStatus: string | null; mpesaReceipt: string | null }) => (
              <tr key={t.id} className="border-b border-gray-800/50">
                <td className="p-3 text-gray-400">{fmtDate(t.createdAt)}</td>
                <td className="p-3">{t.tenantName}</td>
                <td className="p-3">{kes(t.amount)}</td>
                <td className="p-3 text-gray-500">{kes(t.platformFee)}</td>
                <td className="p-3">{kes(t.netToTenant)}</td>
                <td className="p-3">{t.payoutStatus === 'PAID' ? <span className="text-green-400">Paid</span> : <span className="text-amber-400">{t.payoutStatus || 'Pending'}</span>}</td>
                <td className="p-3 font-mono text-xs text-gray-500">{t.mpesaReceipt || '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-gray-500">No central collections yet</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Messaging({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['msg-overview'], queryFn: API.getMessagingOverview, refetchInterval: 60000 });
  const { data: tpl } = useQuery({ queryKey: ['msg-templates'], queryFn: API.getMessagingTemplates });
  const { data: prov } = useQuery({ queryKey: ['msg-provider'], queryFn: API.getMessagingProvider });
  const setProv = useMutation({
    mutationFn: (p: 'BLESSEDTEXTS' | 'TALKSASA') => API.setMessagingProvider(p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['msg-provider'] }); qc.invalidateQueries({ queryKey: ['msg-overview'] }); toast.success('Default SMS gateway switched'); },
    onError: () => toast.error('Failed to switch gateway'),
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [tq, setTq] = useState('');

  const saveTpl = useMutation({
    mutationFn: ({ key, body }: { key: string; body: string }) => API.saveMessagingTemplate(key, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['msg-templates'] }); toast.success('Default template saved'); },
    onError: () => toast.error('Failed to save template'),
  });

  if (isLoading || !data) return <div className="text-gray-400 text-sm">Loading…</div>;
  const t = data.totals;
  const rows = data.tenants.filter(r => !tq || r.name.toLowerCase().includes(tq.toLowerCase()) || r.subdomain.toLowerCase().includes(tq.toLowerCase()));
  const templates = tpl?.templates || [];

  return (
    <div>
      <h2 className="text-lg font-bold mb-3">Messaging</h2>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Card label="Dartbit Gateway Balance" value={data.gatewayBalance != null ? data.gatewayBalance.toLocaleString() + ' SMS' : '—'} sub={`central ${data.defaultProvider === 'TALKSASA' ? 'TalkSasa' : 'BlessedTexts'} account`} />
        <Card label="Sent This Month" value={t.sentThisMonth.toLocaleString()} sub="all tenants" />
        <Card label="Sent Lifetime" value={t.sentLifetime.toLocaleString()} sub="all tenants" />
        <Card label="Tenant SMS Units" value={t.totalUnits.toLocaleString()} sub={kes(t.totalBalanceKes) + ' wallet value'} />
      </div>

      {/* Default SMS gateway switch */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 mb-6">
        <h3 className="text-sm font-semibold text-gray-300 mb-1">Dartbit Default SMS Gateway</h3>
        <p className="text-xs text-gray-500 mb-3">The gateway used for all tenants on the shared Dartbit wallet (tenants with their own gateway are unaffected).</p>
        <div className="flex gap-2 flex-wrap">
          {(['TALKSASA', 'BLESSEDTEXTS'] as const).map(p => {
            const active = prov?.provider === p;
            const configured = prov?.configured?.[p];
            return (
              <button key={p} onClick={() => !active && setProv.mutate(p)} disabled={setProv.isPending || active}
                className={`px-4 py-2 rounded-lg text-sm border transition ${active ? 'border-blue-500 bg-blue-600/20 text-blue-300' : 'border-gray-700 text-gray-300 hover:border-gray-500'}`}>
                {p === 'TALKSASA' ? 'TalkSasa' : 'BlessedTexts'}
                {active && ' ✓'}
                {!configured && <span className="block text-[10px] text-amber-400 mt-0.5">creds not set on backend</span>}
              </button>
            );
          })}
        </div>
        <div className="mt-4 pt-4 border-t border-gray-800"><SmsRateControl /></div>
      </div>

      {/* Per-tenant table */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 mb-6">
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-300">Per-tenant SMS</h3>
          <input value={tq} onChange={e => setTq(e.target.value)} placeholder="Search tenant…" className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 w-48" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-800">
                <th className="p-2">Tenant</th>
                <th className="p-2 text-right">Units</th>
                <th className="p-2 text-right">Wallet</th>
                <th className="p-2 text-right">This month</th>
                <th className="p-2 text-right">Lifetime</th>
                <th className="p-2 text-right">Spent</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan={6} className="p-4 text-center text-gray-500">No tenants</td></tr> :
                rows.map(r => (
                  <tr key={r.tenantId} className="border-b border-gray-800/60">
                    <td className="p-2"><div className="text-gray-100 font-medium">{r.name}</div><div className="text-xs text-gray-500">{r.subdomain}</div></td>
                    <td className="p-2 text-right text-gray-200 font-semibold">{r.units.toLocaleString()}</td>
                    <td className="p-2 text-right text-gray-300">{kes(r.balanceKes)}</td>
                    <td className="p-2 text-right text-gray-300">{r.sentThisMonth.toLocaleString()}</td>
                    <td className="p-2 text-right text-gray-300">{r.sentLifetime.toLocaleString()}</td>
                    <td className="p-2 text-right text-gray-400">{kes(r.spentKes)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Default templates editor */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
        <h3 className="text-sm font-semibold text-gray-300 mb-1">Default Message Templates</h3>
        <p className="text-xs text-gray-500 mb-4">These are the platform defaults tenants start from (and can override). Editing here changes the baseline for all tenants who haven&apos;t customized that template, including the system alerts for offline/online routers and low SMS balance.</p>
        <div className="space-y-4">
          {templates.map(tp => {
            const draft = drafts[tp.key] ?? tp.body;
            const dirty = draft !== tp.body;
            return (
              <div key={tp.key} className="border border-gray-800 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                  <div>
                    <span className="text-sm font-medium text-gray-200">{tp.label}</span>
                    {tp.group === 'system' && <span className="ml-2 text-[10px] uppercase tracking-wide bg-amber-900/40 text-amber-300 px-1.5 py-0.5 rounded">system</span>}
                    {tp.isDefault && <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-500">default</span>}
                  </div>
                  <span className="text-xs text-gray-600">{tp.placeholders.join(' ')}</span>
                </div>
                <p className="text-xs text-gray-500 mb-2">{tp.description}</p>
                <textarea
                  value={draft}
                  onChange={e => setDrafts(d => ({ ...d, [tp.key]: e.target.value }))}
                  disabled={!canEdit}
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 min-h-[60px] disabled:opacity-60"
                />
                {canEdit && (
                  <div className="flex justify-end gap-2 mt-2">
                    {!tp.isDefault && (
                      <button onClick={() => saveTpl.mutate({ key: tp.key, body: '' })} className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1"><RotateCcw size={12} /> Reset to built-in</button>
                    )}
                    <button onClick={() => saveTpl.mutate({ key: tp.key, body: draft })} disabled={!dirty || saveTpl.isPending} className="text-xs bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white px-3 py-1.5 rounded-lg flex items-center gap-1"><Save size={12} /> Save</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Team({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['sa-team'], queryFn: API.getTeam });
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', role: 'SUPERADMIN_VIEWER' });
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ['sa-team'] });

  const createMut = useMutation({ mutationFn: API.createTeamMember, onSuccess: (r: { user: { email: string }; tempPassword: string }) => { inv(); setShowAdd(false); setForm({ name: '', email: '', role: 'SUPERADMIN_VIEWER' }); setTemp({ email: r.user.email, password: r.tempPassword }); }, onError: (e: { response?: { data?: { error?: string } } }) => toast.error(e?.response?.data?.error || 'Failed') });
  const updateMut = useMutation({ mutationFn: ({ id, data }: { id: string; data: { role?: string; isActive?: boolean } }) => API.updateTeamMember(id, data), onSuccess: () => { inv(); toast.success('Updated'); }, onError: (e: { response?: { data?: { error?: string } } }) => toast.error(e?.response?.data?.error || 'Failed') });
  const resetMut = useMutation({ mutationFn: API.resetTeamPassword, onSuccess: (r: { tempPassword: string }, id: string) => { const u = (data || []).find((x: { id: string }) => x.id === id); setTemp({ email: u?.email || 'user', password: r.tempPassword }); }, onError: () => toast.error('Failed') });
  const deleteMut = useMutation({ mutationFn: API.deleteTeamMember, onSuccess: () => { inv(); toast.success('Removed'); }, onError: (e: { response?: { data?: { error?: string } } }) => toast.error(e?.response?.data?.error || 'Failed') });

  if (isLoading || !data) return <div className="text-gray-500">Loading…</div>;
  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">Superadmin Team</h2>
        {canEdit && <button onClick={() => setShowAdd(true)} className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-3 py-1.5 text-sm flex items-center gap-1.5"><Plus size={15} /> Add Member</button>}
      </div>
      {!canEdit && <p className="text-sm text-gray-500 mb-3">You have view-only access. Contact a full superadmin to manage the team.</p>}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-400 border-b border-gray-800"><th className="p-3">Name</th><th className="p-3">Email</th><th className="p-3">Role</th><th className="p-3">Status</th>{canEdit && <th className="p-3 text-right">Actions</th>}</tr></thead>
          <tbody>
            {data.map((u: { id: string; name: string; email: string; role: string; isActive: boolean }) => (
              <tr key={u.id} className="border-b border-gray-800/50">
                <td className="p-3 font-medium">{u.name}</td>
                <td className="p-3 text-gray-400">{u.email}</td>
                <td className="p-3">
                  {canEdit ? (
                    <select value={u.role} onChange={e => updateMut.mutate({ id: u.id, data: { role: e.target.value } })} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs">
                      <option value="SUPERADMIN">Full</option><option value="SUPERADMIN_VIEWER">View Only</option>
                    </select>
                  ) : (u.role === 'SUPERADMIN' ? 'Full' : 'View Only')}
                </td>
                <td className="p-3">{canEdit ? <button onClick={() => updateMut.mutate({ id: u.id, data: { isActive: !u.isActive } })} className={u.isActive ? 'text-green-400' : 'text-red-400'}>{u.isActive ? 'Active' : 'Inactive'}</button> : (u.isActive ? 'Active' : 'Inactive')}</td>
                {canEdit && <td className="p-3"><div className="flex items-center justify-end gap-2">
                  <button onClick={() => resetMut.mutate(u.id)} className="text-gray-400 hover:text-blue-400" title="Reset password"><KeyRound size={15} /></button>
                  <button onClick={() => { if (confirm(`Remove ${u.name}?`)) deleteMut.mutate(u.id); }} className="text-gray-400 hover:text-red-400" title="Remove"><Trash2 size={15} /></button>
                </div></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && canEdit && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 mt-4 space-y-3">
          <h3 className="font-semibold">Add Team Member</h3>
          <input className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white" placeholder="Full name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <input className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white" placeholder="Email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
          <select className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
            <option value="SUPERADMIN_VIEWER">View Only</option><option value="SUPERADMIN">Full Superadmin</option>
          </select>
          <div className="flex gap-2">
            <button onClick={() => createMut.mutate(form)} disabled={createMut.isPending || !form.name || !form.email} className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm">Create</button>
            <button onClick={() => setShowAdd(false)} className="bg-gray-800 text-gray-300 rounded-lg px-4 py-2 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {temp && (
        <div className="bg-gray-900 rounded-xl border-2 border-blue-700 p-5 mt-4">
          <h3 className="font-semibold mb-1">Temporary Password</h3>
          <p className="text-sm text-gray-400 mb-3">Share with {temp.email}. Won&apos;t be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-gray-800 px-3 py-2 rounded font-mono text-sm">{temp.password}</code>
            <button onClick={() => { navigator.clipboard.writeText(temp.password); toast.success('Copied'); }} className="bg-gray-800 text-gray-300 rounded-lg px-3 py-2 text-sm flex items-center gap-1.5"><Copy size={14} /> Copy</button>
          </div>
          <button onClick={() => setTemp(null)} className="text-sm text-gray-500 mt-3">Done</button>
        </div>
      )}
    </div>
  );
}
