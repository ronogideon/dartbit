'use client';
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getRouters, linkRouter, updateRouter, deleteRouter, getProvisionConfig, saveProvisionConfig, rebootRouter, changeRouterIdentity, updateRouterLanPorts, getRouterInterfaces, reprovisionRouter, getRouterZtpCommand } from '@/lib/api';
import LinkWizard from '@/components/LinkWizard';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import toast from 'react-hot-toast';
import { Plus, Edit2, Trash2, Copy, Terminal, Settings2, ChevronDown, ChevronUp, RotateCw, MoreVertical, Tag, Network, DownloadCloud } from 'lucide-react';
import SearchInput from '@/components/ui/SearchInput';

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
                ['WAN Interface', 'wanInterface'],
                ['Bridge Name', 'bridgeName'], ['LAN Subnet', 'lanSubnet'],
                ['LAN Gateway', 'lanGateway'], ['DNS Servers', 'dnsServers'],
                ['DHCP Start', 'dhcpPoolStart'], ['DHCP End', 'dhcpPoolEnd'],
              ] as [string, keyof ProvConfig][]).map(([label, key]) => (
                <div key={String(key)}>
                  <label className="label text-xs">{label}</label>
                  <input className="input text-xs" value={String(form[key])} onChange={set(key)} />
                </div>
              ))}
              <div className="col-span-2">
                <label className="label text-xs">LAN Interfaces (one or more, comma-separated)</label>
                <input className="input text-xs" value={String(form.lanInterface)} onChange={set('lanInterface')} placeholder="e.g. ether2,ether3,ether4,wlan1" />
                <p className="text-[10px] text-gray-500 mt-1">All listed ports will be added to the bridge as LAN ports</p>
              </div>
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

