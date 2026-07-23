'use client';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { login, resetSessionLock } from '@/lib/api';
import { Lock, Zap } from 'lucide-react';

// Mounted once, globally, in layout.tsx. Listens for the 'dartbit:session-expired' event fired by
// the api.ts response interceptor on any 401. When it fires, the ENTIRE app is blocked behind a
// full-screen overlay — no tab, button, or background request can do anything — until the person
// signs back in here. A full page reload on success guarantees no stale, pre-expiry state survives.
export default function SessionExpiredLock() {
  const [locked, setLocked] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onExpired = () => setLocked(true);
    window.addEventListener('dartbit:session-expired', onExpired);
    return () => window.removeEventListener('dartbit:session-expired', onExpired);
  }, []);

  if (!locked) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const data = await login(email, password);
      if (data.user.role !== 'SUPERADMIN' && data.user.role !== 'SUPERADMIN_VIEWER') {
        toast.error('This account is not a superadmin');
        setLoading(false);
        return;
      }
      localStorage.setItem('dartbit_sa_token', data.token);
      localStorage.setItem('dartbit_sa_role', data.user.role);
      resetSessionLock();
      toast.success('Signed back in');
      // Full reload: every query/mutation re-runs fresh against the new token, and no data or
      // in-flight request from the expired session can leak through.
      window.location.reload();
    } catch (err) {
      const e2 = err as { response?: { status?: number; data?: { error?: string } }; message?: string };
      if (e2.response?.status === 401) toast.error('Invalid email or password');
      else toast.error(e2.response?.data?.error || 'Could not sign in — check your connection');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[3000] bg-gray-950/97 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-14 h-14 bg-red-600/20 border border-red-700 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Lock size={26} className="text-red-400" />
          </div>
          <h1 className="text-xl font-bold text-white">Session expired</h1>
          <p className="text-sm text-gray-400 mt-1.5 max-w-xs mx-auto">
            For your security, you&apos;ve been signed out. Sign back in to continue — nothing you were doing has been lost.
          </p>
        </div>
        <form onSubmit={submit} className="bg-gray-900 rounded-2xl p-6 border border-gray-800 shadow-2xl">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
              <Zap size={14} className="text-white" />
            </div>
            <span className="font-semibold text-white text-sm">Dartbit Superadmin</span>
          </div>
          <label className="block text-sm font-medium text-gray-300 mb-1.5">Email</label>
          <input className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white mb-3"
            value={email} onChange={e => setEmail(e.target.value)} autoFocus />
          <label className="block text-sm font-medium text-gray-300 mb-1.5">Password</label>
          <input type="password" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white mb-4"
            value={password} onChange={e => setPassword(e.target.value)} />
          <button disabled={loading || !email || !password}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2.5 font-medium disabled:opacity-50">
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
