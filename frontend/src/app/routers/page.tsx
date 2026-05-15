'use client';
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getRouters, linkRouter, updateRouter, deleteRouter, getProvisionConfig, saveProvisionConfig } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import toast from 'react-hot-toast';
import { Plus, Edit2, Trash2, Copy, Terminal, Settings2, ChevronDown, ChevronUp } from 'lucide-react';

interface ProvConfig {
  wanInterface: string; lanInterface: string; bridgeName: string;
  lanSubnet: string; lanGateway: string; dhcpPoolStart: string;
  dhcpPoolEnd: string; dnsServers: string; pppoeEnabled: boolean;
  pppoeLocalAddress: string; pppoeRemotePool: string;
  pppoePoolStart: string; pppoePoolEnd: string;
  hotspotEnabled: boolean; hotspotInterface: string;
  hotspotDnsName: string; staticEnabled: boolean;
}

interface MikrotikRouter {
  id: string; name: string; host: string; status: string;
  identity?: string; cpuLoad?: number; uptime?: string; lastSeenAt?: string;
  interfaces?: { id: string; name: string; type: string; running: boolean }[];
}

const defaultProvision: ProvConfig = {
  wanInterface: 'ether1', lanInterface: 'ether2', bridgeName: 'bridge-lan',
  lanSubnet: '192.168.88.0/24', lanGateway: '192.168.88.1',
  dhcpPoolStart: '192.168.88.10', dhcpPoolEnd: '192.168.88.254',
  dnsServers: '8.8.8.8,8.8.4.4', pppoeEnabled: true,
  pppoeLocalAddress: '10.10.10.1', pppoeRemotePool: 'pppoe-pool',
  pppoePoolStart: '10.10.10.10', pppoePoolEnd: '10.10.10.200',
  hotspotEnabled: true, hotspotInterface: 'bridge-lan',
  hotspotDnsName: 'dartbit.login', staticEnabled: false,
};

