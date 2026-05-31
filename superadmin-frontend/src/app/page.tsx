'use client';
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import * as API from '@/lib/api';
import { LayoutDashboard, Building2, Wallet, Users, LogOut, Plus, Trash2, KeyRound, Copy, Zap } from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

function kes(n: number) { return 'KES ' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtDate(d?: string | null) { return d ? new Date(d).toLocaleDateString() : '—'; }

type Tab = 'overview' | 'tenants' | 'payouts' | 'team';

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
      <form onSubmit={submit} className="w-full max-w-sm bg-gray-900 rounded-2xl p-7 border border-gray-800">
        <div className="flex items-center gap-2.5 mb-4">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/30">
            <Zap size={22} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white leading-tight">Dartbit</h1>
            <p className="text-xs text-gray-400">Superadmin</p>
          </div>
        </div>
        <p className="text-sm text-gray-400 mb-5">Platform analytics &amp; control</p>
        <input className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white mb-3" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
        <input type="password" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white mb-4" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
        <button disabled={loading} className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2.5 font-medium disabled:opacity-50">{loading ? 'Signing in…' : 'Sign In'}</button>
        <p className="text-[10px] text-gray-600 mt-4 text-center break-all">API: {process.env.NEXT_PUBLIC_API_URL || 'https://api.dartbittech.com'}</p>
      </form>
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
          <NavBtn active={tab === 'payouts'} onClick={() => setTab('payouts')} icon={<Wallet size={17} />} label="Payouts" />
          <NavBtn active={tab === 'team'} onClick={() => setTab('team')} icon={<Users size={17} />} label="Team" />
        </nav>
        <main className="flex-1 p-4 sm:p-6 min-w-0 overflow-x-hidden">
          {tab === 'overview' && <Overview />}
          {tab === 'tenants' && <Tenants />}
          {tab === 'payouts' && <Payouts />}
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

  // Tenant status breakdown for the donut.
  const statusData = [
    { name: 'Active', value: tn.active || 0, color: '#22c55e' },
    { name: 'Trial', value: tn.trial || 0, color: '#3b82f6' },
    { name: 'Due soon', value: tn.dueSoon || 0, color: '#f59e0b' },
    { name: 'Overdue', value: tn.overdue || 0, color: '#ef4444' },
    { name: 'Suspended', value: tn.suspended || 0, color: '#6b7280' },
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
              <XAxis dataKey="month" stroke="#6b7280" fontSize={12} />
              <YAxis stroke="#6b7280" fontSize={12} />
              <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, color: '#fff' }} formatter={(v: number) => kes(v)} />
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
              <XAxis dataKey="month" stroke="#6b7280" fontSize={12} />
              <YAxis stroke="#6b7280" fontSize={12} allowDecimals={false} />
              <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, color: '#fff' }} />
              <Bar dataKey="newTenants" fill="#22c55e" radius={[4, 4, 0, 0]} name="New tenants" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Tenant status donut */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h3 className="text-sm font-semibold mb-4 text-gray-300">Tenant Status</h3>
          {statusData.length === 0 ? (
            <div className="text-gray-500 text-sm h-[240px] flex items-center justify-center">No tenants yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={2}>
                  {statusData.map((s, i) => <Cell key={i} fill={s.color} />)}
                </Pie>
                <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, color: '#fff' }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
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
              <XAxis dataKey="name" stroke="#6b7280" fontSize={11} />
              <YAxis stroke="#6b7280" fontSize={12} />
              <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, color: '#fff' }} formatter={(v: number) => kes(v)} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {[0, 1, 2, 3].map(i => <Cell key={i} fill={['#3b82f6', '#22c55e', '#f59e0b', '#a855f7'][i]} />)}
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
        <div className="mt-3"><SmsRateControl /></div>
      </div>

      <div>
        <h2 className="text-lg font-bold mb-3">Central M-Pesa Collection</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Card label="Total Collected" value={kes(c.collectedTotal)} />
          <Card label="Fee Retained (1%)" value={kes(c.feeRetained)} sub="Dartbit income" />
          <Card label="Owed to Tenants" value={kes(c.owedToTenants)} />
          <Card label="Disbursed" value={kes(c.disbursed)} />
          <Card label="Pending Payout" value={kes(c.pendingPayout)} sub="awaiting settlement" />
          <Card label="Leftover" value={kes(c.leftover)} sub="≈ fee retained" />
        </div>
      </div>
    </div>
  );
}

function Tenants() {
  const { data, isLoading } = useQuery({ queryKey: ['sa-tenants'], queryFn: API.getTenants });
  const [search, setSearch] = useState('');
  if (isLoading || !data) return <div className="text-gray-500">Loading…</div>;
  const q = search.trim().toLowerCase();
  const rows = q
    ? data.filter((t: { name: string; subdomain: string; status: string }) =>
        (t.name || '').toLowerCase().includes(q) || (t.subdomain || '').toLowerCase().includes(q) || (t.status || '').toLowerCase().includes(q))
    : data;
  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <h2 className="text-lg font-bold">All Tenants</h2>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search tenants…"
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm w-64 focus:outline-none focus:border-blue-500"
        />
      </div>
      <div className="overflow-x-auto bg-gray-900 rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-400 border-b border-gray-800">
            <th className="p-3">Name</th><th className="p-3">Status</th><th className="p-3">Subs</th><th className="p-3">Routers</th>
            <th className="p-3">Collected</th><th className="p-3">Owed</th><th className="p-3">Pending</th>
          </tr></thead>
          <tbody>
            {rows.map((t: { id: string; name: string; subdomain: string; status: string; subscribers: number; routers: number; collected: number; owed: number; pendingPayout: number }) => (
              <tr key={t.id} className="border-b border-gray-800/50">
                <td className="p-3"><div className="font-medium">{t.name}</div><div className="text-xs text-gray-500">{t.subdomain}</div></td>
                <td className="p-3"><span className="text-xs px-2 py-0.5 rounded-full bg-gray-800">{t.status}</span></td>
                <td className="p-3">{t.subscribers}</td><td className="p-3">{t.routers}</td>
                <td className="p-3">{kes(t.collected)}</td><td className="p-3">{kes(t.owed)}</td>
                <td className="p-3">{t.pendingPayout > 0 ? <span className="text-amber-400">{kes(t.pendingPayout)}</span> : '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-gray-500">No matching tenants</td></tr>}
          </tbody>
        </table>
      </div>
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
