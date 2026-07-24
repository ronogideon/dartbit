'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPayments, createPayment, editPayment, deletePayment, getSubscribers, getPromptTarget, promptPayment, getPromptStatus, type PromptTarget } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import SubscriberLink from '@/components/ui/SubscriberLink';
import toast from 'react-hot-toast';
import { Plus, Trash2, Edit2, Lock, Smartphone } from 'lucide-react';
import SearchInput from '@/components/ui/SearchInput';

interface Payment {
  id: string; amount: number; method: string; source?: string; reference?: string; mpesaCode?: string;
  notes?: string; createdAt: string; subscriber?: { id?: string; fullName: string; username: string };
}
interface Subscriber { id: string; fullName: string; username: string; }

const emptyForm = { subscriberId: '', amount: '', method: 'MANUAL', reference: '', mpesaCode: '', notes: '' };

// A payment is automatic when it was created by a gateway (M-Pesa callback); manual when an admin
// recorded it. The backend stamps `source`; we fall back to mpesaCode for any legacy row.
function isAutomatic(p: Payment): boolean {
  return (p.source || (p.mpesaCode ? 'AUTOMATIC' : 'MANUAL')) === 'AUTOMATIC';
}

export default function PaymentsPage() {
  const qc = useQueryClient();
  // --- Prompt payment (tenant-initiated M-Pesa STK push) ---
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptSubId, setPromptSubId] = useState('');
  const [promptTarget, setPromptTarget] = useState<PromptTarget | null>(null);
  const [promptPhone, setPromptPhone] = useState('');
  const [promptAmount, setPromptAmount] = useState('');
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptSending, setPromptSending] = useState(false);
  const [promptStatus, setPromptStatus] = useState<string | null>(null);

  const resetPrompt = () => {
    setPromptOpen(false); setPromptSubId(''); setPromptTarget(null);
    setPromptPhone(''); setPromptAmount(''); setPromptStatus(null); setPromptSending(false);
  };

  // Pull the subscriber's saved phone and their package price to prefill the dialog. The tenant can
  // still edit both before sending — e.g. a relative paying on someone else's behalf.
  const loadPromptTarget = async (subId: string) => {
    setPromptSubId(subId);
    setPromptTarget(null); setPromptPhone(''); setPromptAmount(''); setPromptStatus(null);
    if (!subId) return;
    setPromptLoading(true);
    try {
      const t = await getPromptTarget(subId);
      setPromptTarget(t);
      setPromptPhone(t.phone || '');
      setPromptAmount(t.amount != null ? String(t.amount) : '');
    } catch {
      toast.error('Could not load that subscriber');
    } finally {
      setPromptLoading(false);
    }
  };

  const sendPrompt = async () => {
    if (!promptSubId) return toast.error('Choose a subscriber');
    if (!promptPhone.trim()) return toast.error('Enter the phone number to prompt');
    const amt = Number(promptAmount);
    if (!amt || amt <= 0) return toast.error('Enter an amount');
    setPromptSending(true);
    setPromptStatus('Sending request to the phone…');
    try {
      const r = await promptPayment({ subscriberId: promptSubId, phone: promptPhone.trim(), amount: amt });
      setPromptStatus(`Request sent to ${r.phone} — waiting for them to enter their M-Pesa PIN…`);
      // Poll until the customer completes or cancels (STK prompts expire after about a minute).
      const started = Date.now();
      const poll = async (): Promise<void> => {
        if (Date.now() - started > 90_000) { setPromptStatus('No response yet — you can check the Payments list shortly.'); setPromptSending(false); return; }
        await new Promise(res => setTimeout(res, 3000));
        try {
          const st = await getPromptStatus(r.transactionId);
          if (st.status === 'PAID') {
            toast.success('Payment received — subscriber renewed');
            qc.invalidateQueries({ queryKey: ['payments'] });
            qc.invalidateQueries({ queryKey: ['subscribers'] });
            resetPrompt();
            return;
          }
          if (st.status === 'FAILED' || st.status === 'CANCELLED') {
            setPromptStatus(st.message || 'The customer did not complete the payment.');
            setPromptSending(false);
            return;
          }
        } catch { /* keep polling */ }
        return poll();
      };
      void poll();
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not send the request';
      setPromptStatus(msg);
      toast.error(msg);
      setPromptSending(false);
    }
  };

  const [tab, setTab] = useState<'AUTOMATIC' | 'MANUAL'>('AUTOMATIC');
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Payment | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [editForm, setEditForm] = useState({ amount: '', notes: '' });
  const [search, setSearch] = useState('');

  const { data: payments = [], isPending } = useQuery({ queryKey: ['payments'], queryFn: getPayments });
  const { data: subscribers = [] } = useQuery({ queryKey: ['subscribers'], queryFn: getSubscribers });

  const createMut = useMutation({
    mutationFn: createPayment,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payments'] }); toast.success('Payment recorded'); setModalOpen(false); setForm(emptyForm); setTab('MANUAL'); },
    onError: () => toast.error('Failed to record payment'),
  });
  const editMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { amount?: number; notes?: string } }) => editPayment(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payments'] }); toast.success('Payment updated'); setEditing(null); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to update payment'),
  });
  const deleteMut = useMutation({
    mutationFn: deletePayment,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payments'] }); toast.success('Payment deleted'); setDeleteId(null); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to delete payment'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMut.mutate({ ...form, amount: Number(form.amount), reference: form.reference || undefined, mpesaCode: form.mpesaCode || undefined, notes: form.notes || undefined });
  };

  const openEdit = (p: Payment) => { setEditing(p); setEditForm({ amount: String(p.amount), notes: p.notes || '' }); };
  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    editMut.mutate({ id: editing.id, data: { amount: Number(editForm.amount), notes: editForm.notes || undefined } });
  };

  const list = payments as Payment[];
  const automatic = list.filter(isAutomatic);
  const manual = list.filter(p => !isAutomatic(p));
  const total = list.reduce((s, p) => s + p.amount, 0);

  const q = search.trim().toLowerCase();
  const match = (p: Payment) => !q ||
    (p.subscriber?.fullName || '').toLowerCase().includes(q) ||
    (p.subscriber?.username || '').toLowerCase().includes(q) ||
    (p.reference || '').toLowerCase().includes(q) ||
    (p.method || '').toLowerCase().includes(q) ||
    String(p.amount).includes(q);

  const rows = (tab === 'AUTOMATIC' ? automatic : manual).filter(match);

  const TABS = [
    { key: 'AUTOMATIC' as const, label: 'Automatic', count: automatic.length },
    { key: 'MANUAL' as const, label: 'Manual', count: manual.length },
  ];

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Payments</h1>
          <p className="text-sm text-gray-500 mt-1">Total collected: KES {total.toLocaleString()}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setPromptOpen(true)} className="btn-secondary flex items-center gap-2"><Smartphone size={16} /> Prompt Payment</button>
          <button onClick={() => setModalOpen(true)} className="btn-primary flex items-center gap-2"><Plus size={16} /> Record Payment</button>
        </div>
      </div>

      {/* Automatic vs Manual tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200 dark:border-gray-800">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px flex items-center gap-2 transition ${tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}>
            {t.label}
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${tab === t.key ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}>{t.count}</span>
          </button>
        ))}
      </div>

      <div className="mb-4 max-w-md">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by subscriber, reference, method, amount…" />
      </div>

      {tab === 'AUTOMATIC' && (
        <p className="text-xs text-gray-500 mb-3 flex items-center gap-1.5"><Lock size={12} /> Automatic payments come from the M-Pesa gateway and are a permanent record — they can't be edited or deleted.</p>
      )}

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-gray-800/50">
            <tr>
              <th className="table-th">Subscriber</th>
              <th className="table-th">Amount (KES)</th>
              <th className="table-th">Method</th>
              <th className="table-th">Reference</th>
              <th className="table-th">Date</th>
              <th className="table-th">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {isPending ? (
              <tr><td colSpan={6} className="table-td text-center py-8 text-gray-400">Loading...</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="table-td text-center py-8 text-gray-400">No {tab.toLowerCase()} payments</td></tr>
            ) : rows.map(p => (
              <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                <td className="table-td">
                  <p className="font-medium"><SubscriberLink id={p.subscriber?.id} name={p.subscriber?.fullName} /></p>
                  <p className="text-xs text-gray-500">{p.subscriber?.username}</p>
                </td>
                <td className="table-td font-semibold text-green-600">{p.amount.toLocaleString()}</td>
                <td className="table-td"><span className="badge-blue">{p.method}</span></td>
                <td className="table-td text-gray-500">{p.reference || '-'}</td>
                <td className="table-td text-gray-500">{new Date(p.createdAt).toLocaleString()}</td>
                <td className="table-td">
                  {isAutomatic(p) ? (
                    <span className="text-xs text-gray-400 flex items-center gap-1"><Lock size={13} /> Locked</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(p)} className="p-1.5 text-gray-400 hover:text-blue-600" title="Edit amount / notes"><Edit2 size={15} /></button>
                      <button onClick={() => setDeleteId(p.id)} className="p-1.5 text-gray-400 hover:text-red-600" title="Delete"><Trash2 size={15} /></button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Record (manual) payment */}
      <Modal isOpen={modalOpen} onClose={() => { setModalOpen(false); setForm(emptyForm); }} title="Record Payment">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Subscriber</label>
            <select className="input" value={form.subscriberId} onChange={e => setForm(f => ({ ...f, subscriberId: e.target.value }))} required>
              <option value="">-- Select Subscriber --</option>
              {(subscribers as Subscriber[]).map(s => <option key={s.id} value={s.id}>{s.fullName} ({s.username})</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Amount (KES)</label>
              <input className="input" type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required min={0} />
            </div>
            <div>
              <label className="label">Payment Method</label>
              <select className="input" value={form.method} onChange={e => setForm(f => ({ ...f, method: e.target.value }))}>
                <option value="MANUAL">Manual</option>
                <option value="MPESA">M-Pesa</option>
                <option value="BANK">Bank Transfer</option>
                <option value="CASH">Cash</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Reference</label>
              <input className="input" value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="label">Notes</label>
            <textarea className="input" rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary" disabled={createMut.isPending}>Record Payment</button>
          </div>
        </form>
      </Modal>

      {/* Prompt payment — tenant-initiated M-Pesa STK push to the subscriber's phone */}
      <Modal isOpen={promptOpen} onClose={resetPrompt} title="Prompt Payment">
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            Sends an M-Pesa request to the subscriber&apos;s phone. They approve it with their PIN and the
            renewal is applied automatically.
          </p>

          <div>
            <label className="label">Subscriber</label>
            <select className="input" value={promptSubId} onChange={e => loadPromptTarget(e.target.value)} disabled={promptSending}>
              <option value="">Select a subscriber…</option>
              {(subscribers as Subscriber[]).map(sub => (
                <option key={sub.id} value={sub.id}>{sub.fullName} ({sub.username})</option>
              ))}
            </select>
          </div>

          {promptLoading && <p className="text-sm text-gray-400">Loading their details…</p>}

          {promptTarget && (
            <>
              <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 p-3 text-sm">
                {promptTarget.hasPackage ? (
                  <p>
                    Package: <span className="font-medium">{promptTarget.packageName}</span>
                    {promptTarget.expired
                      ? <span className="text-red-500"> · expired — charging their previous package</span>
                      : <span className="text-green-600"> · active</span>}
                  </p>
                ) : (
                  <p className="text-amber-600">No package assigned — enter an amount manually.</p>
                )}
              </div>

              <div>
                <label className="label">Phone to prompt</label>
                <input className="input" value={promptPhone} onChange={e => setPromptPhone(e.target.value)}
                  placeholder="07XXXXXXXX" disabled={promptSending} />
                <p className="text-[11px] text-gray-400 mt-1">
                  {promptTarget.phone ? 'From their saved details — edit if someone else is paying.' : 'No number saved for this subscriber.'}
                </p>
              </div>

              <div>
                <label className="label">Amount (KES)</label>
                <input className="input" type="number" min={1} value={promptAmount}
                  onChange={e => setPromptAmount(e.target.value)} disabled={promptSending} />
                {promptTarget.amount != null && (
                  <p className="text-[11px] text-gray-400 mt-1">Their package price — edit to charge a different amount.</p>
                )}
              </div>
            </>
          )}

          {promptStatus && (
            <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3 text-sm">
              {promptStatus}
            </div>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={resetPrompt} className="btn-secondary">
              {promptSending ? 'Close' : 'Cancel'}
            </button>
            <button type="button" onClick={sendPrompt} className="btn-primary flex items-center gap-2"
              disabled={promptSending || !promptTarget}>
              <Smartphone size={16} /> {promptSending ? 'Waiting…' : 'Send request'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Edit manual payment — amount + notes only */}
      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title="Edit Payment">
        <form onSubmit={handleEditSubmit} className="space-y-4">
          <div>
            <label className="label">Amount (KES)</label>
            <input className="input" type="number" value={editForm.amount} onChange={e => setEditForm(f => ({ ...f, amount: e.target.value }))} required min={0} />
          </div>
          <div>
            <label className="label">Notes</label>
            <textarea className="input" rows={3} value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setEditing(null)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary" disabled={editMut.isPending}>Save Changes</button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog isOpen={!!deleteId} onClose={() => setDeleteId(null)}
        onConfirm={() => deleteId && deleteMut.mutate(deleteId)} loading={deleteMut.isPending} />
    </AppLayout>
  );
}
