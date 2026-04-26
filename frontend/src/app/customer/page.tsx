'use client';
import { useState } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Zap, Wifi, Calendar, Package } from 'lucide-react';

interface Subscriber {
  id: string; username: string; fullName: string; isActive: boolean;
  expiresAt?: string; service: string;
  package?: { name: string; speedDownKbps: number; speedUpKbps: number; validityMinutes: number; price: number };
}

export default function CustomerPortal() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.post('/auth/subscriber-login', { username, password, tenantId });
      setSubscriber(res.data.data.subscriber);
      setToken(res.data.data.token);
      toast.success('Logged in!');
    } catch {
      toast.error('Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  const handleRenew = async () => {
    if (!subscriber?.package) return toast.error('No package assigned');
    try {
      await api.post('/payments', {
        subscriberId: subscriber.id,
        amount: subscriber.package.price,
        method: 'MANUAL',
        notes: 'Self-service renewal',
      }, { headers: { Authorization: `Bearer ${token}` } });
      toast.success('Renewal request submitted!');
    } catch {
      toast.error('Renewal failed. Please contact support.');
    }
  };

  const expired = subscriber?.expiresAt ? new Date(subscriber.expiresAt) < new Date() : false;

  if (!subscriber) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Zap size={24} className="text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white">Customer Portal</h1>
            <p className="text-gray-400 mt-1 text-sm">Login to manage your subscription</p>
          </div>
          <div className="card p-6 bg-gray-900 border-gray-800">
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="label text-gray-300">Tenant ID</label>
                <input className="input bg-gray-800 border-gray-700 text-white" value={tenantId} onChange={e => setTenantId(e.target.value)} placeholder="Your ISP tenant ID" required />
              </div>
              <div>
                <label className="label text-gray-300">Username</label>
                <input className="input bg-gray-800 border-gray-700 text-white" value={username} onChange={e => setUsername(e.target.value)} required />
              </div>
              <div>
                <label className="label text-gray-300">Password</label>
                <input className="input bg-gray-800 border-gray-700 text-white" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
              </div>
              <button type="submit" disabled={loading} className="btn-primary w-full">
                {loading ? 'Logging in...' : 'Login'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <Zap size={24} className="text-white" />
          </div>
          <h1 className="text-xl font-bold text-white">Welcome, {subscriber.fullName}</h1>
        </div>

        <div className="card p-6 bg-gray-900 border-gray-800 space-y-4">
          <div className="flex items-center justify-between p-4 bg-gray-800 rounded-lg">
            <div className="flex items-center gap-3">
              <Wifi size={20} className="text-blue-400" />
              <div>
                <p className="text-sm font-medium text-white">Connection Status</p>
                <p className="text-xs text-gray-400">{subscriber.service}</p>
              </div>
            </div>
            <span className={subscriber.isActive && !expired ? 'badge-green' : 'badge-red'}>
              {expired ? 'Expired' : subscriber.isActive ? 'Active' : 'Inactive'}
            </span>
          </div>

          {subscriber.package && (
            <div className="flex items-center gap-3 p-4 bg-gray-800 rounded-lg">
              <Package size={20} className="text-purple-400" />
              <div>
                <p className="text-sm font-medium text-white">{subscriber.package.name}</p>
                <p className="text-xs text-gray-400">
                  ↑ {(subscriber.package.speedUpKbps / 1024).toFixed(0)} Mbps / ↓ {(subscriber.package.speedDownKbps / 1024).toFixed(0)} Mbps
                </p>
              </div>
            </div>
          )}

          {subscriber.expiresAt && (
            <div className="flex items-center gap-3 p-4 bg-gray-800 rounded-lg">
              <Calendar size={20} className={expired ? 'text-red-400' : 'text-green-400'} />
              <div>
                <p className="text-sm font-medium text-white">Expiry Date</p>
                <p className="text-xs text-gray-400">{new Date(subscriber.expiresAt).toLocaleDateString('en-KE', { dateStyle: 'full' })}</p>
              </div>
            </div>
          )}

          <div className="pt-2 space-y-2">
            <button onClick={handleRenew} className="btn-primary w-full">
              Renew Subscription {subscriber.package ? `— KES ${subscriber.package.price.toLocaleString()}` : ''}
            </button>
            <button onClick={() => setSubscriber(null)} className="btn-secondary w-full">Logout</button>
          </div>
        </div>
      </div>
    </div>
  );
}
