'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSubscribers, createSubscriber, updateSubscriber, deleteSubscriber, getPackages, getRouters } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import toast from 'react-hot-toast';
import { Plus, Edit2, Trash2, Search } from 'lucide-react';

interface Subscriber {
  id: string; username: string; fullName: string; phone?: string;
  service: string; isActive: boolean; expiresAt?: string;
  package?: { name: string }; router?: { name: string };
}
interface Package { id: string; name: string; service: string; }
interface Router { id: string; name: string; }

const emptyForm = {
  username: '', secret: '', fullName: '', phone: '', email: '',
  service: 'PPPOE', packageId: '', routerId: '', expiresAt: '',
};

export default function SubscribersPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Subscriber | null>(null);
  const [form, setForm] = useState(emptyForm);

  const { data: subscribers = [], isLoading } = useQuery({ queryKey: ['subscribers'], queryFn: getSubscribers });
  const { data: packages = [] } = useQuery({ queryKey: ['packages'], queryFn: getPackages });
  const { data: routers = [] } = useQuery({ queryKey: ['routers'], queryFn: getRouters });

  const createMut = useMutation({
    mutationFn: createSubscriber,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['subscribers'] }); toast.success('Subscriber created'); closeModal(); },
    onError: () => toast.error('Failed to create subscriber'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) => updateSubscriber(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['subscribers'] }); toast.success('Subscriber updated'); closeModal(); },
    onError: () => toast.error('Failed to update subscriber'),
  });

  const deleteMut = useMutation({
    mutationFn: deleteSubscriber,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['subscribers'] }); toast.success('Subscriber deleted'); setDeleteId(null); },
    onError: () => toast.error('Failed to delete subscriber'),
  });

  const openCreate = () => { setEditing(null); setForm(emptyForm); setModalOpen(true); };
  const openEdit = (s: Subscriber) => {
    setEditing(s);
    setForm({
      username: s.username, secret: '', fullName: s.fullName, phone: s.phone || '',
      email: '', service: s.service, packageId: '', routerId: '',
      expiresAt: s.expiresAt ? s.expiresAt.split('T')[0] : '',
    });
    setModalOpen(true);
  };
  const closeModal = () => { setModalOpen(false); setEditing(null); setForm(emptyForm); };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      ...form,
      packageId: form.packageId || undefined,
      routerId: form.routerId || undefined,
      expiresAt: form.expiresAt || undefined,
      phone: form.phone || undefined,
      email: form.email || undefined,
    };
    if (editing) updateMut.mutate({ id: editing.id, data: payload });
    else createMut.mutate(payload);
  };

  const filtered = (subscribers as Subscriber[]).filter(s =>
    s.fullName.toLowerCase().includes(search.toLowerCase()) ||
    s.username.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Subscribers</h1>
          <p className="text-sm text-gray-500 mt-1">{(subscribers as Subscriber[]).length} total subscribers</p>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-2">
          <Plus size={16} /> Add Subscriber
        </button>
      </div>

      <div className="card mb-6">
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              className="input pl-9" placeholder="Search subscribers..." />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr>
                <th className="table-th">Name</th>
                <th className="table-th">Username</th>
                <th className="table-th">Service</th>
                <th className="table-th">Package</th>
                <th className="table-th">Status</th>
                <th className="table-th">Expires</th>
                <th className="table-th">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {isLoading ? (
                <tr><td colSpan={7} className="table-td text-center py-8 text-gray-400">Loading...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="table-td text-center py-8 text-gray-400">No subscribers found</td></tr>
              ) : filtered.map(s => {
                const expired = s.expiresAt && new Date(s.expiresAt) < new Date();
                return (
                  <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                    <td className="table-td font-medium">{s.fullName}</td>
                    <td className="table-td text-gray-500">{s.username}</td>
                    <td className="table-td"><span className="badge-blue">{s.service}</span></td>
                    <td className="table-td">{s.package?.name || '-'}</td>
                    <td className="table-td">
                      <span className={s.isActive && !expired ? 'badge-green' : 'badge-red'}>
                        {s.isActive && !expired ? 'Active' : expired ? 'Expired' : 'Inactive'}
                      </span>
                    </td>
                    <td className="table-td text-gray-500">
                      {s.expiresAt ? new Date(s.expiresAt).toLocaleDateString() : '-'}
                    </td>
                    <td className="table-td">
                      <div className="flex items-center gap-2">
                        <button onClick={() => openEdit(s)} className="p-1.5 text-gray-400 hover:text-blue-600 transition-colors"><Edit2 size={15} /></button>
                        <button onClick={() => setDeleteId(s.id)} className="p-1.5 text-gray-400 hover:text-red-600 transition-colors"><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={modalOpen} onClose={closeModal} title={editing ? 'Edit Subscriber' : 'Add Subscriber'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Full Name</label>
              <input className="input" value={form.fullName} onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))} required />
            </div>
            <div>
              <label className="label">Username</label>
              <input className="input" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Password / Secret</label>
              <input className="input" type="password" value={form.secret} onChange={e => setForm(f => ({ ...f, secret: e.target.value }))} required={!editing} placeholder={editing ? 'Leave blank to keep' : ''} />
            </div>
            <div>
              <label className="label">Phone</label>
              <input className="input" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Service Type</label>
              <select className="input" value={form.service} onChange={e => setForm(f => ({ ...f, service: e.target.value }))}>
                <option value="PPPOE">PPPoE</option>
                <option value="HOTSPOT">Hotspot</option>
                <option value="STATIC">Static</option>
              </select>
            </div>
            <div>
              <label className="label">Package</label>
              <select className="input" value={form.packageId} onChange={e => setForm(f => ({ ...f, packageId: e.target.value }))}>
                <option value="">-- Select Package --</option>
                {(packages as Package[]).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Router</label>
              <select className="input" value={form.routerId} onChange={e => setForm(f => ({ ...f, routerId: e.target.value }))}>
                <option value="">-- Select Router --</option>
                {(routers as Router[]).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Expires At</label>
              <input className="input" type="date" value={form.expiresAt} onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={closeModal} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary" disabled={createMut.isPending || updateMut.isPending}>
              {editing ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteId} onClose={() => setDeleteId(null)}
        onConfirm={() => deleteId && deleteMut.mutate(deleteId)}
        loading={deleteMut.isPending}
        message="This will permanently delete the subscriber and all associated data."
      />
    </AppLayout>
  );
}
