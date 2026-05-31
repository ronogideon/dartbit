'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { tenantSubdomainFromHost } from '@/lib/api';
import { Zap, Wifi, CreditCard, Radio, BarChart3, MessageSquare, ArrowRight, Check } from 'lucide-react';

export default function Home() {
  const router = useRouter();
  const [mode, setMode] = useState<'checking' | 'marketing'>('checking');

  useEffect(() => {
    // On a tenant subdomain -> go straight to login. On the apex -> show marketing.
    const sub = tenantSubdomainFromHost();
    if (sub) { router.replace('/auth/login'); return; }
    setMode('marketing');
  }, [router]);

  if (mode === 'checking') {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950">
        <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  const features = [
    { icon: Radio, title: 'MikroTik automation', desc: 'Zero-touch router provisioning, PPPoE, static and hotspot management from one dashboard.' },
    { icon: CreditCard, title: 'M-Pesa billing', desc: 'Collect payments via M-Pesa STK, auto-activate subscribers, and reconcile instantly.' },
    { icon: Wifi, title: 'Hotspot & vouchers', desc: 'Captive portal with package selection, voucher batches and self-service top-ups.' },
    { icon: MessageSquare, title: 'SMS notifications', desc: 'Automated welcome, receipt and expiry reminders with a prepaid SMS wallet.' },
    { icon: BarChart3, title: 'Analytics', desc: 'Payment trends, top packages, data usage and most-active users at a glance.' },
    { icon: Zap, title: 'Your own portal', desc: 'A branded subdomain for your business - admins and customers log in at one place.' },
  ];

  return (
    <div className="min-h-screen bg-gray-950 text-white overflow-x-hidden">
      <div className="pointer-events-none fixed inset-0 opacity-40">
        <div className="absolute -top-40 -left-40 w-[36rem] h-[36rem] rounded-full bg-blue-600/20 blur-3xl" />
        <div className="absolute top-1/3 -right-40 w-[32rem] h-[32rem] rounded-full bg-cyan-500/10 blur-3xl" />
      </div>

      <header className="relative z-10 max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/30">
            <Zap size={20} className="text-white" />
          </div>
          <span className="text-xl font-bold tracking-tight">Dartbit</span>
        </div>
        <Link href="/signup" className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-semibold transition shadow-lg shadow-blue-600/25">
          Sign up
        </Link>
      </header>

      <section className="relative z-10 max-w-6xl mx-auto px-6 pt-16 pb-20 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-gray-800 bg-gray-900/60 text-xs text-gray-400 mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> ISP billing &amp; MikroTik management
        </div>
        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight leading-[1.05] mb-6">
          Run your internet business<br className="hidden sm:block" /> on <span className="text-blue-500">autopilot</span>.
        </h1>
        <p className="max-w-2xl mx-auto text-lg text-gray-400 mb-9">
          Dartbit gives WISPs and fibre operators everything to provision routers, bill customers over M-Pesa,
          run hotspots and keep subscribers connected - under your own branded portal.
        </p>
        <div className="flex items-center justify-center gap-3 flex-wrap">
          <Link href="/signup" className="group px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 font-semibold transition shadow-lg shadow-blue-600/25 flex items-center gap-2">
            Start your free trial
            <ArrowRight size={18} className="group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </div>
        <div className="mt-5 text-sm text-gray-500 flex items-center justify-center gap-5 flex-wrap">
          <span className="flex items-center gap-1.5"><Check size={15} className="text-green-500" /> No setup fees</span>
          <span className="flex items-center gap-1.5"><Check size={15} className="text-green-500" /> Free trial</span>
          <span className="flex items-center gap-1.5"><Check size={15} className="text-green-500" /> Your own subdomain</span>
        </div>
      </section>

      <section className="relative z-10 max-w-6xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((f, i) => (
            <div key={i} className="rounded-2xl border border-gray-800 bg-gray-900/50 p-6 hover:border-gray-700 transition">
              <div className="w-11 h-11 rounded-xl bg-blue-600/15 text-blue-400 flex items-center justify-center mb-4">
                <f.icon size={22} />
              </div>
              <h3 className="font-semibold mb-1.5">{f.title}</h3>
              <p className="text-sm text-gray-400 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="relative z-10 max-w-4xl mx-auto px-6 pb-24">
        <div className="rounded-3xl border border-gray-800 bg-gradient-to-br from-blue-600/10 to-transparent p-10 sm:p-14 text-center">
          <h2 className="text-2xl sm:text-3xl font-bold mb-3">Ready to launch your portal?</h2>
          <p className="text-gray-400 mb-7 max-w-xl mx-auto">
            Create your account, pick your subdomain, and start onboarding subscribers in minutes.
          </p>
          <Link href="/signup" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 font-semibold transition shadow-lg shadow-blue-600/25">
            Sign up <ArrowRight size={18} />
          </Link>
        </div>
      </section>

      <footer className="relative z-10 border-t border-gray-900 py-8 text-center text-sm text-gray-500">
        (c) {new Date().getFullYear()} Dartbit. ISP management platform.
      </footer>
    </div>
  );
}
