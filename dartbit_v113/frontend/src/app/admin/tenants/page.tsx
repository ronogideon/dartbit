'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getTenants, getTenantStats, createTenant, deleteTenant } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import toast from 'react-hot-toast';
import { Plus, Trash2, Building2 } from 'lucide-react';

interface Tenant { id: string; name: string; domain?: string; isActive: boolean; createdAt: string; _count?: { subscribers: number; routers: number }; }
interface Stats { tenants: number; subscribers: number; routers: number; totalRevenue: number; }

const emptyForm = { name: '', domain: '', adminEmail: '', adminPassword: '', adminName: '' };

export default function TenantsPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const { data: tenants = [] } = useQuery({ queryKey: ['tenants'], queryFn: getTenants });
  const { data: stats } = useQuery({ queryKey: ['tenant-stats'], queryFn: getTenantStats });

  const createMut = useMutation({
    mutationFn: createTenant,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenants'] }); toast.success('Tenant created'); setModalOpen(false); setForm(emptyForm); },
    onError: () => toast.error('Failed to create tenant'),
  });
  const deleteMut = useMutation({
    mutationFn: deleteTenant,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenants'] }); toast.success('Tenant deleted'); setDeleteId(null); },
  });

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Tenants</h1>
          <p className="text-sm text-gray-500 mt-1">Manage ISP organizations on the platform</p>
        </div>
        <button onClick={() => setModalOpen(true)} className="btn-primary flex items-center gap-2"><Plus size={16} /> New Tenant</button>
      </div>

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {[
            { label: 'Total Tenants', value: (stats as Stats).tenants },
            { label: 'Total Subscribers', value: (stats as Stats).subscribers },
            { label: 'Total Routers', value: (stats as Stats).routers },
            { label: 'Total Revenue (KES)', value: (stats as Stats).totalRevenue?.toLocaleString() },
          ].map(s => (
            <div key={s.label} className="card p-4">
              <p className="text-sm text-gray-500">{s.label}</p>
              <p className="text-2xl font-bold mt-1">{s.value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-gray-800/50">
            <tr>
              <th className="table-th">Organization</th>
              <th className="table-th">Domain</th>
              <th className="table-th">Subscribers</th>
              <th className="table-th">Routers</th>
              <th className="table-th">Status</th>
              <th className="table-th">Created</th>
              <th className="table-th">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {(tenants as Tenant[]).length === 0 ? (
              <tr>
                <td colSpan={7} className="py-16 text-center">
                  <Building2 size={40} className="mx-auto text-gray-300 mb-3" />
                  <p className="text-gray-400">No tenants yet</p>
                </td>
              </tr>
            ) : (tenants as Tenant[]).map(t => (
              <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                <td className="table-td font-medium">{t.name}</td>
                <td className="table-td text-gray-500">{t.domain || '-'}</td>
                <td className="table-td">{t._count?.subscribers || 0}</td>
                <td className="table-td">{t._count?.routers || 0}</td>
                <td className="table-td"><span className={t.isActive ? 'badge-green' : 'badge-red'}>{t.isActive ? 'Active' : 'Inactive'}</span></td>
                <td className="table-td text-gray-500">{new Date(t.createdAt).toLocaleDateString()}</td>
                <td className="table-td">
                  <button onClick={() => setDeleteId(t.id)} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={15} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modalOpen} onClose={() => { setModalOpen(false); setForm(emptyForm); }} title="Create New Tenant">
        <form onSubmit={(e) => { e.preventDefault(); createMut.mutate(form); }} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Organization Name</label>
              <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
            </div>
            <div>
              <label className="label">Domain</label>
              <input className="input" value={form.domain} onChange={e => setForm(f => ({ ...f, domain: e.target.value }))} placeholder="myisp.com" />
            </div>
          </div>
          <div>
            <label className="label">Admin Full Name</label>
            <input className="input" value={form.adminName} onChange={e => setForm(f => ({ ...f, adminName: e.target.value }))} required />
          </div>
          <div>
            <label className="label">Admin Email</label>
            <input className="input" type="email" value={form.adminEmail} onChange={e => setForm(f => ({ ...f, adminEmail: e.target.value }))} required />
          </div>
          <div>
            <label className="label">Admin Password</label>
            <input className="input" type="password" value={form.adminPassword} onChange={e => setForm(f => ({ ...f, adminPassword: e.target.value }))} minLength={8} required />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary" disabled={createMut.isPending}>Create Tenant</button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog isOpen={!!deleteId} onClose={() => setDeleteId(null)}
        onConfirm={() => deleteId && deleteMut.mutate(deleteId)} loading={deleteMut.isPending}
        message="This will permanently delete the tenant and ALL their data." />
    </AppLayout>
  );
}
