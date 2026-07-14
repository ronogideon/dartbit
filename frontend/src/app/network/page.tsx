'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import AppLayout from '@/components/layout/AppLayout';
import { useAuth } from '@/lib/auth';
import toast from 'react-hot-toast';
import {
  getNetwork, addNetElement, deleteNetElement, addNetCable, deleteNetCable,
  addNetMaintenance, resolveNetMaintenance, getNetInventory, getRouters,
  type NetElement, type NetCable,
} from '@/lib/api';
import 'leaflet/dist/leaflet.css';
import type LType from 'leaflet';

// Colour code by cable core count — consistent everywhere (map lines + legend + inventory).
const CORE_COLORS: Record<number, string> = { 1: '#9ca3af', 2: '#3b82f6', 4: '#22c55e', 6: '#f97316', 8: '#ef4444', 12: '#a855f7', 24: '#92400e', 48: '#111827', 96: '#0ea5e9' };
const coreColor = (c: number) => CORE_COLORS[c] || '#64748b';
const CORE_OPTIONS = [1, 2, 4, 6, 8, 12, 24, 48, 96];

const TYPE_STYLE: Record<string, { label: string; letter: string; color: string }> = {
  OLT: { label: 'OLT', letter: 'O', color: '#dc2626' },
  DOME: { label: 'Dome enclosure', letter: 'D', color: '#7c3aed' },
  FAT: { label: 'FAT / Splitter', letter: 'F', color: '#2563eb' },
  PATCH_CORD: { label: 'Patch cord', letter: 'P', color: '#0891b2' },
  MIKROTIK: { label: 'MikroTik', letter: 'M', color: '#ea580c' },
  CUSTOMER: { label: 'Customer premise', letter: 'C', color: '#16a34a' },
};

type Mode = 'view' | 'place' | 'cable-start' | 'cable-end';

interface ElementForm { type: string; name: string; lat: number; lng: number; ratio: string; inputCore: string; inputPowerDbm: string; outputPowerDbm: string; routerId: string; notes: string }
interface CableForm { fromId: string; fromName: string; toId?: string; toName?: string; toLat?: number; toLng?: number; lengthM: string; cores: number; powerStartDbm: string; powerEndDbm: string; isDrop: boolean; label: string }

