/**
 * Sidebar.tsx — primary navigation.
 *
 * Desktop: fixed 250px rail. Mobile: off-canvas drawer controlled by AppLayout.
 * Only modules that actually exist are listed; future phases are not shown as
 * working links.
 */

import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  Users,
  Wallet,
  BarChart3,
  Settings,
  X,
} from 'lucide-react';
import { cn } from '@/lib/cn';

export interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/invoices', label: 'Invoices', icon: FileText },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/payments', label: 'Payments', icon: Wallet },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: Settings },
];

interface SidebarProps {
  /** Mobile drawer open state. Ignored on desktop. */
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ open, onClose }: SidebarProps) {
  return (
    <>
      {/* Mobile backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-ink/40 transition-opacity lg:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[250px] flex-col border-r border-line bg-surface',
          'transition-transform duration-200 lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Sidebar"
      >
        <div className="flex h-16 items-center justify-between border-b border-line px-5">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-lg bg-navy-700 text-sm font-bold text-white"
            >
              B
            </span>
            <span className="text-base font-semibold tracking-tight text-ink">BizPilot</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-slate-100 lg:hidden"
            aria-label="Close navigation"
          >
            <X className="size-5" />
          </button>
        </div>

        <nav aria-label="Main navigation" className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-navy-50 text-navy-700'
                    : 'text-muted hover:bg-slate-50 hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon className="size-4 shrink-0" aria-hidden="true" />
                  <span>{item.label}</span>
                  {isActive && <span className="sr-only">(current page)</span>}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-line px-5 py-4">
          <p className="text-xs text-muted">
            Accounts receivable
            <br />
            <span className="text-[11px]">Phase 1</span>
          </p>
        </div>
      </aside>
    </>
  );
}
