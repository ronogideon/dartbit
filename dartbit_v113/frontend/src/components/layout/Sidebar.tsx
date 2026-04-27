'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import {
  LayoutDashboard, Users, Package, CreditCard, MessageSquare,
  Router, Settings, Activity, LogOut, Zap, Building2,
  ChevronLeft, ChevronRight, Menu
} from 'lucide-react';
import clsx from 'clsx';
import { useState, useEffect } from 'react';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/active-users', label: 'Active Users', icon: Activity },
  { href: '/subscribers', label: 'Subscribers', icon: Users },
  { href: '/packages', label: 'Packages', icon: Package },
  { href: '/payments', label: 'Payments', icon: CreditCard },
  { href: '/messages', label: 'Messages', icon: MessageSquare },
  { href: '/routers', label: 'Routers', icon: Router },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const superAdminItems = [
  { href: '/admin/tenants', label: 'Tenants', icon: Building2 },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  // Persist collapse state in localStorage
  useEffect(() => {
    const saved = localStorage.getItem('dartbit_sidebar_collapsed');
    if (saved === 'true') setCollapsed(true);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      localStorage.setItem('dartbit_sidebar_collapsed', String(!prev));
      return !prev;
    });
  };

  const items = user?.role === 'SUPERADMIN' ? [...superAdminItems, ...navItems] : navItems;

  return (
    <>
      {/* Sidebar */}
      <aside
        className={clsx(
          'bg-gray-900 text-white flex flex-col h-screen fixed left-0 top-0 z-40 border-r border-gray-800 transition-all duration-300 ease-in-out',
          collapsed ? 'w-16' : 'w-64'
        )}
      >
        {/* Logo */}
        <div className={clsx(
          'flex items-center border-b border-gray-800 h-16 shrink-0 transition-all duration-300',
          collapsed ? 'px-0 justify-center' : 'px-4 gap-3'
        )}>
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
            <Zap size={17} className="text-white" />
          </div>
          {!collapsed && (
            <span className="text-base font-bold tracking-tight truncate">Dartbit</span>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto overflow-x-hidden">
          {items.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                title={collapsed ? label : undefined}
                className={clsx(
                  'flex items-center rounded-lg text-sm font-medium transition-colors group relative',
                  collapsed ? 'justify-center px-0 py-2.5 mx-0' : 'gap-3 px-3 py-2.5',
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                )}
              >
                <Icon size={18} className="shrink-0" />
                {!collapsed && <span className="truncate">{label}</span>}

                {/* Tooltip when collapsed */}
                {collapsed && (
                  <div className="absolute left-full ml-2 px-2 py-1 bg-gray-800 text-white text-xs rounded-md
                    opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity">
                    {label}
                  </div>
                )}
              </Link>
            );
          })}
        </nav>

        {/* User + collapse toggle */}
        <div className="border-t border-gray-800 p-2 space-y-1 shrink-0">
          {/* User info */}
          {!collapsed && (
            <div className="px-3 py-2">
              <p className="text-xs font-medium text-white truncate">{user?.name}</p>
              <p className="text-xs text-gray-500 truncate">{user?.email}</p>
            </div>
          )}

          {/* Logout */}
          <button
            onClick={logout}
            title={collapsed ? 'Sign out' : undefined}
            className={clsx(
              'flex items-center rounded-lg text-sm font-medium text-gray-400 hover:text-white hover:bg-gray-800 w-full transition-colors group relative',
              collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2.5'
            )}
          >
            <LogOut size={17} className="shrink-0" />
            {!collapsed && <span>Sign out</span>}
            {collapsed && (
              <div className="absolute left-full ml-2 px-2 py-1 bg-gray-800 text-white text-xs rounded-md
                opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity">
                Sign out
              </div>
            )}
          </button>

          {/* Collapse toggle */}
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

      {/* Spacer so content shifts correctly */}
      <div className={clsx('shrink-0 transition-all duration-300', collapsed ? 'w-16' : 'w-64')} />
    </>
  );
}
