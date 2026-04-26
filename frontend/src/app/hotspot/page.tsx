'use client';
import { useEffect, useState } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Wifi, Zap, Check } from 'lucide-react';

interface Package {
  id: string; name: string; service: string; speedDownKbps: number;
  speedUpKbps: number; validityMinutes: number; price: number;
}

function formatValidity(mins: number) {
  if (mins >= 43200) return `${Math.floor(mins / 43200)} month(s)`;
  if (mins >= 1440) return `${Math.floor(mins / 1440)} day(s)`;
  if (mins >= 60) return `${Math.floor(mins / 60)} hour(s)`;
  return `${mins} min`;
}

function formatSpeed(kbps: number) {
  return kbps >= 1024 ? `${(kbps / 1024).toFixed(0)} Mbps` : `${kbps} Kbps`;
}

export default function HotspotPage() {
  const [packages, setPackages] = useState<Package[]>([]);
  const [selected, setSelected] = useState<Package | null>(null);
  const [form, setForm] = useState({ username: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'browse' | 'login' | 'success'>('browse');

  // MikroTik passes these as query params to the hotspot login page
  const [hsParams, setHsParams] = useState({ mac: '', ip: '', username: '', linkLogin: '', linkOrig: '', error: '' });

  useEffect(() => {
    // Parse MikroTik hotspot query parameters
    const params = new URLSearchParams(window.location.search);
    setHsParams({
      mac: params.get('mac') || '',
      ip: params.get('ip') || '',
      username: params.get('username') || '',
      linkLogin: params.get('link-login') || params.get('linkLogin') || '',
      linkOrig: params.get('link-orig') || params.get('linkOrig') || '',
      error: params.get('error') || '',
    });

    // Pre-fill username if passed by MikroTik
    if (params.get('username')) {
      setForm(f => ({ ...f, username: params.get('username') || '' }));
    }

    // If there's a MAC/IP from MikroTik, go straight to login
    if (params.get('mac') || params.get('ip')) {
      setStep('login');
    }

    // Load hotspot packages
    api.get('/packages').then(r => {
      const hotspot = (r.data.data as Package[]).filter(p => p.service === 'HOTSPOT');
      setPackages(hotspot);
    }).catch(() => setPackages([]));
  }, []);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      // Try to authenticate via Dartbit backend
      // In a real MikroTik hotspot setup, this would POST to the MikroTik login URL
      // For now we validate credentials via Dartbit
      const res = await api.post('/auth/subscriber-login-hotspot', {
        username: form.username,
        password: form.password,
        mac: hsParams.mac,
        ip: hsParams.ip,
      });

      if (res.data.success) {
        setStep('success');
        toast.success('Connected!');

        // If MikroTik provided a login link, redirect to it for actual hotspot auth
        if (hsParams.linkLogin) {
          const loginUrl = `${hsParams.linkLogin}?username=${encodeURIComponent(form.username)}&password=${encodeURIComponent(form.password)}`;
          setTimeout(() => { window.location.href = loginUrl; }, 1500);
        }
      } else {
        toast.error('Invalid credentials');
      }
    } catch {
      toast.error('Invalid username or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-950 via-gray-900 to-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-600/30">
            <Wifi size={32} className="text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white">Wi-Fi Login</h1>
          <p className="text-gray-400 mt-2 text-sm">Connect to the internet</p>
          {hsParams.error && (
            <div className="mt-3 bg-red-900/30 border border-red-700 rounded-lg px-4 py-2">
              <p className="text-red-400 text-sm">Authentication failed. Please try again.</p>
            </div>
          )}
        </div>

        {/* Browse Packages */}
        {step === 'browse' && (
          <div className="space-y-3">
            <h2 className="text-base font-semibold text-white text-center mb-4">Choose a Package</h2>
            {packages.length === 0 ? (
              <div className="card p-6 text-center bg-gray-900/60 border-gray-700">
                <p className="text-gray-400 text-sm">Contact the network administrator for access credentials.</p>
                <button onClick={() => setStep('login')} className="btn-primary mt-4 w-full">I have credentials</button>
              </div>
            ) : packages.map(pkg => (
              <div key={pkg.id}
                className="card p-4 bg-gray-900/60 border-gray-700 hover:border-blue-500 cursor-pointer transition-all group"
                onClick={() => { setSelected(pkg); setStep('login'); }}>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-white group-hover:text-blue-400 transition-colors">{pkg.name}</h3>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-xs text-gray-400">↓ {formatSpeed(pkg.speedDownKbps)}</span>
                      <span className="text-xs text-gray-400">↑ {formatSpeed(pkg.speedUpKbps)}</span>
                      <span className="text-xs text-gray-400">{formatValidity(pkg.validityMinutes)}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-lg font-bold text-blue-400">KES {pkg.price.toLocaleString()}</p>
                    <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded-full">Select</span>
                  </div>
                </div>
              </div>
            ))}
            <p className="text-center text-xs text-gray-500 mt-4">
              Already subscribed?{' '}
              <button onClick={() => setStep('login')} className="text-blue-400 hover:underline">Login here</button>
            </p>
          </div>
        )}

        {/* Login Form */}
        {step === 'login' && (
          <div className="card p-6 bg-gray-900/60 border-gray-800">
            {selected && (
              <div className="mb-4 p-3 bg-blue-600/20 border border-blue-600/30 rounded-lg">
                <p className="text-sm text-blue-300 font-medium">{selected.name}</p>
                <p className="text-xs text-blue-400 mt-0.5">
                  KES {selected.price} • {formatValidity(selected.validityMinutes)} •{' '}
                  {formatSpeed(selected.speedDownKbps)} down
                </p>
              </div>
            )}

            {hsParams.mac && (
              <div className="mb-4 p-2 bg-gray-800 rounded text-xs text-gray-400 font-mono">
                Device: {hsParams.mac} {hsParams.ip ? `• ${hsParams.ip}` : ''}
              </div>
            )}

            <h2 className="text-base font-semibold text-white mb-4">Enter your credentials</h2>
            <form onSubmit={handleConnect} className="space-y-3">
              <div>
                <label className="label text-gray-300 text-sm">Username</label>
                <input className="input bg-gray-800 border-gray-700 text-white"
                  value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  placeholder="your.username" required autoFocus />
              </div>
              <div>
                <label className="label text-gray-300 text-sm">Password</label>
                <input className="input bg-gray-800 border-gray-700 text-white"
                  type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="••••••••" required />
              </div>
              <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
                {loading ? 'Connecting...' : 'Connect to Internet'}
              </button>
              {packages.length > 0 && (
                <button type="button" onClick={() => { setStep('browse'); setSelected(null); }} className="btn-secondary w-full text-sm">
                  View Packages
                </button>
              )}
            </form>
          </div>
        )}

        {/* Success */}
        {step === 'success' && (
          <div className="card p-8 text-center bg-gray-900/60 border-gray-800">
            <div className="w-16 h-16 bg-green-600 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg shadow-green-600/30">
              <Check size={32} className="text-white" />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">You&apos;re Connected!</h2>
            <p className="text-gray-400 text-sm mb-1">Welcome, {form.username}</p>
            {selected && (
              <p className="text-xs text-gray-500">
                {selected.name} • Valid for {formatValidity(selected.validityMinutes)}
              </p>
            )}
            <div className="mt-6 flex items-center justify-center gap-2 text-green-400">
              <Zap size={16} />
              <span className="text-sm font-medium">Internet access granted</span>
            </div>
          </div>
        )}

        <p className="text-center text-xs text-gray-600 mt-6">Powered by Dartbit ISP Platform</p>
      </div>
    </div>
  );
}
