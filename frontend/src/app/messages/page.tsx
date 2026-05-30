'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMessages, sendMessage, getSmsBalance, topupSms, type MessageRow } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import toast from 'react-hot-toast';
import { Plus, MessageSquare, Wallet, RefreshCw } from 'lucide-react';
import SearchInput from '@/components/ui/SearchInput';

export default function MessagesPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);
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
    mutationFn: () => topupSms(topup.amount, topup.phone || undefined),
    onSuccess: (data) => {
      toast.success(data.message || 'Topup initiated — check your phone for the M-Pesa prompt');
      setTopupOpen(false);
      setTimeout(() => refetchBalance(), 15000);
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Topup failed'),
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
              SMS balance:{' '}
              <span className="font-semibold">{balanceData ? balanceData.balance.toLocaleString() : '—'}</span>
            </span>
            <button onClick={() => refetchBalance()} className="text-gray-400 hover:text-gray-600" title="Refresh balance">
              <RefreshCw size={14} />
            </button>
          </div>
          <button onClick={() => setTopupOpen(true)} className="btn-secondary flex items-center gap-2 text-sm">
            <Wallet size={16} /> Refill SMS
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

      <Modal isOpen={topupOpen} onClose={() => setTopupOpen(false)} title="Refill SMS credit">
        <form onSubmit={(e) => { e.preventDefault(); topupMut.mutate(); }} className="space-y-4">
          <p className="text-sm text-gray-500">
            An M-Pesa STK push will be sent to your phone to top up your SMS credit.
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
              <label className="label">Phone (optional)</label>
              <input
                className="input"
                placeholder="Default: account phone"
                value={topup.phone}
                onChange={e => setTopup(t => ({ ...t, phone: e.target.value }))}
              />
            </div>
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setTopupOpen(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary" disabled={topupMut.isPending}>
              {topupMut.isPending ? 'Requesting…' : `Top up KES ${topup.amount}`}
            </button>
          </div>
        </form>
      </Modal>
    </AppLayout>
  );
}