// Options menu — identity change & LAN port update
function RouterOptionsMenu({ router, onReboot, onEdit, onDelete }: {
  router: MikrotikRouter;
  onReboot: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [identityModal, setIdentityModal] = useState(false);
  const [lanPortsModal, setLanPortsModal] = useState(false);
  const [reprovisionModal, setReprovisionModal] = useState<{ command: string } | null>(null);
  const [identity, setIdentity] = useState(router.identity || router.name);
  const [selectedPorts, setSelectedPorts] = useState<Set<string>>(new Set());
  const [availableInterfaces, setAvailableInterfaces] = useState<Array<{ name: string; type: string }>>([]);
  const [loadingIfaces, setLoadingIfaces] = useState(false);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = () => setOpen(false);
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  const openLanPorts = async () => {
    setOpen(false);
    setLoadingIfaces(true);
    try {
      const [cfg, ifaces] = await Promise.all([
        getProvisionConfig(router.id),
        getRouterInterfaces(router.id),
      ]);
      const currentPorts = (cfg?.lanInterface || '').split(',').map((p: string) => p.trim()).filter(Boolean);
      setSelectedPorts(new Set(currentPorts));
      // Filter out the bridge itself + the WAN interface from selection
      const wan = cfg?.wanInterface || 'ether1';
      const bridgeName = cfg?.bridgeName || 'bridge-lan';
      const filtered = (ifaces as Array<{ name: string; type: string }>).filter(
        i => i.name !== bridgeName && i.name !== wan && i.type !== 'bridge'
      );
      setAvailableInterfaces(filtered);
    } catch {
      setAvailableInterfaces([]);
    } finally {
      setLoadingIfaces(false);
    }
    setLanPortsModal(true);
  };

  const togglePort = (name: string) => {
    setSelectedPorts(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const identityMut = useMutation({
    mutationFn: (newIdentity: string) => changeRouterIdentity(router.id, newIdentity),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routers'] });
      toast.success('Identity change queued — applies within 30s');
      setIdentityModal(false);
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed'),
  });

  const lanMut = useMutation({
    mutationFn: (ports: string[]) => updateRouterLanPorts(router.id, ports),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routers'] });
      toast.success('LAN ports update queued — applies within 30s');
      setLanPortsModal(false);
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed'),
  });

  const reprovisionMut = useMutation({
    mutationFn: () => reprovisionRouter(router.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routers'] });
      toast.success('Reprovision queued — router will re-run the script within 30s');
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed'),
  });

  // For offline routers: get the manual fetch command
  const showManualReprovision = async () => {
    setOpen(false);
    try {
      const data = await getRouterZtpCommand(router.id);
      setReprovisionModal({ command: data.command });
    } catch (e: unknown) {
      toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to fetch command');
    }
  };

  const isOnline = router.status === 'ONLINE';

  return (
    <>
      <div className="relative">
        <button
          onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
          className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          title="More options"
        >
          <MoreVertical size={15} />
        </button>
        {open && (
          <div
            onClick={e => e.stopPropagation()}
            className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-20 py-1"
          >
            <button
              onClick={() => { setOpen(false); setIdentity(router.identity || router.name); setIdentityModal(true); }}
              disabled={!isOnline}
              className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Tag size={14} className="text-purple-600" /> Change identity
            </button>
            <button
              onClick={openLanPorts}
              disabled={!isOnline}
              className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Network size={14} className="text-cyan-600" /> Update LAN ports
            </button>
            <button
              onClick={() => {
                if (isOnline) {
                  setOpen(false);
                  reprovisionMut.mutate();
                } else {
                  showManualReprovision();
                }
              }}
              disabled={reprovisionMut.isPending}
              className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              title={isOnline ? 'Re-run provisioning script (updates existing setup)' : 'Get manual reprovision command'}
            >
              <DownloadCloud size={14} className="text-green-600" /> Reprovision router
            </button>
            <button
              onClick={() => { setOpen(false); onReboot(); }}
              disabled={!isOnline}
              className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RotateCw size={14} className="text-orange-600" /> Reboot router
            </button>
            <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
            <button
              onClick={() => { setOpen(false); onEdit(); }}
              className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
            >
              <Edit2 size={14} className="text-blue-600" /> Edit name
            </button>
            <button
              onClick={() => { setOpen(false); onDelete(); }}
              className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 text-red-600"
            >
              <Trash2 size={14} /> Delete router
            </button>
          </div>
        )}
      </div>

      {/* Identity change modal */}
      <Modal isOpen={identityModal} onClose={() => setIdentityModal(false)} title="Change router identity">
        <form onSubmit={e => { e.preventDefault(); identityMut.mutate(identity); }} className="space-y-4">
          <div>
            <label className="label">New identity</label>
            <input className="input" value={identity} onChange={e => setIdentity(e.target.value)} placeholder="e.g. Office-Router-01" autoFocus required />
            <p className="text-xs text-gray-500 mt-1">Sets the RouterOS system identity. Letters, numbers, hyphens, underscores and dots only.</p>
          </div>
          <div className="flex gap-3 justify-end">
            <button type="button" onClick={() => setIdentityModal(false)} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={identityMut.isPending} className="btn-primary">{identityMut.isPending ? 'Saving...' : 'Apply'}</button>
          </div>
        </form>
      </Modal>

      {/* LAN ports checkbox modal */}
      <Modal isOpen={lanPortsModal} onClose={() => setLanPortsModal(false)} title="Update LAN ports on bridge">
        <form
          onSubmit={e => {
            e.preventDefault();
            lanMut.mutate(Array.from(selectedPorts));
          }}
          className="space-y-4"
        >
          {loadingIfaces ? (
            <div className="text-center py-6 text-gray-500 text-sm">Loading interfaces...</div>
          ) : availableInterfaces.length === 0 ? (
            <div className="text-sm text-gray-500 p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">
              No interfaces detected yet. The router reports its interface list every 60 seconds — try again shortly after the router comes online.
            </div>
          ) : (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">
                Check the ports that should be added to the LAN bridge. Unchecked ports will be removed from the bridge.
              </p>
              <div className="space-y-1 max-h-72 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg p-2">
                {availableInterfaces.map(iface => (
                  <label
                    key={iface.name}
                    className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedPorts.has(iface.name)}
                      onChange={() => togglePort(iface.name)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{iface.name}</span>
                      <span className="text-xs text-gray-400 ml-2">{iface.type}</span>
                    </div>
                  </label>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-2">
                {selectedPorts.size} port{selectedPorts.size === 1 ? '' : 's'} selected
              </p>
            </div>
          )}

          <div className="flex gap-3 justify-end">
            <button type="button" onClick={() => setLanPortsModal(false)} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={lanMut.isPending || selectedPorts.size === 0} className="btn-primary">
              {lanMut.isPending ? 'Saving...' : 'Update bridge ports'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Reprovision modal — shown when router is offline so user can paste command manually */}
      <Modal isOpen={!!reprovisionModal} onClose={() => setReprovisionModal(null)} title="Reprovision router (offline)">
        <div className="space-y-4">
          <div className="p-3 bg-blue-900/20 border border-blue-800 rounded-lg">
            <p className="text-sm text-blue-300">
              The router isn&apos;t online so we can&apos;t push the update automatically. Copy this command and run it on the MikroTik terminal to re-apply the latest provisioning script:
            </p>
          </div>
          <div className="relative">
            <pre className="p-3 pr-12 bg-gray-950 border border-gray-700 rounded-lg text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap break-all">
              {reprovisionModal?.command}
            </pre>
            <button
              onClick={() => {
                if (reprovisionModal) {
                  navigator.clipboard.writeText(reprovisionModal.command);
                  toast.success('Copied to clipboard');
                }
              }}
              className="absolute top-2 right-2 p-1.5 text-gray-400 hover:text-white"
              title="Copy"
            >
              <Copy size={14} />
            </button>
          </div>
          <p className="text-xs text-gray-500">
            This uses the existing API key for this router — it will UPDATE the setup, not create a duplicate.
          </p>
          <div className="flex justify-end">
            <button onClick={() => setReprovisionModal(null)} className="btn-primary">Done</button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export default function RoutersPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [bootstrapModal, setBootstrapModal] = useState<{ apiKey: string; command: string; routerId: string } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<MikrotikRouter | null>(null);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ name: '', host: '' });

  const { data: routers = [], isPending } = useQuery({ queryKey: ['routers'], queryFn: getRouters, refetchInterval: 5000 });

  const linkMut = useMutation({
    mutationFn: linkRouter,
    onSuccess: (data: { apiKey: string; bootstrapCommand: string; routerId: string }) => {
      qc.invalidateQueries({ queryKey: ['routers'] });
      setModalOpen(false); setForm({ name: '', host: '' });
      setBootstrapModal({ apiKey: data.apiKey, command: data.bootstrapCommand, routerId: data.routerId });
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

  const rebootMut = useMutation({
    mutationFn: rebootRouter,
    onSuccess: () => toast.success('Reboot scheduled — will execute within 30 seconds'),
    onError: () => toast.error('Failed to schedule reboot'),
  });

  const openEdit = (r: MikrotikRouter) => { setEditing(r); setForm({ name: r.name, host: r.host }); setModalOpen(true); };
  const closeModal = () => { setModalOpen(false); setEditing(null); setForm({ name: '', host: '' }); };
  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); editing ? updateMut.mutate({ id: editing.id, data: form }) : linkMut.mutate(form); };
  const allRouters = routers as MikrotikRouter[];
  const rq = search.trim().toLowerCase();
  const list = rq ? allRouters.filter(r => (r.name||'').toLowerCase().includes(rq) || (r.host||'').toLowerCase().includes(rq) || (r.status||'').toLowerCase().includes(rq)) : allRouters;

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Routers</h1>
          <p className="text-sm text-gray-500 mt-1">{allRouters.length} router{allRouters.length !== 1 ? 's' : ''} configured</p>
        </div>
        <button onClick={() => { setEditing(null); setModalOpen(true); }} className="btn-primary flex items-center gap-2">
          <Plus size={16} /> Link Router
        </button>
      </div>

      <div className="mb-4 max-w-md">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name, host, status…" />
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
                  {r.host && r.host !== 'auto' && <p className="text-sm text-gray-500">{r.host}</p>}
                  {r.identity && <p className="text-xs text-gray-400 mt-0.5">Identity: {r.identity}</p>}
                </div>
                <div className="flex items-center gap-2 ml-2 shrink-0">
                  <span className={r.status === 'ONLINE' ? 'badge-green' : r.status === 'OFFLINE' ? 'badge-red' : 'badge-yellow'}>{r.status}</span>
                  <RouterOptionsMenu
                    router={r}
                    onReboot={() => rebootMut.mutate(r.id)}
                    onEdit={() => openEdit(r)}
                    onDelete={() => setDeleteId(r.id)}
                  />
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
        <Modal isOpen onClose={() => setBootstrapModal(null)} title="Link MikroTik Router" size="lg">
          <LinkWizard
            routerId={bootstrapModal.routerId}
            command={bootstrapModal.command}
            onDone={() => { setBootstrapModal(null); qc.invalidateQueries({ queryKey: ['routers'] }); }}
          />
        </Modal>
      )}

      <ConfirmDialog isOpen={!!deleteId} onClose={() => setDeleteId(null)}
        onConfirm={() => deleteId && deleteMut.mutate(deleteId)} loading={deleteMut.isPending}
        message="This will permanently delete the router and all its data." />
    </AppLayout>
  );
}
