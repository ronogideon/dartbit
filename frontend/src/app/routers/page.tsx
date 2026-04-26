'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getRouters, linkRouter, updateRouter, deleteRouter, getProvisionConfig, saveProvisionConfig } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import toast from 'react-hot-toast';
import { Plus, Edit2, Trash2, Copy, Terminal, Settings2, ChevronDown, ChevronUp } from 'lucide-react';

interface MikrotikRouter {
  id: string; name: string; host: string; status: string;
  identity?: string; cpuLoad?: number; uptime?: string; lastSeenAt?: string;
  interfaces?: { id: string; name: string; type: string; running: boolean }[];
}

const defaultProvision = {
  wanInterface: 'ether1', lanInterface: 'ether2', bridgeName: 'bridge-lan',
  lanSubnet: '192.168.88.0/24', lanGateway: '192.168.88.1',
  dhcpPoolStart: '192.168.88.10', dhcpPoolEnd: '192.168.88.254',
  dnsServers: '8.8.8.8,8.8.4.4',
  pppoeEnabled: true, pppoeLocalAddress: '10.10.10.1',
  pppoeRemotePool: 'pppoe-pool', pppoePoolStart: '10.10.10.10', pppoePoolEnd: '10.10.10.200',
  hotspotEnabled: true, hotspotInterface: 'bridge-lan', hotspotDnsName: 'dartbit.login',
  staticEnabled: false,
};

