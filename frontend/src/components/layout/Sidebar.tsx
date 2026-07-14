'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useQuery } from '@tanstack/react-query';
import { getTenantInfo, getSidebarCounts } from '@/lib/api';
import {
  LayoutDashboard, Users, Package, CreditCard, MessageSquare,
  Router, Activity, Zap, Wifi, Building2, Ticket, Receipt,
  ChevronLeft, ChevronRight, X, Map } from 'lucide-react';
import clsx from 'clsx';
import { useState, useEffect } from 'react';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/active-users', label: 'Active Users', icon: Activity },
  { href: '/subscribers', label: 'Subscribers', icon: Users },
  { href: '/packages', label: 'Packages', icon: Package },
  { href: '/vouchers', label: 'Vouchers', icon: Ticket },
  { href: '/payments', label: 'Payments', icon: CreditCard },
  { href: '/expenses', label: 'Expenses', icon: Receipt },
  { href: '/messages', label: 'Messages', icon: MessageSquare },
  { href: '/routers', label: 'Routers', icon: Router },
  { href: '/network', label: 'Network Map', icon: Map },
  // Settings intentionally removed — it now lives behind the gear icon in the top bar.
];

const superAdminItems = [
  { href: '/admin/tenants', label: 'Tenants', icon: Building2 },
];

export default function Sidebar({
  mobileOpen,
  onMobileClose,
}: {
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const pathname = usePathname();
  const { user } = useAuth();
  const isSuper = user?.role === 'SUPERADMIN' || user?.role === 'SUPERADMIN_VIEWER';
  // Brand the sidebar with the tenant's business name (wifi icon placeholder). Superadmins
  // keep the Dartbit branding.
  const { data: tenantInfo } = useQuery({
    queryKey: ['tenant-info-brand'],
    queryFn: getTenantInfo,
    enabled: !!user && !isSuper,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const brandName = !isSuper && tenantInfo?.name ? tenantInfo.name : 'Dartbit';
  const BrandIcon = !isSuper && tenantInfo?.name ? Wifi : Zap;
  const [collapsed, setCollapsed] = useState(false);

  // Counts for the sidebar bubbles (tenant-scoped). Refreshed periodically; superadmins skip it.
  const { data: counts } = useQuery({
    queryKey: ['sidebar-counts'],
    queryFn: getSidebarCounts,
    enabled: !!user && !isSuper,
    refetchInterval: 30000,
    retry: false,
  });
  const badgeFor = (href: string): number | null => {
    if (!counts) return null;
    if (href === '/active-users') return counts.online;
    if (href === '/subscribers') return counts.total;
    if (href === '/routers') return counts.routers;
    return null;
  };

  // Persist collapse state (desktop only) in localStorage.
  useEffect(() => {
    const saved = localStorage.getItem('dartbit_sidebar_collapsed');
    if (saved === 'true') setCollapsed(true);
  }, []);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => { onMobileClose(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pathname]);

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      localStorage.setItem('dartbit_sidebar_collapsed', String(!prev));
      return !prev;
    });
  };

  // Technicians (read-only) only get the views relevant to them: dashboard, live users, subscribers, routers.
  const TECH_ALLOWED = ['/dashboard', '/active-users', '/subscribers', '/routers', '/network'];
  const baseItems = user?.role === 'TENANT_VIEWER' ? navItems.filter(i => TECH_ALLOWED.includes(i.href)) : navItems;
  const items = user?.role === 'SUPERADMIN' ? [...superAdminItems, ...navItems] : baseItems;

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onMobileClose}
          aria-hidden
        />
      )}

      {/* Sidebar.
          - Desktop (lg+): static in the flex row, collapsible width.
          - Mobile: fixed drawer that slides in from the left, toggled by `mobileOpen`. */}
      <aside
        className={clsx(
          'bg-gray-900 text-white flex flex-col h-screen border-r border-gray-800 transition-all duration-300 ease-in-out z-50',
          // mobile drawer positioning
          'fixed left-0 top-0 lg:static lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
          // width: on mobile always full 64; on desktop respect collapse
          collapsed ? 'w-64 lg:w-16' : 'w-64'
        )}
      >
        {/* Logo + mobile close */}
        <div className={clsx(
          'flex items-center border-b border-gray-800 h-14 shrink-0 transition-all duration-300',
          collapsed ? 'lg:px-0 lg:justify-center px-4 gap-3' : 'px-4 gap-3'
        )}>
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
            <BrandIcon size={17} className="text-white" />
          </div>
          {(!collapsed) && <span className="text-base font-bold tracking-tight truncate lg:inline">{brandName}</span>}
          {collapsed && <span className="text-base font-bold tracking-tight truncate lg:hidden">{brandName}</span>}
          {/* close button (mobile) */}
          <button onClick={onMobileClose} className="ml-auto lg:hidden p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800" aria-label="Close menu">
            <X size={18} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto overflow-x-hidden">
          {items.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            const badge = badgeFor(href);
            return (
              <Link
                key={href}
                href={href}
                title={collapsed ? label : undefined}
                className={clsx(
                  'flex items-center rounded-lg text-sm font-medium transition-colors group relative',
                  collapsed ? 'gap-3 px-3 py-2.5 lg:justify-center lg:px-0' : 'gap-3 px-3 py-2.5',
                  active ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                )}
              >
                <Icon size={18} className="shrink-0" />
                <span className={clsx('truncate', collapsed && 'lg:hidden')}>{label}</span>
                {badge !== null && (
                  <span className={clsx(
                    'ml-auto text-xs font-semibold rounded-full px-1.5 min-w-[1.25rem] text-center shrink-0',
                    active ? 'bg-white/25 text-white' : 'bg-gray-700 text-gray-200 group-hover:bg-gray-600',
                    collapsed && 'lg:hidden',
                  )}>{badge > 999 ? '999+' : badge}</span>
                )}
                {collapsed && (
                  <div className="hidden lg:block absolute left-full ml-2 px-2 py-1 bg-gray-800 text-white text-xs rounded-md
                    opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity">
                    {label}
                  </div>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Collapse toggle (desktop only) */}
        <div className="border-t border-gray-800 p-2 shrink-0 hidden lg:block">
          <button
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={clsx(
              'flex items-center rounded-lg text-sm font-medium text-gray-500 hover:text-white hover:bg-gray-800 w-full transition-colors',
              collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2.5'
            )}
          >
            {collapsed
              ? <ChevronRight size={17} className="shrink-0" />
              : <><ChevronLeft size={17} className="shrink-0" /><span>Collapse</span></>
            }
          </button>
        </div>
      </aside>
    </>
  );
}
