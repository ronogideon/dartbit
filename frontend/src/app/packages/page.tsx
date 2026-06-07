'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPackages, createPackage, updatePackage, deletePackage } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { toKbps, fromKbps, formatSpeed, formatValidity, VALIDITY_OPTIONS, type SpeedUnit } from '@/lib/packageUnits';
import toast from 'react-hot-toast';
import { Plus, Edit2, Trash2 } from 'lucide-react';

interface Package {
  id: string; name: string; service: string; speedUpKbps: number;
  speedDownKbps: number; validityMinutes: number; price: number; isActive: boolean; isTrial?: boolean;
}

const emptyForm = { name: '', service: '', validityMinutes: '' as number | '', price: '' as number | '', isTrial: false };

export default function PackagesPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Package | null>(null);
  const [form, setForm] = useState(emptyForm);
  // Speed entered as value + unit (Kbps/Mbps/Gbps), converted to Kbps on submit. Start EMPTY so the
  // tenant must consciously choose — nothing is prefilled, preventing unintended speed/price/validity.
  const [upSpeed, setUpSpeed] = useState<{ value: number | ''; unit: SpeedUnit }>({ value: '', unit: 'Mbps' });
  const [downSpeed, setDownSpeed] = useState<{ value: number | ''; unit: SpeedUnit }>({ value: '', unit: 'Mbps' });

  const { data: packages = [], isPending } = useQuery({ queryKey: ['packages'], queryFn: getPackages });

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

  const openCreate = () => {
    setEditing(null); setForm(emptyForm);
    setUpSpeed({ value: '', unit: 'Mbps' }); setDownSpeed({ value: '', unit: 'Mbps' });
    setModalOpen(true);
  };
  const openEdit = (p: Package) => {
    setEditing(p);
    setForm({ name: p.name, service: p.service, validityMinutes: p.validityMinutes, price: p.price, isTrial: !!p.isTrial });
    setUpSpeed(fromKbps(p.speedUpKbps)); setDownSpeed(fromKbps(p.speedDownKbps));
    setModalOpen(true);
  };
  const closeModal = () => { setModalOpen(false); setEditing(null); };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Validate that every parameter was consciously chosen — nothing defaulted.
    if (!form.name.trim()) { toast.error('Enter a package name'); return; }
    if (!form.service) { toast.error('Select a service type'); return; }
    if (form.validityMinutes === '' || Number(form.validityMinutes) <= 0) { toast.error('Select a validity period'); return; }
    if (!form.isTrial && (form.price === '' || Number(form.price) < 0)) { toast.error('Enter a price'); return; }
    if (upSpeed.value === '' || Number(upSpeed.value) <= 0) { toast.error('Enter an upload speed'); return; }
    if (downSpeed.value === '' || Number(downSpeed.value) <= 0) { toast.error('Enter a download speed'); return; }
    const payload = {
      name: form.name,
      service: form.service,
      speedUpKbps: toKbps(Number(upSpeed.value), upSpeed.unit),
      speedDownKbps: toKbps(Number(downSpeed.value), downSpeed.unit),
      validityMinutes: Number(form.validityMinutes),
      price: form.isTrial ? 0 : Number(form.price),
      isTrial: form.isTrial,
    };
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
            {isPending ? (
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
              <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} disabled={form.isTrial} required />
              {form.isTrial && <div className="text-xs text-gray-500 mt-1">Name is set automatically for free trial packages.</div>}
            </div>
            <div>
              <label className="label">Service Type</label>
              <select className="input"
                value={form.isTrial ? 'TRIAL' : form.service}
                onChange={e => {
                  const v = e.target.value;
                  if (v === 'TRIAL') {
                    // Free trial = a hotspot package, no price, fixed name. Tenant only sets speeds + validity.
                    setForm(f => ({ ...f, service: 'HOTSPOT', isTrial: true, name: f.name && !f.isTrial ? f.name : 'Free Trial', price: 0 }));
                  } else {
                    setForm(f => ({ ...f, service: v, isTrial: false, name: f.isTrial ? '' : f.name }));
                  }
                }}
                required>
                <option value="" disabled>Select service…</option>
                <option value="PPPOE">PPPoE</option>
                <option value="HOTSPOT">Hotspot</option>
                <option value="STATIC">Static</option>
                <option value="TRIAL">Free Trial (Hotspot)</option>
              </select>
            </div>
            <div>
              <label className="label">Price (KES)</label>
              <input className="input" type="number" value={form.isTrial ? 0 : form.price}
                onChange={e => setForm(f => ({ ...f, price: e.target.value === '' ? '' : Number(e.target.value) }))}
                disabled={form.isTrial} min={0} placeholder={form.isTrial ? 'Free' : 'Enter price'} />
              {form.isTrial && <div className="text-xs text-gray-500 mt-1">Free trials have no price.</div>}
            </div>
            <div>
              <label className="label">Upload Speed</label>
              <div className="flex gap-2">
                <input className="input flex-1" type="number" step="any" value={upSpeed.value}
                  onChange={e => setUpSpeed(s => ({ ...s, value: e.target.value === '' ? '' : Number(e.target.value) }))} min={0.1} placeholder="e.g. 5" />
                <select className="input w-24" value={upSpeed.unit}
                  onChange={e => setUpSpeed(s => ({ ...s, unit: e.target.value as SpeedUnit }))}>
                  <option value="Kbps">Kbps</option>
                  <option value="Mbps">Mbps</option>
                  <option value="Gbps">Gbps</option>
                </select>
              </div>
            </div>
            <div>
              <label className="label">Download Speed</label>
              <div className="flex gap-2">
                <input className="input flex-1" type="number" step="any" value={downSpeed.value}
                  onChange={e => setDownSpeed(s => ({ ...s, value: e.target.value === '' ? '' : Number(e.target.value) }))} min={0.1} placeholder="e.g. 5" />
                <select className="input w-24" value={downSpeed.unit}
                  onChange={e => setDownSpeed(s => ({ ...s, unit: e.target.value as SpeedUnit }))}>
                  <option value="Kbps">Kbps</option>
                  <option value="Mbps">Mbps</option>
                  <option value="Gbps">Gbps</option>
                </select>
              </div>
            </div>
            <div className="col-span-2">
              <label className="label">Validity</label>
              <SearchableSelect
                options={VALIDITY_OPTIONS.map(o => ({ label: o.label, value: o.minutes }))}
                value={form.validityMinutes === '' ? '' : form.validityMinutes}
                onChange={(v) => setForm(f => ({ ...f, validityMinutes: Number(v) }))}
                placeholder="Select validity…"
              />
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
