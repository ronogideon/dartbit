'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Zap, Eye, EyeOff, Check, X, ArrowRight, Loader2 } from 'lucide-react';
import Link from 'next/link';

interface SubdomainCheck { subdomain: string; available: boolean; }

export default function SignupPage() {
  const router = useRouter();
  const { setAuth } = useAuth();

  const [step, setStep] = useState<'details' | 'password' | 'done'>('details');
  const [loading, setLoading] = useState(false);
  const [checkingSubdomain, setCheckingSubdomain] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [subdomainInfo, setSubdomainInfo] = useState<SubdomainCheck | null>(null);

  const [form, setForm] = useState({
    companyName: '',
    email: '',
    phone: '',
    adminName: '',
    password: '',
    confirmPassword: '',
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  // Check subdomain availability as user types company name
  const checkSubdomain = useCallback(async (name: string) => {
    if (name.length < 2) { setSubdomainInfo(null); return; }
    setCheckingSubdomain(true);
    try {
      const res = await api.get(`/signup/check-subdomain?name=${encodeURIComponent(name)}`);
      setSubdomainInfo(res.data.data);
    } catch {
      setSubdomainInfo(null);
    } finally {
      setCheckingSubdomain(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (form.companyName) checkSubdomain(form.companyName);
    }, 500);
    return () => clearTimeout(timer);
  }, [form.companyName, checkSubdomain]);

  const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm(f => ({ ...f, [field]: e.target.value }));
    setErrors(err => ({ ...err, [field]: '' }));
  };

  const validateStep1 = () => {
    const e: Record<string, string> = {};
    if (!form.companyName.trim()) e.companyName = 'Company name is required';
    if (!form.adminName.trim()) e.adminName = 'Your name is required';
    if (!form.email.trim()) e.email = 'Email is required';
    else if (!/\S+@\S+\.\S+/.test(form.email)) e.email = 'Invalid email';
    if (!form.phone.trim()) e.phone = 'Phone number is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const validateStep2 = () => {
    const e: Record<string, string> = {};
    if (!form.password) e.password = 'Password is required';
    else if (form.password.length < 8) e.password = 'At least 8 characters';
    if (form.password !== form.confirmPassword) e.confirmPassword = 'Passwords do not match';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleStep1 = (e: React.FormEvent) => {
    e.preventDefault();
    if (validateStep1()) setStep('password');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateStep2()) return;
    setLoading(true);
    try {
      const res = await api.post('/signup', {
        companyName: form.companyName,
        email: form.email,
        phone: form.phone,
        adminName: form.adminName,
        password: form.password,
      });

      const { token, user, tenant } = res.data.data;
      setAuth(user, token);
      setStep('done');

      setTimeout(() => {
        toast.success(`Welcome to Dartbit, ${user.name}!`);
        router.push('/dashboard');
      }, 2000);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Signup failed';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const passwordStrength = (p: string) => {
    let score = 0;
    if (p.length >= 8) score++;
    if (/[A-Z]/.test(p)) score++;
    if (/[0-9]/.test(p)) score++;
    if (/[^A-Za-z0-9]/.test(p)) score++;
    return score;
  };
  const strength = passwordStrength(form.password);
  const strengthLabel = ['', 'Weak', 'Fair', 'Good', 'Strong'][strength];
  const strengthColor = ['', 'bg-red-500', 'bg-yellow-500', 'bg-blue-500', 'bg-green-500'][strength];

  if (step === 'done') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
        <div className="text-center">
          <div className="w-20 h-20 bg-green-600 rounded-full flex items-center justify-center mx-auto mb-6 shadow-lg shadow-green-600/30">
            <Check size={40} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">You&apos;re all set!</h1>
          <p className="text-gray-400">Setting up your dashboard...</p>
          <div className="mt-6 flex justify-center">
            <Loader2 size={24} className="text-blue-500 animate-spin" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-600/30">
            <Zap size={28} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">Start your free trial</h1>
          <p className="text-gray-400 mt-1 text-sm">14 days free • No credit card required</p>
        </div>

        {/* Progress */}
        <div className="flex items-center gap-2 mb-6">
          {['Company Details', 'Set Password'].map((label, i) => (
            <div key={label} className="flex items-center gap-2 flex-1">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors ${
                (i === 0 && step === 'details') || (i === 1 && step === 'password')
                  ? 'bg-blue-600 text-white'
                  : i === 0 && step === 'password'
                  ? 'bg-green-600 text-white'
                  : 'bg-gray-800 text-gray-500'
              }`}>
                {i === 0 && step === 'password' ? <Check size={14} /> : i + 1}
              </div>
              <span className={`text-xs ${step === (i === 0 ? 'details' : 'password') ? 'text-white' : 'text-gray-600'}`}>
                {label}
              </span>
              {i === 0 && <div className="flex-1 h-px bg-gray-800 ml-2" />}
            </div>
          ))}
        </div>

        <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 shadow-xl">

          {/* Step 1 — Company Details */}
          {step === 'details' && (
            <form onSubmit={handleStep1} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Company / ISP Name</label>
                <input className={`w-full px-3 py-2.5 border rounded-lg bg-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm ${errors.companyName ? 'border-red-500' : 'border-gray-700'}`}
                  value={form.companyName} onChange={set('companyName')} placeholder="Acme Internet Ltd" autoFocus />
                {errors.companyName && <p className="text-red-400 text-xs mt-1">{errors.companyName}</p>}

                {/* Subdomain preview */}
                {form.companyName.length >= 2 && (
                  <div className="mt-2 flex items-center gap-2">
                    {checkingSubdomain ? (
                      <Loader2 size={12} className="text-gray-400 animate-spin" />
                    ) : subdomainInfo ? (
                      subdomainInfo.available
                        ? <Check size={12} className="text-green-400" />
                        : <X size={12} className="text-red-400" />
                    ) : null}
                    <span className="text-xs text-gray-500">
                      Your subdomain:{' '}
                      <span className={`font-mono font-medium ${subdomainInfo?.available ? 'text-green-400' : 'text-red-400'}`}>
                        {subdomainInfo?.subdomain ?? '...'}
                      </span>
                      {subdomainInfo && !subdomainInfo.available && (
                        <span className="text-red-400 ml-1">(taken)</span>
                      )}
                    </span>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Your Full Name</label>
                <input className={`w-full px-3 py-2.5 border rounded-lg bg-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm ${errors.adminName ? 'border-red-500' : 'border-gray-700'}`}
                  value={form.adminName} onChange={set('adminName')} placeholder="John Doe" />
                {errors.adminName && <p className="text-red-400 text-xs mt-1">{errors.adminName}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Work Email</label>
                <input type="email" className={`w-full px-3 py-2.5 border rounded-lg bg-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm ${errors.email ? 'border-red-500' : 'border-gray-700'}`}
                  value={form.email} onChange={set('email')} placeholder="you@company.com" />
                {errors.email && <p className="text-red-400 text-xs mt-1">{errors.email}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Phone Number</label>
                <input type="tel" className={`w-full px-3 py-2.5 border rounded-lg bg-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm ${errors.phone ? 'border-red-500' : 'border-gray-700'}`}
                  value={form.phone} onChange={set('phone')} placeholder="+254700000000" />
                {errors.phone && <p className="text-red-400 text-xs mt-1">{errors.phone}</p>}
              </div>

              <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-medium transition-colors text-sm flex items-center justify-center gap-2 mt-2">
                Continue <ArrowRight size={16} />
              </button>
            </form>
          )}

          {/* Step 2 — Password */}
          {step === 'password' && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="p-3 bg-gray-800 rounded-lg mb-2">
                <p className="text-xs text-gray-400">Setting up account for</p>
                <p className="text-sm font-semibold text-white">{form.companyName}</p>
                <p className="text-xs text-gray-400">{form.email}</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Password</label>
                <div className="relative">
                  <input type={showPassword ? 'text' : 'password'}
                    className={`w-full px-3 py-2.5 border rounded-lg bg-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm pr-10 ${errors.password ? 'border-red-500' : 'border-gray-700'}`}
                    value={form.password} onChange={set('password')} placeholder="Min 8 characters" autoFocus />
                  <button type="button" onClick={() => setShowPassword(s => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {form.password && (
                  <div className="mt-2">
                    <div className="flex gap-1 mb-1">
                      {[1,2,3,4].map(i => (
                        <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= strength ? strengthColor : 'bg-gray-700'}`} />
                      ))}
                    </div>
                    <p className="text-xs text-gray-400">{strengthLabel}</p>
                  </div>
                )}
                {errors.password && <p className="text-red-400 text-xs mt-1">{errors.password}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Confirm Password</label>
                <div className="relative">
                  <input type={showConfirm ? 'text' : 'password'}
                    className={`w-full px-3 py-2.5 border rounded-lg bg-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm pr-10 ${errors.confirmPassword ? 'border-red-500' : 'border-gray-700'}`}
                    value={form.confirmPassword} onChange={set('confirmPassword')} placeholder="Repeat password" />
                  <button type="button" onClick={() => setShowConfirm(s => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                    {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {errors.confirmPassword && <p className="text-red-400 text-xs mt-1">{errors.confirmPassword}</p>}
              </div>

              <div className="p-3 bg-blue-900/20 border border-blue-800 rounded-lg">
                <p className="text-xs text-blue-300 font-medium mb-1">✨ What you get free for 14 days:</p>
                <div className="space-y-1">
                  {['Unlimited subscribers', 'MikroTik PPPoE & Hotspot management', 'Billing & payments', 'Customer portal', 'Live session monitoring'].map(f => (
                    <p key={f} className="text-xs text-blue-400 flex items-center gap-1.5"><Check size={10} />{f}</p>
                  ))}
                </div>
              </div>

              <div className="flex gap-3">
                <button type="button" onClick={() => setStep('details')}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 py-2.5 rounded-lg font-medium transition-colors text-sm">
                  Back
                </button>
                <button type="submit" disabled={loading}
                  className="flex-2 flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-medium transition-colors text-sm disabled:opacity-50 flex items-center justify-center gap-2">
                  {loading ? <><Loader2 size={16} className="animate-spin" /> Creating...</> : 'Create Account'}
                </button>
              </div>

              <p className="text-xs text-gray-600 text-center">
                By creating an account you agree to our Terms of Service
              </p>
            </form>
          )}
        </div>

        <p className="text-center text-sm text-gray-500 mt-6">
          Already have an account?{' '}
          <Link href="/auth/login" className="text-blue-400 hover:text-blue-300 font-medium">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
