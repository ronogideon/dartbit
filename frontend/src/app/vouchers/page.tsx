'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getVouchers, getVoucherBatches, generateVouchers, deleteVoucher, deleteVoucherBatch, getPackages, getRouters } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import toast from 'react-hot-toast';
import { Plus, Trash2, Ticket, Download, Copy, Layers, Search, X } from 'lucide-react';

interface Voucher {
  id: string; code: string; durationMinutes: number; isUsed: boolean;
  usedAt?: string; usedByMac?: string; usedByIp?: string;
  expiresAt?: string; batchId?: string; notes?: string;
  createdAt: string;
  package?: { id: string; name: string };
  router?: { id: string; name: string };
}
interface Batch {
  batchId: string; createdAt: string; packageName?: string;
  durationMinutes: number; total: number; used: number; unused: number;
  notes?: string;
}

const emptyForm = { count: 50, packageId: '', routerId: '', durationMinutes: 60, codeLength: 8, notes: '' };

export default function VouchersPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<'batches' | 'all'>('batches');
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'unused' | 'used'>('all');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteBatchId, setDeleteBatchId] = useState<string | null>(null);
  const [generatedBatch, setGeneratedBatch] = useState<Voucher[] | null>(null);

  const { data: vouchers = [], isPending } = useQuery({ queryKey: ['vouchers'], queryFn: getVouchers, refetchInterval: 10000 });
  const { data: batches = [] } = useQuery({ queryKey: ['voucher-batches'], queryFn: getVoucherBatches, refetchInterval: 10000 });
  const { data: packages = [] } = useQuery({ queryKey: ['packages'], queryFn: getPackages });
  const { data: routers = [] } = useQuery({ queryKey: ['routers'], queryFn: getRouters });

  const list = vouchers as Voucher[];
  const batchList = batches as Batch[];
  const pkgList = packages as Array<{ id: string; name: string; service: string }>;
  const hotspotPackages = pkgList.filter(p => p.service === 'HOTSPOT');
  const routerList = routers as Array<{ id: string; name: string }>;

  const generateMut = useMutation({
    mutationFn: generateVouchers,
    onSuccess: (data: { vouchers: Voucher[]; count: number }) => {
      qc.invalidateQueries({ queryKey: ['vouchers'] });
      qc.invalidateQueries({ queryKey: ['voucher-batches'] });
      toast.success(`Generated ${data.count} vouchers`);
      setGeneratedBatch(data.vouchers);
      setModalOpen(false);
      setForm(emptyForm);
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed'),
  });

  const deleteMut = useMutation({
    mutationFn: deleteVoucher,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vouchers'] });
      qc.invalidateQueries({ queryKey: ['voucher-batches'] });
      toast.success('Deleted'); setDeleteId(null);
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed'),
  });

  const deleteBatchMut = useMutation({
    mutationFn: deleteVoucherBatch,
    onSuccess: (data: { deleted: number }) => {
      qc.invalidateQueries({ queryKey: ['vouchers'] });
      qc.invalidateQueries({ queryKey: ['voucher-batches'] });
      toast.success(`Removed ${data.deleted} unused vouchers`); setDeleteBatchId(null);
    },
    onError: () => toast.error('Failed to delete batch'),
  });

  const filtered = list.filter(v => {
    if (filter === 'used' && !v.isUsed) return false;
    if (filter === 'unused' && v.isUsed) return false;
    if (search && !v.code.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const copyBatchCodes = (batchId: string) => {
    const codes = list.filter(v => v.batchId === batchId && !v.isUsed).map(v => v.code).join('\n');
    navigator.clipboard.writeText(codes);
    toast.success(`Copied ${codes.split('\n').length} codes to clipboard`);
  };

  const downloadBatchCsv = (batchId: string) => {
    const items = list.filter(v => v.batchId === batchId);
    const header = 'code,duration_minutes,package,status,used_at,used_by_mac\n';
    const rows = items.map(v =>
      `${v.code},${v.durationMinutes},${v.package?.name || ''},${v.isUsed ? 'used' : 'unused'},${v.usedAt || ''},${v.usedByMac || ''}`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `vouchers-${batchId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  function formatDuration(mins: number) {
    if (mins < 60) return `${mins}m`;
    if (mins < 60 * 24) return `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
    return `${Math.floor(mins / (60 * 24))}d`;
  }

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Ticket size={24} /> Voucher / Receipt</h1>
          <p className="text-sm text-gray-500 mt-1">{list.length} total · {list.filter(v => !v.isUsed).length} unused · {list.filter(v => v.isUsed).length} used</p>
        </div>
        <button onClick={() => setModalOpen(true)} className="btn-primary flex items-center gap-2">
          <Plus size={16} /> Generate Vouchers
        </button>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => setView('batches')} className={`px-4 py-2 text-sm rounded-lg font-medium ${view === 'batches' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-600'}`}>
          <Layers size={14} className="inline mr-1" /> Batches
        </button>
        <button onClick={() => setView('all')} className={`px-4 py-2 text-sm rounded-lg font-medium ${view === 'all' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-600'}`}>
          <Ticket size={14} className="inline mr-1" /> All Vouchers
        </button>
      </div>

      {view === 'batches' ? (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr>
                <th className="table-th">Batch</th>
                <th className="table-th">Package</th>
                <th className="table-th">Duration</th>
                <th className="table-th">Total</th>
                <th className="table-th">Used</th>
                <th className="table-th">Unused</th>
                <th className="table-th">Created</th>
                <th className="table-th text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {batchList.length === 0 ? (
                <tr><td colSpan={8} className="py-16 text-center text-gray-400">No voucher batches yet. Click "Generate Vouchers" above.</td></tr>
              ) : batchList.map(b => (
                <tr key={b.batchId} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                  <td className="table-td font-mono text-xs text-gray-500">{b.batchId.substring(6, 18)}</td>
                  <td className="table-td">{b.packageName || <span className="text-gray-400">Default</span>}</td>
                  <td className="table-td">{formatDuration(b.durationMinutes)}</td>
                  <td className="table-td font-medium">{b.total}</td>
                  <td className="table-td text-red-600">{b.used}</td>
                  <td className="table-td text-green-600">{b.unused}</td>
                  <td className="table-td text-gray-500 text-sm">{new Date(b.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td className="table-td text-right">
                    <div className="inline-flex gap-1">
                      <button onClick={() => copyBatchCodes(b.batchId)} title="Copy unused codes" className="p-1.5 text-gray-400 hover:text-blue-600"><Copy size={14} /></button>
                      <button onClick={() => downloadBatchCsv(b.batchId)} title="Download CSV" className="p-1.5 text-gray-400 hover:text-green-600"><Download size={14} /></button>
                      {b.unused > 0 && <button onClick={() => setDeleteBatchId(b.batchId)} title="Delete unused vouchers in batch" className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={14} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-4">
            <div className="relative flex-1 max-w-xs">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search code..." className="input pl-9 text-sm" />
            </div>
            <select value={filter} onChange={e => setFilter(e.target.value as 'all' | 'unused' | 'used')} className="input text-sm w-32">
              <option value="all">All</option>
              <option value="unused">Unused</option>
              <option value="used">Used</option>
            </select>
          </div>

          <div className="card overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th className="table-th">Code</th>
                  <th className="table-th">Package</th>
                  <th className="table-th">Duration</th>
                  <th className="table-th">Status</th>
                  <th className="table-th">Used By</th>
                  <th className="table-th">When</th>
                  <th className="table-th text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {isPending ? (
                  <tr><td colSpan={7} className="py-8 text-center text-gray-400">Loading...</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={7} className="py-16 text-center text-gray-400">No vouchers found</td></tr>
                ) : filtered.slice(0, 200).map(v => (
                  <tr key={v.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                    <td className="table-td font-mono font-bold text-base">{v.code}</td>
                    <td className="table-td">{v.package?.name || <span className="text-gray-400">—</span>}</td>
                    <td className="table-td">{formatDuration(v.durationMinutes)}</td>
                    <td className="table-td">
                      {v.isUsed ? <span className="badge-red">Used</span> : <span className="badge-green">Available</span>}
                    </td>
                    <td className="table-td text-xs font-mono text-gray-500">{v.usedByMac || v.usedByIp || '—'}</td>
                    <td className="table-td text-sm text-gray-500">{v.usedAt ? new Date(v.usedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
                    <td className="table-td text-right">
                      {!v.isUsed && (
                        <button onClick={() => setDeleteId(v.id)} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={14} /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > 200 && (
              <div className="p-3 text-center text-sm text-gray-500 border-t">Showing first 200 of {filtered.length} — use search to narrow down</div>
            )}
          </div>
        </>
      )}

      {/* Generate modal */}
      <Modal isOpen={modalOpen} onClose={() => { setModalOpen(false); setForm(emptyForm); }} title="Generate Voucher Batch">
        <form onSubmit={e => { e.preventDefault(); generateMut.mutate(form); }} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Number of vouchers</label>
              <input type="number" min={1} max={500} required className="input" value={form.count} onChange={e => setForm(f => ({ ...f, count: parseInt(e.target.value) || 1 }))} />
            </div>
            <div>
              <label className="label">Code length</label>
              <input type="number" min={4} max={16} required className="input" value={form.codeLength} onChange={e => setForm(f => ({ ...f, codeLength: parseInt(e.target.value) || 8 }))} />
            </div>
          </div>

          <div>
            <label className="label">Hotspot package</label>
            <select className="input" value={form.packageId} onChange={e => setForm(f => ({ ...f, packageId: e.target.value }))}>
              <option value="">— No package (uses default speed) —</option>
              {hotspotPackages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {hotspotPackages.length === 0 && (
              <p className="text-xs text-orange-500 mt-1">No HOTSPOT packages yet. Create one on the Packages page first.</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Session duration</label>
              <select className="input" value={form.durationMinutes} onChange={e => setForm(f => ({ ...f, durationMinutes: parseInt(e.target.value) }))}>
                <option value={30}>30 minutes</option>
                <option value={60}>1 hour</option>
                <option value={180}>3 hours</option>
                <option value={360}>6 hours</option>
                <option value={720}>12 hours</option>
                <option value={1440}>1 day</option>
                <option value={4320}>3 days</option>
                <option value={10080}>1 week</option>
                <option value={43200}>30 days</option>
              </select>
            </div>
            <div>
              <label className="label">Restrict to router (optional)</label>
              <select className="input" value={form.routerId} onChange={e => setForm(f => ({ ...f, routerId: e.target.value }))}>
                <option value="">— Any router —</option>
                {routerList.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Notes (optional)</label>
            <input className="input" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="e.g. Sold at front desk Nov 2024" />
          </div>

          <div className="flex gap-3 justify-end">
            <button type="button" onClick={() => { setModalOpen(false); setForm(emptyForm); }} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={generateMut.isPending} className="btn-primary">
              {generateMut.isPending ? 'Generating...' : `Generate ${form.count} vouchers`}
            </button>
          </div>
        </form>
      </Modal>

      {/* Generated batch viewer */}
      <Modal isOpen={!!generatedBatch} onClose={() => setGeneratedBatch(null)} title={`Generated ${generatedBatch?.length || 0} vouchers`}>
        {generatedBatch && (
          <div className="space-y-4">
            <p className="text-sm text-gray-500">Copy or download these codes — they're ready to use immediately and have been pushed to all your routers.</p>
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 max-h-72 overflow-y-auto font-mono text-sm">
              {generatedBatch.map(v => <div key={v.id} className="py-0.5">{v.code}</div>)}
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { navigator.clipboard.writeText(generatedBatch.map(v => v.code).join('\n')); toast.success('Copied!'); }}
                className="btn-secondary flex items-center gap-1"
              >
                <Copy size={14} /> Copy all
              </button>
              <button
                onClick={() => {
                  const csv = 'code,duration_minutes\n' + generatedBatch.map(v => `${v.code},${v.durationMinutes}`).join('\n');
                  const blob = new Blob([csv], { type: 'text/csv' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url; a.download = `vouchers-${Date.now()}.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="btn-primary flex items-center gap-1"
              >
                <Download size={14} /> Download CSV
              </button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteId}
        title="Delete voucher?"
        message="This will permanently delete this unused voucher."
        onConfirm={() => deleteId && deleteMut.mutate(deleteId)}
        onClose={() => setDeleteId(null)}
      />
      <ConfirmDialog
        isOpen={!!deleteBatchId}
        title="Delete unused vouchers in batch?"
        message="This will permanently delete all UNUSED vouchers in this batch. Used vouchers will be kept for audit."
        onConfirm={() => deleteBatchId && deleteBatchMut.mutate(deleteBatchId)}
        onClose={() => setDeleteBatchId(null)}
      />
    </AppLayout>
  );
}