export default function NetworkMapPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'TENANT_ADMIN' || user?.role === 'SUPERADMIN';
  const { data: net } = useQuery({ queryKey: ['network'], queryFn: getNetwork, refetchInterval: 30000 });
  const { data: inv } = useQuery({ queryKey: ['net-inventory'], queryFn: getNetInventory, refetchInterval: 60000 });
  const { data: routers = [] } = useQuery({ queryKey: ['routers'], queryFn: getRouters });

  const mapRef = useRef<LType.Map | null>(null);
  const LRef = useRef<typeof LType | null>(null);
  const layerRef = useRef<LType.LayerGroup | null>(null);
  const mapDiv = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('view');
  const modeRef = useRef<Mode>('view');
  modeRef.current = mode;
  const [elementForm, setElementForm] = useState<ElementForm | null>(null);
  const [cableForm, setCableForm] = useState<CableForm | null>(null);
  const cableFormRef = useRef<CableForm | null>(null);
  cableFormRef.current = cableForm;
  const [maintFor, setMaintFor] = useState<{ cableId?: string; elementId?: string; name: string } | null>(null);
  const [maintKind, setMaintKind] = useState('CABLE_RERUN');
  const [maintNote, setMaintNote] = useState('');
  const [maintLen, setMaintLen] = useState('');
  const [showInventory, setShowInventory] = useState(false);
  const [satellite, setSatellite] = useState(false);
  const tileRef = useRef<LType.TileLayer | null>(null);

  const invalidate = useCallback(() => { qc.invalidateQueries({ queryKey: ['network'] }); qc.invalidateQueries({ queryKey: ['net-inventory'] }); }, [qc]);

  const addElementMut = useMutation({ mutationFn: addNetElement, onSuccess: () => { invalidate(); setElementForm(null); setMode('view'); toast.success('Equipment added to the map'); }, onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed') });
  const addCableMut = useMutation({ mutationFn: addNetCable, onSuccess: () => { invalidate(); setCableForm(null); setMode('view'); toast.success('Cable recorded'); }, onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed') });
  const maintMut = useMutation({ mutationFn: addNetMaintenance, onSuccess: () => { invalidate(); setMaintFor(null); setMaintNote(''); setMaintLen(''); toast.success('Maintenance logged — admin will be asked to confirm'); }, onError: () => toast.error('Failed to log maintenance') });

  // Map init (client-only)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (mapRef.current || !mapDiv.current) return;
      const L = (await import('leaflet')).default;
      if (cancelled || !mapDiv.current) return;
      LRef.current = L;
      const map = L.map(mapDiv.current, { zoomControl: true }).setView([-1.2921, 36.8219], 13); // Nairobi default
      tileRef.current = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      map.on('click', (e: LType.LeafletMouseEvent) => {
        const m = modeRef.current;
        if (m === 'place') {
          setElementForm(f => f ? { ...f, lat: e.latlng.lat, lng: e.latlng.lng } : { type: 'FAT', name: '', lat: e.latlng.lat, lng: e.latlng.lng, ratio: '1x8', inputCore: '', inputPowerDbm: '', outputPowerDbm: '', routerId: '', notes: '' });
        } else if (m === 'cable-end') {
          const cf = cableFormRef.current;
          if (cf) setCableForm({ ...cf, toId: undefined, toName: `point (${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)})`, toLat: e.latlng.lat, toLng: e.latlng.lng });
        }
      });
      mapRef.current = map;
    })();
    return () => { cancelled = true; if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, []);

  // Satellite toggle (Esri World Imagery — no key needed)
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!L || !map || !tileRef.current) return;
    map.removeLayer(tileRef.current);
    tileRef.current = satellite
      ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: '© Esri' }).addTo(map)
      : L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  }, [satellite]);

  // Render elements + cables
  useEffect(() => {
    const L = LRef.current, layer = layerRef.current;
    if (!L || !layer || !net) return;
    layer.clearLayers();
    const byId: Record<string, NetElement> = {};
    net.elements.forEach(el => { byId[el.id] = el; });

    net.cables.forEach((c: NetCable) => {
      const from = byId[c.fromId];
      if (!from) return;
      const to: [number, number] | null = c.toId && byId[c.toId] ? [byId[c.toId].lat, byId[c.toId].lng] : (c.toLat != null && c.toLng != null ? [c.toLat, c.toLng] : null);
      if (!to) return;
      const loss = c.powerStartDbm != null && c.powerEndDbm != null ? (c.powerStartDbm - c.powerEndDbm).toFixed(1) : null;
      const weak = c.powerEndDbm != null && c.powerEndDbm < -25;
      const line = L.polyline([[from.lat, from.lng], to], { color: coreColor(c.cores), weight: c.isDrop ? 2 : 4, opacity: 0.9, dashArray: c.isDrop ? '6 6' : undefined });
      line.bindPopup(`
        <div style="min-width:200px">
          <b>${c.label || (c.isDrop ? 'Customer drop' : 'Cable')}</b><br/>
          ${c.cores} core${c.cores > 1 ? 's' : ''} • ${Math.round(c.lengthM)} m<br/>
          Power: ${c.powerStartDbm ?? '—'} → ${c.powerEndDbm ?? '—'} dBm${loss ? ` (loss ${loss} dB)` : ''}
          ${weak ? '<br/><span style="color:#dc2626;font-weight:600">⚠ Weak signal at end (&lt; -25 dBm)</span>' : ''}
          <br/><a href="#" data-maint-cable="${c.id}">Log maintenance</a>
          ${isAdmin ? ` • <a href="#" data-del-cable="${c.id}" style="color:#dc2626">Delete</a>` : ''}
        </div>`);
      line.addTo(layer);
    });

    net.elements.forEach((el: NetElement) => {
      const st = TYPE_STYLE[el.type] || { label: el.type, letter: '?', color: '#64748b' };
      let metaHtml = '';
      try {
        const m = el.meta ? JSON.parse(el.meta) : null;
        if (m) {
          if (el.type === 'FAT') metaHtml = `Split ${m.ratio || '?'}${m.inputCore ? ` • in core #${m.inputCore}` : ''}<br/>Power in ${m.inputPowerDbm ?? '—'} dBm → out ${m.outputPowerDbm ?? '—'} dBm<br/>`;
          else if (m.notes) metaHtml = `${m.notes}<br/>`;
        }
      } catch { /* ignore bad meta */ }
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:26px;height:26px;border-radius:${el.type === 'CUSTOMER' ? '4px' : '50%'};background:${st.color};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)">${st.letter}</div>`,
        iconSize: [26, 26], iconAnchor: [13, 13],
      });
      const marker = L.marker([el.lat, el.lng], { icon });
      marker.bindPopup(`
        <div style="min-width:190px">
          <b>${el.name}</b><br/><span style="color:#6b7280">${st.label}</span><br/>${metaHtml}
          <a href="#" data-cable-from="${el.id}">Run cable from here</a><br/>
          <a href="#" data-maint-el="${el.id}">Log maintenance</a>
          ${isAdmin ? `<br/><a href="#" data-del-el="${el.id}" style="color:#dc2626">Delete</a>` : ''}
        </div>`);
      marker.addTo(layer);
    });
  }, [net, isAdmin]);

  // Popup link actions (event delegation on the map container)
  useEffect(() => {
    const div = mapDiv.current;
    if (!div || !net) return;
    const handler = (ev: Event) => {
      const t = ev.target as HTMLElement;
      const cableFrom = t.getAttribute?.('data-cable-from');
      const maintCable = t.getAttribute?.('data-maint-cable');
      const maintEl = t.getAttribute?.('data-maint-el');
      const delEl = t.getAttribute?.('data-del-el');
      const delCable = t.getAttribute?.('data-del-cable');
      if (!cableFrom && !maintCable && !maintEl && !delEl && !delCable) return;
      ev.preventDefault();
      mapRef.current?.closePopup();
      if (cableFrom) {
        const el = net.elements.find(e => e.id === cableFrom);
        if (el) { setCableForm({ fromId: el.id, fromName: el.name, lengthM: '', cores: 4, powerStartDbm: '', powerEndDbm: '', isDrop: false, label: '' }); setMode('cable-end'); toast('Now tap the END: another equipment marker, or any point on the map (e.g. the customer premise).', { duration: 5000 }); }
      } else if (maintCable) {
        setMaintFor({ cableId: maintCable, name: 'cable' }); setMaintKind('CABLE_RERUN');
      } else if (maintEl) {
        const el = net.elements.find(e => e.id === maintEl);
        setMaintFor({ elementId: maintEl, name: el?.name || 'equipment' }); setMaintKind(el?.type === 'MIKROTIK' ? 'ROUTER_REISSUE' : 'OTHER');
      } else if (delEl && confirm('Delete this equipment and its cables?')) {
        deleteNetElement(delEl).then(invalidate).catch(() => toast.error('Delete failed'));
      } else if (delCable && confirm('Delete this cable?')) {
        deleteNetCable(delCable).then(invalidate).catch(() => toast.error('Delete failed'));
      }
    };
    div.addEventListener('click', handler);
    return () => div.removeEventListener('click', handler);
  }, [net, invalidate]);

  // When picking a cable end, clicking a marker should snap to that element
  useEffect(() => {
    if (mode !== 'cable-end' || !net || !cableForm) return;
    // handled via popup? Simpler: listen for marker clicks by checking nearest element on map click is complex;
    // instead show an element picker in the cable form.
  }, [mode, net, cableForm]);

  const useMyGps = (cb: (lat: number, lng: number) => void) => {
    if (!navigator.geolocation) return toast.error('This device has no GPS/location support');
    navigator.geolocation.getCurrentPosition(
      p => { cb(p.coords.latitude, p.coords.longitude); mapRef.current?.setView([p.coords.latitude, p.coords.longitude], 17); },
      () => toast.error('Could not get your location — check permissions'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const startPlacing = () => {
    setMode('place');
    setElementForm({ type: 'FAT', name: '', lat: 0, lng: 0, ratio: '1x8', inputCore: '', inputPowerDbm: '', outputPowerDbm: '', routerId: '', notes: '' });
    toast('Tap the map to position the equipment, or use "My GPS".', { duration: 4000 });
  };

  const submitElement = () => {
    if (!elementForm) return;
    if (!elementForm.lat && !elementForm.lng) return toast.error('Set a position first (tap the map or use My GPS)');
    const meta: Record<string, unknown> = {};
    if (elementForm.type === 'FAT') {
      meta.ratio = elementForm.ratio;
      if (elementForm.inputCore) meta.inputCore = Number(elementForm.inputCore);
      if (elementForm.inputPowerDbm) meta.inputPowerDbm = Number(elementForm.inputPowerDbm);
      if (elementForm.outputPowerDbm) meta.outputPowerDbm = Number(elementForm.outputPowerDbm);
    }
    if (elementForm.type === 'MIKROTIK' && elementForm.routerId) meta.routerId = elementForm.routerId;
    if (elementForm.notes) meta.notes = elementForm.notes;
    addElementMut.mutate({ type: elementForm.type, name: elementForm.name || undefined, lat: elementForm.lat, lng: elementForm.lng, meta });
  };

  const submitCable = () => {
    if (!cableForm) return;
    if (!cableForm.toId && cableForm.toLat == null) return toast.error('Pick the cable end first');
    if (!cableForm.lengthM || Number(cableForm.lengthM) <= 0) return toast.error('Enter the cable length in meters');
    addCableMut.mutate({
      fromId: cableForm.fromId, toId: cableForm.toId, toLat: cableForm.toLat, toLng: cableForm.toLng,
      lengthM: Number(cableForm.lengthM), cores: cableForm.cores,
      powerStartDbm: cableForm.powerStartDbm ? Number(cableForm.powerStartDbm) : undefined,
      powerEndDbm: cableForm.powerEndDbm ? Number(cableForm.powerEndDbm) : undefined,
      isDrop: cableForm.isDrop, label: cableForm.label || undefined,
    });
  };

  const pending = (net?.maintenance || []).filter(m => m.status === 'PENDING');

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Network Map</h1>
          <p className="text-sm text-gray-500 mt-1">Your plant on the map — equipment, cables, power readings and inventory</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setSatellite(s => !s)} className="btn-secondary text-sm">{satellite ? 'Street view' : 'Satellite'}</button>
          <button onClick={() => setShowInventory(s => !s)} className="btn-secondary text-sm">Inventory{inv?.pendingMaintenance ? ` (${inv.pendingMaintenance} pending)` : ''}</button>
          <button onClick={startPlacing} className="btn-primary text-sm">+ Add equipment</button>
        </div>
      </div>

      {/* Admin: pending maintenance confirmations */}
      {isAdmin && pending.length > 0 && (
        <div className="mb-4 border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 rounded-xl p-3">
          <p className="text-sm font-semibold mb-2">Maintenance awaiting your confirmation</p>
          {pending.map(m => (
            <div key={m.id} className="flex items-center gap-2 text-sm py-1 flex-wrap">
              <span>{m.kind === 'CABLE_RERUN' ? 'Cable rerun' : m.kind === 'ROUTER_REISSUE' ? 'Router re-issued to client' : 'Maintenance'}{m.newLengthM ? ` — new length ${m.newLengthM} m` : ''}{m.note ? ` — “${m.note}”` : ''}{m.createdByName ? ` (by ${m.createdByName})` : ''}</span>
              <span className="ml-auto flex gap-2">
                <button onClick={() => resolveNetMaintenance(m.id, 'CONFIRMED').then(invalidate)} className="text-green-600 font-medium">Confirm</button>
                <button onClick={() => resolveNetMaintenance(m.id, 'REJECTED').then(invalidate)} className="text-red-500">Reject</button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="relative">
        <div ref={mapDiv} className="w-full rounded-xl border border-gray-200 dark:border-gray-800" style={{ height: '65vh', minHeight: 420 }} />

        {/* Core-count colour legend */}
        <div className="absolute bottom-3 left-3 z-[1000] bg-white/95 dark:bg-gray-900/95 rounded-lg shadow px-3 py-2 text-xs">
          <p className="font-semibold mb-1">Cable cores</p>
          <div className="grid grid-cols-3 gap-x-3 gap-y-0.5">
            {CORE_OPTIONS.map(c => (
              <span key={c} className="flex items-center gap-1.5"><span className="inline-block w-4 h-1.5 rounded" style={{ background: coreColor(c) }} />{c}</span>
            ))}
          </div>
          <p className="mt-1 text-gray-400">dashed = customer drop</p>
        </div>
      </div>

      {/* Add-equipment form */}
      {elementForm && (
        <div className="fixed inset-x-0 bottom-0 sm:inset-auto sm:right-6 sm:bottom-6 sm:w-96 z-[1100] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-t-2xl sm:rounded-2xl shadow-2xl p-4 max-h-[75vh] overflow-y-auto">
          <p className="font-semibold mb-2">Add equipment</p>
          <label className="label text-xs">Type</label>
          <select className="input text-sm mb-2" value={elementForm.type} onChange={e => setElementForm(f => f && ({ ...f, type: e.target.value }))}>
            {Object.entries(TYPE_STYLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <label className="label text-xs">Name / label</label>
          <input className="input text-sm mb-2" value={elementForm.name} onChange={e => setElementForm(f => f && ({ ...f, name: e.target.value }))} placeholder={elementForm.type === 'FAT' ? 'e.g. FAT-Kahawa-03' : 'e.g. OLT Main'} />
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-gray-500 flex-1">{elementForm.lat ? `${elementForm.lat.toFixed(5)}, ${elementForm.lng.toFixed(5)}` : 'No position yet — tap the map'}</span>
            <button onClick={() => useMyGps((lat, lng) => setElementForm(f => f && ({ ...f, lat, lng })))} className="btn-secondary text-xs">📍 My GPS</button>
          </div>
          {elementForm.type === 'FAT' && (
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div>
                <label className="label text-xs">Split ratio</label>
                <select className="input text-sm" value={elementForm.ratio} onChange={e => setElementForm(f => f && ({ ...f, ratio: e.target.value }))}>
                  {['1x2', '1x4', '1x8', '1x16', '1x32', '1x64'].map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="label text-xs">Fed by core #</label>
                <input className="input text-sm" type="number" min={1} value={elementForm.inputCore} onChange={e => setElementForm(f => f && ({ ...f, inputCore: e.target.value }))} placeholder="e.g. 3" />
              </div>
              <div>
                <label className="label text-xs">Power in (dBm)</label>
                <input className="input text-sm" type="number" step="0.1" value={elementForm.inputPowerDbm} onChange={e => setElementForm(f => f && ({ ...f, inputPowerDbm: e.target.value }))} placeholder="-14.5" />
              </div>
              <div>
                <label className="label text-xs">Power out / split (dBm)</label>
                <input className="input text-sm" type="number" step="0.1" value={elementForm.outputPowerDbm} onChange={e => setElementForm(f => f && ({ ...f, outputPowerDbm: e.target.value }))} placeholder="-18.2" />
              </div>
            </div>
          )}
          {elementForm.type === 'MIKROTIK' && (
            <div className="mb-2">
              <label className="label text-xs">Link to platform router (optional)</label>
              <select className="input text-sm" value={elementForm.routerId} onChange={e => setElementForm(f => f && ({ ...f, routerId: e.target.value }))}>
                <option value="">— none —</option>
                {(routers as { id: string; name: string }[]).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          )}
          <label className="label text-xs">Notes</label>
          <input className="input text-sm mb-3" value={elementForm.notes} onChange={e => setElementForm(f => f && ({ ...f, notes: e.target.value }))} placeholder="optional" />
          <div className="flex justify-end gap-2">
            <button onClick={() => { setElementForm(null); setMode('view'); }} className="btn-secondary text-sm">Cancel</button>
            <button onClick={submitElement} disabled={addElementMut.isPending} className="btn-primary text-sm disabled:opacity-50">Save to map</button>
          </div>
        </div>
      )}

      {/* Run-cable form */}
      {cableForm && (
        <div className="fixed inset-x-0 bottom-0 sm:inset-auto sm:right-6 sm:bottom-6 sm:w-96 z-[1100] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-t-2xl sm:rounded-2xl shadow-2xl p-4 max-h-[75vh] overflow-y-auto">
          <p className="font-semibold mb-1">Run cable</p>
          <p className="text-xs text-gray-500 mb-2">From <b>{cableForm.fromName}</b> → {cableForm.toName || <i>tap the map, or pick equipment below</i>}</p>
          <label className="label text-xs">End at equipment (or tap a map point)</label>
          <select className="input text-sm mb-2" value={cableForm.toId || ''} onChange={e => {
            const el = (net?.elements || []).find(x => x.id === e.target.value);
            setCableForm(f => f && ({ ...f, toId: el?.id, toName: el?.name, toLat: undefined, toLng: undefined }));
          }}>
            <option value="">— map point / customer premise —</option>
            {(net?.elements || []).filter(e2 => e2.id !== cableForm.fromId).map(e2 => <option key={e2.id} value={e2.id}>{TYPE_STYLE[e2.type]?.label || e2.type}: {e2.name}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <label className="label text-xs">Length (m)</label>
              <input className="input text-sm" type="number" min={1} value={cableForm.lengthM} onChange={e => setCableForm(f => f && ({ ...f, lengthM: e.target.value }))} />
            </div>
            <div>
              <label className="label text-xs">Cores</label>
              <select className="input text-sm" value={cableForm.cores} onChange={e => setCableForm(f => f && ({ ...f, cores: Number(e.target.value) }))}>
                {CORE_OPTIONS.map(c => <option key={c} value={c}>{c} core{c > 1 ? 's' : ''}</option>)}
              </select>
            </div>
            <div>
              <label className="label text-xs">Power at start (dBm)</label>
              <input className="input text-sm" type="number" step="0.1" value={cableForm.powerStartDbm} onChange={e => setCableForm(f => f && ({ ...f, powerStartDbm: e.target.value }))} placeholder="-12.0" />
            </div>
            <div>
              <label className="label text-xs">Power at end (dBm)</label>
              <input className="input text-sm" type="number" step="0.1" value={cableForm.powerEndDbm} onChange={e => setCableForm(f => f && ({ ...f, powerEndDbm: e.target.value }))} placeholder="-17.8" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm mb-2">
            <input type="checkbox" checked={cableForm.isDrop} onChange={e => setCableForm(f => f && ({ ...f, isDrop: e.target.checked }))} />
            Drop to customer premise (final point — record the reading at the customer end)
          </label>
          <label className="label text-xs">Label</label>
          <input className="input text-sm mb-3" value={cableForm.label} onChange={e => setCableForm(f => f && ({ ...f, label: e.target.value }))} placeholder={cableForm.isDrop ? "customer name / account" : 'e.g. Feeder to Zone B'} />
          <div className="flex justify-end gap-2">
            <button onClick={() => { setCableForm(null); setMode('view'); }} className="btn-secondary text-sm">Cancel</button>
            <button onClick={submitCable} disabled={addCableMut.isPending} className="btn-primary text-sm disabled:opacity-50">Save cable</button>
          </div>
        </div>
      )}

      {/* Maintenance form */}
      {maintFor && (
        <div className="fixed inset-x-0 bottom-0 sm:inset-auto sm:right-6 sm:bottom-6 sm:w-96 z-[1100] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-t-2xl sm:rounded-2xl shadow-2xl p-4">
          <p className="font-semibold mb-2">Log maintenance — {maintFor.name}</p>
          <select className="input text-sm mb-2" value={maintKind} onChange={e => setMaintKind(e.target.value)}>
            {maintFor.cableId && <option value="CABLE_RERUN">Cable rerun (new cable laid)</option>}
            {maintFor.elementId && <option value="ROUTER_REISSUE">Router re-issued to client</option>}
            <option value="OTHER">Other maintenance</option>
          </select>
          {maintKind === 'CABLE_RERUN' && (
            <>
              <label className="label text-xs">New cable length (m)</label>
              <input className="input text-sm mb-2" type="number" min={1} value={maintLen} onChange={e => setMaintLen(e.target.value)} />
            </>
          )}
          <label className="label text-xs">Note</label>
          <input className="input text-sm mb-3" value={maintNote} onChange={e => setMaintNote(e.target.value)} placeholder="what was done and why" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setMaintFor(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => maintMut.mutate({ kind: maintKind, cableId: maintFor.cableId, elementId: maintFor.elementId, note: maintNote || undefined, newLengthM: maintLen ? Number(maintLen) : undefined })} disabled={maintMut.isPending} className="btn-primary text-sm disabled:opacity-50">Log it</button>
          </div>
          <p className="text-[11px] text-gray-400 mt-2">The admin is notified and must confirm before the record is applied.</p>
        </div>
      )}

      {/* Inventory panel */}
      {showInventory && inv && (
        <div className="mt-4 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <p className="font-semibold mb-3">Plant inventory</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
            {[
              ['Routers (platform)', inv.routers], ['MikroTiks on map', inv.mikrotiksOnMap], ['OLTs', inv.olts],
              ['Dome enclosures', inv.domes], ['FATs / Splitters', inv.fats], ['Patch cords', inv.patchCords],
            ].map(([label, val]) => (
              <div key={String(label)} className="rounded-lg bg-gray-50 dark:bg-gray-800/60 p-3">
                <p className="text-xs text-gray-500">{label}</p>
                <p className="text-xl font-bold">{val as number}</p>
              </div>
            ))}
          </div>
          <p className="text-sm font-medium mb-2">Cable by core count — total {Math.round(inv.totalCableMeters).toLocaleString()} m</p>
          <div className="space-y-1">
            {inv.cableByCores.map(c => (
              <div key={c.cores} className="flex items-center gap-2 text-sm">
                <span className="inline-block w-5 h-2 rounded" style={{ background: coreColor(c.cores) }} />
                <span className="w-16">{c.cores} core{c.cores > 1 ? 's' : ''}</span>
                <span className="text-gray-500">{c.runs} run{c.runs === 1 ? '' : 's'}</span>
                <span className="ml-auto font-medium">{Math.round(c.meters).toLocaleString()} m</span>
              </div>
            ))}
            {inv.cableByCores.length === 0 && <p className="text-sm text-gray-400">No cables recorded yet.</p>}
          </div>
          <p className="text-xs text-gray-500 mt-3">Customer drops: {inv.customerDrops.count} ({Math.round(inv.customerDrops.meters).toLocaleString()} m) • Pending maintenance: {inv.pendingMaintenance}</p>
        </div>
      )}
    </AppLayout>
  );
}
