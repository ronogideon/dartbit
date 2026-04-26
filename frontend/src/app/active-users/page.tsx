'use client';
import { useQuery } from '@tanstack/react-query';
import { getOnlineSessions } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import { Activity, Wifi } from 'lucide-react';

interface Session {
  id: string; username: string; ipAddress?: string; macAddress?: string;
  uploadSpeed?: number; downloadSpeed?: number; uptime?: string;
  router?: { name: string }; subscriber?: { fullName: string };
}

function formatSpeed(kbps?: number) {
  if (!kbps) return '0 Kbps';
  return kbps >= 1024 ? `${(kbps / 1024).toFixed(1)} Mbps` : `${kbps} Kbps`;
}

export default function ActiveUsersPage() {
  const { data: sessions = [], isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['online-sessions'],
    queryFn: getOnlineSessions,
    refetchInterval: 2000,
  });

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Activity size={24} /> Active Users</h1>
          <p className="text-sm text-gray-500 mt-1">
            {(sessions as Session[]).length} online • Live (updates every 2s) • Last updated: {new Date(dataUpdatedAt).toLocaleTimeString()}
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
              <th className="table-th">Subscriber</th>
              <th className="table-th">IP Address</th>
              <th className="table-th">MAC Address</th>
              <th className="table-th">Upload</th>
              <th className="table-th">Download</th>
              <th className="table-th">Uptime</th>
              <th className="table-th">Router</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {isLoading ? (
              <tr><td colSpan={8} className="table-td text-center py-8 text-gray-400">Loading...</td></tr>
            ) : (sessions as Session[]).length === 0 ? (
              <tr>
                <td colSpan={8} className="py-16 text-center">
                  <Wifi size={40} className="mx-auto text-gray-300 mb-3" />
                  <p className="text-gray-400">No active sessions</p>
                  <p className="text-xs text-gray-500 mt-1">Sessions appear here when subscribers connect</p>
                </td>
              </tr>
            ) : (sessions as Session[]).map(s => (
              <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                <td className="table-td font-medium flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  {s.username}
                </td>
                <td className="table-td text-gray-500">{s.subscriber?.fullName || '-'}</td>
                <td className="table-td font-mono text-sm">{s.ipAddress || '-'}</td>
                <td className="table-td font-mono text-sm text-gray-500">{s.macAddress || '-'}</td>
                <td className="table-td text-blue-600">{formatSpeed(s.uploadSpeed)}</td>
                <td className="table-td text-green-600">{formatSpeed(s.downloadSpeed)}</td>
                <td className="table-td text-gray-500">{s.uptime || '-'}</td>
                <td className="table-td"><span className="badge-blue">{s.router?.name || '-'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppLayout>
  );
}
