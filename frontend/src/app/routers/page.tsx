'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getRouters, linkRouter, updateRouter, deleteRouter } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import toast from 'react-hot-toast';
import { Plus, Edit2, Trash2, Copy, Terminal } from 'lucide-react';

interface MikrotikRouter {
  id: string; name: string; host: string; status: string;
  identity?: string; cpuLoad?: number; uptime?: string; lastSeenAt?: string;
  interfaces?: { id: string; name: string; type: string; running: boolean }[];
}

const emptyForm = { name: '', host: '' };

export default function RoutersPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [bootstrapModal, setBootstrapModal] = useState<{ routerId: string; apiKey: string; command: string } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<MikrotikRouter | null>(null);
  const [form, setForm] = useState(emptyForm);

  const { data: routers = [], isLoading } = useQuery({ queryKey: ['routers'], queryFn: getRouters, refetchInterval: 10000 });

  const linkMut = useMutation({
    mutationFn: linkRouter,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['routers'] });
      setModalOpen(false);
      setForm(emptyForm);
      setBootstrapModal({ routerId: data.routerId, apiKey: data.apiKey, command: data.bootstrapCommand });
    },
    onError: () => toast.error('Failed to link router'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) => updateRouter(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['routers'] }); toast.success('Router updated'); closeModal(); },
    onError: () => toast.error('Failed to update router'),
  });

  const deleteMut = useMutation({
    mutationFn: deleteRouter,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['routers'] }); toast.success('Router deleted'); setDeleteId(null); },
  });

  const openCreate = () => { setEditing(null); setForm(emptyForm); setModalOpen(true); };
  const openEdit = (r: MikrotikRouter) => { setEditing(r); setForm({ name: r.name, host: r.host }); setModalOpen(true); };
  const closeModal = () => { setModalOpen(false); setEditing(null); setForm(emptyForm); };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editing) updateMut.mutate({ id: editing.id, data: form });
    else linkMut.mutate(form);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard!');
  };

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Routers</h1>
          <p className="text-sm text-gray-500 mt-1">{(routers as MikrotikRouter[]).length} routers configured</p>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-2"><Plus size={16} /> Link Router</button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {isLoading ? (
          <div className="card p-8 text-center text-gray-400">Loading...</div>
        ) : (routers as MikrotikRouter[]).length === 0 ? (
          <div className="card p-12 text-center col-span-2">
            <Terminal size={40} className="mx-auto text-gray-300 mb-3" />
            <p className="text-gray-400 font-medium">No routers linked yet</p>
            <p className="text-sm text-gray-500 mt-1">Click "Link Router" to add your first MikroTik</p>
          </div>
        ) : (routers as MikrotikRouter[]).map(r => (
          <div key={r.id} className="card p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold">{r.name}</h3>
                <p className="text-sm text-gray-500">{r.host}</p>
                {r.identity && <p className="text-xs text-gray-400 mt-0.5">Identity: {r.identity}</p>}
              </div>
              <div className="flex items-center gap-2">
                <span className={r.status === 'ONLINE' ? 'badge-green' : r.status === 'OFFLINE' ? 'badge-red' : 'badge-yellow'}>
                  {r.status}
                </span>
                <button onClick={() => openEdit(r)} className="p-1.5 text-gray-400 hover:text-blue-600"><Edit2 size={15} /></button>
                <button onClick={() => setDeleteId(r.id)} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={15} /></button>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">CPU</p>
                <p className="font-semibold">{r.cpuLoad !== undefined && r.cpuLoad !== null ? `${r.cpuLoad}%` : '-'}</p>
              </div>
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">Uptime</p>
                <p className="font-semibold text-xs">{r.uptime || '-'}</p>
              </div>
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">Interfaces</p>
                <p className="font-semibold">{r.interfaces?.length || 0}</p>
              </div>
            </div>
            {r.lastSeenAt && (
              <p className="text-xs text-gray-400 mt-3">Last seen: {new Date(r.lastSeenAt).toLocaleString()}</p>
            )}
          </div>
        ))}
      </div>

      {/* Link / Edit Modal */}
      <Modal isOpen={modalOpen} onClose={closeModal} title={editing ? 'Edit Router' : 'Link MikroTik Router'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Router Name</label>
            <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Main Gateway" required />
          </div>
          <div>
            <label className="label">Host / IP Address</label>
            <input className="input" value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} placeholder="e.g. 192.168.88.1" required />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={closeModal} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary" disabled={linkMut.isPending || updateMut.isPending}>
              {editing ? 'Update' : 'Link Router'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Bootstrap Command Modal */}
      {bootstrapModal && (
        <Modal isOpen={true} onClose={() => setBootstrapModal(null)} title="Router Linked — Run Bootstrap Command" size="lg">
          <div className="space-y-4">
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
              <p className="text-sm font-medium text-green-800 dark:text-green-300">✅ Router linked successfully!</p>
              <p className="text-xs text-green-700 dark:text-green-400 mt-1">Run the command below in your MikroTik terminal to complete setup.</p>
            </div>
            <div>
              <label className="label">Bootstrap Command (run in MikroTik terminal)</label>
              <div className="relative">
                <pre className="bg-gray-900 text-green-400 text-xs p-4 rounded-lg overflow-x-auto whitespace-pre-wrap break-all font-mono">
                  {bootstrapModal.command}
                </pre>
                <button onClick={() => copyToClipboard(bootstrapModal.command)}
                  className="absolute top-2 right-2 p-1.5 bg-gray-800 text-gray-400 hover:text-white rounded transition-colors">
                  <Copy size={14} />
                </button>
              </div>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <p className="text-xs text-blue-700 dark:text-blue-400">
                <strong>API Key:</strong> {bootstrapModal.apiKey}
              </p>
              <p className="text-xs text-blue-700 dark:text-blue-400 mt-1">
                The router will automatically send heartbeats every 15 seconds once the script is installed.
              </p>
            </div>
            <button onClick={() => setBootstrapModal(null)} className="btn-primary w-full">Done</button>
          </div>
        </Modal>
      )}

      <ConfirmDialog isOpen={!!deleteId} onClose={() => setDeleteId(null)}
        onConfirm={() => deleteId && deleteMut.mutate(deleteId)} loading={deleteMut.isPending} />
    </AppLayout>
  );
}
