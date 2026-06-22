'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { login, portalLogin, resolveSubdomain, tenantSubdomainFromHost, forgotPassword, resetPasswordWithCode } from '@/lib/api';
import toast from 'react-hot-toast';
import { Zap, Wifi, Eye, EyeOff, ArrowRight } from 'lucide-react';
import Link from 'next/link';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [brand, setBrand] = useState<{ name: string } | null>(null);
  const { setAuth } = useAuth();
  const router = useRouter();

  // The themed /portal is now the single login entry for both staff and customers. On a tenant
  // subdomain, send /auth/login there. (Apex/superadmin keeps this page.)
  const [redirecting, setRedirecting] = useState(false);
  const [fpOpen, setFpOpen] = useState(false);
  const [fpStep, setFpStep] = useState(1);
  const [fpId, setFpId] = useState('');
  const [fpCode, setFpCode] = useState('');
  const [fpNew, setFpNew] = useState('');
  const [fpLoading, setFpLoading] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (tenantSubdomainFromHost()) {
      setRedirecting(true);
      window.location.replace('/portal');
    }
  }, []);

  // On a tenant subdomain, brand the page with the ISP's name (wifi icon placeholder).
  useEffect(() => {
    const sub = tenantSubdomainFromHost();
    if (!sub) return;
    resolveSubdomain(sub).then(r => { if (r.valid && r.name) setBrand({ name: r.name }); }).catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return toast.error('Please enter your login and password');
    setLoading(true);
    try {
      // One login box for everyone. Try the business/admin login first; if these credentials
      // aren't an admin, fall back to the customer (subscriber) portal login. Role/όoutcome
      // decides which portal opens.
      let adminData: { user: { id: string; email: string; name: string; role: string; tenantId?: string }; token: string; subdomain?: string } | null = null;
      try {
        adminData = await login(email, password);
      } catch {
        adminData = null;
      }

      if (adminData) {
        setAuth(adminData.user, adminData.token);
        if (adminData.subdomain) { try { localStorage.setItem('dartbit_subdomain', adminData.subdomain); } catch {} }
        toast.success(`Welcome back, ${adminData.user.name}!`);
        const base = process.env.NEXT_PUBLIC_PORTAL_BASE_DOMAIN;
        if (base && adminData.subdomain && typeof window !== 'undefined') {
          const host = window.location.hostname;
          const expected = `${adminData.subdomain}.${base}`;
          if (host !== expected) { window.location.href = `https://${expected}/dashboard`; return; }
        }
        router.push('/dashboard');
        return;
      }

      // Not an admin — try the customer portal login (username + password).
      try {
        const res = await portalLogin(email, password);
        const tok = res?.token || res?.data?.token;
        if (tok) {
          try { sessionStorage.setItem('dartbit_portal_token', tok); } catch {}
          router.push('/portal');
          return;
        }
      } catch { /* fall through to error */ }

      toast.error('Invalid credentials');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Invalid credentials';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  if (redirecting) return <div className="min-h-screen bg-gray-950" />;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 p-4">
      <div className="w-full max-w-sm">

        {/* Logo / branding */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-600/30">
            {brand ? <Wifi size={28} className="text-white" /> : <Zap size={28} className="text-white" />}
          </div>
          <h1 className="text-2xl font-bold text-white">{brand ? brand.name : 'Dartbit'}</h1>
          <p className="text-gray-400 mt-1 text-sm">{brand ? 'Customer & business portal' : 'ISP Management Platform'}</p>
        </div>

        {/* Card */}
        <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 shadow-xl">
          <h2 className="text-base font-semibold text-white mb-5">Sign in to your account</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">Email or username</label>
              <input
                type="text" value={email} onChange={e => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-700 rounded-lg bg-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                placeholder="you@company.com or your username" required autoFocus
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                  className="w-full px-3 py-2.5 border border-gray-700 rounded-lg bg-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm pr-10"
                  placeholder="••••••••" required
                />
                <button type="button" onClick={() => setShowPassword(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors">
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <div className="text-right mt-1.5">
                <button type="button" onClick={() => { setFpId(email); setFpStep(1); setFpOpen(true); }}
                  className="text-xs text-blue-400 hover:text-blue-300">Forgot password?</button>
              </div>
            </div>

            <button type="submit" disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50 text-sm flex items-center justify-center gap-2 mt-2">
              {loading ? 'Signing in...' : <><span>Sign in</span><ArrowRight size={15} /></>}
            </button>
          </form>
        </div>

        {/* Signup CTA — only on the apex (new ISPs), not on a tenant portal */}
        {!brand && (
          <div className="mt-5 text-center">
            <p className="text-sm text-gray-500">
              Don&apos;t have an account?{' '}
              <Link href="/signup" className="text-blue-400 hover:text-blue-300 font-medium transition-colors">
                Start free trial
              </Link>
            </p>
          </div>
        )}

      </div>

      {fpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setFpOpen(false)}>
          <div className="w-full max-w-sm rounded-xl bg-gray-900 border border-gray-700 p-5" onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-semibold mb-1">Reset password</h3>
            {fpStep === 1 ? (
              <>
                <p className="text-xs text-gray-400 mb-3">Enter your email (staff) or username (customer). We&apos;ll text a reset code to the phone on file.</p>
                <input value={fpId} onChange={e => setFpId(e.target.value)} placeholder="Email or username"
                  className="w-full px-3 py-2 mb-3 border border-gray-700 rounded-lg bg-gray-800 text-white text-sm" />
                <button type="button" disabled={fpLoading || !fpId} onClick={async () => {
                  setFpLoading(true);
                  try {
                    await forgotPassword(fpId.includes('@') ? 'STAFF' : 'CUSTOMER', fpId.trim());
                    toast.success('If the account exists, a code was sent by SMS.');
                    setFpStep(2);
                  } catch { toast.error('Could not send code'); } finally { setFpLoading(false); }
                }} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg text-sm disabled:opacity-50">
                  {fpLoading ? 'Sending…' : 'Send code'}
                </button>
              </>
            ) : (
              <>
                <p className="text-xs text-gray-400 mb-3">Enter the 6-digit code from the SMS and your new password.</p>
                <input value={fpCode} onChange={e => setFpCode(e.target.value)} placeholder="6-digit code" inputMode="numeric"
                  className="w-full px-3 py-2 mb-2 border border-gray-700 rounded-lg bg-gray-800 text-white text-sm" />
                <input value={fpNew} onChange={e => setFpNew(e.target.value)} type="password" placeholder="New password (min 6)"
                  className="w-full px-3 py-2 mb-3 border border-gray-700 rounded-lg bg-gray-800 text-white text-sm" />
                <button type="button" disabled={fpLoading || fpCode.length < 4 || fpNew.length < 6} onClick={async () => {
                  setFpLoading(true);
                  try {
                    await resetPasswordWithCode(fpId.includes('@') ? 'STAFF' : 'CUSTOMER', fpId.trim(), fpCode.trim(), fpNew);
                    toast.success('Password changed — sign in with your new password.');
                    setFpOpen(false); setFpCode(''); setFpNew('');
                  } catch (e) { const err = e as { response?: { data?: { error?: string } } }; toast.error(err?.response?.data?.error || 'Invalid or expired code'); } finally { setFpLoading(false); }
                }} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg text-sm disabled:opacity-50">
                  {fpLoading ? 'Saving…' : 'Set new password'}
                </button>
                <button type="button" onClick={() => setFpStep(1)} className="w-full text-xs text-gray-400 hover:text-gray-200 mt-2">Back</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
