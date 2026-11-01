/**
 * Topbar.tsx — business selector, user menu and mobile navigation trigger.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, ChevronDown, LogOut, Menu, User } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useBusiness } from '@/context/BusinessContext';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/cn';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  accountant: 'Accountant',
  collection_staff: 'Collection staff',
  read_only: 'Read only',
};

export function Topbar({ onOpenNav }: { onOpenNav: () => void }) {
  const { user, signOut } = useAuth();
  const { businesses, currentBusiness, selectBusiness, role } = useBusiness();
  const toast = useToast();
  const navigate = useNavigate();

  const [businessMenuOpen, setBusinessMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const businessRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click or Escape.
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (businessRef.current && !businessRef.current.contains(target)) setBusinessMenuOpen(false);
      if (userRef.current && !userRef.current.contains(target)) setUserMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setBusinessMenuOpen(false);
        setUserMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  async function handleSignOut() {
    try {
      await signOut();
      navigate('/login', { replace: true });
    } catch {
      toast.error('Could not sign out. Please try again.');
    }
  }

  const email = user?.email ?? '';
  const initial = (email[0] ?? 'U').toUpperCase();

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-surface px-4 sm:px-6">
      <button
        type="button"
        onClick={onOpenNav}
        className="rounded-lg p-2 text-muted hover:bg-slate-100 lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="size-5" />
      </button>

      {/* Business selector */}
      <div className="relative min-w-0" ref={businessRef}>
        <button
          type="button"
          onClick={() => setBusinessMenuOpen((open) => !open)}
          aria-haspopup="listbox"
          aria-expanded={businessMenuOpen}
          className="flex max-w-[220px] items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-50 sm:max-w-xs"
        >
          <Building2 className="size-4 shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-ink">
              {currentBusiness?.display_name ?? 'Select business'}
            </span>
            {role && (
              <span className="block text-[11px] text-muted">{ROLE_LABELS[role] ?? role}</span>
            )}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden="true" />
        </button>

        {businessMenuOpen && (
          <div
            role="listbox"
            className="absolute left-0 top-full z-40 mt-1 w-64 overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
          >
            {businesses.map((business) => (
              <button
                key={business.id}
                type="button"
                role="option"
                aria-selected={business.id === currentBusiness?.id}
                onClick={() => {
                  selectBusiness(business.id);
                  setBusinessMenuOpen(false);
                }}
                className={cn(
                  'flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-slate-50',
                  business.id === currentBusiness?.id && 'bg-navy-50',
                )}
              >
                <span className="font-medium text-ink">{business.display_name}</span>
                <span className="text-xs text-muted">{ROLE_LABELS[business.role] ?? business.role}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setBusinessMenuOpen(false);
                navigate('/onboarding');
              }}
              className="w-full border-t border-line px-3 py-2 text-left text-sm font-medium text-navy-700 hover:bg-slate-50"
            >
              + Add another business
            </button>
          </div>
        )}
      </div>

      <div className="flex-1" />

      {/* User menu */}
      <div className="relative" ref={userRef}>
        <button
          type="button"
          onClick={() => setUserMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={userMenuOpen}
          className="flex items-center gap-2 rounded-lg p-1 hover:bg-slate-50"
        >
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-full bg-navy-100 text-sm font-semibold text-navy-700"
          >
            {initial}
          </span>
          <span className="hidden max-w-[160px] truncate text-sm text-ink sm:block">{email}</span>
          <ChevronDown className="hidden size-4 text-muted sm:block" aria-hidden="true" />
        </button>

        {userMenuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
          >
            <div className="border-b border-line px-3 py-2">
              <p className="truncate text-sm font-medium text-ink">{email}</p>
              <p className="text-xs text-muted">{role ? ROLE_LABELS[role] ?? role : 'No business'}</p>
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setUserMenuOpen(false);
                navigate('/settings');
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-slate-50"
            >
              <User className="size-4 text-muted" aria-hidden="true" />
              Account settings
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={handleSignOut}
              className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-sm text-coral-700 hover:bg-coral-50"
            >
              <LogOut className="size-4" aria-hidden="true" />
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
