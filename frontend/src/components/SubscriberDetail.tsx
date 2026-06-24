'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSubscriberDetail, extendSubscriber, sendMessage } from '@/lib/api';
import toast from 'react-hot-toast';
import { X, Wifi, Download, Upload, Clock, Calendar, Phone, Mail, Router as RouterIcon, Package as PackageIcon, Key, Plus, Edit2, ChevronDown, Info as InfoIcon, CreditCard, MessageSquare, Send, Activity } from 'lucide-react';

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

type Tab = 'info' | 'payments' | 'sms' | 'sessions';

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
function fmtMoney(n: number): string {
  return `KES ${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

type Sess = { id: string; startedAt: string; endedAt: string | null; active: boolean; durationSeconds: number; ipAddress: string | null; downloadBytes: string; uploadBytes: string };
type Pay = { id: string; amount: number; method: string; source: string; reference: string | null; mpesaCode: string | null; packageName: string | null; createdAt: string };
type Msg = { id: string; recipient: string; body: string; status: string; category: string | null; createdAt: string };

function SessionCard({ s }: { s: Sess }) {
  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-3 text-sm">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium">{fmtDateTime(s.startedAt)}</span>
        {s.active ? <span className="badge-green text-xs">Online</span> : <span className="text-xs text-gray-400">{fmtDuration(s.durationSeconds)}</span>}
      </div>
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1"><Download size={12} className="text-green-600" /> {fmtBytes(s.downloadBytes)}</span>
        <span className="flex items-center gap-1"><Upload size={12} className="text-blue-600" /> {fmtBytes(s.uploadBytes)}</span>
        {s.ipAddress && <span className="font-mono ml-auto">{s.ipAddress}</span>}
      </div>
      {!s.active && <div className="text-xs text-gray-400 mt-1">{fmtDateTime(s.startedAt)} → {fmtDateTime(s.endedAt)}</div>}
    </div>
  );
}

export default function SubscriberDetail({ subscriberId, onClose, onEdit }: Props) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('info');
  const [showOptions, setShowOptions] = useState(false);
  const [pendingExtend, setPendingExtend] = useState<number | null>(null);
  const [sms, setSms] = useState('');
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

  const smsMut = useMutation({
    mutationFn: (body: string) => sendMessage(data!.subscriber.phone, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subscriber-detail', subscriberId] });
      toast.success('Message sent');
      setSms('');
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to send SMS'),
  });

  if (!subscriberId) return null;

  const TABS: { id: Tab; label: string; icon: typeof InfoIcon }[] = [
    { id: 'info', label: 'Info', icon: InfoIcon },
    { id: 'payments', label: 'Payments', icon: CreditCard },
    { id: 'sms', label: 'SMS', icon: MessageSquare },
    { id: 'sessions', label: 'Sessions', icon: Activity },
  ];

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white dark:bg-gray-900 shadow-2xl z-50 overflow-y-auto flex flex-col">
        <div className="sticky top-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-5 py-4 flex items-center justify-between z-10">
          <h2 className="text-lg font-semibold">Subscriber Details</h2>
          <div className="flex items-center gap-1">
            {onEdit && <button onClick={() => onEdit(subscriberId)} className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30" title="Edit subscriber"><Edit2 size={18} /></button>}
            <button onClick={() => { setShowOptions(o => !o); setPendingExtend(null); }} className={`p-1.5 rounded-lg ${showOptions ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/30' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`} title="Adjust expiry"><Clock size={18} /></button>
            <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><X size={20} /></button>
          </div>
        </div>

        {isPending ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : isError || !data ? (
          <div className="p-8 text-center text-red-500">Failed to load details</div>
        ) : (
          <>
            {/* Tabs */}
            <div className="sticky top-[57px] bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex z-10">
              {TABS.map(t => {
                const Icon = t.icon;
                return (
                  <button key={t.id} onClick={() => setTab(t.id)}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium border-b-2 transition ${tab === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}>
                    <Icon size={15} /> {t.label}
                  </button>
                );
              })}
            </div>

            {/* Expiry adjuster (shared across tabs) */}
            {showOptions && (
              <div className="m-5 mb-0 rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-gray-50 dark:bg-gray-800/40">
                <div className="flex items-center gap-2 mb-1"><Clock size={15} className="text-gray-500" /><h3 className="font-semibold text-sm">Adjust expiry</h3></div>
                <p className="text-xs text-gray-500 mb-3">Select how much to extend, then tap Save. Added to the current expiry, or from now if already expired.</p>
                <div className="flex flex-wrap gap-2">
                  {EXTEND_OPTIONS.map(opt => (
                    <button key={opt.minutes} onClick={() => setPendingExtend(p => p === opt.minutes ? null : opt.minutes)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium border flex items-center gap-1 transition ${pendingExtend === opt.minutes ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:border-blue-400 hover:text-blue-600'}`}>
                      <Plus size={13} /> {opt.label.replace('+', '')}
                    </button>
                  ))}
                </div>
                <div className="flex items-center justify-end gap-2 mt-4">
                  {pendingExtend !== null && <button onClick={() => setPendingExtend(null)} className="btn-secondary text-sm py-1.5">Cancel</button>}
                  <button onClick={() => pendingExtend !== null && extendMut.mutate(pendingExtend)} disabled={pendingExtend === null || extendMut.isPending} className="btn-primary text-sm py-1.5 disabled:opacity-50">{extendMut.isPending ? 'Saving…' : 'Save'}</button>
                </div>
              </div>
            )}

            <div className="p-5 space-y-6 flex-1">
              {/* ───────── INFO ───────── */}
              {tab === 'info' && (() => {
                const all = data.sessions as Sess[];
                const actives = all.filter(s => s.active);
                const firstClosed = all.find(s => !s.active);
                const recent = [...actives, ...(firstClosed ? [firstClosed] : [])];
                return (
                  <>
                    <div>
                      <div className="flex items-center gap-3 mb-3">
                        <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center text-blue-600 dark:text-blue-300 font-bold text-lg">{data.subscriber.fullName?.charAt(0)?.toUpperCase() || '?'}</div>
                        <div>
                          <div className="font-semibold text-lg">{data.subscriber.fullName}</div>
                          <div className="text-sm text-gray-500">{data.subscriber.username}</div>
                        </div>
                        <span className={`ml-auto ${data.subscriber.isActive ? 'badge-green' : 'badge-red'}`}>{data.subscriber.isActive ? 'Active' : 'Inactive'}</span>
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
                        <div className="flex items-center gap-2 font-bold text-gray-900 dark:text-white"><Calendar size={16} strokeWidth={2.5} /> Expires: {fmtDateTime(data.subscriber.expiresAt)}</div>
                      </div>
                    </div>

                    <div>
                      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Last 30 Days</h3>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center"><Download size={16} className="mx-auto text-green-600 mb-1" /><div className="font-bold text-sm">{fmtBytes(data.usage30d.totalDownloadBytes)}</div><div className="text-xs text-gray-500">Download</div></div>
                        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center"><Upload size={16} className="mx-auto text-blue-600 mb-1" /><div className="font-bold text-sm">{fmtBytes(data.usage30d.totalUploadBytes)}</div><div className="text-xs text-gray-500">Upload</div></div>
                        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center"><Wifi size={16} className="mx-auto text-purple-600 mb-1" /><div className="font-bold text-sm">{data.usage30d.sessionCount}</div><div className="text-xs text-gray-500">Sessions</div></div>
                      </div>
                    </div>

                    <div>
                      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Current & recent session</h3>
                      {recent.length === 0 ? <div className="text-sm text-gray-400 text-center py-6">No recent sessions</div> : (
                        <div className="space-y-2">{recent.map(s => <SessionCard key={s.id} s={s} />)}</div>
                      )}
                      {all.length > recent.length && <button onClick={() => setTab('sessions')} className="mt-2 w-full text-sm text-blue-600 hover:underline py-1.5">View all sessions ({all.length})</button>}
                    </div>
                  </>
                );
              })()}

              {/* ───────── PAYMENTS ───────── */}
              {tab === 'payments' && (() => {
                const pays = (data.payments || []) as Pay[];
                return (
                  <>
                    <div className="rounded-xl bg-gradient-to-br from-blue-600 to-blue-700 text-white p-4">
                      <div className="text-xs uppercase tracking-wide opacity-80">Lifetime value</div>
                      <div className="text-2xl font-bold mt-1">{fmtMoney(data.lifetimeValue || 0)}</div>
                      <div className="text-xs opacity-80 mt-1">{pays.length} payment{pays.length === 1 ? '' : 's'}</div>
                    </div>
                    {pays.length === 0 ? <div className="text-sm text-gray-400 text-center py-6">No payments recorded</div> : (
                      <div className="space-y-2">
                        {pays.map(p => (
                          <div key={p.id} className="border border-gray-200 dark:border-gray-800 rounded-lg p-3 text-sm">
                            <div className="flex items-center justify-between">
                              <span className="font-semibold">{fmtMoney(p.amount)}</span>
                              <span className="text-xs text-gray-400">{fmtDateTime(p.createdAt)}</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-gray-500 mt-1 flex-wrap">
                              <span className={`px-1.5 py-0.5 rounded ${p.source === 'AUTOMATIC' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>{p.source === 'AUTOMATIC' ? 'M-Pesa' : 'Manual'}</span>
                              {p.packageName && <span className="flex items-center gap-1"><PackageIcon size={11} /> {p.packageName}</span>}
                              {p.mpesaCode && <span className="font-mono">{p.mpesaCode}</span>}
                              {p.reference && !p.mpesaCode && <span className="font-mono">{p.reference}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}

              {/* ───────── SMS ───────── */}
              {tab === 'sms' && (() => {
                const msgs = (data.messages || []) as Msg[];
                const hasPhone = !!data.subscriber.phone;
                return (
                  <>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Send a message</h3>
                      {!hasPhone ? (
                        <div className="text-sm text-gray-400">No phone number on file for this subscriber.</div>
                      ) : (
                        <div>
                          <textarea value={sms} onChange={e => setSms(e.target.value)} rows={3} placeholder={`Message to ${data.subscriber.phone}`} className="input w-full text-sm" maxLength={480} />
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-xs text-gray-400">{sms.length}/480</span>
                            <button onClick={() => sms.trim() && smsMut.mutate(sms.trim())} disabled={!sms.trim() || smsMut.isPending} className="btn-primary text-sm py-1.5 flex items-center gap-1.5 disabled:opacity-50"><Send size={14} /> {smsMut.isPending ? 'Sending…' : 'Send'}</button>
                          </div>
                        </div>
                      )}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">History</h3>
                      {msgs.length === 0 ? <div className="text-sm text-gray-400 text-center py-6">No messages sent</div> : (
                        <div className="space-y-2">
                          {msgs.map(m => (
                            <div key={m.id} className="border border-gray-200 dark:border-gray-800 rounded-lg p-3 text-sm">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs text-gray-400">{fmtDateTime(m.createdAt)}{m.category ? ` · ${m.category}` : ''}</span>
                                <span className={`text-xs px-1.5 py-0.5 rounded ${m.status === 'SENT' || m.status === 'DELIVERED' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : m.status === 'FAILED' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>{m.status}</span>
                              </div>
                              <div className="text-gray-700 dark:text-gray-200 whitespace-pre-wrap">{m.body}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}

              {/* ───────── SESSIONS ───────── */}
              {tab === 'sessions' && (() => {
                const all = data.sessions as Sess[];
                return all.length === 0 ? <div className="text-sm text-gray-400 text-center py-6">No sessions recorded in the last 30 days</div> : (
                  <div className="space-y-2">{all.map(s => <SessionCard key={s.id} s={s} />)}</div>
                );
              })()}
            </div>
          </>
        )}
      </div>
    </>
  );
}
