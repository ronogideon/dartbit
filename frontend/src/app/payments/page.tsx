'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPayments, createPayment, deletePayment, getSubscribers } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';

interface Payment { id: string; amount: number; method: string; reference?: string; mpesaCode?: string; createdAt: string; subscriber?: { fullName: string; username: string }; }
interface Subscriber { id: string; fullName: string; username: string; }

const emptyForm = { subscriberId: '', amount: '', method: 'MANUAL', reference: '', mpesaCode: '', notes: '' };

export default function PaymentsPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const { data: payments = [], isLoading } = useQuery({ queryKey: ['payments'], queryFn: getPayments });
  const { data: subscribers = [] } = useQuery({ queryKey: ['subscribers'], queryFn: getSubscribers });

  const createMut = useMutation({
    mutationFn: createPayment,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payments'] }); toast.success('Payment recorded'); setModalOpen(false); setForm(emptyForm); },
    onError: () => toast.error('Failed to record payment'),
  });
  const deleteMut = useMutation({
    mutationFn: deletePayment,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payments'] }); toast.success('Payment deleted'); setDeleteId(null); },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMut.mutate({ ...form, amount: Number(form.amount), reference: form.reference || undefined, mpesaCode: form.mpesaCode || undefined, notes: form.notes || undefined });
  };

  const total = (payments as Payment[]).reduce((s, p) => s + p.amount, 0);

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Payments</h1>
          <p className="text-sm text-gray-500 mt-1">Total collected: KES {total.toLocaleString()}</p>
        </div>
        <button onClick={() => setModalOpen(true)} className="btn-primary flex items-center gap-2"><Plus size={16} /> Record Payment</button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-gray-800/50">
            <tr>
              <th className="table-th">Subscriber</th>
              <th className="table-th">Amount (KES)</th>
              <th className="table-th">Method</th>
              <th className="table-th">Reference</th>
              <th className="table-th">M-Pesa Code</th>
              <th className="table-th">Date</th>
              <th className="table-th">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {isLoading ? (
              <tr><td colSpan={7} className="table-td text-center py-8 text-gray-400">Loading...</td></tr>
            ) : (payments as Payment[]).map(p => (
              <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                <td className="table-td">
                  <p className="font-medium">{p.subscriber?.fullName}</p>
                  <p className="text-xs text-gray-500">{p.subscriber?.username}</p>
                </td>
                <td className="table-td font-semibold text-green-600">{p.amount.toLocaleString()}</td>
                <td className="table-td"><span className="badge-blue">{p.method}</span></td>
                <td className="table-td text-gray-500">{p.reference || '-'}</td>
                <td className="table-td text-gray-500">{p.mpesaCode || '-'}</td>
                <td className="table-td text-gray-500">{new Date(p.createdAt).toLocaleString()}</td>
                <td className="table-td">
                  <button onClick={() => setDeleteId(p.id)} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={15} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
            <div>
              <label className="label">M-Pesa Code</label>
              <input className="input" value={form.mpesaCode} onChange={e => setForm(f => ({ ...f, mpesaCode: e.target.value }))} placeholder="e.g. QHX1234567" />
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

      <ConfirmDialog isOpen={!!deleteId} onClose={() => setDeleteId(null)}
        onConfirm={() => deleteId && deleteMut.mutate(deleteId)} loading={deleteMut.isPending} />
    </AppLayout>
  );
}
