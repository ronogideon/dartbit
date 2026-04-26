'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { login } from '@/lib/api';
import toast from 'react-hot-toast';
import { Zap } from 'lucide-react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuth();
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const data = await login(email, password);
      setAuth(data.user, data.token);
      toast.success('Welcome back!');
      router.push('/dashboard');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Login failed';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Zap size={24} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">Dartbit</h1>
          <p className="text-gray-400 mt-1 text-sm">ISP Management Platform</p>
        </div>

        <div className="card p-6 bg-gray-900 border-gray-800">
          <h2 className="text-lg font-semibold text-white mb-6">Sign in to your account</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label text-gray-300">Email</label>
              <input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                className="input bg-gray-800 border-gray-700 text-white"
                placeholder="admin@example.com" required
              />
            </div>
            <div>
              <label className="label text-gray-300">Password</label>
              <input
                type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                className="input bg-gray-800 border-gray-700 text-white"
                placeholder="••••••••" required
              />
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
          <div className="mt-4 p-3 bg-gray-800 rounded-lg">
            <p className="text-xs text-gray-400 font-medium mb-1">Demo credentials:</p>
            <p className="text-xs text-gray-400">Admin: admin@demoisp.com / Test12345</p>
            <p className="text-xs text-gray-400">Super: superadmin@dartbit.local / SuperAdmin123!</p>
          </div>
        </div>
      </div>
    </div>
  );
}
