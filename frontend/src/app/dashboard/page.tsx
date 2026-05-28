'use client';
import { useQuery } from '@tanstack/react-query';
import { getSubscribers, getRouters, getPayments, getOnlineSessions, getSmsBalance } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
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

  return (
    <AppLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">Welcome to Dartbit ISP Management</p>
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
          value={smsBalance ? smsBalance.balance.toLocaleString() : '—'}
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
