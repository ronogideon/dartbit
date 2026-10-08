'use client';
// "Install the app" banner for tenant subdomains, so staff and customers open the portal from
// their home screen instead of typing the address.
//
//   Android / desktop Chrome, once Chrome offers it → one-tap native install.
//   iPhone/iPad, other browsers, or Chrome before it offers → short how-to for the browser menu.
//
// Hidden when already running as the installed app, on the hotspot captive-portal pages (that's an
// OS sign-in window where installing is impossible), on the apex, and for 14 days after dismissal.
// The account menu's "Install app" item brings it back on demand.
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Download, Share, X, MoreVertical, PlusSquare } from 'lucide-react';
import { tenantSubdomainFromHost } from '@/lib/api';
import { useInstallApp, registerServiceWorker, SHOW_INSTALL_EVENT } from '@/lib/installApp';

const DISMISS_KEY = 'dartbit_install_dismissed_at';
const DISMISS_DAYS = 14;

function recentlyDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return at > 0 && Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

export default function InstallAppBanner() {
  const pathname = usePathname() || '';
  const { mounted, canPrompt, installed, platform, promptInstall } = useInstallApp();
  const [eligible, setEligible] = useState(false);
  const [forced, setForced] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [showHow, setShowHow] = useState(false);
  const [appName, setAppName] = useState('');
  const [iconUrl, setIconUrl] = useState('');

  useEffect(() => {
    registerServiceWorker();
    const onSub = !!tenantSubdomainFromHost();
    setEligible(onSub);
    setDismissed(recentlyDismissed());
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

  useEffect(() => {
    const open = () => { setForced(true); setShowHow(false); };
    window.addEventListener(SHOW_INSTALL_EVENT, open);
    return () => window.removeEventListener(SHOW_INSTALL_EVENT, open);
  }, []);

  if (!mounted || !eligible || installed) return null;
  if (pathname.startsWith('/hotspot')) return null;
  // Desktop without a native prompt has no simple install path worth nagging about.
  if (!forced && platform === 'desktop' && !canPrompt) return null;
  if (!forced && dismissed) return null;

  const close = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
    setDismissed(true);
    setForced(false);
    setShowHow(false);
  };

  const install = async () => {
    if (canPrompt) {
      const r = await promptInstall();
      if (r === 'accepted') { setForced(false); return; }
      if (r === 'dismissed') return;
    }
    setShowHow(true);
  };

  const label = appName ? `Install ${appName}` : 'Install the app';

  return (
    <div
      role="dialog"
      aria-label={label}
      className="fixed inset-x-0 bottom-0 z-[60] px-3 pointer-events-none"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
    >
      <div className="pointer-events-auto mx-auto max-w-md rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-2xl p-4">
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
          <button onClick={close} aria-label="Not now" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1 -m-1 shrink-0">
            <X size={18} />
          </button>
        </div>

        {showHow || (platform === 'ios' && !canPrompt) ? (
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
    </div>
  );
}
