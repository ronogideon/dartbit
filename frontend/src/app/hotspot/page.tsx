'use client';
import { useEffect, useState } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Wifi, Zap } from 'lucide-react';

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

export default function HotspotPage() {
  const [packages, setPackages] = useState<Package[]>([]);
  const [selected, setSelected] = useState<Package | null>(null);
  const [form, setForm] = useState({ username: '', password: '', tenantId: '' });
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'browse' | 'login' | 'success'>('browse');

  useEffect(() => {
    api.get('/packages').then(r => {
      const hotspot = (r.data.data as Package[]).filter(p => p.service === 'HOTSPOT');
      setPackages(hotspot);
    }).catch(() => setPackages([]));
  }, []);

  const handlePurchase = (pkg: Package) => { setSelected(pkg); setStep('login'); };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/auth/subscriber-login', { username: form.username, password: form.password, tenantId: form.tenantId });
      setStep('success');
      toast.success('Connected!');
    } catch {
      toast.error('Invalid credentials. Please contact your ISP.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-950 via-gray-900 to-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-600/30">
            <Wifi size={32} className="text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white">Welcome</h1>
          <p className="text-gray-400 mt-2">Connect to the internet in seconds</p>
        </div>

        {step === 'browse' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-white text-center mb-4">Choose a Package</h2>
            {packages.length === 0 ? (
              <div className="card p-8 text-center bg-gray-900/60 border-gray-800">
                <p className="text-gray-400">No hotspot packages available</p>
              </div>
            ) : packages.map(pkg => (
              <div key={pkg.id} className="card p-5 bg-gray-900/60 border-gray-700 hover:border-blue-500 cursor-pointer transition-all group" onClick={() => handlePurchase(pkg)}>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-white group-hover:text-blue-400 transition-colors">{pkg.name}</h3>
                    <p className="text-sm text-gray-400 mt-1">{(pkg.speedDownKbps / 1024).toFixed(0)} Mbps • {formatValidity(pkg.validityMinutes)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-bold text-blue-400">KES {pkg.price.toLocaleString()}</p>
                    <button className="mt-2 text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">Connect</button>
                  </div>
                </div>
              </div>
            ))}
            <div className="text-center pt-2">
              <p className="text-xs text-gray-500">Already have an account? <button onClick={() => setStep('login')} className="text-blue-400 hover:underline">Login here</button></p>
            </div>
          </div>
        )}

        {step === 'login' && (
          <div className="card p-6 bg-gray-900/60 border-gray-800">
            {selected && (
              <div className="mb-5 p-3 bg-blue-600/20 border border-blue-600/30 rounded-lg">
                <p className="text-sm text-blue-300 font-medium">Selected: {selected.name}</p>
                <p className="text-xs text-blue-400">KES {selected.price.toLocaleString()} • {formatValidity(selected.validityMinutes)}</p>
              </div>
            )}
            <h2 className="text-lg font-semibold text-white mb-4">Enter your credentials</h2>
            <form onSubmit={handleConnect} className="space-y-4">
              <div>
                <label className="label text-gray-300">Tenant / ISP ID</label>
                <input className="input bg-gray-800 border-gray-700 text-white" value={form.tenantId} onChange={e => setForm(f => ({ ...f, tenantId: e.target.value }))} placeholder="Provided by your ISP" required />
              </div>
              <div>
                <label className="label text-gray-300">Username</label>
                <input className="input bg-gray-800 border-gray-700 text-white" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} required />
              </div>
              <div>
                <label className="label text-gray-300">Password</label>
                <input className="input bg-gray-800 border-gray-700 text-white" type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required />
              </div>
              <button type="submit" disabled={loading} className="btn-primary w-full">{loading ? 'Connecting...' : 'Connect'}</button>
              <button type="button" onClick={() => setStep('browse')} className="btn-secondary w-full">Back to Packages</button>
            </form>
          </div>
        )}

        {step === 'success' && (
          <div className="card p-8 text-center bg-gray-900/60 border-gray-800">
            <div className="w-16 h-16 bg-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <Zap size={32} className="text-white" />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Connected!</h2>
            <p className="text-gray-400 text-sm">Enjoy your internet access.</p>
            {selected && <p className="text-xs text-gray-500 mt-2">Package: {selected.name} • {formatValidity(selected.validityMinutes)}</p>}
            <button onClick={() => setStep('browse')} className="btn-secondary mt-6">Back to Packages</button>
          </div>
        )}
      </div>
    </div>
  );
}
