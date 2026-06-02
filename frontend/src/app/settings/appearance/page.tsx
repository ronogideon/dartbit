'use client';
import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getBranding, saveBranding } from '@/lib/api';
import { FONT_OPTIONS, fontStack } from '@/lib/fonts';
import AppLayout from '@/components/layout/AppLayout';
import toast from 'react-hot-toast';
import { Wifi, Upload, Phone, Palette, Type, Check } from 'lucide-react';

const PRESET_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#d97706', '#16a34a', '#0d9488', '#0891b2', '#4f46e5', '#1f2937', '#475569'];

export default function AppearancePage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['branding-edit'], queryFn: getBranding });

  const [color, setColor] = useState('#2563eb');
  const [font, setFont] = useState('default');
  const [logo, setLogo] = useState<string | null>(null);
  const [support, setSupport] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!data) return;
    setColor(data.themeColor || '#2563eb');
    setFont(data.fontFamily || 'default');
    setLogo(data.logoUrl || null);
    setSupport(data.supportPhone || data.signupPhone || '');
  }, [data]);

  const save = useMutation({
    mutationFn: () => saveBranding({ themeColor: color, fontFamily: font, logoUrl: logo, supportPhone: support.trim() }),
    onSuccess: () => {
      toast.success('Appearance saved');
      qc.invalidateQueries({ queryKey: ['branding-theme'] });
      qc.invalidateQueries({ queryKey: ['branding-edit'] });
      qc.invalidateQueries({ queryKey: ['tenant-info-brand'] });
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to save'),
  });

  const onPickLogo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast.error('Please choose an image file');
    if (file.size > 1024 * 1024) return toast.error('Image must be under 1 MB');
    const reader = new FileReader();
    reader.onload = () => {
      // Downscale to a square ~256px to keep the stored data URL small.
      const img = new Image();
      img.onload = () => {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) { setLogo(reader.result as string); return; }
        // cover-crop to square
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2, sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        setLogo(canvas.toDataURL('image/png'));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  return (
    <AppLayout>
      <div className="max-w-2xl space-y-6">
        <div>
          <h1 className="text-xl font-bold">Appearance</h1>
          <p className="text-sm text-gray-500 mt-1">Customize how your portal looks to you and your customers.</p>
        </div>

        {isLoading ? (
          <div className="card p-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : (
          <>
            {/* Logo */}
            <div className="card p-5">
              <h2 className="font-semibold flex items-center gap-2 mb-1"><Upload size={16} /> Logo</h2>
              <p className="text-sm text-gray-500 mb-4">A square image works best. Used on your portals in place of the default icon.</p>
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center overflow-hidden shrink-0 shadow-lg" style={{ background: color }}>
                  {logo ? <img src={logo} alt="logo" className="w-full h-full object-cover" /> : <Wifi size={30} className="text-white" />}
                </div>
                <div className="flex flex-col gap-2">
                  <input ref={fileRef} type="file" accept="image/*" onChange={onPickLogo} className="hidden" />
                  <button onClick={() => fileRef.current?.click()} className="btn-secondary text-sm">Choose image</button>
                  {logo && <button onClick={() => setLogo(null)} className="text-xs text-red-500 hover:underline text-left">Remove logo</button>}
                </div>
              </div>
            </div>

            {/* Theme colour */}
            <div className="card p-5">
              <h2 className="font-semibold flex items-center gap-2 mb-1"><Palette size={16} /> Theme colour</h2>
              <p className="text-sm text-gray-500 mb-4">Replaces the default blue across your portal.</p>
              <div className="flex flex-wrap gap-2 mb-4">
                {PRESET_COLORS.map(c => (
                  <button key={c} onClick={() => setColor(c)}
                    className="w-9 h-9 rounded-full border-2 flex items-center justify-center transition"
                    style={{ background: c, borderColor: color.toLowerCase() === c.toLowerCase() ? '#fff' : 'transparent', boxShadow: color.toLowerCase() === c.toLowerCase() ? `0 0 0 2px ${c}` : 'none' }}>
                    {color.toLowerCase() === c.toLowerCase() && <Check size={16} className="text-white" />}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <input type="color" value={color} onChange={e => setColor(e.target.value)} className="w-10 h-10 rounded cursor-pointer bg-transparent border border-gray-300 dark:border-gray-700" />
                <input type="text" value={color} onChange={e => setColor(e.target.value)} className="input max-w-[140px] font-mono" placeholder="#2563eb" />
              </div>
            </div>

            {/* Font */}
            <div className="card p-5">
              <h2 className="font-semibold flex items-center gap-2 mb-1"><Type size={16} /> Font style</h2>
              <p className="text-sm text-gray-500 mb-4">Applied across your portal text.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {FONT_OPTIONS.map(f => (
                  <button key={f.key} onClick={() => setFont(f.key)}
                    className={`text-left px-4 py-3 rounded-lg border transition ${font === f.key ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'}`}
                    style={{ fontFamily: f.stack }}>
                    <div className="text-sm font-semibold">{f.label}</div>
                    <div className="text-xs text-gray-500">The quick brown fox</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Support number */}
            <div className="card p-5">
              <h2 className="font-semibold flex items-center gap-2 mb-1"><Phone size={16} /> Support number</h2>
              <p className="text-sm text-gray-500 mb-4">Shown on your customer portal and hotspot page. Tapping it on a phone starts a call. Defaults to your sign-up number.</p>
              <input type="tel" value={support} onChange={e => setSupport(e.target.value)} className="input max-w-xs" placeholder="07XX XXX XXX" />
              {data?.signupPhone && support !== data.signupPhone && (
                <button onClick={() => setSupport(data.signupPhone)} className="block mt-2 text-xs text-blue-600 hover:underline">
                  Use sign-up number ({data.signupPhone})
                </button>
              )}
            </div>

            <div className="flex justify-end">
              <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary">
                {save.isPending ? 'Saving…' : 'Save appearance'}
              </button>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
