'use client';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getPackages, analyzeImport, importSubscribers } from '@/lib/api';
import Modal from '@/components/ui/Modal';
import toast from 'react-hot-toast';
import { Upload, ArrowRight, Check } from 'lucide-react';

interface Pkg { id: string; name: string; speedDownKbps: number; speedUpKbps: number; }
interface MapEntry { mode: 'existing' | 'new'; packageId: string; name: string; down: string; up: string; price: string; validity: string; }
type Phase = 'pick' | 'analyzing' | 'map' | 'importing' | 'done';

export default function ImportUsersModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const { data: packages = [] } = useQuery<Pkg[]>({ queryKey: ['packages'], queryFn: getPackages, enabled: open });
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState('');
  const [phase, setPhase] = useState<Phase>('pick');
  const [values, setValues] = useState<{ name: string; count: number }[]>([]);
  const [pkgColumn, setPkgColumn] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, MapEntry>>({});
  const [result, setResult] = useState<{ imported: number; skipped: number; unparsedExpiry?: number; createdPackages?: string[]; message?: string } | null>(null);

  const reset = () => { setCsv(''); setPhase('pick'); setValues([]); setPkgColumn(null); setMapping({}); setResult(null); if (fileRef.current) fileRef.current.value = ''; };
  const close = () => { reset(); onClose(); };

  const runImport = async (text: string, map?: Record<string, unknown>) => {
    setPhase('importing');
    try {
      const r = await importSubscribers(text, map);
      setResult(r); setPhase('done'); onImported();
    } catch (e) {
      toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Import failed');
      setPhase(map ? 'map' : 'pick');
    }
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const text = String(reader.result || '');
      setCsv(text);
      setPhase('analyzing');
      try {
        const a = await analyzeImport(text);
        setPkgColumn(a.packageColumn);
        if (!a.packageColumn || a.values.length === 0) {
          // No package/rate-limit column — import straight away.
          await runImport(text);
          return;
        }
        setValues(a.values);
        const init: Record<string, MapEntry> = {};
        a.values.forEach(v => { init[v.name] = { mode: 'new', packageId: '', name: v.name, down: '', up: '', price: '0', validity: '30' }; });
        setMapping(init);
        setPhase('map');
      } catch (err) {
        toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not read the CSV');
        setPhase('pick');
      }
    };
    reader.onerror = () => { toast.error('Could not read that file'); setPhase('pick'); };
    reader.readAsText(file);
  };

  const upd = (val: string, patch: Partial<MapEntry>) => setMapping(m => ({ ...m, [val]: { ...m[val], ...patch } }));

  const valid = values.every(v => {
    const e = mapping[v.name];
    if (!e) return false;
    if (e.mode === 'existing') return !!e.packageId;
    return !!e.name.trim() && Number(e.down) > 0 && Number(e.up) > 0;
  });

  const submit = () => {
    const map: Record<string, unknown> = {};
    for (const v of values) {
      const e = mapping[v.name];
      if (e.mode === 'existing') map[v.name] = { packageId: e.packageId };
      else map[v.name] = { newPackage: {
        name: e.name.trim(),
        speedDownKbps: Math.round(Number(e.down) * 1024),
        speedUpKbps: Math.round(Number(e.up) * 1024),
        price: Number(e.price) || 0,
        validityMinutes: Math.round((Number(e.validity) || 30) * 1440),
      } };
    }
    runImport(csv, map);
  };

  return (
    <Modal isOpen={open} onClose={close} title="Import users">
      {phase === 'pick' && (
        <div className="text-center py-6">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onPick} />
          <p className="text-sm text-gray-500 mb-4">Upload a CSV exported from your current billing system. Dartbit auto-detects name, username, phone and expiry columns — and if there's a package or rate-limit column, it'll help you map those to real packages next.</p>
          <button onClick={() => fileRef.current?.click()} className="btn-primary inline-flex items-center gap-2">
            <Upload size={16} /> Choose CSV file
          </button>
        </div>
      )}

      {phase === 'analyzing' && <div className="text-center py-8 text-gray-400">Reading the file…</div>}
      {phase === 'importing' && <div className="text-center py-8 text-gray-400">Importing subscribers…</div>}

      {phase === 'map' && (
        <div>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            Found <b>{values.length}</b> distinct value{values.length === 1 ? '' : 's'} in the <b>{pkgColumn}</b> column. Map each to a package — pick an existing one or define a new one with its speed. Dartbit creates the new packages and assigns them to the matching users.
          </p>
          <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
            {values.map(v => {
              const e = mapping[v.name];
              if (!e) return null;
              return (
                <div key={v.name} className="border border-gray-200 dark:border-gray-800 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-medium text-sm">{v.name}</span>
                    <span className="text-xs text-gray-400">{v.count} user{v.count === 1 ? '' : 's'}</span>
                    <div className="ml-auto inline-flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
                      <button onClick={() => upd(v.name, { mode: 'new' })} className={`px-2 py-1 ${e.mode === 'new' ? 'bg-blue-600 text-white' : 'text-gray-500'}`}>New package</button>
                      <button onClick={() => upd(v.name, { mode: 'existing' })} className={`px-2 py-1 ${e.mode === 'existing' ? 'bg-blue-600 text-white' : 'text-gray-500'}`}>Existing</button>
                    </div>
                  </div>
                  {e.mode === 'existing' ? (
                    <select className="input text-sm" value={e.packageId} onChange={ev => upd(v.name, { packageId: ev.target.value })}>
                      <option value="">Select a package…</option>
                      {packages.map(p => <option key={p.id} value={p.id}>{p.name} ({Math.round(p.speedDownKbps / 1024)}/{Math.round(p.speedUpKbps / 1024)} Mbps)</option>)}
                    </select>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <input className="input text-sm col-span-2 sm:col-span-1" placeholder="Package name" value={e.name} onChange={ev => upd(v.name, { name: ev.target.value })} />
                      <input className="input text-sm" type="number" min="1" placeholder="Down (Mbps)" value={e.down} onChange={ev => upd(v.name, { down: ev.target.value })} />
                      <input className="input text-sm" type="number" min="1" placeholder="Up (Mbps)" value={e.up} onChange={ev => upd(v.name, { up: ev.target.value })} />
                      <input className="input text-sm" type="number" min="0" placeholder="Price" value={e.price} onChange={ev => upd(v.name, { price: ev.target.value })} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={close} className="btn-secondary">Cancel</button>
            <button onClick={submit} disabled={!valid} className="btn-primary inline-flex items-center gap-2 disabled:opacity-50">
              Import <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="text-center py-6">
          <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center mx-auto mb-3"><Check className="text-green-600" size={24} /></div>
          <p className="font-semibold text-lg">Imported {result.imported} subscriber{result.imported === 1 ? '' : 's'}</p>
          <p className="text-sm text-gray-500 mt-1">
            {result.skipped ? `${result.skipped} skipped (already existed or blank). ` : ''}
            {result.createdPackages && result.createdPackages.length ? `Created packages: ${result.createdPackages.join(', ')}. ` : ''}
            {result.unparsedExpiry ? `${result.unparsedExpiry} had an unreadable expiry date.` : ''}
          </p>
          <button onClick={close} className="btn-primary mt-4">Done</button>
        </div>
      )}
    </Modal>
  );
}