function ProvisionPanel({ routerId, routerName }: { routerId: string; routerName: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(defaultProvision);
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'https://dartbit-production.up.railway.app';

  const { data: config, isLoading } = useQuery({
    queryKey: ['provision', routerId],
    queryFn: () => getProvisionConfig(routerId),
    enabled: open,
    onSuccess: (data: unknown) => { if (data) setForm({ ...defaultProvision, ...(data as typeof defaultProvision) }); },
  });

  const saveMut = useMutation({
    mutationFn: (data: unknown) => saveProvisionConfig(routerId, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['provision', routerId] }); toast.success('Provisioning config saved!'); },
    onError: () => toast.error('Failed to save config'),
  });

  const ztpUrl = `${backendUrl}/router/ztp-script?apiKey=`;

  return (
    <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 font-medium">
        <Settings2 size={14} />
        Provisioning Config
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          {isLoading ? <p className="text-sm text-gray-400">Loading...</p> : (
            <>
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 text-xs text-blue-700 dark:text-blue-300">
                Configure then save. The ZTP script will use these settings when run on your MikroTik.
              </div>

              {/* Network */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Network Interfaces</p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    ['WAN Interface', 'wanInterface'],
                    ['LAN Interface', 'lanInterface'],
                    ['Bridge Name', 'bridgeName'],
                    ['LAN Subnet', 'lanSubnet'],
                    ['LAN Gateway', 'lanGateway'],
                    ['DNS Servers', 'dnsServers'],
                  ].map(([label, key]) => (
                    <div key={key}>
                      <label className="label text-xs">{label}</label>
                      <input className="input text-xs" value={(form as Record<string, string>)[key]}
                        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />
                    </div>
                  ))}
                </div>
              </div>

              {/* DHCP */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">DHCP Pool</p>
                <div className="grid grid-cols-2 gap-2">
                  {[['Pool Start', 'dhcpPoolStart'], ['Pool End', 'dhcpPoolEnd']].map(([label, key]) => (
                    <div key={key}>
                      <label className="label text-xs">{label}</label>
                      <input className="input text-xs" value={(form as Record<string, string>)[key]}
                        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />
                    </div>
                  ))}
                </div>
              </div>

              {/* PPPoE */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <input type="checkbox" id={`pppoe-${routerId}`} checked={form.pppoeEnabled}
                    onChange={e => setForm(f => ({ ...f, pppoeEnabled: e.target.checked }))} />
                  <label htmlFor={`pppoe-${routerId}`} className="text-xs font-semibold text-gray-500 uppercase cursor-pointer">PPPoE Server</label>
                </div>
                {form.pppoeEnabled && (
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      ['Local Address', 'pppoeLocalAddress'],
                      ['Pool Name', 'pppoeRemotePool'],
                      ['Pool Start', 'pppoePoolStart'],
                      ['Pool End', 'pppoePoolEnd'],
                    ].map(([label, key]) => (
                      <div key={key}>
                        <label className="label text-xs">{label}</label>
                        <input className="input text-xs" value={(form as Record<string, string>)[key]}
                          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Hotspot */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <input type="checkbox" id={`hs-${routerId}`} checked={form.hotspotEnabled}
                    onChange={e => setForm(f => ({ ...f, hotspotEnabled: e.target.checked }))} />
                  <label htmlFor={`hs-${routerId}`} className="text-xs font-semibold text-gray-500 uppercase cursor-pointer">Hotspot</label>
                </div>
                {form.hotspotEnabled && (
                  <div className="grid grid-cols-2 gap-2">
                    {[['Interface', 'hotspotInterface'], ['DNS Name', 'hotspotDnsName']].map(([label, key]) => (
                      <div key={key}>
                        <label className="label text-xs">{label}</label>
                        <input className="input text-xs" value={(form as Record<string, string>)[key]}
                          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Static */}
              <div className="flex items-center gap-2">
                <input type="checkbox" id={`static-${routerId}`} checked={form.staticEnabled}
                  onChange={e => setForm(f => ({ ...f, staticEnabled: e.target.checked }))} />
                <label htmlFor={`static-${routerId}`} className="text-xs font-semibold text-gray-500 uppercase cursor-pointer">Static IP Bridge</label>
              </div>

              <button onClick={() => saveMut.mutate(form)} disabled={saveMut.isLoading}
                className="btn-primary w-full text-sm">
                {saveMut.isLoading ? 'Saving...' : 'Save Provisioning Config'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const emptyForm = { name: '', host: '' };

export default function RoutersPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [bootstrapModal, setBootstrapModal] = useState<{ apiKey: string; command: string } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<MikrotikRouter | null>(null);
  const [form, setForm] = useState(emptyForm);

  const { data: routers = [], isLoading } = useQuery({
    queryKey: ['routers'], queryFn: getRouters, refetchInterval: 10000,
  });

  const linkMut = useMutation({
    mutationFn: linkRouter,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['routers'] });
      setModalOpen(false); setForm(emptyForm);
      setBootstrapModal({ apiKey: data.apiKey, command: data.bootstrapCommand });
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

  const openEdit = (r: MikrotikRouter) => { setEditing(r); setForm({ name: r.name, host: r.host }); setModalOpen(true); };
  const closeModal = () => { setModalOpen(false); setEditing(null); setForm(emptyForm); };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editing) updateMut.mutate({ id: editing.id, data: form });
    else linkMut.mutate(form);
  };

  const copy = (text: string) => { navigator.clipboard.writeText(text); toast.success('Copied!'); };

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Routers</h1>
          <p className="text-sm text-gray-500 mt-1">{(routers as MikrotikRouter[]).length} routers configured</p>
        </div>
        <button onClick={() => { setEditing(null); setForm(emptyForm); setModalOpen(true); }}
          className="btn-primary flex items-center gap-2"><Plus size={16} /> Link Router</button>
      </div>

      {isLoading ? (
        <div className="card p-8 text-center text-gray-400">Loading...</div>
      ) : (routers as MikrotikRouter[]).length === 0 ? (
        <div className="card p-12 text-center">
          <Terminal size={40} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-400 font-medium">No routers linked yet</p>
          <p className="text-sm text-gray-500 mt-1">Click "Link Router" to add your first MikroTik</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(routers as MikrotikRouter[]).map(r => (
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

              <div className="grid grid-cols-3 gap-2 text-sm mb-2">
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2 text-center">
                  <p className="text-xs text-gray-500 mb-1">CPU</p>
                  <p className="font-semibold">{r.cpuLoad != null ? `${r.cpuLoad}%` : '-'}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2 text-center">
                  <p className="text-xs text-gray-500 mb-1">Uptime</p>
                  <p className="font-semibold text-xs truncate">{r.uptime || '-'}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2 text-center">
                  <p className="text-xs text-gray-500 mb-1">Interfaces</p>
                  <p className="font-semibold">{r.interfaces?.length || 0}</p>
                </div>
              </div>

              {r.lastSeenAt && (
                <p className="text-xs text-gray-400 mb-1">Last seen: {new Date(r.lastSeenAt).toLocaleString()}</p>
              )}

              <ProvisionPanel routerId={r.id} routerName={r.name} />
            </div>
          ))}
        </div>
      )}

      {/* Link/Edit Modal */}
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
            <button type="submit" className="btn-primary" disabled={linkMut.isLoading || updateMut.isLoading}>
              {editing ? 'Update' : 'Link Router'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Bootstrap Command Modal */}
      {bootstrapModal && (
        <Modal isOpen={true} onClose={() => setBootstrapModal(null)} title="Run this on your MikroTik" size="lg">
          <div className="space-y-4">
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
              <p className="text-sm font-medium text-green-800 dark:text-green-300">✅ Router linked!</p>
              <p className="text-xs text-green-700 dark:text-green-400 mt-1">
                Run the command below in your MikroTik terminal. It will set up the bridge, PPPoE server, hotspot, DHCP, NAT and start sending heartbeats.
              </p>
            </div>

            <div>
              <label className="label">Bootstrap Command</label>
              <div className="relative">
                <pre className="bg-gray-900 text-green-400 text-xs p-4 rounded-lg overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed">
                  {bootstrapModal.command}
                </pre>
                <button onClick={() => copy(bootstrapModal.command)}
                  className="absolute top-2 right-2 p-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors flex items-center gap-1 text-xs">
                  <Copy size={12} /> Copy
                </button>
              </div>
            </div>

            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3 text-xs text-yellow-700 dark:text-yellow-400 space-y-1">
              <p className="font-semibold">What this script does:</p>
              <p>• Creates LAN bridge and adds your LAN port</p>
              <p>• Sets up DHCP server and DNS</p>
              <p>• Configures PPPoE server for subscriber authentication</p>
              <p>• Sets up Hotspot with login page redirect</p>
              <p>• Configures NAT masquerade</p>
              <p>• Starts heartbeat every 15s back to Dartbit</p>
              <p>• Syncs active sessions every 30s</p>
            </div>

            <button onClick={() => setBootstrapModal(null)} className="btn-primary w-full">Done</button>
          </div>
        </Modal>
      )}

      <ConfirmDialog isOpen={!!deleteId} onClose={() => setDeleteId(null)}
        onConfirm={() => deleteId && deleteMut.mutate(deleteId)} loading={deleteMut.isLoading} />
    </AppLayout>
  );
}