function ProvisionPanel({ routerId }: { routerId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProvConfig>(defaultProvision);

  const { data: config } = useQuery({
    queryKey: ['provision', routerId],
    queryFn: () => getProvisionConfig(routerId),
    enabled: open,
    staleTime: 60000,
  });

  useEffect(() => {
    if (config) setForm({ ...defaultProvision, ...(config as Partial<ProvConfig>) });
  }, [config]);

  const saveMut = useMutation({
    mutationFn: (data: ProvConfig) => saveProvisionConfig(routerId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['provision', routerId] });
      toast.success('Config saved! Re-run ZTP script on router to apply.');
    },
    onError: () => toast.error('Failed to save config'),
  });

  const set = (key: keyof ProvConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  return (
    <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 font-medium w-full">
        <Settings2 size={14} />
        <span>Provisioning Config</span>
        {open ? <ChevronUp size={14} className="ml-auto" /> : <ChevronDown size={14} className="ml-auto" />}
      </button>

      {open && (
        <div className="mt-4 space-y-5">
          <p className="text-xs text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
            Save config first, then re-run the ZTP script on your router to apply changes.
          </p>

          <div>
            <p className="text-xs font-bold text-gray-400 uppercase mb-2">Network</p>
            <div className="grid grid-cols-2 gap-2">
              {([
                ['WAN Interface', 'wanInterface'], ['LAN Interface', 'lanInterface'],
                ['Bridge Name', 'bridgeName'], ['LAN Subnet', 'lanSubnet'],
                ['LAN Gateway', 'lanGateway'], ['DNS Servers', 'dnsServers'],
                ['DHCP Start', 'dhcpPoolStart'], ['DHCP End', 'dhcpPoolEnd'],
              ] as [string, keyof ProvConfig][]).map(([label, key]) => (
                <div key={String(key)}>
                  <label className="label text-xs">{label}</label>
                  <input className="input text-xs" value={String(form[key])} onChange={set(key)} />
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 mb-2 cursor-pointer">
              <input type="checkbox" checked={form.pppoeEnabled} onChange={set('pppoeEnabled')} />
              <span className="text-xs font-bold text-gray-400 uppercase">PPPoE Server</span>
            </label>
            {form.pppoeEnabled && (
              <div className="grid grid-cols-2 gap-2">
                {([
                  ['Local Address', 'pppoeLocalAddress'], ['Pool Name', 'pppoeRemotePool'],
                  ['Pool Start', 'pppoePoolStart'], ['Pool End', 'pppoePoolEnd'],
                ] as [string, keyof ProvConfig][]).map(([label, key]) => (
                  <div key={String(key)}>
                    <label className="label text-xs">{label}</label>
                    <input className="input text-xs" value={String(form[key])} onChange={set(key)} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="flex items-center gap-2 mb-2 cursor-pointer">
              <input type="checkbox" checked={form.hotspotEnabled} onChange={set('hotspotEnabled')} />
              <span className="text-xs font-bold text-gray-400 uppercase">Hotspot</span>
            </label>
            {form.hotspotEnabled && (
              <div className="grid grid-cols-2 gap-2">
                {([
                  ['Interface', 'hotspotInterface'], ['DNS Name', 'hotspotDnsName'],
                ] as [string, keyof ProvConfig][]).map(([label, key]) => (
                  <div key={String(key)}>
                    <label className="label text-xs">{label}</label>
                    <input className="input text-xs" value={String(form[key])} onChange={set(key)} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.staticEnabled} onChange={set('staticEnabled')} />
            <span className="text-xs font-bold text-gray-400 uppercase">Static IP Subscribers</span>
          </label>

          <button onClick={() => saveMut.mutate(form)} disabled={saveMut.isPending} className="btn-primary w-full text-sm">
            {saveMut.isPending ? 'Saving...' : 'Save Provisioning Config'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function RoutersPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [bootstrapModal, setBootstrapModal] = useState<{ apiKey: string; command: string } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<MikrotikRouter | null>(null);
  const [form, setForm] = useState({ name: '', host: '' });

  const { data: routers = [], isPending } = useQuery({ queryKey: ['routers'], queryFn: getRouters, refetchInterval: 10000 });

  const linkMut = useMutation({
    mutationFn: linkRouter,
    onSuccess: (data: { apiKey: string; bootstrapCommand: string }) => {
      qc.invalidateQueries({ queryKey: ['routers'] });
      setModalOpen(false); setForm({ name: '', host: '' });
      setBootstrapModal({ apiKey: data.apiKey, command: data.bootstrapCommand });
    },
    onError: () => toast.error('Failed to link router'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) => updateRouter(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['routers'] }); toast.success('Updated'); closeModal(); },
    onError: () => toast.error('Failed to update router'),
  });

  const deleteMut = useMutation({
    mutationFn: deleteRouter,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['routers'] }); toast.success('Deleted'); setDeleteId(null); },
    onError: () => toast.error('Failed to delete'),
  });

  const openEdit = (r: MikrotikRouter) => { setEditing(r); setForm({ name: r.name, host: r.host }); setModalOpen(true); };
  const closeModal = () => { setModalOpen(false); setEditing(null); setForm({ name: '', host: '' }); };
  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); editing ? updateMut.mutate({ id: editing.id, data: form }) : linkMut.mutate(form); };
  const copy = (t: string) => { navigator.clipboard.writeText(t); toast.success('Copied!'); };
  const list = routers as MikrotikRouter[];

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Routers</h1>
          <p className="text-sm text-gray-500 mt-1">{list.length} router{list.length !== 1 ? 's' : ''} configured</p>
        </div>
        <button onClick={() => { setEditing(null); setModalOpen(true); }} className="btn-primary flex items-center gap-2">
          <Plus size={16} /> Link Router
        </button>
      </div>

      {isPending ? (
        <div className="card p-8 text-center text-gray-400">
          <div className="animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-2" />
          Loading...
        </div>
      ) : list.length === 0 ? (
        <div className="card p-12 text-center">
          <Terminal size={40} className="mx-auto text-gray-300 mb-3" />
          <p className="font-medium text-gray-500">No routers linked yet</p>
          <p className="text-sm text-gray-400 mt-1">Click "Link Router" to connect your first MikroTik</p>
          <button onClick={() => setModalOpen(true)} className="btn-primary mt-4 inline-flex items-center gap-2"><Plus size={16} /> Link Router</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {list.map(r => (
            <div key={r.id} className="card p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold">{r.name}</h3>
                  <p className="text-sm text-gray-500">{r.host}</p>
                  {r.identity && <p className="text-xs text-gray-400 mt-0.5">Identity: {r.identity}</p>}
                </div>
                <div className="flex items-center gap-2 ml-2 shrink-0">
                  <span className={r.status === 'ONLINE' ? 'badge-green' : r.status === 'OFFLINE' ? 'badge-red' : 'badge-yellow'}>{r.status}</span>
                  <button onClick={() => openEdit(r)} className="p-1.5 text-gray-400 hover:text-blue-600"><Edit2 size={15} /></button>
                  <button onClick={() => setDeleteId(r.id)} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={15} /></button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-2">
                {[['CPU', r.cpuLoad != null ? `${r.cpuLoad}%` : '—'], ['Uptime', r.uptime || '—'], ['Interfaces', String(r.interfaces?.length ?? 0)]].map(([label, val]) => (
                  <div key={label} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2 text-center">
                    <p className="text-xs text-gray-500 mb-1">{label}</p>
                    <p className="font-semibold text-xs truncate">{val}</p>
                  </div>
                ))}
              </div>
              {r.lastSeenAt && <p className="text-xs text-gray-400 mb-1">Last seen: {new Date(r.lastSeenAt).toLocaleString()}</p>}
              <ProvisionPanel routerId={r.id} />
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={modalOpen} onClose={closeModal} title={editing ? 'Edit Router' : 'Link MikroTik Router'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Router Name</label>
            <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Main Gateway" required autoFocus />
            <p className="text-xs text-gray-500 mt-1.5">
              💡 Just enter a friendly name — the router&apos;s IP is detected automatically once the ZTP script runs.
            </p>
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={closeModal} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary" disabled={linkMut.isPending || updateMut.isPending}>
              {editing ? (updateMut.isPending ? 'Saving...' : 'Update') : (linkMut.isPending ? 'Linking...' : 'Link Router')}
            </button>
          </div>
        </form>
      </Modal>

      {bootstrapModal && (
        <Modal isOpen onClose={() => setBootstrapModal(null)} title="Run on your MikroTik Terminal" size="lg">
          <div className="space-y-4">
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
              <p className="text-sm font-semibold text-green-800 dark:text-green-300">✅ Router linked!</p>
              <p className="text-xs text-green-700 dark:text-green-400 mt-1">Paste and run in MikroTik terminal to fully configure the router.</p>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="label mb-0">Bootstrap Command</label>
                <button onClick={() => copy(bootstrapModal.command)} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"><Copy size={12} /> Copy</button>
              </div>
              <pre className="bg-gray-900 text-green-400 text-xs p-4 rounded-lg overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed">{bootstrapModal.command}</pre>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-xs text-gray-600 dark:text-gray-400 space-y-1">
              <p className="font-semibold text-gray-700 dark:text-gray-300 mb-1">Script automatically configures:</p>
              <p>✓ LAN bridge + DHCP server + DNS</p>
              <p>✓ PPPoE server with subscriber authentication</p>
              <p>✓ Hotspot with Dartbit login page redirect</p>
              <p>✓ NAT + firewall rules</p>
              <p>✓ Heartbeat every 15s + session sync every 30s</p>
            </div>
            <button onClick={() => setBootstrapModal(null)} className="btn-primary w-full">Done</button>
          </div>
        </Modal>
      )}

      <ConfirmDialog isOpen={!!deleteId} onClose={() => setDeleteId(null)}
        onConfirm={() => deleteId && deleteMut.mutate(deleteId)} loading={deleteMut.isPending}
        message="This will permanently delete the router and all its data." />
    </AppLayout>
  );
}
