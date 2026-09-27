import React from 'react';
import { Plus, User as UserIcon, LogOut, LayoutList, ShieldCheck } from 'lucide-react';
import { User } from '../types';
import { SITE_NAME, SITE_TAGLINE } from '../lib/site';

interface HeaderProps {
  user: User | null;
  isAccountViewOpen: boolean;
  /** True while the `/admin` route is open, so its button can read as pressed. */
  isAdminViewOpen?: boolean;
  onOpenAuth: () => void;
  onOpenCreate: () => void;
  onLogout: () => void;
  onToggleAccountView: () => void;
  /** Navigates to `/admin`. Optional so existing callers/tests keep working unchanged. */
  onOpenAdminView?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  isAccountViewOpen,
  isAdminViewOpen = false,
  onOpenAuth,
  onOpenCreate,
  onLogout,
  onToggleAccountView,
  onOpenAdminView,
}) => {
  // DISPLAY ONLY. `role` arrives from the server and is cached in localStorage, both of which
  // the person at the browser can edit -- so this decides whether the button is RENDERED and
  // nothing more. `/api/admin/*` is gated by `requireAdmin` server-side, which re-reads the
  // role from the database on every request. Do not treat this as a permission check.
  const showAdminLink = Boolean(user && user.role === 'admin' && onOpenAdminView);

  return (
    <header className="sticky top-0 z-30 bg-[#e2eafc] border-b border-[#ccdbfd] shadow-sm backdrop-blur-md bg-opacity-95">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-2 sm:gap-4">

        {/* Brand Logo & Title */}
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          <img
            src="/MSA_Logo.png"
            alt={`${SITE_NAME} logo`}
            className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl object-contain bg-[#abc4ff] border border-[#ccdbfd] shadow-xs shrink-0"
          />
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg md:text-xl font-extrabold tracking-tight text-[#1e293b] truncate">
              {SITE_NAME}
            </h1>
            <p className="text-xs text-[#1e293b]/70 hidden sm:block truncate">
              {SITE_TAGLINE}
            </p>
          </div>
        </div>

        {/* Right Action Controls & User Profile */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* Create Listing Button */}
          <button
            id="create-listing-header-btn"
            onClick={onOpenCreate}
            aria-label="Create listing"
            className="flex items-center justify-center gap-2 px-3 sm:px-3.5 py-2 min-h-[44px] min-w-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-[#1e293b] text-sm font-bold shadow-xs transition-colors cursor-pointer active:scale-98"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Create Listing</span>
          </button>

          {/* User Section */}
          {user ? (
            <div className="flex items-center gap-2 pl-2 border-l border-[#ccdbfd] min-w-0">
              <div className="hidden lg:flex flex-col text-right min-w-0">
                <span className="text-xs font-bold text-[#1e293b] truncate max-w-[120px]">
                  {user.name}
                </span>
                <span className="text-[11px] text-[#1e293b]/70 truncate max-w-[120px]">
                  @{user.username}
                </span>
              </div>

              <div className="flex items-center gap-1 sm:gap-1.5 bg-[#d7e3fc] border border-[#ccdbfd] rounded-xl p-1 shrink-0">
                <div className="w-7 h-7 rounded-lg bg-[#b6ccfe] text-[#1e293b] flex items-center justify-center font-bold text-xs shrink-0">
                  {user.name.charAt(0).toUpperCase()}
                </div>

                <button
                  id="my-account-btn"
                  onClick={onToggleAccountView}
                  title={isAccountViewOpen ? 'Back to browse' : 'My listings'}
                  aria-label={isAccountViewOpen ? 'Back to browse' : 'My account: your listings'}
                  aria-pressed={isAccountViewOpen}
                  className={`inline-flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg transition-colors cursor-pointer ${
                    isAccountViewOpen
                      ? 'bg-[#abc4ff] text-[#1e293b]'
                      : 'text-[#1e293b]/80 hover:text-[#1e293b] hover:bg-[#c1d3fe]'
                  }`}
                >
                  <LayoutList className="w-3.5 h-3.5" />
                </button>

                {showAdminLink && (
                  <button
                    id="admin-panel-btn"
                    onClick={onOpenAdminView}
                    title={isAdminViewOpen ? 'Back to browse' : 'Committee admin'}
                    aria-label="Committee admin: reports, takedowns and password resets"
                    aria-pressed={isAdminViewOpen}
                    className={`inline-flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg transition-colors cursor-pointer ${
                      isAdminViewOpen
                        ? 'bg-[#abc4ff] text-[#1e293b]'
                        : 'text-[#1e293b]/80 hover:text-[#1e293b] hover:bg-[#c1d3fe]'
                    }`}
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                  </button>
                )}

                <button
                  id="user-logout-btn"
                  onClick={onLogout}
                  title="Sign Out"
                  aria-label="Sign out"
                  className="inline-flex items-center justify-center p-2 min-h-[38px] min-w-[38px] rounded-lg text-[#1e293b]/80 hover:text-[#1e293b] hover:bg-[#c1d3fe] transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : (
            <button
              id="sign-in-btn"
              onClick={onOpenAuth}
              className="flex items-center justify-center gap-1.5 px-3 sm:px-3.5 py-2 min-h-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-[#1e293b] text-sm font-semibold transition-colors shadow-xs shrink-0"
            >
              <UserIcon className="w-4 h-4" />
              <span>Sign In</span>
            </button>
          )}
        </div>

      </div>
    </header>
  );
};
