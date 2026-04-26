'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPackages, createPackage, updatePackage, deletePackage } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import toast from 'react-hot-toast';
import { Plus, Edit2, Trash2 } from 'lucide-react';

interface Package {
  id: string; name: string; service: string; speedUpKbps: number;
  speedDownKbps: number; validityMinutes: number; price: number; isActive: boolean;
}

const emptyForm = { name: '', service: 'PPPOE', speedUpKbps: 10240, speedDownKbps: 10240, validityMinutes: 43200, price: 1500 };

function formatSpeed(kbps: number) {
  return kbps >= 1024 ? `${(kbps / 1024).toFixed(0)} Mbps` : `${kbps} Kbps`;
}
function formatValidity(mins: number) {
  if (mins >= 43200) return `${(mins / 43200).toFixed(0)} month(s)`;
  if (mins >= 1440) return `${(mins / 1440).toFixed(0)} day(s)`;
  return `${mins} min`;
}

export default function PackagesPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Package | null>(null);
  const [form, setForm] = useState(emptyForm);

  const { data: packages = [], isLoading } = useQuery({ queryKey: ['packages'], queryFn: getPackages });

  const createMut = useMutation({
    mutationFn: createPackage,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['packages'] }); toast.success('Package created'); closeModal(); },
    onError: () => toast.error('Failed to create package'),
  });
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) => updatePackage(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['packages'] }); toast.success('Package updated'); closeModal(); },
    onError: () => toast.error('Failed to update package'),
  });
  const deleteMut = useMutation({
    mutationFn: deletePackage,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['packages'] }); toast.success('Package deleted'); setDeleteId(null); },
    onError: () => toast.error('Failed to delete package'),
  });

  const openCreate = () => { setEditing(null); setForm(emptyForm); setModalOpen(true); };
  const openEdit = (p: Package) => {
    setEditing(p);
    setForm({ name: p.name, service: p.service, speedUpKbps: p.speedUpKbps, speedDownKbps: p.speedDownKbps, validityMinutes: p.validityMinutes, price: p.price });
    setModalOpen(true);
  };
  const closeModal = () => { setModalOpen(false); setEditing(null); };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = { ...form, speedUpKbps: Number(form.speedUpKbps), speedDownKbps: Number(form.speedDownKbps), validityMinutes: Number(form.validityMinutes), price: Number(form.price) };
    if (editing) updateMut.mutate({ id: editing.id, data: payload });
    else createMut.mutate(payload);
  };

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Packages</h1>
          <p className="text-sm text-gray-500 mt-1">{(packages as Package[]).length} packages</p>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-2"><Plus size={16} /> Add Package</button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-gray-800/50">
            <tr>
              <th className="table-th">Name</th>
              <th className="table-th">Service</th>
              <th className="table-th">Upload</th>
              <th className="table-th">Download</th>
              <th className="table-th">Validity</th>
              <th className="table-th">Price (KES)</th>
              <th className="table-th">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {isLoading ? (
              <tr><td colSpan={7} className="table-td text-center py-8 text-gray-400">Loading...</td></tr>
            ) : (packages as Package[]).map(p => (
              <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                <td className="table-td font-medium">{p.name}</td>
                <td className="table-td"><span className="badge-blue">{p.service}</span></td>
                <td className="table-td">{formatSpeed(p.speedUpKbps)}</td>
                <td className="table-td">{formatSpeed(p.speedDownKbps)}</td>
                <td className="table-td">{formatValidity(p.validityMinutes)}</td>
                <td className="table-td font-medium">{p.price.toLocaleString()}</td>
                <td className="table-td">
                  <div className="flex items-center gap-2">
                    <button onClick={() => openEdit(p)} className="p-1.5 text-gray-400 hover:text-blue-600"><Edit2 size={15} /></button>
                    <button onClick={() => setDeleteId(p.id)} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={15} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modalOpen} onClose={closeModal} title={editing ? 'Edit Package' : 'Add Package'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="label">Package Name</label>
              <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
            </div>
            <div>
              <label className="label">Service Type</label>
              <select className="input" value={form.service} onChange={e => setForm(f => ({ ...f, service: e.target.value }))}>
                <option value="PPPOE">PPPoE</option>
                <option value="HOTSPOT">Hotspot</option>
                <option value="STATIC">Static</option>
              </select>
            </div>
            <div>
              <label className="label">Price (KES)</label>
              <input className="input" type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: Number(e.target.value) }))} required min={0} />
            </div>
            <div>
              <label className="label">Upload Speed (Kbps)</label>
              <input className="input" type="number" value={form.speedUpKbps} onChange={e => setForm(f => ({ ...f, speedUpKbps: Number(e.target.value) }))} required min={1} />
            </div>
            <div>
              <label className="label">Download Speed (Kbps)</label>
              <input className="input" type="number" value={form.speedDownKbps} onChange={e => setForm(f => ({ ...f, speedDownKbps: Number(e.target.value) }))} required min={1} />
            </div>
            <div className="col-span-2">
              <label className="label">Validity (minutes) — 1440=1day, 43200=30days</label>
              <input className="input" type="number" value={form.validityMinutes} onChange={e => setForm(f => ({ ...f, validityMinutes: Number(e.target.value) }))} required min={1} />
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

      <ConfirmDialog isOpen={!!deleteId} onClose={() => setDeleteId(null)}
        onConfirm={() => deleteId && deleteMut.mutate(deleteId)} loading={deleteMut.isPending} />
    </AppLayout>
  );
}
