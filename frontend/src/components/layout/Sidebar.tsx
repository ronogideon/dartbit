'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import {
  LayoutDashboard, Users, Package, CreditCard, MessageSquare,
  Router, Settings, Activity, LogOut, Zap, Building2
} from 'lucide-react';
import clsx from 'clsx';

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

  const items = user?.role === 'SUPERADMIN' ? [...superAdminItems, ...navItems] : navItems;

  return (
    <aside className="w-64 bg-gray-900 dark:bg-gray-950 text-white flex flex-col h-screen fixed left-0 top-0 z-40 border-r border-gray-800">
      {/* Logo */}
      <div className="px-6 py-5 border-b border-gray-800 flex items-center gap-3">
        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
          <Zap size={18} className="text-white" />
        </div>
        <span className="text-lg font-bold tracking-tight">Dartbit</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {items.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                active
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              )}
            >
              <Icon size={17} />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* User */}
      <div className="px-3 py-4 border-t border-gray-800">
        <div className="px-3 py-2 mb-1">
          <p className="text-xs font-medium text-white truncate">{user?.name}</p>
          <p className="text-xs text-gray-500 truncate">{user?.email}</p>
        </div>
        <button
          onClick={logout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-400 hover:text-white hover:bg-gray-800 w-full transition-colors"
        >
          <LogOut size={17} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
