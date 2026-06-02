'use client';
import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { HexColorPicker } from 'react-colorful';
import { getBranding, saveBranding } from '@/lib/api';
import { FONT_OPTIONS, fontStack } from '@/lib/fonts';
import AppLayout from '@/components/layout/AppLayout';
import toast from 'react-hot-toast';
import { Wifi, Upload, Palette, Type } from 'lucide-react';

export default function AppearancePage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['branding-edit'], queryFn: getBranding });

  const [color, setColor] = useState('#2563eb');
  const [font, setFont] = useState('default');
  const [logo, setLogo] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!data) return;
    setColor(data.themeColor || '#2563eb');
    setFont(data.fontFamily || 'default');
    setLogo(data.logoUrl || null);
  }, [data]);

  const save = useMutation({
    mutationFn: () => saveBranding({ themeColor: color, fontFamily: font, logoUrl: logo }),
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
      const img = new Image();
      img.onload = () => {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) { setLogo(reader.result as string); return; }
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2, sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        setLogo(canvas.toDataURL('image/png'));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const validHex = /^#[0-9a-fA-F]{6}$/.test(color);

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
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center overflow-hidden shrink-0 shadow-lg" style={{ background: validHex ? color : '#2563eb' }}>
                  {logo ? <img src={logo} alt="logo" className="w-full h-full object-cover" /> : <Wifi size={30} className="text-white" />}
                </div>
                <div className="flex flex-col gap-2">
                  <input ref={fileRef} type="file" accept="image/*" onChange={onPickLogo} className="hidden" />
                  <button onClick={() => fileRef.current?.click()} className="btn-secondary text-sm">Choose image</button>
                  {logo && <button onClick={() => setLogo(null)} className="text-xs text-red-500 hover:underline text-left">Remove logo</button>}
                </div>
              </div>
            </div>

            {/* Theme colour — colour wheel */}
            <div className="card p-5">
              <h2 className="font-semibold flex items-center gap-2 mb-1"><Palette size={16} /> Theme colour</h2>
              <p className="text-sm text-gray-500 mb-4">Pick any colour to replace the default blue across your portal.</p>
              <div className="flex flex-col sm:flex-row items-start gap-6">
                <div className="brand-wheel">
                  <HexColorPicker color={validHex ? color : '#2563eb'} onChange={setColor} />
                </div>
                <div className="flex-1 w-full">
                  <label className="label">Hex value</label>
                  <div className="flex items-center gap-2">
                    <span className="w-9 h-9 rounded-lg border border-gray-300 dark:border-gray-700 shrink-0" style={{ background: validHex ? color : '#2563eb' }} />
                    <input type="text" value={color} onChange={e => setColor(e.target.value)} className="input max-w-[150px] font-mono" placeholder="#2563eb" />
                  </div>
                  {!validHex && <p className="text-xs text-red-500 mt-1">Enter a valid hex like #2563eb</p>}
                  <div className="mt-4">
                    <div className="text-xs text-gray-500 mb-1">Preview</div>
                    <button className="text-white rounded-lg px-4 py-2 text-sm font-medium" style={{ background: validHex ? color : '#2563eb' }}>Primary button</button>
                  </div>
                </div>
              </div>
            </div>

            {/* Font — dropdown */}
            <div className="card p-5">
              <h2 className="font-semibold flex items-center gap-2 mb-1"><Type size={16} /> Font style</h2>
              <p className="text-sm text-gray-500 mb-4">Applied across your portal text.</p>
              <select value={font} onChange={e => setFont(e.target.value)} className="input max-w-xs" style={{ fontFamily: fontStack(font) }}>
                {FONT_OPTIONS.map(f => (
                  <option key={f.key} value={f.key} style={{ fontFamily: f.stack }}>{f.label}</option>
                ))}
              </select>
              <div className="mt-4 p-4 rounded-lg border border-gray-200 dark:border-gray-700" style={{ fontFamily: fontStack(font) }}>
                <div className="text-lg font-bold">{data?.name || 'Your ISP'}</div>
                <div className="text-sm text-gray-500">The quick brown fox jumps over the lazy dog — 1234567890</div>
              </div>
            </div>

            <div className="flex justify-end">
              <button onClick={() => save.mutate()} disabled={save.isPending || !validHex} className="btn-primary">
                {save.isPending ? 'Saving…' : 'Save appearance'}
              </button>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
