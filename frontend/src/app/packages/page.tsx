'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPackages, createPackage, updatePackage, deletePackage, getRouters } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { toKbps, fromKbps, formatSpeed, formatValidity, VALIDITY_OPTIONS, type SpeedUnit } from '@/lib/packageUnits';
import toast from 'react-hot-toast';
import { Plus, Edit2, Trash2 } from 'lucide-react';

interface Package {
  id: string; name: string; service: string; speedUpKbps: number;
  speedDownKbps: number; validityMinutes: number; price: number; isActive: boolean; isTrial?: boolean; routerIds?: string[];
}

const emptyForm = { name: '', service: '', validityMinutes: '' as number | '', price: '' as number | '', isTrial: false, routerIds: [] as string[] };

export default function PackagesPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Package | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [tab, setTab] = useState<'ALL' | 'PPPOE' | 'HOTSPOT' | 'STATIC'>('ALL');
  // Speed entered as value + unit (Kbps/Mbps/Gbps), converted to Kbps on submit. Start EMPTY so the
  // tenant must consciously choose — nothing is prefilled, preventing unintended speed/price/validity.
  const [upSpeed, setUpSpeed] = useState<{ value: number | ''; unit: SpeedUnit }>({ value: '', unit: 'Mbps' });
  const [downSpeed, setDownSpeed] = useState<{ value: number | ''; unit: SpeedUnit }>({ value: '', unit: 'Mbps' });

  const { data: packages = [], isPending } = useQuery({ queryKey: ['packages'], queryFn: getPackages });
  const { data: routers = [] } = useQuery({ queryKey: ['routers'], queryFn: getRouters });
  const routerList = routers as Array<{ id: string; name: string }>;

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
    setForm({ name: p.name, service: p.service, validityMinutes: p.validityMinutes, price: p.price, isTrial: !!p.isTrial, routerIds: p.routerIds || [] });
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
      routerIds: form.routerIds,
    };
    if (editing) updateMut.mutate({ id: editing.id, data: payload });
    else createMut.mutate(payload);
  };

  const allPkgs = packages as Package[];
  const counts = {
    ALL: allPkgs.length,
    PPPOE: allPkgs.filter(p => p.service === 'PPPOE').length,
    HOTSPOT: allPkgs.filter(p => p.service === 'HOTSPOT').length,
    STATIC: allPkgs.filter(p => p.service === 'STATIC').length,
  };
  const visible = tab === 'ALL' ? allPkgs : allPkgs.filter(p => p.service === tab);
  const PKG_TABS = [
    { key: 'ALL' as const, label: 'All' },
    { key: 'PPPOE' as const, label: 'PPPoE' },
    { key: 'HOTSPOT' as const, label: 'Hotspot' },
    { key: 'STATIC' as const, label: 'Static' },
  ];

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Packages</h1>
          <p className="text-sm text-gray-500 mt-1">{allPkgs.length} packages</p>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-2"><Plus size={16} /> Add Package</button>
      </div>

      {/* Service tabs with count bubbles (mirrors the Subscribers page) */}
      <div className="flex gap-1 mb-4 border-b border-gray-200 dark:border-gray-800 overflow-x-auto">
        {PKG_TABS.map(t => (
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
            ) : visible.length === 0 ? (
              <tr><td colSpan={7} className="table-td text-center py-8 text-gray-400">No packages in this category</td></tr>
            ) : visible.map(p => (
              <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                <td className="table-td font-medium">{p.name}{p.isTrial && <span className="ml-2 badge-green text-xs">Trial</span>}</td>
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
            <div className="col-span-2">
              <label className="label">Available on routers</label>
              <div className="flex flex-wrap gap-2">
                <button type="button"
                  onClick={() => setForm(f => ({ ...f, routerIds: [] }))}
                  className={`px-3 py-1.5 rounded-full text-sm border ${form.routerIds.length === 0 ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300'}`}>
                  All routers
                </button>
                {routerList.map(r => {
                  const on = form.routerIds.includes(r.id);
                  return (
                    <button key={r.id} type="button"
                      onClick={() => setForm(f => ({ ...f, routerIds: on ? f.routerIds.filter(x => x !== r.id) : [...f.routerIds, r.id] }))}
                      className={`px-3 py-1.5 rounded-full text-sm border ${on ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300'}`}>
                      {r.name}
                    </button>
                  );
                })}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {form.routerIds.length === 0 ? 'This package is offered on every router.' : `Offered only on the ${form.routerIds.length} selected router${form.routerIds.length > 1 ? 's' : ''}.`}
              </div>
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
