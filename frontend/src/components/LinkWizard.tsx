'use client';
import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getRouterLinkStatus, updateRouterLanPorts } from '@/lib/api';
import toast from 'react-hot-toast';
import { Copy, Check, Loader2, Wifi, Cable } from 'lucide-react';

type Stage = 'AWAITING_HEARTBEAT' | 'AWAITING_INTERFACES' | 'AWAITING_PORTS' | 'COMPLETE';

// Walks the tenant through linking: copy command -> wait for heartbeat -> wait for interface list
// -> pick bridge ports -> complete. Polls the backend every 2s while setup is in progress.
export default function LinkWizard({ routerId, command, onDone }: { routerId: string; command: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const { data } = useQuery({
    queryKey: ['link-status', routerId],
    queryFn: () => getRouterLinkStatus(routerId),
    refetchInterval: (q) => {
      const s = q.state.data?.stage;
      return s === 'COMPLETE' ? false : 2000; // stop polling once complete
    },
  });
  const stage = (data?.stage || 'AWAITING_HEARTBEAT') as Stage;
  const interfaces = data?.interfaces || [];

  // Pre-select nothing; tenant explicitly chooses. Default-suggest ether2 if present.
  useEffect(() => {
    if (stage === 'AWAITING_PORTS' && selected.length === 0 && interfaces.length > 0) {
      const e2 = interfaces.find(i => i.name === 'ether2');
      if (e2) setSelected([e2.name]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, interfaces.length]);

  const portsMut = useMutation({
    mutationFn: () => updateRouterLanPorts(routerId, selected),
    onSuccess: () => toast.success('Ports applied — finishing provisioning'),
    onError: () => toast.error('Failed to apply ports'),
  });

  const copy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    toast.success('Copied! Paste it into your MikroTik terminal.');
    setTimeout(() => setCopied(false), 2500);
  };

  const toggle = (name: string) =>
    setSelected(s => s.includes(name) ? s.filter(x => x !== name) : [...s, name]);

  // ---- Step rendering ----
  const steps = [
    { key: 'cmd', label: 'Copy & run command', done: stage !== 'AWAITING_HEARTBEAT' || copied },
    { key: 'hb', label: 'Router linked', done: stage === 'AWAITING_INTERFACES' || stage === 'AWAITING_PORTS' || stage === 'COMPLETE' },
    { key: 'if', label: 'Interfaces received', done: stage === 'AWAITING_PORTS' || stage === 'COMPLETE' },
    { key: 'ports', label: 'Bridge ports chosen', done: stage === 'COMPLETE' },
  ];

  return (
    <div className="space-y-5">
      {/* Step indicator */}
      <div className="flex items-center justify-between">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center flex-1 last:flex-none">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${s.done ? 'bg-green-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-500'}`}>
              {s.done ? <Check size={13} /> : i + 1}
            </div>
            {i < steps.length - 1 && <div className={`h-0.5 flex-1 mx-1 ${s.done ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-700'}`} />}
          </div>
        ))}
      </div>

      {/* Step 1: command (always visible) */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="label mb-0">1. Paste this in your MikroTik terminal</label>
          <button onClick={copy} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700">
            {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
          </button>
        </div>
        <pre className="bg-gray-900 text-green-400 text-xs p-4 rounded-lg overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed">{command}</pre>
      </div>

      {/* Live status */}
      {stage === 'AWAITING_HEARTBEAT' && (
        <div className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <Loader2 size={18} className="animate-spin text-blue-600 shrink-0" />
          <div>
            <p className="text-sm font-medium">Waiting for your router…</p>
            <p className="text-xs text-gray-500">Run the command above. Once the router checks in, this updates automatically.</p>
          </div>
        </div>
      )}

      {stage === 'AWAITING_INTERFACES' && (
        <div className="flex items-center gap-3 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-4">
          <Loader2 size={18} className="animate-spin text-green-600 shrink-0" />
          <div>
            <p className="text-sm font-medium text-green-800 dark:text-green-300">✅ Router linked{data?.identity ? ` (${data.identity})` : ''}!</p>
            <p className="text-xs text-green-700 dark:text-green-400">Waiting for the interface list from the router…</p>
          </div>
        </div>
      )}

      {stage === 'AWAITING_PORTS' && (
        <div className="space-y-3">
          <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-3">
            <p className="text-sm font-medium text-green-800 dark:text-green-300">Interfaces received. Choose the ports to add to the Dartbit bridge.</p>
            <p className="text-xs text-green-700 dark:text-green-400 mt-0.5">These ports are combined into one bridge serving PPPoE, Hotspot and Static clients. Don&apos;t include your WAN/internet port.</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {interfaces.length === 0 ? (
              <p className="text-sm text-gray-400 col-span-full">No selectable interfaces reported.</p>
            ) : interfaces.map(i => {
              const on = selected.includes(i.name);
              return (
                <button key={i.name} onClick={() => toggle(i.name)}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition ${on ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'}`}>
                  {i.type === 'wlan' ? <Wifi size={14} /> : <Cable size={14} />}
                  <span className="font-medium truncate">{i.name}</span>
                  {on && <Check size={14} className="ml-auto text-blue-600" />}
                </button>
              );
            })}
          </div>
          <button onClick={() => portsMut.mutate()} disabled={selected.length === 0 || portsMut.isPending}
            className="btn-primary w-full">
            {portsMut.isPending ? 'Applying…' : `Add ${selected.length} port${selected.length === 1 ? '' : 's'} & finish`}
          </button>
        </div>
      )}

      {stage === 'COMPLETE' && (
        <div className="space-y-3">
          <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-4 text-center">
            <Check size={28} className="mx-auto text-green-600 mb-1" />
            <p className="text-sm font-semibold text-green-800 dark:text-green-300">Provisioning complete</p>
            <p className="text-xs text-green-700 dark:text-green-400">Your router is linked and configured. It will finish applying the bridge ports within a few seconds.</p>
          </div>
          <button onClick={onDone} className="btn-primary w-full">Done</button>
        </div>
      )}

      {stage !== 'COMPLETE' && (
        <button onClick={onDone} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 w-full text-center">
          Close — I&apos;ll finish later
        </button>
      )}
    </div>
  );
}
