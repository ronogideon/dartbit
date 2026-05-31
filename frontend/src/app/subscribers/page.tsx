'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSubscribers, createSubscriber, updateSubscriber, deleteSubscriber, getPackages, getRouters } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import SubscriberDetail from '@/components/SubscriberDetail';
import { expiryInfo, type ExpiryTier } from '@/lib/format';

// Time-left pill colors: text close to the indicator, on a near-opaque tinted background.
const EXPIRY_PILL: Record<Exclude<ExpiryTier, 'none'>, string> = {
  ok: 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300',
  soon: 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300',
  expired: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300',
};
import toast from 'react-hot-toast';
import { Plus, Edit2, Trash2, Search } from 'lucide-react';

interface Subscriber {
  id: string; username: string; fullName: string; phone?: string; email?: string;
  service: string; isActive: boolean; expiresAt?: string; isOnline?: boolean;
  packageId?: string; routerId?: string; ipAddress?: string; macAddress?: string;
  lastOnlineAt?: string;
  package?: { id: string; name: string }; router?: { id: string; name: string };
}

// Convert ISO UTC string to "YYYY-MM-DDTHH:MM" in user's LOCAL time for datetime-local input
function isoToLocalInput(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Convert datetime-local input "2024-12-31T14:30" to ISO string preserving local time.
// We interpret the input as LOCAL time and produce a proper ISO with timezone offset
// so the backend stores the exact local moment the user picked.
function localInputToIso(local: string): string {
  if (!local) return '';
  // new Date("2024-12-31T14:30") is interpreted as local time by JS
  const d = new Date(local);
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
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
  const [tab, setTab] = useState<'ALL' | 'PPPOE' | 'HOTSPOT' | 'STATIC'>('ALL');
  const [modalOpen, setModalOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Subscriber | null>(null);
  const [form, setForm] = useState(emptyForm);

  const { data: subscribers = [], isPending } = useQuery({ queryKey: ['subscribers'], queryFn: getSubscribers });
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
      username: s.username,
      secret: '', // never pre-fill password
      fullName: s.fullName,
      phone: s.phone || '',
      email: s.email || '',
      service: s.service,
      packageId: s.package?.id || s.packageId || '',
      routerId: s.router?.id || s.routerId || '',
      // datetime-local needs YYYY-MM-DDTHH:MM in LOCAL time (not UTC)
      expiresAt: isoToLocalInput(s.expiresAt),
    });
    setModalOpen(true);
  };
  const closeModal = () => { setModalOpen(false); setEditing(null); setForm(emptyForm); };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (editing) {
      // For edit: only send fields that have values (preserves existing data on backend)
      const payload: Record<string, unknown> = {};
      if (form.username && form.username !== editing.username) payload.username = form.username;
      if (form.secret) payload.secret = form.secret; // only if password changed
      if (form.fullName && form.fullName !== editing.fullName) payload.fullName = form.fullName;
      if (form.phone !== (editing.phone || '')) payload.phone = form.phone;
      if (form.email !== (editing.email || '')) payload.email = form.email;
      if (form.service !== editing.service) payload.service = form.service;
      if (form.packageId !== (editing.package?.id || editing.packageId || '')) payload.packageId = form.packageId;
      if (form.routerId !== (editing.router?.id || editing.routerId || '')) payload.routerId = form.routerId;
      const currentExpiry = isoToLocalInput(editing.expiresAt);
      if (form.expiresAt !== currentExpiry) {
        // Send as full ISO with timezone so backend stores the exact local moment
        payload.expiresAt = form.expiresAt ? localInputToIso(form.expiresAt) : '';
      }

      // If user didn't actually change anything, still send the changed ones (could be empty if everything same)
      if (Object.keys(payload).length === 0) {
        toast.success('No changes to save');
        closeModal();
        return;
      }

      updateMut.mutate({ id: editing.id, data: payload });
    } else {
      // For create: send everything, convert empty to undefined
      const payload = {
        ...form,
        packageId: form.packageId || undefined,
        routerId: form.routerId || undefined,
        expiresAt: form.expiresAt ? localInputToIso(form.expiresAt) : undefined,
        phone: form.phone || undefined,
        email: form.email || undefined,
      };
      createMut.mutate(payload);
    }
  };

  const all = subscribers as Subscriber[];
  const counts = {
    ALL: all.length,
    PPPOE: all.filter(s => s.service === 'PPPOE').length,
    HOTSPOT: all.filter(s => s.service === 'HOTSPOT').length,
    STATIC: all.filter(s => s.service === 'STATIC').length,
  };
  const filtered = all.filter(s =>
    (tab === 'ALL' || s.service === tab) &&
    (s.fullName.toLowerCase().includes(search.toLowerCase()) ||
     s.username.toLowerCase().includes(search.toLowerCase()))
  );

  const TABS = [
    { key: 'ALL' as const, label: 'All' },
    { key: 'PPPOE' as const, label: 'PPPoE' },
    { key: 'HOTSPOT' as const, label: 'Hotspot' },
    { key: 'STATIC' as const, label: 'Static' },
  ];

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

      {/* Service tabs with count bubbles */}
      <div className="flex gap-1 mb-4 border-b border-gray-200 dark:border-gray-800 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px flex items-center gap-2 whitespace-nowrap transition ${tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
          >
            {t.label}
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${tab === t.key ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}>
              {counts[t.key]}
            </span>
          </button>
        ))}
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
                <th className="table-th">Subscriber</th>
                <th className="table-th">Service</th>
                <th className="table-th">Package</th>
                <th className="table-th">Time Left</th>
                <th className="table-th">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {isPending ? (
                <tr><td colSpan={5} className="table-td text-center py-8 text-gray-400">Loading...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={5} className="table-td text-center py-8 text-gray-400">No subscribers found</td></tr>
              ) : filtered.map(s => {
                const exp = expiryInfo(s.expiresAt);
                return (
                  <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                    <td className="table-td">
                      <button onClick={() => setDetailId(s.id)} className="flex items-center gap-2 text-left group">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${s.isOnline ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`} title={s.isOnline ? 'Online' : 'Offline'} />
                        <span>
                          <span className="block font-medium text-blue-600 group-hover:underline">{s.fullName}</span>
                          <span className="block text-xs text-gray-500">{s.username}</span>
                        </span>
                      </button>
                    </td>
                    <td className="table-td"><span className="badge-blue">{s.service}</span></td>
                    <td className="table-td">{s.package?.name || '-'}</td>
                    <td className="table-td">
                      {exp.tier === 'none' ? (
                        <span className="text-gray-400">—</span>
                      ) : (
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${EXPIRY_PILL[exp.tier]}`}>
                          {exp.text}
                        </span>
                      )}
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

      <SubscriberDetail subscriberId={detailId} onClose={() => setDetailId(null)} />

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
              <label className="label">Expires At (date & time)</label>
              <input className="input" type="datetime-local" value={form.expiresAt} onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))} />
              <p className="text-xs text-gray-500 mt-1">Leave blank for no expiry</p>
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
