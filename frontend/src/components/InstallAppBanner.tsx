'use client';
// "Install the app" card for tenant subdomains, so staff and customers open the portal from
// their home screen instead of typing the address.
//
// Shown once on page load for 10 seconds, then it closes itself and stays away for 14 days —
// whether it timed out or was closed by hand. Touching or focusing it stops the timer, so it
// never disappears while someone is reading the steps or about to tap Install.
//
//   Android / desktop Chrome, once Chrome offers it → one-tap native install.
//   iPhone/iPad, other browsers, or Chrome before it offers → short how-to for the browser menu.
//
// Never shown to someone who already has the app (see detectInstalled), on the hotspot
// captive-portal pages (an OS sign-in window where installing is impossible), or on the apex.
// The account menu's "Install app" item opens it on demand, without the timer.
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Download, Share, X, MoreVertical, PlusSquare } from 'lucide-react';
import { tenantSubdomainFromHost } from '@/lib/api';
import { useInstallApp, registerServiceWorker, SHOW_INSTALL_EVENT } from '@/lib/installApp';

// Kept from v1.11.89's first cut so anyone who already dismissed it isn't shown it again early.
const SHOWN_KEY = 'dartbit_install_dismissed_at';
const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const VISIBLE_MS = 10_000;

function shownRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(SHOWN_KEY) || 0);
    return at > 0 && Date.now() - at < COOLDOWN_MS;
  } catch {
    return false;
  }
}
function recordShown() {
  try { localStorage.setItem(SHOWN_KEY, String(Date.now())); } catch { /* storage blocked */ }
}

type Mode = 'hidden' | 'auto' | 'manual';

export default function InstallAppBanner() {
  const pathname = usePathname() || '';
  const { mounted, canPrompt, installed, checking, platform, promptInstall } = useInstallApp();
  const [eligible, setEligible] = useState(false);
  const [mode, setMode] = useState<Mode>('hidden');
  const [engaged, setEngaged] = useState(false);
  const [draining, setDraining] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const [appName, setAppName] = useState('');
  const [iconUrl, setIconUrl] = useState('');
  const decided = useRef(false);

  useEffect(() => {
    registerServiceWorker();
    const onSub = !!tenantSubdomainFromHost();
    setEligible(onSub);
    if (!onSub) return;
    // Name and icon come from the same per-tenant manifest the browser installs from.
    fetch('/manifest.webmanifest')
      .then((r) => (r.ok ? r.json() : null))
      .then((m: { short_name?: string; name?: string; icons?: { src: string }[] } | null) => {
        if (!m) return;
        setAppName(m.name || m.short_name || '');
        if (m.icons?.[0]?.src) setIconUrl(m.icons[0].src);
      })
      .catch(() => {});
  }, []);

  // The once-per-load decision, made as soon as we know whether the app is installed.
  useEffect(() => {
    if (decided.current || !mounted || !eligible || checking) return;
    decided.current = true;
    if (installed) return;
    if (pathname.startsWith('/hotspot')) return;
    // Desktop without a native prompt has no simple install path worth interrupting for.
    if (platform === 'desktop' && !canPrompt) return;
    if (shownRecently()) return;
    recordShown(); // the 14 days start now, however the card ends up closing
    setMode('auto');
  }, [mounted, eligible, checking, installed, pathname, platform, canPrompt]);

  // 10-second auto-close, cancelled the moment the person engages with the card.
  useEffect(() => {
    if (mode !== 'auto' || engaged) return;
    const raf = requestAnimationFrame(() => setDraining(true));
    const t = setTimeout(() => setMode('hidden'), VISIBLE_MS);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [mode, engaged]);

  // Opened on demand from the account menu: no timer, and it doesn't touch the 14-day clock.
  useEffect(() => {
    const open = () => { setShowHow(false); setEngaged(true); setMode('manual'); };
    window.addEventListener(SHOW_INSTALL_EVENT, open);
    return () => window.removeEventListener(SHOW_INSTALL_EVENT, open);
  }, []);

  // Installed while it was open → nothing left to offer.
  useEffect(() => { if (installed) setMode('hidden'); }, [installed]);

  if (mode === 'hidden' || installed) return null;

  const close = () => { setMode('hidden'); setShowHow(false); };
  const engage = () => setEngaged(true);

  const install = async () => {
    engage();
    if (canPrompt) {
      const r = await promptInstall();
      if (r === 'accepted') { close(); return; }
      if (r === 'dismissed') return;
    }
    setShowHow(true);
  };

  const label = appName ? `Install ${appName}` : 'Install the app';
  const showSteps = showHow || (platform === 'ios' && !canPrompt);
  const timed = mode === 'auto' && !engaged;

  return (
    <div
      role="dialog"
      aria-label={label}
      className="fixed inset-x-0 bottom-0 z-[60] px-3 pointer-events-none"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
    >
      <div
        onPointerDown={engage}
        onFocusCapture={engage}
        className="pointer-events-auto mx-auto max-w-md overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-2xl"
      >
        <div className="p-4">
          <div className="flex items-start gap-3">
            {iconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={iconUrl} alt="" width={44} height={44} className="w-11 h-11 rounded-xl shrink-0" />
            ) : (
              <div className="w-11 h-11 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0"><Download size={20} /></div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{label}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Open it from your home screen in one tap — no typing the address.
              </p>
            </div>
            <button onClick={close} aria-label="Close" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1 -m-1 shrink-0">
              <X size={18} />
            </button>
          </div>

          {showSteps ? (
            <ol className="mt-3 space-y-2 text-sm text-gray-700 dark:text-gray-300">
              {platform === 'ios' ? (
                <>
                  <li className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs flex items-center justify-center shrink-0">1</span>
                    Tap <Share size={15} className="inline shrink-0" aria-label="Share" /> <b>Share</b> in Safari&apos;s toolbar
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs flex items-center justify-center shrink-0">2</span>
                    Choose <PlusSquare size={15} className="inline shrink-0" aria-hidden /> <b>Add to Home Screen</b>
                  </li>
                </>
              ) : (
                <>
                  <li className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs flex items-center justify-center shrink-0">1</span>
                    Tap the browser menu <MoreVertical size={15} className="inline shrink-0" aria-label="menu" />
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs flex items-center justify-center shrink-0">2</span>
                    Choose <b>Install app</b> or <b>Add to Home screen</b>
                  </li>
                </>
              )}
            </ol>
          ) : (
            <button
              onClick={install}
              className="mt-3 w-full rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2.5 flex items-center justify-center gap-2"
            >
              <Download size={16} /> Install
            </button>
          )}
        </div>

        {/* Countdown: shows the card is temporary. Disappears once the person engages. */}
        {timed && (
          <div className="h-1 bg-gray-100 dark:bg-gray-800" aria-hidden>
            <div
              className="h-full bg-blue-600"
              style={{ width: draining ? '0%' : '100%', transition: `width ${VISIBLE_MS}ms linear` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
