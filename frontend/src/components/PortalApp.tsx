'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
import { login as adminLogin, forgotPassword, resetPasswordWithCode } from '@/lib/api';
import toast from 'react-hot-toast';
import { fontStack } from '@/lib/fonts';
import { googleFontsHref } from '@/lib/fonts';
import { expiryBadge } from '@/lib/format';
import { Wifi, Calendar, Download, Upload, LogOut, Clock, RefreshCw, Zap } from 'lucide-react';

interface Account {
  kind: string; name: string; username: string; package?: string;
  isActive: boolean; expiresAt?: string; lastOnlineAt?: string;
  usage30d?: { download: string; upload: string } | null;
  sessions: { startedAt: string; endedAt: string | null; active: boolean; download: string; upload: string }[];
}
interface Pkg { id: string; name: string; price: number; validityMinutes: number; speedDownKbps: number; speedUpKbps: number; service: string }

function fmtDate(d?: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDur(mins: number): string {
  if (mins < 60) return `${mins} min`;
  if (mins < 1440) return `${Math.round(mins / 60)} hr`;
  return `${Math.round(mins / 1440)} day(s)`;
}

export default function PortalApp({ subdomain }: { subdomain?: string }) {
  const qs = subdomain ? `?t=${encodeURIComponent(subdomain)}` : '';
  const [tenantName, setTenantName] = useState('');
  const [brand, setBrand] = useState<{ logoUrl?: string | null; themeColor?: string | null; fontFamily?: string | null; supportPhone?: string | null }>({});
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fpOpen, setFpOpen] = useState(false);
  const [fpStep, setFpStep] = useState(1);
  const [fpId, setFpId] = useState('');
  const [fpCode, setFpCode] = useState('');
  const [fpNew, setFpNew] = useState('');
  const [fpLoading, setFpLoading] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [renewPkg, setRenewPkg] = useState<Pkg | null>(null);
  const [renewPhone, setRenewPhone] = useState('');
  const [renewing, setRenewing] = useState(false);

  useEffect(() => {
    // Load the tenant fonts so the chosen fontFamily actually renders on the subdomain portal
    // (without this the font-family was set but the webfont never downloaded → system fallback).
    if (typeof document !== 'undefined' && !document.getElementById('portal-fonts')) {
      const link = document.createElement('link');
      link.id = 'portal-fonts';
      link.rel = 'stylesheet';
      link.href = googleFontsHref();
      document.head.appendChild(link);
    }
    api.get(`/portal/tenant${qs}`).then(r => {
      if (r.data.success) {
        const t = r.data.tenant;
        setTenantName(t.name);
        setBrand({ logoUrl: t.logoUrl, themeColor: t.themeColor, fontFamily: t.fontFamily, supportPhone: t.supportPhone });
      }
    }).catch(() => {});
    // If the unified login already authenticated a customer, pick up the handoff token.
    try {
      const handoff = sessionStorage.getItem('dartbit_portal_token');
      if (handoff) {
        sessionStorage.removeItem('dartbit_portal_token');
        setToken(handoff);
        loadAccount(handoff);
      }
    } catch { /* ignore */ }
  }, []);

  const loadAccount = useCallback(async (tok: string) => {
    try {
      // Cache-buster so a manual refresh always hits the server (avoids any stale cache).
      const cb = `${qs ? '&' : '?'}_=${Date.now()}`;
      const [acc, pkgs] = await Promise.all([
        api.get(`/portal/account${qs}${cb}`, { headers: { Authorization: `Bearer ${tok}` } }),
        api.get(`/portal/packages${qs}${cb}`, { headers: { Authorization: `Bearer ${tok}` } }),
      ]);
      setAccount(acc.data.account);
      setPackages(pkgs.data.packages || []);
    } catch { toast.error('Session expired, please log in again'); setToken(''); }
  }, [qs]);

  // Manual refresh from the button — shows a spinner + confirms when done.
  const refresh = useCallback(async () => {
    if (!token || refreshing) return;
    setRefreshing(true);
    try {
      await loadAccount(token);
      toast.success('Updated');
    } finally {
      setRefreshing(false);
    }
  }, [token, refreshing, loadAccount]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      // Unified login: this themed page is the single entry point for BOTH tenant admins/staff
      // (who sign in with their email) and subscribers (username). Try the admin login first; if
      // these aren't admin credentials, fall back to the subscriber portal login.
      let adminData: { user: { id: string; email: string; name: string; role: string; tenantId?: string }; token: string; subdomain?: string } | null = null;
      // Only an email can be an admin account — skip the admin probe entirely for usernames so a
      // customer login never triggers an (expected) admin-login 401.
      if (username.includes('@')) {
        try { adminData = await adminLogin(username, password); } catch { adminData = null; }
      }

      if (adminData) {
        // Persist admin auth the same way the admin app does, then hand off to the dashboard.
        try {
          localStorage.setItem('dartbit_token', adminData.token);
          localStorage.setItem('dartbit_user', JSON.stringify(adminData.user));
          if (adminData.subdomain) localStorage.setItem('dartbit_subdomain', adminData.subdomain);
        } catch {}
        toast.success(`Welcome back, ${adminData.user.name}!`);
        const base = process.env.NEXT_PUBLIC_PORTAL_BASE_DOMAIN;
        if (base && adminData.subdomain && typeof window !== 'undefined') {
          const expected = `${adminData.subdomain}.${base}`;
          if (window.location.hostname !== expected) { window.location.href = `https://${expected}/dashboard`; return; }
        }
        window.location.href = '/dashboard';
        return;
      }

      // Not an admin — subscriber portal login (username/secret or hotspot creds).
      const res = await api.post(`/portal/login${qs}`, { username, password });
      const tok = res.data.token;
      setToken(tok);
      await loadAccount(tok);
      toast.success('Welcome back!');
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e?.response?.data?.error || 'Invalid credentials');
    } finally { setLoading(false); }
  };

  const startRenew = async () => {
    if (!renewPkg || !renewPhone) { toast.error('Pick a package and enter your phone'); return; }
    setRenewing(true);
    try {
      const res = await api.post(`/portal/renew${qs}`, { packageId: renewPkg.id, phone: renewPhone }, { headers: { Authorization: `Bearer ${token}` } });
      const txId = res.data.transactionId;
      toast.success('Check your phone for the M-Pesa prompt');
      // poll
      let tries = 0;
      const iv = setInterval(async () => {
        tries++;
        if (tries > 30) { clearInterval(iv); setRenewing(false); toast.error('Payment timed out'); return; }
        try {
          const s = await api.get(`/portal/renew-status/${txId}${qs}`, { headers: { Authorization: `Bearer ${token}` } });
          if (s.data.status === 'PAID') { clearInterval(iv); setRenewing(false); setRenewPkg(null); toast.success('Payment received!'); loadAccount(token); }
          else if (s.data.status === 'FAILED') { clearInterval(iv); setRenewing(false); toast.error(s.data.message || 'Payment failed'); }
        } catch {}
      }, 3000);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e?.response?.data?.error || 'Could not start payment');
      setRenewing(false);
    }
  };

  const logout = () => { setToken(''); setAccount(null); setUsername(''); setPassword(''); };

  const accent = brand.themeColor && /^#[0-9a-f]{6}$/i.test(brand.themeColor) ? brand.themeColor : '#2563eb';
  const fontStyle = brand.fontFamily ? { fontFamily: fontStack(brand.fontFamily) } : undefined;
  const support = brand.supportPhone || '';
  const SupportFooter = support ? (
    <p className="text-center text-sm text-gray-400 mt-5">
      Need help? <a href={`tel:${support}`} className="font-semibold hover:underline" style={{ color: accent }}>{support}</a>
    </p>
  ) : null;

  // ===== Login screen =====
  if (!token || !account) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ ...fontStyle, background: `radial-gradient(circle at 50% -10%, ${accent}33, transparent 55%), linear-gradient(to bottom right, #0f1117, #090b10)` }}>
        <div className="w-full max-w-sm">
          <div className="text-center mb-6">
            <div className="inline-flex w-14 h-14 rounded-2xl items-center justify-center mb-3 overflow-hidden" style={{ background: accent }}>
              {brand.logoUrl ? <img src={brand.logoUrl} alt={tenantName} className="w-full h-full object-cover" /> : <Wifi className="text-white" size={26} />}
            </div>
            <h1 className="text-xl font-bold text-white">{tenantName || 'Subscriber Portal'}</h1>
            <p className="text-sm text-gray-400">Sign in to manage your account</p>
          </div>
          <form onSubmit={login} className="bg-gray-800 rounded-2xl p-6 space-y-4 border border-gray-700">
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Email or Username</label>
              <input className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-white" value={username} onChange={e => setUsername(e.target.value)} placeholder="Email or Username" autoCapitalize="none" />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Password</label>
              <input type="password" className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-white" value={password} onChange={e => setPassword(e.target.value)} placeholder="Your password" />
              <div className="text-right mt-1.5">
                <button type="button" onClick={() => { setFpId(username); setFpStep(1); setFpOpen(true); }} className="text-xs" style={{ color: accent }}>Forgot password?</button>
              </div>
            </div>
            <button type="submit" disabled={loading} className="w-full text-white rounded-lg py-2.5 font-medium disabled:opacity-50" style={{ background: accent }}>
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
            <p className="text-xs text-gray-500 text-center">Staff sign in with your email. PPPoE customers use your account login; hotspot customers use the credentials sent on purchase.</p>
          </form>
          {SupportFooter}
        </div>
        {fpOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setFpOpen(false)}>
            <div className="w-full max-w-sm rounded-xl bg-gray-900 border border-gray-700 p-5" onClick={e => e.stopPropagation()}>
              <h3 className="text-white font-semibold mb-1">Reset password</h3>
              {fpStep === 1 ? (
                <>
                  <p className="text-xs text-gray-400 mb-3">Enter your email (staff) or username (customer). We&apos;ll text a reset code to the phone on your account.</p>
                  <input value={fpId} onChange={e => setFpId(e.target.value)} placeholder="Email or username" autoCapitalize="none"
                    className="w-full px-3 py-2 mb-3 border border-gray-700 rounded-lg bg-gray-800 text-white text-sm" />
                  <button type="button" disabled={fpLoading || !fpId} onClick={async () => {
                    setFpLoading(true);
                    try { await forgotPassword(fpId.includes('@') ? 'STAFF' : 'CUSTOMER', fpId.trim()); toast.success('If the account exists, a code was sent by SMS.'); setFpStep(2); }
                    catch { toast.error('Could not send code'); } finally { setFpLoading(false); }
                  }} className="w-full text-white py-2 rounded-lg text-sm disabled:opacity-50" style={{ background: accent }}>
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
                    try { await resetPasswordWithCode(fpId.includes('@') ? 'STAFF' : 'CUSTOMER', fpId.trim(), fpCode.trim(), fpNew); toast.success('Password changed — sign in with your new password.'); setFpOpen(false); setFpCode(''); setFpNew(''); }
                    catch (e) { const err = e as { response?: { data?: { error?: string } } }; toast.error(err?.response?.data?.error || 'Invalid or expired code'); } finally { setFpLoading(false); }
                  }} className="w-full text-white py-2 rounded-lg text-sm disabled:opacity-50" style={{ background: accent }}>
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

  // ===== Account dashboard =====
  return (
    <div className="min-h-screen bg-gray-950 text-white p-4" style={fontStyle}>
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {brand.logoUrl && <img src={brand.logoUrl} alt="" className="w-9 h-9 rounded-lg object-cover" />}
            <div>
              <h1 className="text-lg font-bold">{tenantName}</h1>
              <p className="text-sm text-gray-400">Hi, {account.name}</p>
            </div>
          </div>
          <button onClick={logout} className="text-gray-400 hover:text-white flex items-center gap-1.5 text-sm"><LogOut size={16} /> Log out</button>
        </div>

        {/* Status card */}
        <div className="bg-gray-800 rounded-2xl p-5 border border-gray-700">
          <div className="flex items-center justify-between mb-4">
            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${account.isActive ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'}`}>
              {account.isActive ? '● Active' : '● Expired'}
            </span>
            <button onClick={refresh} disabled={refreshing} className="text-gray-400 hover:text-white disabled:opacity-50" aria-label="Refresh"><RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /></button>
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><div className="text-gray-400 text-xs">Username</div><div className="font-mono">{account.username}</div></div>
            <div><div className="text-gray-400 text-xs">Package</div><div>{account.package || '—'}</div></div>
            <div className="flex items-center gap-1.5"><Calendar size={16} className="text-white" strokeWidth={2.5} /><div><div className="text-gray-400 text-xs">Expires</div><div className="font-bold text-white flex items-center gap-2">{fmtDate(account.expiresAt)}{(() => { const b = expiryBadge(account.expiresAt); return b.className === 'text-gray-400' ? null : <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${b.className}`}>{b.text}</span>; })()}</div></div></div>
            <div className="flex items-center gap-1.5"><Clock size={14} className="text-gray-400" /><div><div className="text-gray-400 text-xs">Last online</div><div>{fmtDate(account.lastOnlineAt)}</div></div></div>
          </div>
        </div>

        {/* Usage (PPPoE) */}
        {account.usage30d && (
          <div className="bg-gray-800 rounded-2xl p-5 border border-gray-700">
            <h2 className="text-sm font-semibold mb-3 text-gray-300">Last 30 Days</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-900 rounded-xl p-3 text-center"><Download size={16} className="mx-auto text-green-400 mb-1" /><div className="font-bold">{account.usage30d.download}</div><div className="text-xs text-gray-500">Downloaded</div></div>
              <div className="bg-gray-900 rounded-xl p-3 text-center"><Upload size={16} className="mx-auto text-blue-400 mb-1" /><div className="font-bold">{account.usage30d.upload}</div><div className="text-xs text-gray-500">Uploaded</div></div>
            </div>
          </div>
        )}

        {/* Renew / buy */}
        <div className="bg-gray-800 rounded-2xl p-5 border border-gray-700">
          <h2 className="text-sm font-semibold mb-3 text-gray-300 flex items-center gap-1.5"><Zap size={15} /> Renew / Buy a Package</h2>
          <div className="space-y-2 mb-3">
            {packages.map(p => (
              <button key={p.id} onClick={() => setRenewPkg(p)} className={`w-full text-left p-3 rounded-xl border transition-colors ${renewPkg?.id === p.id ? 'border-blue-500 bg-blue-900/20' : 'border-gray-700 hover:border-gray-600'}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{p.name}</span>
                  <span className="font-bold text-blue-400">KES {p.price.toFixed(0)}</span>
                </div>
                <div className="text-xs text-gray-500">{fmtDur(p.validityMinutes)} • {Math.round(p.speedDownKbps/1024)}Mbps</div>
              </button>
            ))}
            {packages.length === 0 && <p className="text-sm text-gray-500 text-center py-2">No packages available</p>}
          </div>
          {renewPkg && (
            <div className="space-y-2">
              <input className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-white" value={renewPhone} onChange={e => setRenewPhone(e.target.value)} placeholder="M-Pesa phone (e.g. 0712345678)" inputMode="tel" />
              <button onClick={startRenew} disabled={renewing} className="w-full bg-green-600 hover:bg-green-700 text-white rounded-lg py-2.5 font-medium disabled:opacity-50">
                {renewing ? 'Waiting for payment…' : `Pay KES ${renewPkg.price.toFixed(0)} with M-Pesa`}
              </button>
            </div>
          )}
        </div>

        {/* Sessions */}
        {account.sessions.length > 0 && (
          <div className="bg-gray-800 rounded-2xl p-5 border border-gray-700">
            <h2 className="text-sm font-semibold mb-3 text-gray-300">Recent Sessions</h2>
            <div className="space-y-2">
              {account.sessions.slice(0, 10).map((s, i) => (
                <div key={i} className="flex items-center justify-between text-sm border-b border-gray-700/50 pb-2">
                  <span className="text-gray-400">{fmtDate(s.startedAt)}</span>
                  <span className="text-xs">↓{s.download} ↑{s.upload}</span>
                  {s.active && <span className="text-xs text-green-400">online</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {SupportFooter}
      </div>
    </div>
  );
}
