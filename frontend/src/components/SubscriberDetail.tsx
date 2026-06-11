'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSubscriberDetail, extendSubscriber } from '@/lib/api';
import toast from 'react-hot-toast';
import { X, Wifi, Download, Upload, Clock, Calendar, Phone, Mail, Router as RouterIcon, Package as PackageIcon, Key, Plus, Edit2, ChevronDown } from 'lucide-react';

interface Props {
  subscriberId: string | null;
  onClose: () => void;
  onEdit?: (subscriberId: string) => void;
}

const EXTEND_OPTIONS: { label: string; minutes: number }[] = [
  { label: '+1 hour', minutes: 60 },
  { label: '+12 hours', minutes: 720 },
  { label: '+1 day', minutes: 1440 },
  { label: '+7 days', minutes: 10080 },
  { label: '+1 month', minutes: 43200 },
];

function fmtBytes(bytesStr: string): string {
  const b = Number(bytesStr || '0');
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b < 1024 ** 4) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  return `${(b / 1024 ** 4).toFixed(2)} TB`;
}

function fmtDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

function fmtDateTime(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function SubscriberDetail({ subscriberId, onClose, onEdit }: Props) {
  const qc = useQueryClient();
  const [showOptions, setShowOptions] = useState(false);
  const [pendingExtend, setPendingExtend] = useState<number | null>(null); // selected but not yet saved
  const [showAllSessions, setShowAllSessions] = useState(false);
  const { data, isPending, isError } = useQuery({
    queryKey: ['subscriber-detail', subscriberId],
    queryFn: () => getSubscriberDetail(subscriberId!),
    enabled: !!subscriberId,
    refetchInterval: 10000,
  });

  const extendMut = useMutation({
    mutationFn: (minutes: number) => extendSubscriber(subscriberId!, minutes),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subscriber-detail', subscriberId] });
      qc.invalidateQueries({ queryKey: ['subscribers'] });
      toast.success('Expiry updated');
      setPendingExtend(null);
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to update expiry'),
  });

  if (!subscriberId) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white dark:bg-gray-900 shadow-2xl z-50 overflow-y-auto">
        <div className="sticky top-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-5 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Subscriber Details</h2>
          <div className="flex items-center gap-1">
            {onEdit && (
              <button onClick={() => onEdit(subscriberId)} className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30" title="Edit subscriber"><Edit2 size={18} /></button>
            )}
            <button onClick={() => { setShowOptions(o => !o); setPendingExtend(null); }} className={`p-1.5 rounded-lg ${showOptions ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/30' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`} title="Adjust expiry"><Clock size={18} /></button>
            <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><X size={20} /></button>
          </div>
        </div>

        {isPending ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : isError || !data ? (
          <div className="p-8 text-center text-red-500">Failed to load details</div>
        ) : (
          <div className="p-5 space-y-6">
            {/* Identity */}
            <div>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center text-blue-600 dark:text-blue-300 font-bold text-lg">
                  {data.subscriber.fullName?.charAt(0)?.toUpperCase() || '?'}
                </div>
                <div>
                  <div className="font-semibold text-lg">{data.subscriber.fullName}</div>
                  <div className="text-sm text-gray-500">{data.subscriber.username}</div>
                </div>
                <span className={`ml-auto ${data.subscriber.isActive ? 'badge-green' : 'badge-red'}`}>
                  {data.subscriber.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                {data.subscriber.phone && <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300"><Phone size={14} className="text-gray-400" /> {data.subscriber.phone}</div>}
                {data.subscriber.email && <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300"><Mail size={14} className="text-gray-400" /> {data.subscriber.email}</div>}
                <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300"><Wifi size={14} className="text-gray-400" /> {data.subscriber.service}</div>
                {data.subscriber.password && <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300 col-span-2"><Key size={14} className="text-gray-400" /> <span className="text-gray-500">Password:</span> <span className="font-mono font-medium text-gray-800 dark:text-gray-100 select-all">{data.subscriber.password}</span></div>}
                {data.subscriber.package && <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300"><PackageIcon size={14} className="text-gray-400" /> {data.subscriber.package.name}</div>}
                {data.subscriber.router && <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300"><RouterIcon size={14} className="text-gray-400" /> {data.subscriber.router.name}</div>}
                {data.subscriber.ipAddress && <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300 font-mono text-xs">{data.subscriber.ipAddress}</div>}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div className="flex items-center gap-2 text-gray-500"><Clock size={14} /> Last online: {fmtDateTime(data.subscriber.lastOnlineAt)}</div>
                <div className="flex items-center gap-2 font-bold text-gray-900 dark:text-white"><Calendar size={16} strokeWidth={2.5} className="text-gray-900 dark:text-white" /> Expires: {fmtDateTime(data.subscriber.expiresAt)}</div>
              </div>
            </div>

            {/* Adjust expiry: pick an amount, then Save — a deliberate two-step to avoid accidental changes */}
            {showOptions && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-gray-50 dark:bg-gray-800/40">
                <div className="flex items-center gap-2 mb-1"><Clock size={15} className="text-gray-500" /><h3 className="font-semibold text-sm">Adjust expiry</h3></div>
                <p className="text-xs text-gray-500 mb-3">Select how much to extend, then tap Save. Added to the current expiry, or from now if already expired.</p>
                <div className="flex flex-wrap gap-2">
                  {EXTEND_OPTIONS.map(opt => (
                    <button
                      key={opt.minutes}
                      onClick={() => setPendingExtend(p => p === opt.minutes ? null : opt.minutes)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium border flex items-center gap-1 transition ${pendingExtend === opt.minutes
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:border-blue-400 hover:text-blue-600'}`}
                    >
                      <Plus size={13} /> {opt.label.replace('+', '')}
                    </button>
                  ))}
                </div>
                <div className="flex items-center justify-end gap-2 mt-4">
                  {pendingExtend !== null && (
                    <button onClick={() => setPendingExtend(null)} className="btn-secondary text-sm py-1.5">Cancel</button>
                  )}
                  <button
                    onClick={() => pendingExtend !== null && extendMut.mutate(pendingExtend)}
                    disabled={pendingExtend === null || extendMut.isPending}
                    className="btn-primary text-sm py-1.5 disabled:opacity-50"
                  >
                    {extendMut.isPending ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            )}

            {/* 30-day usage summary */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Last 30 Days</h3>
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
                  <Download size={16} className="mx-auto text-green-600 mb-1" />
                  <div className="font-bold text-sm">{fmtBytes(data.usage30d.totalDownloadBytes)}</div>
                  <div className="text-xs text-gray-500">Download</div>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
                  <Upload size={16} className="mx-auto text-blue-600 mb-1" />
                  <div className="font-bold text-sm">{fmtBytes(data.usage30d.totalUploadBytes)}</div>
                  <div className="text-xs text-gray-500">Upload</div>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
                  <Wifi size={16} className="mx-auto text-purple-600 mb-1" />
                  <div className="font-bold text-sm">{data.usage30d.sessionCount}</div>
                  <div className="text-xs text-gray-500">Sessions</div>
                </div>
              </div>
              <div className="mt-2 text-center text-sm text-gray-500">
                Total: <span className="font-semibold text-gray-700 dark:text-gray-200">{fmtBytes(data.usage30d.totalBytes)}</span>
              </div>
            </div>

            {/* Session history — by default just the live session + the most recent closed one */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Sessions</h3>
              {data.sessions.length === 0 ? (
                <div className="text-sm text-gray-400 text-center py-6">No sessions recorded in the last 30 days</div>
              ) : (() => {
                type Sess = {
                  id: string; startedAt: string; endedAt: string | null; active: boolean;
                  durationSeconds: number; ipAddress: string | null;
                  downloadBytes: string; uploadBytes: string;
                };
                const all = data.sessions as Sess[];
                // Collapsed view: every active (online) session + the single most-recent closed one.
                const actives = all.filter(s => s.active);
                const firstClosed = all.find(s => !s.active);
                const collapsed = [...actives, ...(firstClosed ? [firstClosed] : [])];
                const shown = showAllSessions ? all : collapsed;
                const hiddenCount = all.length - collapsed.length;
                return (
                  <>
                    <div className="space-y-2">
                      {shown.map((s) => (
                        <div key={s.id} className="border border-gray-200 dark:border-gray-800 rounded-lg p-3 text-sm">
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-medium">{fmtDateTime(s.startedAt)}</span>
                            {s.active ? (
                              <span className="badge-green text-xs">Online</span>
                            ) : (
                              <span className="text-xs text-gray-400">{fmtDuration(s.durationSeconds)}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-4 text-xs text-gray-500">
                            <span className="flex items-center gap-1"><Download size={12} className="text-green-600" /> {fmtBytes(s.downloadBytes)}</span>
                            <span className="flex items-center gap-1"><Upload size={12} className="text-blue-600" /> {fmtBytes(s.uploadBytes)}</span>
                            {s.ipAddress && <span className="font-mono ml-auto">{s.ipAddress}</span>}
                          </div>
                          {!s.active && (
                            <div className="text-xs text-gray-400 mt-1">
                              {fmtDateTime(s.startedAt)} → {fmtDateTime(s.endedAt)}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    {hiddenCount > 0 && (
                      <button
                        onClick={() => setShowAllSessions(v => !v)}
                        className="mt-2 w-full flex items-center justify-center gap-1 text-sm text-blue-600 hover:underline py-1.5"
                      >
                        {showAllSessions ? 'Show less' : `Show all sessions (${all.length})`}
                        <ChevronDown size={14} className={`transition-transform ${showAllSessions ? 'rotate-180' : ''}`} />
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
