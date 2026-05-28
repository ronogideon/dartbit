'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/useTheme';
import { getTenantInfo } from '@/lib/api';
import { Menu, Sun, Moon, Settings as SettingsIcon, LogOut, Building2, X } from 'lucide-react';
import clsx from 'clsx';

interface TenantInfo {
  name?: string;
  subdomain?: string;
  status?: string;
  billingStatus?: string;
}

export default function TopBar({ onMenuClick }: { onMenuClick: () => void }) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const router = useRouter();
  const [accountOpen, setAccountOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const isTenantAdmin = user?.role === 'TENANT_ADMIN';
  const { data: tenant } = useQuery({
    queryKey: ['tenant-info'],
    queryFn: getTenantInfo,
    staleTime: 60000,
    enabled: !!user && isTenantAdmin && accountOpen,
  });
  const t = tenant as TenantInfo | undefined;

  // Close the account panel on outside click / escape.
  useEffect(() => {
    if (!accountOpen) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setAccountOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAccountOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [accountOpen]);

  return (
    <header className="h-14 shrink-0 flex items-center justify-between gap-2 px-3 sm:px-4 border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-900/80 backdrop-blur sticky top-0 z-30">
      {/* Left: hamburger (mobile only) */}
      <div className="flex items-center gap-2">
        <button
          onClick={onMenuClick}
          className="lg:hidden p-2 -ml-1 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
      </div>

      {/* Right: dark mode toggle + gear */}
      <div className="flex items-center gap-1">
        <button
          onClick={toggle}
          className="p-2 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
          aria-label="Toggle dark mode"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
        </button>

        <div className="relative" ref={panelRef}>
          <button
            onClick={() => setAccountOpen(o => !o)}
            className={clsx(
              'p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800',
              accountOpen ? 'text-blue-600' : 'text-gray-600 dark:text-gray-300'
            )}
            aria-label="Account"
            title="Account"
          >
            <SettingsIcon size={19} />
          </button>

          {accountOpen && (
            <div className="absolute right-0 mt-2 w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-xl overflow-hidden flex flex-col">
              {/* Header */}
              <div className="p-4 border-b border-gray-100 dark:border-gray-800">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{user?.name}</p>
                    <p className="text-xs text-gray-500 truncate">{user?.email}</p>
                  </div>
                  <button onClick={() => setAccountOpen(false)} className="text-gray-400 hover:text-gray-600 p-0.5 -mr-1">
                    <X size={16} />
                  </button>
                </div>
                {isTenantAdmin && t?.name && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                    <Building2 size={14} className="text-gray-400" />
                    <span className="truncate">{t.name}</span>
                    {t.status && (
                      <span className="ml-auto px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-[10px] uppercase tracking-wide">{t.status}</span>
                    )}
                  </div>
                )}
              </div>

              {/* Account links */}
              <div className="p-1.5">
                <Link
                  href="/settings"
                  onClick={() => setAccountOpen(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <SettingsIcon size={16} /> Tenant account &amp; settings
                </Link>
                <button
                  onClick={() => { setAccountOpen(false); toggle(); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
                  {theme === 'dark' ? 'Light mode' : 'Dark mode'}
                </button>
              </div>

              {/* Sign out pinned at the bottom */}
              <div className="mt-auto p-1.5 border-t border-gray-100 dark:border-gray-800">
                <button
                  onClick={() => { setAccountOpen(false); logout(); router.push('/auth/login'); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  <LogOut size={16} /> Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
