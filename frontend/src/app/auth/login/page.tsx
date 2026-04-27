'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { login } from '@/lib/api';
import toast from 'react-hot-toast';
<<<<<<< HEAD
import { Zap, Eye, EyeOff } from 'lucide-react';
=======
import { Zap } from 'lucide-react';
>>>>>>> aec8eb59fae5ddb9c2b5bdbd861d15f5e7b7c253

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
<<<<<<< HEAD
  const [showPassword, setShowPassword] = useState(false);
=======
>>>>>>> aec8eb59fae5ddb9c2b5bdbd861d15f5e7b7c253
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuth();
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
<<<<<<< HEAD
    if (!email || !password) return toast.error('Please enter email and password');
=======
>>>>>>> aec8eb59fae5ddb9c2b5bdbd861d15f5e7b7c253
    setLoading(true);
    try {
      const data = await login(email, password);
      setAuth(data.user, data.token);
<<<<<<< HEAD
      toast.success(`Welcome back, ${data.user.name}!`);
      router.push('/dashboard');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Invalid email or password';
=======
      toast.success('Welcome back!');
      router.push('/dashboard');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Login failed';
>>>>>>> aec8eb59fae5ddb9c2b5bdbd861d15f5e7b7c253
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

<<<<<<< HEAD
  const fillDemo = (email: string, password: string) => {
    setEmail(email);
    setPassword(password);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-600/30">
            <Zap size={28} className="text-white" />
=======
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Zap size={24} className="text-white" />
>>>>>>> aec8eb59fae5ddb9c2b5bdbd861d15f5e7b7c253
          </div>
          <h1 className="text-2xl font-bold text-white">Dartbit</h1>
          <p className="text-gray-400 mt-1 text-sm">ISP Management Platform</p>
        </div>

<<<<<<< HEAD
        {/* Card */}
        <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 shadow-xl">
          <h2 className="text-base font-semibold text-white mb-5">Sign in to your account</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Email</label>
              <input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-700 rounded-lg bg-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                placeholder="admin@example.com" required autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2.5 border border-gray-700 rounded-lg bg-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm pr-10"
                  placeholder="••••••••" required
                />
                <button type="button" onClick={() => setShowPassword(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <button type="submit" disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50 text-sm mt-2">
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          {/* Demo credentials */}
          <div className="mt-5 pt-5 border-t border-gray-800">
            <p className="text-xs font-medium text-gray-500 mb-3 uppercase tracking-wide">Quick Login (Demo)</p>
            <div className="space-y-2">
              <button onClick={() => fillDemo('admin@demoisp.com', 'Test12345')}
                className="w-full text-left px-3 py-2.5 rounded-lg bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-blue-600 transition-all group">
                <p className="text-xs font-semibold text-blue-400 group-hover:text-blue-300">Tenant Admin</p>
                <p className="text-xs text-gray-400 mt-0.5">admin@demoisp.com / Test12345</p>
              </button>
              <button onClick={() => fillDemo('superadmin@dartbit.local', 'SuperAdmin123!')}
                className="w-full text-left px-3 py-2.5 rounded-lg bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-purple-600 transition-all group">
                <p className="text-xs font-semibold text-purple-400 group-hover:text-purple-300">Superadmin</p>
                <p className="text-xs text-gray-400 mt-0.5">superadmin@dartbit.local / SuperAdmin123!</p>
              </button>
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-gray-600 mt-6">
          Dartbit v1.1.4 — ISP Management Platform
        </p>
=======
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
>>>>>>> aec8eb59fae5ddb9c2b5bdbd861d15f5e7b7c253
      </div>
    </div>
  );
}
