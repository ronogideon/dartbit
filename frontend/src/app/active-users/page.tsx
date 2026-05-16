'use client';
import { useQuery } from '@tanstack/react-query';
import { getOnlineSessions } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import { Activity, Wifi, Clock } from 'lucide-react';

interface Session {
  id: string; username: string; ipAddress?: string; macAddress?: string;
  uploadSpeed?: number; downloadSpeed?: number; uptime?: string;
  router?: { name: string };
  subscriber?: { id: string; fullName: string; expiresAt?: string };
}

function formatSpeed(kbps?: number) {
  if (!kbps || kbps === 0) return '0 Kbps';
  return kbps >= 1024 ? `${(kbps / 1024).toFixed(2)} Mbps` : `${kbps} Kbps`;
}

function timeUntilExpiry(expiresAt?: string): { text: string; color: string } {
  if (!expiresAt) return { text: 'No expiry', color: 'text-gray-400' };

  const now = Date.now();
  const expiry = new Date(expiresAt).getTime();
  const diff = expiry - now;

  if (diff <= 0) return { text: 'Expired', color: 'text-red-500' };

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let text = '';
  if (days > 0) text = `${days}d ${hours % 24}h`;
  else if (hours > 0) text = `${hours}h ${minutes % 60}m`;
  else if (minutes > 0) text = `${minutes}m ${seconds % 60}s`;
  else text = `${seconds}s`;

  const color = days >= 7 ? 'text-green-600' : days >= 1 ? 'text-blue-600' : hours >= 1 ? 'text-yellow-600' : 'text-orange-600';
  return { text, color };
}

export default function ActiveUsersPage() {
  const { data: sessions = [], isPending, dataUpdatedAt } = useQuery({
    queryKey: ['online-sessions'],
    queryFn: getOnlineSessions,
    refetchInterval: 2000,
  });

  const list = sessions as Session[];

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Activity size={24} /> Active Users</h1>
          <p className="text-sm text-gray-500 mt-1">
            {list.length} online • Updates every 2s • Last: {new Date(dataUpdatedAt).toLocaleTimeString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-sm text-green-600 font-medium">Live</span>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-gray-800/50">
            <tr>
              <th className="table-th">Username</th>
              <th className="table-th">IP Address</th>
              <th className="table-th">Session Time Left</th>
              <th className="table-th">Router</th>
              <th className="table-th">Upload</th>
              <th className="table-th">Download</th>
              <th className="table-th">Uptime</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {isPending ? (
              <tr><td colSpan={7} className="table-td text-center py-8 text-gray-400">Loading...</td></tr>
            ) : list.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-16 text-center">
                  <Wifi size={40} className="mx-auto text-gray-300 mb-3" />
                  <p className="text-gray-400">No active sessions</p>
                  <p className="text-xs text-gray-500 mt-1">Sessions appear here when subscribers connect</p>
                </td>
              </tr>
            ) : list.map(s => {
              const exp = timeUntilExpiry(s.subscriber?.expiresAt);
              return (
                <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                  <td className="table-td font-medium">
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                      <div className="min-w-0">
                        <div className="truncate">{s.username}</div>
                        {s.subscriber?.fullName && <div className="text-xs text-gray-500 truncate">{s.subscriber.fullName}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="table-td font-mono text-sm">{s.ipAddress || '-'}</td>
                  <td className="table-td">
                    <span className={`text-sm font-medium ${exp.color} flex items-center gap-1`}>
                      <Clock size={12} />
                      {exp.text}
                    </span>
                  </td>
                  <td className="table-td"><span className="badge-blue">{s.router?.name || '-'}</span></td>
                  <td className="table-td text-blue-600 font-mono text-sm">{formatSpeed(s.uploadSpeed)}</td>
                  <td className="table-td text-green-600 font-mono text-sm">{formatSpeed(s.downloadSpeed)}</td>
                  <td className="table-td text-gray-500 text-sm">{s.uptime || '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </AppLayout>
  );
}
