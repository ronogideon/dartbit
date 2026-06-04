'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMessages, sendMessage, getSmsBalance, topupSms, broadcastMessage, getRouters, type MessageRow } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import toast from 'react-hot-toast';
import { Plus, MessageSquare, Wallet, RefreshCw, Users, Send } from 'lucide-react';
import SearchInput from '@/components/ui/SearchInput';

export default function MessagesPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);
  const [bcastOpen, setBcastOpen] = useState(false);
  const [bcast, setBcast] = useState<{ body: string; routerIds: string[]; services: string[]; statuses: string[] }>({ body: '', routerIds: [], services: [], statuses: [] });
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ recipient: '', body: '' });
  const [topup, setTopup] = useState({ amount: 500, phone: '' });

  const { data: messages = [], isPending } = useQuery({
    queryKey: ['messages'],
    queryFn: getMessages,
    refetchInterval: 30000,
  });
  const { data: balanceData, refetch: refetchBalance } = useQuery({
    queryKey: ['sms-balance'],
    queryFn: getSmsBalance,
    refetchInterval: 60000,
    retry: false,
  });

  const { data: routers = [] } = useQuery({ queryKey: ['routers'], queryFn: getRouters, staleTime: 60000 });

  const bcastMut = useMutation({
    mutationFn: () => broadcastMessage({
      body: bcast.body,
      routerIds: bcast.routerIds.length ? bcast.routerIds : undefined,
      services: bcast.services.length ? bcast.services : undefined,
      statuses: bcast.statuses.length ? bcast.statuses : undefined,
    }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['sms-balance'] });
      toast.success(`Sent to ${r.sent} of ${r.matched}${r.failed ? ` (${r.failed} failed)` : ''}`);
      setBcastOpen(false);
      setBcast({ body: '', routerIds: [], services: [], statuses: [] });
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Broadcast failed'),
  });

  const sendMut = useMutation({
    mutationFn: () => sendMessage(form.recipient, form.body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['sms-balance'] });
      toast.success('Message sent');
      setModalOpen(false);
      setForm({ recipient: '', body: '' });
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to send message'),
  });

  const topupMut = useMutation({
    mutationFn: () => topupSms(topup.amount, topup.phone),
    onSuccess: (data) => {
      toast.success(data.message || 'Check your phone for the M-Pesa prompt');
      setTopupOpen(false);
      // Poll the wallet balance a few times as the callback lands.
      let tries = 0;
      const iv = setInterval(() => { tries++; refetchBalance(); if (tries >= 6) clearInterval(iv); }, 5000);
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Top-up failed'),
  });

  const allMsgs = messages as MessageRow[];
  const mq = search.trim().toLowerCase();
  const list = mq ? allMsgs.filter(m => (m.recipient||'').toLowerCase().includes(mq) || (m.username||'').toLowerCase().includes(mq) || (m.body||'').toLowerCase().includes(mq) || (m.category||'').toLowerCase().includes(mq) || (m.status||'').toLowerCase().includes(mq)) : allMsgs;
  const totalCost = list.reduce((sum, m) => sum + (m.cost || 0), 0);

  function statusBadge(s: string) {
    if (s === 'SENT' || s === 'DELIVERED') return 'badge-green';
    if (s === 'FAILED') return 'badge-red';
    return 'badge-yellow';
  }

  function categoryBadge(c?: string | null) {
    if (!c) return null;
    const colors: Record<string, string> = {
      WELCOME: 'badge-blue', RECEIPT: 'badge-blue', REMINDER: 'badge-yellow', MANUAL: 'badge-gray', OTHER: 'badge-gray',
    };
    return <span className={colors[c] || 'badge-gray'}>{c}</span>;
  }

  return (
    <AppLayout>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold">Messages</h1>
          <p className="text-sm text-gray-500 mt-1">{list.length} messages · KES {totalCost.toFixed(2)} total cost</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
            <Wallet size={16} className="text-blue-600" />
            <span className="text-sm">
              {balanceData?.mode === 'WALLET' ? (
                <>
                  SMS wallet:{' '}
                  <span className="font-semibold">KES {(balanceData.balanceKES ?? 0).toLocaleString()}</span>
                  <span className="text-gray-400"> · ~{(balanceData.smsRemaining ?? 0).toLocaleString()} SMS</span>
                </>
              ) : (
                <>SMS balance: <span className="font-semibold">{balanceData ? balanceData.balance.toLocaleString() : '—'}</span></>
              )}
            </span>
            <button onClick={() => refetchBalance()} className="text-gray-400 hover:text-gray-600" title="Refresh balance">
              <RefreshCw size={14} />
            </button>
          </div>
          <button onClick={() => setTopupOpen(true)} className="btn-secondary flex items-center gap-2 text-sm">
            <Wallet size={16} /> Refill SMS
          </button>
          <button onClick={() => setBcastOpen(true)} className="btn-secondary flex items-center gap-2">
            <Users size={16} /> Group Broadcast
          </button>
          <button onClick={() => setModalOpen(true)} className="btn-primary flex items-center gap-2">
            <Plus size={16} /> New Message
          </button>
        </div>
      </div>

      <div className="mb-4 max-w-md">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by phone, username, message, status…" />
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr>
                <th className="table-th">Time</th>
                <th className="table-th">Username</th>
                <th className="table-th">Phone</th>
                <th className="table-th">Message</th>
                <th className="table-th">Category</th>
                <th className="table-th">Status</th>
                <th className="table-th">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {isPending ? (
                <tr><td colSpan={7} className="table-td text-center py-8 text-gray-400">Loading...</td></tr>
              ) : list.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center">
                    <MessageSquare size={40} className="mx-auto text-gray-300 mb-3" />
                    <p className="text-gray-400">No messages yet</p>
                  </td>
                </tr>
              ) : list.map(m => (
                <tr key={m.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                  <td className="table-td text-gray-500 whitespace-nowrap text-xs">{new Date(m.createdAt).toLocaleString()}</td>
                  <td className="table-td font-medium">{m.username || '—'}</td>
                  <td className="table-td font-mono text-xs">{m.recipient}</td>
                  <td className="table-td text-gray-600 dark:text-gray-400 max-w-md truncate" title={m.body}>{m.body}</td>
                  <td className="table-td">{categoryBadge(m.category)}</td>
                  <td className="table-td">
                    <span className={statusBadge(m.status)}>{m.status}</span>
                    {m.status === 'FAILED' && m.errorMessage && (
                      <div className="text-xs text-red-500 mt-1" title={m.errorMessage}>{m.errorMessage}</div>
                    )}
                  </td>
                  <td className="table-td text-gray-700 dark:text-gray-300 whitespace-nowrap">
                    {m.cost ? `KES ${m.cost.toFixed(2)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Send SMS">
        <form onSubmit={(e) => { e.preventDefault(); sendMut.mutate(); }} className="space-y-4">
          <div>
            <label className="label">Recipient</label>
            <input
              className="input"
              value={form.recipient}
              onChange={e => setForm(f => ({ ...f, recipient: e.target.value }))}
              placeholder="0712345678"
              required
            />
          </div>
          <div>
            <label className="label">Message</label>
            <textarea
              className="input"
              rows={4}
              value={form.body}
              onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
              placeholder="Type your message..."
              required
              maxLength={480}
            />
            <div className="text-xs text-gray-400 mt-1">{form.body.length} / 480 chars · ~{Math.max(1, Math.ceil(form.body.length / 160))} SMS</div>
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary" disabled={sendMut.isPending}>
              {sendMut.isPending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={topupOpen} onClose={() => setTopupOpen(false)} title="Top up SMS wallet">
        <form onSubmit={(e) => { e.preventDefault(); topupMut.mutate(); }} className="space-y-4">
          <p className="text-sm text-gray-500">
            An M-Pesa prompt will be sent to your phone. Your SMS wallet is credited once payment completes.
            {balanceData?.mode === 'WALLET' && balanceData.rate ? ` At KES ${balanceData.rate}/SMS, KES ${topup.amount} ≈ ${Math.floor(topup.amount / balanceData.rate)} SMS.` : ''}
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Amount (KES)</label>
              <input
                className="input"
                type="number"
                min={1}
                value={topup.amount}
                onChange={e => setTopup(t => ({ ...t, amount: Number(e.target.value) }))}
                required
              />
            </div>
            <div>
              <label className="label">M-Pesa Phone</label>
              <input
                className="input"
                placeholder="07XXXXXXXX"
                value={topup.phone}
                onChange={e => setTopup(t => ({ ...t, phone: e.target.value }))}
                required
              />
            </div>
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setTopupOpen(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary" disabled={topupMut.isPending || !topup.phone}>
              {topupMut.isPending ? 'Requesting…' : `Top up KES ${topup.amount}`}
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={bcastOpen} onClose={() => setBcastOpen(false)} title="Group Broadcast">
        <div className="space-y-4">
          <p className="text-sm text-gray-500">Send one SMS to everyone matching the selected groups. Leave a group blank to not filter by it. Placeholders like <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">{'{name}'}</code>, <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">{'{package}'}</code>, <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">{'{expiry}'}</code> are filled per subscriber.</p>

          <div>
            <label className="label">User type</label>
            <div className="flex flex-wrap gap-2">
              {(['PPPOE', 'HOTSPOT', 'STATIC'] as const).map(s => {
                const on = bcast.services.includes(s);
                return <button key={s} type="button" onClick={() => setBcast(b => ({ ...b, services: on ? b.services.filter(x => x !== s) : [...b.services, s] }))}
                  className={`px-3 py-1.5 rounded-lg text-sm border ${on ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-gray-700'}`}>{s === 'PPPOE' ? 'PPPoE' : s.charAt(0) + s.slice(1).toLowerCase()}</button>;
              })}
            </div>
          </div>

          <div>
            <label className="label">Status</label>
            <div className="flex flex-wrap gap-2">
              {(['ACTIVE', 'EXPIRED'] as const).map(s => {
                const on = bcast.statuses.includes(s);
                return <button key={s} type="button" onClick={() => setBcast(b => ({ ...b, statuses: on ? b.statuses.filter(x => x !== s) : [...b.statuses, s] }))}
                  className={`px-3 py-1.5 rounded-lg text-sm border ${on ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-gray-700'}`}>{s.charAt(0) + s.slice(1).toLowerCase()}</button>;
              })}
            </div>
          </div>

          <div>
            <label className="label">Routers</label>
            <div className="flex flex-wrap gap-2 max-h-28 overflow-y-auto">
              {(routers as { id: string; name: string }[]).length === 0 ? <span className="text-sm text-gray-400">No routers</span> :
                (routers as { id: string; name: string }[]).map(r => {
                  const on = bcast.routerIds.includes(r.id);
                  return <button key={r.id} type="button" onClick={() => setBcast(b => ({ ...b, routerIds: on ? b.routerIds.filter(x => x !== r.id) : [...b.routerIds, r.id] }))}
                    className={`px-3 py-1.5 rounded-lg text-sm border ${on ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-gray-700'}`}>{r.name}</button>;
                })}
            </div>
            <p className="text-xs text-gray-400 mt-1">No selection = all users system-wide for this ISP.</p>
          </div>

          <div>
            <label className="label">Message</label>
            <textarea className="input min-h-[90px]" value={bcast.body} onChange={e => setBcast(b => ({ ...b, body: e.target.value }))} placeholder="Hi {name}, your {package} plan expires on {expiry}…" />
            <p className="text-xs text-gray-400 mt-1">{bcast.body.length} chars · ~{Math.max(1, Math.ceil(bcast.body.length / 160))} SMS each</p>
          </div>

          <div className="flex gap-2 justify-end pt-1">
            <button onClick={() => setBcastOpen(false)} className="btn-secondary">Cancel</button>
            <button onClick={() => bcast.body.trim() ? bcastMut.mutate() : toast.error('Enter a message')} disabled={bcastMut.isPending} className="btn-primary flex items-center gap-2">
              <Send size={15} /> {bcastMut.isPending ? 'Sending…' : 'Send broadcast'}
            </button>
          </div>
        </div>
      </Modal>
    </AppLayout>
  );
}
