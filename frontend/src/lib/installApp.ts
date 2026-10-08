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

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own banner instead of Chrome's mini-infobar
    window.__dartbitBip = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    window.__dartbitBip = null;
    window.__dartbitInstalled = true;
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

export function useInstallApp() {
  const [, force] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  const canPrompt = mounted && !!window.__dartbitBip;
  const installed = mounted && (isStandalone() || !!window.__dartbitInstalled);
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
      return outcome;
    } catch {
      return 'unavailable';
    }
  };

  return { mounted, canPrompt, installed, platform, promptInstall };
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
