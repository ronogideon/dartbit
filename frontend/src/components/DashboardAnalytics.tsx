'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAnalytics } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend,
} from 'recharts';
import { TrendingUp, Package as PackageIcon, Coins, Activity, Wifi } from 'lucide-react';

const PERIODS = [
  { key: 'day', label: 'Daily' },
  { key: 'week', label: 'Weekly' },
  { key: 'month', label: 'Monthly' },
  { key: 'year', label: 'Yearly' },
  { key: 'all', label: 'All time' },
];

const SERVICE_COLORS: Record<string, string> = { PPPOE: '#3b82f6', STATIC: '#a855f7', HOTSPOT: '#22c55e' };

export default function DashboardAnalytics() {
  const [period, setPeriod] = useState('month');
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', period],
    queryFn: () => getAnalytics(period),
    refetchInterval: 60000,
  });

  const dataByService = data?.dataByService || { PPPOE: 0, STATIC: 0, HOTSPOT: 0 };
  const totalData = dataByService.PPPOE + dataByService.STATIC + dataByService.HOTSPOT;
  const serviceRows = [
    { name: 'PPPoE', key: 'PPPOE', value: dataByService.PPPOE },
    { name: 'Static', key: 'STATIC', value: dataByService.STATIC },
    { name: 'Hotspot', key: 'HOTSPOT', value: dataByService.HOTSPOT },
  ];

  return (
    <div className="mb-8">
      {/* Header + period selector */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h2 className="text-lg font-bold flex items-center gap-2"><TrendingUp size={18} /> Trends & Analytics</h2>
        <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          {PERIODS.map(p => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`px-3 py-1.5 text-xs font-medium transition ${period === p.key ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading || !data ? (
        <div className="card p-8 text-center text-sm text-gray-400">Loading analytics…</div>
      ) : (
        <div className="space-y-6">
          {/* Payment trend + data by service */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="card p-5 lg:col-span-2">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold flex items-center gap-2 text-sm"><Coins size={15} /> Payment Trend</h3>
                <span className="text-sm text-gray-500">Total: KES {data.totalRevenue.toLocaleString()}</span>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.paymentTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:opacity-20" />
                  <XAxis dataKey="label" fontSize={11} stroke="#9ca3af" tick={{ fill: '#6b7280', fontSize: 11, fontWeight: 500 }} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis fontSize={11} stroke="#9ca3af" tick={{ fill: '#6b7280', fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                    labelStyle={{ color: '#111827', fontWeight: 700, marginBottom: 4 }}
                    itemStyle={{ fontWeight: 600 }}
                    formatter={(v: number, name: string) => [`KES ${Number(v).toLocaleString()}`, name === 'hotspot' ? 'Hotspot' : 'PPPoE']} />
                  <Legend formatter={(val: string) => (val === 'hotspot' ? 'Hotspot' : 'PPPoE')} iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="pppoe" stackId="pay" fill="#1d4ed8" />
                  <Bar dataKey="hotspot" stackId="pay" fill="#7dd3fc" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="card p-5">
              <h3 className="font-semibold flex items-center gap-2 text-sm mb-4"><Wifi size={15} /> Data by Service</h3>
              <div className="text-2xl font-bold mb-1">{formatBytes(totalData)}</div>
              <div className="text-xs text-gray-500 mb-4">total in period</div>
              <div className="space-y-3">
                {serviceRows.map(s => {
                  const pct = totalData > 0 ? (s.value / totalData) * 100 : 0;
                  return (
                    <div key={s.key}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="font-medium">{s.name}</span>
                        <span className="text-gray-500">{formatBytes(s.value)}</span>
                      </div>
                      <div className="h-2 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: SERVICE_COLORS[s.key] }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Top packages: users + income */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card p-5">
              <h3 className="font-semibold flex items-center gap-2 text-sm mb-4"><PackageIcon size={15} /> Packages — Most Users</h3>
              {data.topByUsers.length === 0 ? <Empty /> : (
                <div className="space-y-2">
                  {data.topByUsers.map((p, i) => (
                    <Row key={i} rank={i + 1} name={p.name} value={`${p.value} user${p.value !== 1 ? 's' : ''}`} />
                  ))}
                </div>
              )}
            </div>
            <div className="card p-5">
              <h3 className="font-semibold flex items-center gap-2 text-sm mb-4"><Coins size={15} /> Packages — Most Income</h3>
              {data.topByIncome.length === 0 ? <Empty /> : (
                <div className="space-y-2">
                  {data.topByIncome.map((p, i) => (
                    <Row key={i} rank={i + 1} name={p.name} value={`KES ${p.value.toLocaleString()}`} />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Most active users by data */}
          <div className="card p-5">
            <h3 className="font-semibold flex items-center gap-2 text-sm mb-4"><Activity size={15} /> Most Active Users (by data used)</h3>
            {data.topUsers.length === 0 ? <Empty /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-800">
                      <th className="py-2 pr-2">#</th><th className="py-2 pr-2">User</th>
                      <th className="py-2 pr-2">Download</th><th className="py-2 pr-2">Upload</th><th className="py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topUsers.map((u, i) => (
                      <tr key={i} className="border-b border-gray-50 dark:border-gray-800/50 last:border-0">
                        <td className="py-2 pr-2 text-gray-400">{i + 1}</td>
                        <td className="py-2 pr-2 font-medium">{u.username}</td>
                        <td className="py-2 pr-2">{formatBytes(u.down)}</td>
                        <td className="py-2 pr-2">{formatBytes(u.up)}</td>
                        <td className="py-2 font-semibold">{formatBytes(u.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ rank, name, value }: { rank: number; name: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-50 dark:border-gray-800/50 last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs flex items-center justify-center text-gray-500 shrink-0">{rank}</span>
        <span className="text-sm font-medium truncate">{name}</span>
      </div>
      <span className="text-sm text-gray-600 dark:text-gray-300 shrink-0">{value}</span>
    </div>
  );
}

function Empty() {
  return <p className="text-sm text-gray-400 text-center py-4">No data for this period</p>;
}
