'use client';
// Installable-app plumbing shared by the install banner and the account-menu "Install app" item.
//
// Chrome fires `beforeinstallprompt` once, and only after it judges the user "engaged" (a tap on
// the page plus some time on it). An inline script in the root layout stashes that event on
// window before React loads, so it's never missed; this module picks it up from there.
//
// Where no native prompt exists — iPhone/iPad, Samsung Internet, Firefox, or Chrome before it has
// decided to offer one — callers fall back to showing how to install from the browser menu.
import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

declare global {
  interface Window {
    __dartbitBip?: BeforeInstallPromptEvent | null;
    __dartbitInstalled?: boolean;
  }
}

export type InstallPlatform = 'ios' | 'android' | 'desktop';

const INSTALLED_KEY = 'dartbit_app_installed';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function flagInstalled() {
  try { localStorage.setItem(INSTALLED_KEY, '1'); } catch { /* storage blocked */ }
}
function hasInstalledFlag(): boolean {
  try { return localStorage.getItem(INSTALLED_KEY) === '1'; } catch { return false; }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own banner instead of Chrome's mini-infobar
    window.__dartbitBip = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    window.__dartbitBip = null;
    window.__dartbitInstalled = true;
    flagInstalled();
    detection = Promise.resolve(true);
    notify();
  });
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: minimal-ui)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function detectPlatform(): InstallPlatform {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support gives it away.
  if (/iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'desktop';
}

/**
 * Has this person already installed the app? A page in an ordinary browser tab can't see the home
 * screen directly, so three signals are combined:
 *   1. Running as the installed app right now.
 *   2. A flag saved when it was installed or opened as the app. On Android the installed app shares
 *      storage with Chrome, so the flag set inside the app is visible in the browser tab too.
 *   3. getInstalledRelatedApps() — Chrome can confirm an installed copy of this exact app (the
 *      manifest lists itself under related_applications for this purpose).
 * iPhone home-screen apps keep separate storage from Safari and iOS has no detection API, so an
 * iPhone user who installed and later opens Safari may still see the card once per 14 days.
 */
let detection: Promise<boolean> | null = null;
export function detectInstalled(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (detection) return detection;
  detection = (async () => {
    if (isStandalone()) { flagInstalled(); return true; }
    if (hasInstalledFlag() || window.__dartbitInstalled) return true;
    const nav = navigator as Navigator & { getInstalledRelatedApps?: () => Promise<unknown[]> };
    if (typeof nav.getInstalledRelatedApps === 'function') {
      try {
        const apps = await Promise.race([
          nav.getInstalledRelatedApps(),
          new Promise<unknown[]>((resolve) => setTimeout(() => resolve([]), 1500)),
        ]);
        if (apps.length > 0) { flagInstalled(); return true; }
      } catch { /* unsupported in this context */ }
    }
    return false;
  })();
  return detection;
}

export function useInstallApp() {
  const [, force] = useState(0);
  const [mounted, setMounted] = useState(false);
  // null while still checking, so callers never flash the card at someone who has the app.
  const [installed, setInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    setMounted(true);
    let alive = true;
    detectInstalled().then((v) => { if (alive) setInstalled(v); });
    const l = () => {
      force((n) => n + 1);
      if (window.__dartbitInstalled) setInstalled(true);
    };
    listeners.add(l);
    return () => { alive = false; listeners.delete(l); };
  }, []);

  const canPrompt = mounted && !!window.__dartbitBip;
  const platform: InstallPlatform = mounted ? detectPlatform() : 'desktop';

  const promptInstall = async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    const e = window.__dartbitBip;
    if (!e) return 'unavailable';
    // A prompt event can only be used once; Chrome sends a fresh one later if it's declined.
    window.__dartbitBip = null;
    notify();
    try {
      await e.prompt();
      const { outcome } = await e.userChoice;
      if (outcome === 'accepted') {
        flagInstalled();
        window.__dartbitInstalled = true;
        notify();
      }
      return outcome;
    } catch {
      return 'unavailable';
    }
  };

  return {
    mounted,
    canPrompt,
    /** true once confirmed installed; false while unknown or not installed. */
    installed: installed === true,
    /** still working out whether the app is installed. */
    checking: installed === null,
    platform,
    promptInstall,
  };
}

/** Lets the account menu re-open the banner after it was dismissed. */
export const SHOW_INSTALL_EVENT = 'dartbit:show-install';
export function requestInstallHelp() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SHOW_INSTALL_EVENT));
}

/** Registers the service worker once per page load. Production + secure context only. */
let swRequested = false;
export function registerServiceWorker() {
  if (swRequested || typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  if (process.env.NODE_ENV !== 'production' || !window.isSecureContext) return;
  swRequested = true;
  const go = () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
    console.warn('[pwa] service worker registration failed:', err);
  });
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}
