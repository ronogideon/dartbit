'use client';
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import * as API from '@/lib/api';
import { LayoutDashboard, Building2, Wallet, Users, LogOut, Plus, Trash2, KeyRound, Copy } from 'lucide-react';

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
        toast.error('Not a superadmin account'); setLoading(false); return;
      }
      localStorage.setItem('dartbit_sa_token', data.token);
      localStorage.setItem('dartbit_sa_role', data.user.role);
      onAuthed(data.user.role);
    } catch {
      toast.error('Invalid credentials'); setLoading(false);
    }
  };
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-gray-900 rounded-2xl p-7 border border-gray-800">
        <h1 className="text-xl font-bold text-white mb-1">Dartbit Superadmin</h1>
        <p className="text-sm text-gray-400 mb-5">Platform analytics & control</p>
        <input className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white mb-3" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
        <input type="password" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white mb-4" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
        <button disabled={loading} className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2.5 font-medium disabled:opacity-50">{loading ? 'Signing in…' : 'Sign In'}</button>
      </form>
    </div>
  );
}

function Dashboard({ role, onLogout }: { role: string; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const isFull = role === 'SUPERADMIN';
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-bold">Dartbit Superadmin</h1>
          {!isFull && <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full">View Only</span>}
        </div>
        <button onClick={onLogout} className="text-gray-400 hover:text-white flex items-center gap-1.5 text-sm"><LogOut size={16} /> Log out</button>
      </header>
      <div className="flex">
        <nav className="w-52 border-r border-gray-800 min-h-[calc(100vh-65px)] p-3 space-y-1">
          <NavBtn active={tab === 'overview'} onClick={() => setTab('overview')} icon={<LayoutDashboard size={17} />} label="Overview" />
          <NavBtn active={tab === 'tenants'} onClick={() => setTab('tenants')} icon={<Building2 size={17} />} label="Tenants" />
          <NavBtn active={tab === 'payouts'} onClick={() => setTab('payouts')} icon={<Wallet size={17} />} label="Payouts" />
          <NavBtn active={tab === 'team'} onClick={() => setTab('team')} icon={<Users size={17} />} label="Team" />
        </nav>
        <main className="flex-1 p-6">
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
    <button onClick={onClick} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm ${active ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-900 hover:text-white'}`}>
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

function Overview() {
  const { data, isLoading } = useQuery({ queryKey: ['overview'], queryFn: API.getOverview, refetchInterval: 30000 });
  if (isLoading || !data) return <div className="text-gray-500">Loading…</div>;
  const c = data.centralCollection;
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold">Platform Overview</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label="Tenants" value={String(data.tenants.total)} sub={`${data.tenants.active} active`} />
        <Card label="Subscribers" value={String(data.subscribers)} />
        <Card label="Routers" value={String(data.routers)} />
        <Card label="Subscription Revenue (mo)" value={kes(data.subscriptionRevenue.thisMonth)} sub={`${kes(data.subscriptionRevenue.allTime)} all-time`} />
      </div>
      <h2 className="text-lg font-bold pt-2">Central M-Pesa Collection</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Card label="Total Collected" value={kes(c.collectedTotal)} />
        <Card label="Fee Retained (1%)" value={kes(c.feeRetained)} sub="Dartbit income" />
        <Card label="Owed to Tenants" value={kes(c.owedToTenants)} />
        <Card label="Disbursed" value={kes(c.disbursed)} />
        <Card label="Pending Payout" value={kes(c.pendingPayout)} sub="awaiting settlement" />
        <Card label="Leftover" value={kes(c.leftover)} sub="≈ fee retained" />
      </div>
    </div>
  );
}

function Tenants() {
  const { data, isLoading } = useQuery({ queryKey: ['sa-tenants'], queryFn: API.getTenants });
  if (isLoading || !data) return <div className="text-gray-500">Loading…</div>;
  return (
    <div>
      <h2 className="text-lg font-bold mb-4">All Tenants</h2>
      <div className="overflow-x-auto bg-gray-900 rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-400 border-b border-gray-800">
            <th className="p-3">Name</th><th className="p-3">Status</th><th className="p-3">Subs</th><th className="p-3">Routers</th>
            <th className="p-3">Collected</th><th className="p-3">Owed</th><th className="p-3">Pending</th>
          </tr></thead>
          <tbody>
            {data.map((t: { id: string; name: string; subdomain: string; status: string; subscribers: number; routers: number; collected: number; owed: number; pendingPayout: number }) => (
              <tr key={t.id} className="border-b border-gray-800/50">
                <td className="p-3"><div className="font-medium">{t.name}</div><div className="text-xs text-gray-500">{t.subdomain}</div></td>
                <td className="p-3"><span className="text-xs px-2 py-0.5 rounded-full bg-gray-800">{t.status}</span></td>
                <td className="p-3">{t.subscribers}</td><td className="p-3">{t.routers}</td>
                <td className="p-3">{kes(t.collected)}</td><td className="p-3">{kes(t.owed)}</td>
                <td className="p-3">{t.pendingPayout > 0 ? <span className="text-amber-400">{kes(t.pendingPayout)}</span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Payouts() {
  const { data, isLoading } = useQuery({ queryKey: ['sa-payouts'], queryFn: API.getPayouts });
  if (isLoading || !data) return <div className="text-gray-500">Loading…</div>;
  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Disbursement Ledger</h2>
      <div className="overflow-x-auto bg-gray-900 rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-400 border-b border-gray-800">
            <th className="p-3">Date</th><th className="p-3">Tenant</th><th className="p-3">Amount</th>
            <th className="p-3">Fee</th><th className="p-3">Net</th><th className="p-3">Payout</th><th className="p-3">Receipt</th>
          </tr></thead>
          <tbody>
            {data.map((t: { id: string; createdAt: string; tenantName: string; amount: number; platformFee: number; netToTenant: number; payoutStatus: string | null; mpesaReceipt: string | null }) => (
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
            {data.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-gray-500">No central collections yet</td></tr>}
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
