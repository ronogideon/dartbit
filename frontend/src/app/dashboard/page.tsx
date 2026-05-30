'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { getSubscribers, getRouters, getPayments, getOnlineSessions, getSmsBalance } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import SearchInput from '@/components/ui/SearchInput';
import { Users, Router, Activity, Wallet, TrendingUp, MessageSquare, CreditCard } from 'lucide-react';

function StatCard({ title, value, icon: Icon, color }: {
  title: string; value: string | number; icon: React.ElementType; color: string;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">{title}</p>
          <p className="text-2xl font-bold mt-1">{value}</p>
        </div>
        <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${color}`}>
          <Icon size={22} className="text-white" />
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { data: subscribers = [] } = useQuery({ queryKey: ['subscribers'], queryFn: getSubscribers });
  const { data: routers = [] } = useQuery({ queryKey: ['routers'], queryFn: getRouters });
  const { data: payments = [] } = useQuery({ queryKey: ['payments'], queryFn: getPayments });
  const { data: sessions = [] } = useQuery({ queryKey: ['online-sessions'], queryFn: getOnlineSessions, refetchInterval: 2000 });
  const { data: smsBalance } = useQuery({ queryKey: ['sms-balance'], queryFn: getSmsBalance, retry: false, refetchInterval: 60000 });

  const activeSubscribers = (subscribers as { isActive: boolean }[]).filter((s) => s.isActive).length;
  const onlineRouters = (routers as { status: string }[]).filter((r) => r.status === 'ONLINE').length;
  const totalRevenue = (payments as { amount: number }[]).reduce((sum, p) => sum + p.amount, 0);

  // Earned this month: sum of payments from the 1st of the current month (00:00) to now.
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const earnedThisMonth = (payments as { amount: number; createdAt: string }[])
    .filter((p) => new Date(p.createdAt) >= monthStart)
    .reduce((sum, p) => sum + p.amount, 0);
  const monthLabel = monthStart.toLocaleString(undefined, { month: 'long' });

  // Global search across subscribers, routers, and payments. Shows categorized quick
  // results that link to the relevant page.
  const [search, setSearch] = useState('');
  const gq = search.trim().toLowerCase();
  const subResults = gq ? (subscribers as { id: string; username: string; fullName?: string; phone?: string }[])
    .filter(s => (s.username || '').toLowerCase().includes(gq) || (s.fullName || '').toLowerCase().includes(gq) || (s.phone || '').toLowerCase().includes(gq))
    .slice(0, 6) : [];
  const routerResults = gq ? (routers as { id: string; name: string; host?: string }[])
    .filter(r => (r.name || '').toLowerCase().includes(gq) || (r.host || '').toLowerCase().includes(gq))
    .slice(0, 6) : [];
  const payResults = gq ? (payments as { id: string; reference?: string; amount: number; subscriber?: { fullName?: string } }[])
    .filter(p => (p.reference || '').toLowerCase().includes(gq) || String(p.amount).includes(gq) || (p.subscriber?.fullName || '').toLowerCase().includes(gq))
    .slice(0, 6) : [];
  const hasResults = subResults.length + routerResults.length + payResults.length > 0;

  return (
    <AppLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">Welcome to Dartbit ISP Management</p>
      </div>

      {/* Global search */}
      <div className="mb-6 relative max-w-xl">
        <SearchInput value={search} onChange={setSearch} placeholder="Search subscribers, routers, payments…" />
        {gq && (
          <div className="absolute z-30 mt-2 w-full rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-xl overflow-hidden">
            {!hasResults ? (
              <div className="px-4 py-6 text-center text-sm text-gray-400">No matches for “{search}”</div>
            ) : (
              <div className="max-h-96 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800">
                {subResults.length > 0 && (
                  <div className="p-2">
                    <div className="px-2 py-1 text-xs font-semibold text-gray-400 uppercase">Subscribers</div>
                    {subResults.map(s => (
                      <Link key={s.id} href="/subscribers" className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-sm">
                        <Users size={14} className="text-blue-500" />
                        <span className="font-medium">{s.fullName || s.username}</span>
                        <span className="text-gray-400 text-xs">{s.username}{s.phone ? ` · ${s.phone}` : ''}</span>
                      </Link>
                    ))}
                  </div>
                )}
                {routerResults.length > 0 && (
                  <div className="p-2">
                    <div className="px-2 py-1 text-xs font-semibold text-gray-400 uppercase">Routers</div>
                    {routerResults.map(r => (
                      <Link key={r.id} href="/routers" className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-sm">
                        <Router size={14} className="text-orange-500" />
                        <span className="font-medium">{r.name}</span>
                        <span className="text-gray-400 text-xs">{r.host}</span>
                      </Link>
                    ))}
                  </div>
                )}
                {payResults.length > 0 && (
                  <div className="p-2">
                    <div className="px-2 py-1 text-xs font-semibold text-gray-400 uppercase">Payments</div>
                    {payResults.map(p => (
                      <Link key={p.id} href="/payments" className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-sm">
                        <CreditCard size={14} className="text-green-500" />
                        <span className="font-medium">KES {p.amount.toLocaleString()}</span>
                        <span className="text-gray-400 text-xs">{p.subscriber?.fullName || ''}{p.reference ? ` · ${p.reference}` : ''}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 mb-8">
        <StatCard
          title={`Earned in ${monthLabel}`}
          value={`KES ${earnedThisMonth.toLocaleString()}`}
          icon={TrendingUp}
          color="bg-green-600"
        />
        <StatCard
          title="SMS Balance"
          value={smsBalance ? (smsBalance.mode === 'WALLET' ? `KES ${(smsBalance.balanceKES ?? 0).toLocaleString()}` : smsBalance.balance.toLocaleString()) : '—'}
          icon={MessageSquare}
          color="bg-indigo-600"
        />
        <StatCard
          title="Active / Total Subscribers"
          value={`${activeSubscribers} / ${subscribers.length}`}
          icon={Users}
          color="bg-blue-600"
        />
        <StatCard
          title="Online Sessions"
          value={sessions.length}
          icon={Activity}
          color="bg-purple-600"
        />
        <StatCard
          title="Online Routers"
          value={`${onlineRouters} / ${(routers as unknown[]).length}`}
          icon={Router}
          color="bg-orange-600"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Payments */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold flex items-center gap-2"><CreditCard size={16} /> Recent Payments</h2>
            <span className="text-sm text-gray-500">Total: KES {totalRevenue.toLocaleString()}</span>
          </div>
          <div className="space-y-2">
            {(payments as { id: string; subscriber?: { fullName?: string }; amount: number; method: string; createdAt: string }[]).slice(0, 5).map((p) => (
              <div key={p.id} className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-800 last:border-0">
                <div>
                  <p className="text-sm font-medium">{p.subscriber?.fullName || 'Unknown'}</p>
                  <p className="text-xs text-gray-500">{p.method} • {new Date(p.createdAt).toLocaleDateString()}</p>
                </div>
                <span className="text-sm font-semibold text-green-600">KES {p.amount.toLocaleString()}</span>
              </div>
            ))}
            {payments.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No payments yet</p>}
          </div>
        </div>

        {/* Router Status */}
        <div className="card p-5">
          <h2 className="font-semibold flex items-center gap-2 mb-4"><Router size={16} /> Router Status</h2>
          <div className="space-y-2">
            {(routers as { id: string; name: string; status: string; identity?: string; cpuLoad?: number; uptime?: string }[]).map((r) => (
              <div key={r.id} className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-800 last:border-0">
                <div>
                  <p className="text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-gray-500">{r.identity || 'Not connected'} {r.uptime ? `• Up: ${r.uptime}` : ''}</p>
                </div>
                <div className="flex items-center gap-2">
                  {r.cpuLoad !== null && r.cpuLoad !== undefined && (
                    <span className="text-xs text-gray-500">CPU: {r.cpuLoad}%</span>
                  )}
                  <span className={r.status === 'ONLINE' ? 'badge-green' : r.status === 'OFFLINE' ? 'badge-red' : 'badge-yellow'}>
                    {r.status}
                  </span>
                </div>
              </div>
            ))}
            {routers.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No routers linked yet</p>}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
