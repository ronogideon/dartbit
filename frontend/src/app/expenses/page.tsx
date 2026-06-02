'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getExpenses, getExpenseSummary, addExpense, deleteExpense, type Expense } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import toast from 'react-hot-toast';
import { Plus, Trash2, Receipt, MessageSquare, Building2, Wallet } from 'lucide-react';

const kes = (n: number) => `KES ${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const CATEGORY = {
  SMS: { label: 'SMS', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300', icon: MessageSquare },
  TENANCY: { label: 'Tenancy', cls: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300', icon: Building2 },
  OTHER: { label: 'Other', cls: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300', icon: Wallet },
} as const;

const emptyForm = { amount: '', description: '', paymentMode: 'M-Pesa', reference: '' };

export default function ExpensesPage() {
  const qc = useQueryClient();
  const { data: expenses = [], isPending } = useQuery({ queryKey: ['expenses'], queryFn: getExpenses });
  const { data: summary } = useQuery({ queryKey: ['expense-summary'], queryFn: getExpenseSummary });
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['expenses'] });
    qc.invalidateQueries({ queryKey: ['expense-summary'] });
  };

  const createMut = useMutation({
    mutationFn: () => addExpense({
      amount: parseFloat(form.amount),
      description: form.description.trim() || undefined,
      paymentMode: form.paymentMode.trim() || undefined,
      reference: form.reference.trim() || undefined,
    }),
    onSuccess: () => { refresh(); toast.success('Expense added'); setModalOpen(false); setForm(emptyForm); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to add'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteExpense(id),
    onSuccess: () => { refresh(); toast.success('Expense deleted'); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Cannot delete'),
  });

  const submit = () => {
    const amt = parseFloat(form.amount);
    if (!amt || amt <= 0) return toast.error('Enter a valid amount');
    createMut.mutate();
  };

  const list = expenses as Expense[];
  const cat = (c: string) => CATEGORY[c as keyof typeof CATEGORY] || CATEGORY.OTHER;

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">Expenses</h1>
          <p className="text-sm text-gray-500 mt-0.5">SMS top-ups and tenancy are recorded automatically. Add your own below.</p>
        </div>
        <button onClick={() => setModalOpen(true)} className="btn-primary flex items-center gap-2"><Plus size={16} /> Add Expense</button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="card p-5">
          <div className="text-sm text-gray-500 mb-1">Total Expenses</div>
          <div className="text-2xl font-bold">{kes(summary?.total || 0)}</div>
          <div className="text-xs text-gray-400 mt-1">{summary?.count || 0} record{(summary?.count || 0) === 1 ? '' : 's'}</div>
        </div>
        <div className="card p-5">
          <div className="text-sm text-gray-500 mb-1">This Month</div>
          <div className="text-2xl font-bold">{kes(summary?.thisMonth || 0)}</div>
        </div>
        <div className="card p-5">
          <div className="text-sm text-gray-500 mb-2">By Category</div>
          <div className="space-y-1">
            {(['SMS', 'TENANCY', 'OTHER'] as const).map(c => (
              <div key={c} className="flex justify-between text-xs">
                <span className="text-gray-500">{CATEGORY[c].label}</span>
                <span className="font-medium">{kes(summary?.byCategory?.[c] || 0)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr>
                <th className="table-th">Date</th>
                <th className="table-th">Category</th>
                <th className="table-th">Description</th>
                <th className="table-th">Mode</th>
                <th className="table-th">Reference</th>
                <th className="table-th">Amount</th>
                <th className="table-th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {isPending ? (
                <tr><td colSpan={7} className="table-td text-center py-8 text-gray-400">Loading...</td></tr>
              ) : list.length === 0 ? (
                <tr><td colSpan={7} className="py-12 text-center">
                  <Receipt size={36} className="mx-auto text-gray-300 mb-2" />
                  <p className="text-gray-400 text-sm">No expenses yet</p>
                </td></tr>
              ) : list.map(e => {
                const C = cat(e.category);
                return (
                  <tr key={e.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                    <td className="table-td text-sm text-gray-500">{new Date(e.incurredAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                    <td className="table-td"><span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${C.cls}`}><C.icon size={11} /> {C.label}</span></td>
                    <td className="table-td text-sm">{e.description || '—'}</td>
                    <td className="table-td text-sm text-gray-500">{e.paymentMode || '—'}</td>
                    <td className="table-td text-sm text-gray-500 font-mono">{e.reference || '—'}</td>
                    <td className="table-td font-semibold">{kes(e.amount)}</td>
                    <td className="table-td">
                      {e.source === 'MANUAL' ? (
                        <button onClick={() => deleteMut.mutate(e.id)} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={15} /></button>
                      ) : (
                        <span className="text-[10px] uppercase tracking-wide text-gray-400">Auto</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Add Expense">
        <div className="space-y-4">
          <div>
            <label className="label">Amount (KES)</label>
            <input type="number" min="0" step="0.01" className="input" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" autoFocus />
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="e.g. Router purchase, rent, fuel" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Mode of payment</label>
              <select className="input" value={form.paymentMode} onChange={e => setForm(f => ({ ...f, paymentMode: e.target.value }))}>
                <option>M-Pesa</option><option>Cash</option><option>Bank</option><option>Card</option><option>Other</option>
              </select>
            </div>
            <div>
              <label className="label">Transaction reference</label>
              <input className="input" value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} placeholder="optional" />
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <button onClick={() => setModalOpen(false)} className="btn-secondary">Cancel</button>
            <button onClick={submit} disabled={createMut.isPending} className="btn-primary">{createMut.isPending ? 'Adding…' : 'Add Expense'}</button>
          </div>
        </div>
      </Modal>
    </AppLayout>
  );
}
