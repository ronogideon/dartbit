'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { login } from '@/lib/api';
import toast from 'react-hot-toast';
import { Zap, Eye, EyeOff, ArrowRight } from 'lucide-react';
import Link from 'next/link';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuth();
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return toast.error('Please enter email and password');
    setLoading(true);
    try {
      const data = await login(email, password);
      setAuth(data.user, data.token);
      toast.success(`Welcome back, ${data.user.name}!`);
      router.push('/dashboard');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Invalid email or password';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-gray-950">
      {/* Left — branding */}
      <div className="hidden lg:flex flex-col justify-between w-1/2 bg-gradient-to-br from-blue-950 via-blue-900 to-gray-900 p-12">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center">
            <Zap size={20} className="text-white" />
          </div>
          <span className="text-xl font-bold text-white">Dartbit</span>
        </div>
        <div>
          <h2 className="text-4xl font-bold text-white leading-tight mb-4">
            Manage your ISP<br />with confidence
          </h2>
          <p className="text-blue-300 text-lg mb-8">PPPoE, Hotspot, billing and MikroTik management — all in one platform.</p>
          <div className="space-y-3">
            {[
              'MikroTik zero-touch provisioning',
              'PPPoE & Hotspot subscriber management',
              'Automated billing & M-Pesa ready',
              'Live session monitoring',
              'Multi-tenant architecture',
            ].map(f => (
              <div key={f} className="flex items-center gap-3">
                <div className="w-5 h-5 rounded-full bg-blue-600/40 border border-blue-500 flex items-center justify-center shrink-0">
                  <div className="w-2 h-2 rounded-full bg-blue-400" />
                </div>
                <span className="text-blue-200 text-sm">{f}</span>
              </div>
            ))}
          </div>
        </div>
        <p className="text-blue-400 text-sm">© 2024 Dartbit. All rights reserved.</p>
      </div>

      {/* Right — login form */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="flex items-center gap-2 mb-8 lg:hidden">
            <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center">
              <Zap size={20} className="text-white" />
            </div>
            <span className="text-xl font-bold text-white">Dartbit</span>
          </div>

          <h1 className="text-2xl font-bold text-white mb-1">Sign in</h1>
          <p className="text-gray-400 text-sm mb-8">Welcome back to your ISP dashboard</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-700 rounded-lg bg-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                placeholder="admin@company.com" required autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">Password</label>
              <div className="relative">
                <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                  className="w-full px-3 py-2.5 border border-gray-700 rounded-lg bg-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm pr-10"
                  placeholder="••••••••" required />
                <button type="button" onClick={() => setShowPassword(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <button type="submit" disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50 text-sm flex items-center justify-center gap-2">
              {loading ? 'Signing in...' : <><span>Sign in</span><ArrowRight size={16} /></>}
            </button>
          </form>

          {/* Demo credentials */}
          <div className="mt-5 pt-5 border-t border-gray-800">
            <p className="text-xs font-medium text-gray-500 mb-3 uppercase tracking-wide">Quick Demo Login</p>
            <div className="space-y-2">
              <button onClick={() => { setEmail('admin@demoisp.com'); setPassword('Test12345'); }}
                className="w-full text-left px-3 py-2.5 rounded-lg bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-blue-600 transition-all group">
                <p className="text-xs font-semibold text-blue-400">Tenant Admin</p>
                <p className="text-xs text-gray-400 mt-0.5">admin@demoisp.com / Test12345</p>
              </button>
              <button onClick={() => { setEmail('superadmin@dartbit.local'); setPassword('SuperAdmin123!'); }}
                className="w-full text-left px-3 py-2.5 rounded-lg bg-gray-800 border border-gray-700 hover:border-purple-600 transition-all group">
                <p className="text-xs font-semibold text-purple-400">Superadmin</p>
                <p className="text-xs text-gray-400 mt-0.5">superadmin@dartbit.local / SuperAdmin123!</p>
              </button>
            </div>
          </div>

          {/* Signup CTA */}
          <div className="mt-6 p-4 bg-gradient-to-r from-blue-900/40 to-purple-900/40 border border-blue-800/50 rounded-xl text-center">
            <p className="text-sm text-white font-medium mb-1">New to Dartbit?</p>
            <p className="text-xs text-gray-400 mb-3">Start managing your ISP for free</p>
            <Link href="/signup"
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              Start 14-day free trial <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
