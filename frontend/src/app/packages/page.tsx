'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPackages, createPackage, updatePackage, deletePackage, getRouters, getPackageImpact } from '@/lib/api';
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
  fupEnabled?: boolean; fupPeriod?: string; fupLimitMb?: number | null; fupCountMode?: string;
  fupThrottleMode?: string; fupThrottlePercent?: number | null;
  fupThrottleUpKbps?: number | null; fupThrottleDownKbps?: number | null; fupNotify?: boolean;
}

const emptyForm = {
  name: '', service: '', validityMinutes: '' as number | '', price: '' as number | '',
  isTrial: false, routerIds: [] as string[],
  // Fair Use Policy. Defaults are inert (disabled), so existing packages are unaffected until the
  // tenant deliberately turns it on.
  fupEnabled: false,
  fupPeriod: 'MONTHLY' as 'DAILY' | 'MONTHLY',
  fupLimitMb: '' as number | '',
  fupCountMode: 'COMBINED' as 'DOWNLOAD' | 'COMBINED',
  fupThrottleMode: 'PERCENT' as 'PERCENT' | 'MANUAL',
  fupThrottlePercent: 20,
  fupThrottleUpKbps: '' as number | '',
  fupThrottleDownKbps: '' as number | '',
  fupNotify: false,
};

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
  // Speed changes don't reach existing subscribers on their own — each one's rate is a snapshot
  // taken at activation. Rather than silently switching to instant propagation (some tenants rely
  // on the grandfathering), the tenant is shown how many subscribers are affected and picks.
  const [speedConfirm, setSpeedConfirm] = useState<{ payload: Record<string, unknown>; id: string; active: number; total: number } | null>(null);
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
    onSuccess: (res: unknown) => {
      qc.invalidateQueries({ queryKey: ['packages'] });
      const queued = (res as { resyncQueued?: boolean } | null)?.resyncQueued;
      toast.success(queued ? 'Package updated — applying new speed to subscribers' : 'Package updated');
      setSpeedConfirm(null);
      closeModal();
    },
    onError: () => { setSpeedConfirm(null); toast.error('Failed to update package'); },
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
    setForm({
      name: p.name, service: p.service, validityMinutes: p.validityMinutes, price: p.price,
      isTrial: !!p.isTrial, routerIds: p.routerIds || [],
      fupEnabled: !!p.fupEnabled,
      fupPeriod: (p.fupPeriod === 'DAILY' ? 'DAILY' : 'MONTHLY'),
      fupLimitMb: p.fupLimitMb ?? '',
      fupCountMode: (p.fupCountMode === 'DOWNLOAD' ? 'DOWNLOAD' : 'COMBINED'),
      fupThrottleMode: (p.fupThrottleMode === 'MANUAL' ? 'MANUAL' : 'PERCENT'),
      fupThrottlePercent: p.fupThrottlePercent ?? 20,
      fupThrottleUpKbps: p.fupThrottleUpKbps ?? '',
      fupThrottleDownKbps: p.fupThrottleDownKbps ?? '',
      fupNotify: !!p.fupNotify,
    });
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
    if (form.fupEnabled) {
      if (form.fupLimitMb === '' || Number(form.fupLimitMb) <= 0) { toast.error('Enter the data allowance before FUP triggers'); return; }
      if (form.fupThrottleMode === 'MANUAL' && (form.fupThrottleUpKbps === '' || form.fupThrottleDownKbps === '')) {
        toast.error('Enter both throttled upload and download speeds'); return;
      }
    }
    const payload = {
      name: form.name,
      service: form.service,
      speedUpKbps: toKbps(Number(upSpeed.value), upSpeed.unit),
      speedDownKbps: toKbps(Number(downSpeed.value), downSpeed.unit),
      validityMinutes: Number(form.validityMinutes),
      price: form.isTrial ? 0 : Number(form.price),
      isTrial: form.isTrial,
      routerIds: form.routerIds,
      fupEnabled: form.fupEnabled,
      fupPeriod: form.fupPeriod,
      fupLimitMb: form.fupEnabled ? Number(form.fupLimitMb) : null,
      fupCountMode: form.fupCountMode,
      fupThrottleMode: form.fupThrottleMode,
      fupThrottlePercent: form.fupThrottleMode === 'PERCENT' ? Number(form.fupThrottlePercent) : null,
      fupThrottleUpKbps: form.fupThrottleMode === 'MANUAL' && form.fupThrottleUpKbps !== '' ? Number(form.fupThrottleUpKbps) : null,
      fupThrottleDownKbps: form.fupThrottleMode === 'MANUAL' && form.fupThrottleDownKbps !== '' ? Number(form.fupThrottleDownKbps) : null,
      fupNotify: form.fupNotify,
    };
    if (editing) {
      // Only ask when the SPEED actually changed — price/name edits propagate nothing.
      const speedChanged = payload.speedUpKbps !== editing.speedUpKbps || payload.speedDownKbps !== editing.speedDownKbps;
      if (speedChanged) {
        getPackageImpact(editing.id)
          .then(({ active, total }) => {
            if (active > 0) setSpeedConfirm({ payload, id: editing.id, active, total });
            // Nobody on the package — nothing to propagate, just save.
            else updateMut.mutate({ id: editing.id, data: payload });
          })
          .catch(() => updateMut.mutate({ id: editing.id, data: payload }));
        return;
      }
      updateMut.mutate({ id: editing.id, data: payload });
    }
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
                <td className="table-td">
                  {formatSpeed(p.speedDownKbps)}
                  {p.fupEnabled && p.fupLimitMb ? (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400"
                      title={`Throttles after ${p.fupLimitMb} MB per ${p.fupPeriod === 'DAILY' ? 'day' : 'cycle'}`}>
                      FUP {p.fupLimitMb >= 1024 ? `${(p.fupLimitMb / 1024).toFixed(0)}GB` : `${p.fupLimitMb}MB`}
                    </span>
                  ) : null}
                </td>
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
            {/* ---- Fair Use Policy ---------------------------------------------------------
                 Enforced for PPPoE today: STATIC has no per-IP usage source on the router yet, and
                 HOTSPOT sessions are too short for a period cap. The panel only opens once the
                 toggle is on, so existing packages are untouched. */}
            <div className="col-span-2 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <label className="flex items-center justify-between cursor-pointer">
                <span>
                  <span className="text-sm font-medium">Fair Use Policy (FUP)</span>
                  <span className="block text-[11px] text-gray-400">Throttle speed after a data allowance is used up.</span>
                </span>
                <input type="checkbox" className="h-4 w-4" checked={form.fupEnabled}
                  onChange={e => setForm(f => ({ ...f, fupEnabled: e.target.checked }))} />
              </label>

              {form.fupEnabled && (
                <div className="mt-4 space-y-4">
                  {form.service === 'PPPOE' ? null : (
                    <p className="text-[11px] text-amber-600">
                      FUP currently enforces on PPPoE packages only — usage tracking for {form.service || 'this service'} isn&apos;t collected yet.
                    </p>
                  )}

                  <div>
                    <label className="label">Period</label>
                    <div className="flex gap-2">
                      {(['DAILY', 'MONTHLY'] as const).map(pd => (
                        <button key={pd} type="button" onClick={() => setForm(f => ({ ...f, fupPeriod: pd }))}
                          className={`flex-1 px-3 py-2 rounded-lg text-sm border transition-colors ${form.fupPeriod === pd ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300'}`}>
                          {pd === 'DAILY' ? 'Daily' : 'Monthly'}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-gray-400 mt-1">
                      {form.fupPeriod === 'DAILY'
                        ? 'Resets at midnight — the throttle lifts automatically each night.'
                        : "Follows the subscriber's billing cycle — the throttle lifts when they renew."}
                    </p>
                  </div>

                  <div>
                    <label className="label">Data allowance before throttling</label>
                    <div className="flex gap-2 items-center">
                      <input className="input flex-1" type="number" min={1} value={form.fupLimitMb}
                        onChange={e => setForm(f => ({ ...f, fupLimitMb: e.target.value === '' ? '' : Number(e.target.value) }))}
                        placeholder="e.g. 20000" />
                      <span className="text-sm text-gray-500 w-10">MB</span>
                    </div>
                    {form.fupLimitMb !== '' && Number(form.fupLimitMb) >= 1024 && (
                      <p className="text-[11px] text-gray-400 mt-1">= {(Number(form.fupLimitMb) / 1024).toFixed(1)} GB per {form.fupPeriod === 'DAILY' ? 'day' : 'cycle'}.</p>
                    )}
                  </div>

                  <div>
                    <label className="label">Count toward the allowance</label>
                    <div className="flex gap-2">
                      {([['COMBINED', 'Upload + download'], ['DOWNLOAD', 'Download only']] as const).map(([v, lbl]) => (
                        <button key={v} type="button" onClick={() => setForm(f => ({ ...f, fupCountMode: v }))}
                          className={`flex-1 px-3 py-2 rounded-lg text-sm border transition-colors ${form.fupCountMode === v ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300'}`}>
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="label">Throttled speed</label>
                    <div className="flex gap-2 mb-3">
                      {([['PERCENT', '% of package speed'], ['MANUAL', 'Enter speed']] as const).map(([v, lbl]) => (
                        <button key={v} type="button" onClick={() => setForm(f => ({ ...f, fupThrottleMode: v }))}
                          className={`flex-1 px-3 py-2 rounded-lg text-sm border transition-colors ${form.fupThrottleMode === v ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300'}`}>
                          {lbl}
                        </button>
                      ))}
                    </div>

                    {form.fupThrottleMode === 'PERCENT' ? (
                      <>
                        <input type="range" min={1} max={100} step={1} className="w-full accent-blue-600"
                          value={form.fupThrottlePercent}
                          onChange={e => setForm(f => ({ ...f, fupThrottlePercent: Number(e.target.value) }))} />
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-sm font-medium">{form.fupThrottlePercent}% of full speed</span>
                          {/* Live preview of what they'll actually get, from the speeds entered above. */}
                          {upSpeed.value !== '' && downSpeed.value !== '' && (
                            <span className="text-[11px] text-gray-400">
                              ≈ {formatSpeed(Math.max(64, Math.round(toKbps(Number(upSpeed.value), upSpeed.unit) * Number(form.fupThrottlePercent) / 100)))} up
                              {' / '}
                              {formatSpeed(Math.max(64, Math.round(toKbps(Number(downSpeed.value), downSpeed.unit) * Number(form.fupThrottlePercent) / 100)))} down
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-gray-400 mt-1">Applied to both upload and download.</p>
                      </>
                    ) : (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="label text-xs">Upload (Kbps)</label>
                          <input className="input" type="number" min={64} value={form.fupThrottleUpKbps}
                            onChange={e => setForm(f => ({ ...f, fupThrottleUpKbps: e.target.value === '' ? '' : Number(e.target.value) }))}
                            placeholder="512" />
                        </div>
                        <div>
                          <label className="label text-xs">Download (Kbps)</label>
                          <input className="input" type="number" min={64} value={form.fupThrottleDownKbps}
                            onChange={e => setForm(f => ({ ...f, fupThrottleDownKbps: e.target.value === '' ? '' : Number(e.target.value) }))}
                            placeholder="512" />
                        </div>
                      </div>
                    )}
                  </div>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" className="h-4 w-4" checked={form.fupNotify}
                      onChange={e => setForm(f => ({ ...f, fupNotify: e.target.checked }))} />
                    <span className="text-sm">SMS the subscriber when they get throttled</span>
                  </label>
                </div>
              )}
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
    
      {/* Speed propagation choice. Existing subscribers hold a rate snapshot taken at activation, so
          a speed edit reaches them only on renewal unless applied explicitly. Shown with the real
          affected count so the tenant isn't guessing at the blast radius. */}
      <Modal isOpen={!!speedConfirm} onClose={() => setSpeedConfirm(null)} title="Apply new speed to existing subscribers?">
        {speedConfirm && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              <span className="font-semibold text-gray-900 dark:text-gray-100">{speedConfirm.active}</span>
              {speedConfirm.total !== speedConfirm.active && <> of {speedConfirm.total}</>}{' '}
              subscriber{speedConfirm.active === 1 ? '' : 's'} on this package will be re-synced.
            </p>
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 space-y-2">
              {/* "Active" here means paid-up and not expired — NOT "currently online". Offline
                  subscribers are included; the change is written to their RADIUS record and takes
                  effect the moment they reconnect. */}
              <p className="text-xs text-gray-500 dark:text-gray-400">
                This covers everyone on the package who isn&apos;t expired or disabled —
                <span className="font-medium"> including those currently offline</span>. It is not
                limited to who&apos;s online right now.
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Their speed was set when they activated, so it won&apos;t change on its own. Applying
                now rewrites each record and briefly reconnects live sessions so the new speed takes
                effect immediately.
              </p>
              {speedConfirm.total > speedConfirm.active && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  The other {speedConfirm.total - speedConfirm.active} {speedConfirm.total - speedConfirm.active === 1 ? 'is' : 'are'} expired or
                  disabled and hold no speed setting right now — they pick up the new speed
                  automatically when they renew.
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="btn-primary"
                disabled={updateMut.isPending}
                onClick={() => updateMut.mutate({ id: speedConfirm.id, data: { ...speedConfirm.payload, applySpeedNow: true } })}
              >
                Apply now to all {speedConfirm.active}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={updateMut.isPending}
                onClick={() => updateMut.mutate({ id: speedConfirm.id, data: { ...speedConfirm.payload, applySpeedNow: false } })}
              >
                Apply on next renewal only
              </button>
            </div>
          </div>
        )}
      </Modal>
</AppLayout>
  );
}
