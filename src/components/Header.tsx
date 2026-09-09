import React from 'react';
import { Gavel, Plus, User as UserIcon, LogOut, Radio, ShieldCheck } from 'lucide-react';
import { User } from '../types';

interface HeaderProps {
  user: User | null;
  isConnected: boolean;
  onOpenAuth: () => void;
  onOpenCreate: () => void;
  onLogout: () => void;
  onQuickSwitchUser: (username: string) => void;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  isConnected,
  onOpenAuth,
  onOpenCreate,
  onLogout,
  onQuickSwitchUser,
}) => {
  return (
    <header className="sticky top-0 z-30 bg-[#e2eafc] border-b border-[#ccdbfd] shadow-sm backdrop-blur-md bg-opacity-95">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        
        {/* Brand Logo & Title */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#abc4ff] border border-[#ccdbfd] flex items-center justify-center shadow-xs text-[#1e293b]">
            <Gavel className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-extrabold tracking-tight text-[#1e293b]">
                MSA Auction
              </h1>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-[#b6ccfe] text-[#1e293b] border border-[#c1d3fe] uppercase tracking-wider">
                Live
              </span>
            </div>
            <p className="text-xs text-[#1e293b]/70 hidden sm:block">
              Real-time bi-directional bidding system
            </p>
          </div>
        </div>

        {/* Center Live Socket Status */}
        <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#d7e3fc] border border-[#ccdbfd] text-xs font-semibold text-[#1e293b]">
          <span className="relative flex h-2.5 w-2.5">
            {isConnected ? (
              <>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </>
            ) : (
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
            )}
          </span>
          <Radio className="w-3.5 h-3.5 opacity-80" />
          <span>{isConnected ? 'Socket.io Connected' : 'Connecting to Server...'}</span>
        </div>

        {/* Right Action Controls & User Profile */}
        <div className="flex items-center gap-3">
          {/* Create Listing Button */}
          <button
            id="create-listing-header-btn"
            onClick={onOpenCreate}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-[#1e293b] text-sm font-bold shadow-xs transition-colors cursor-pointer active:scale-98"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Create Listing</span>
          </button>

          {/* User Section */}
          {user ? (
            <div className="flex items-center gap-2 pl-2 border-l border-[#ccdbfd]">
              <div className="hidden lg:flex flex-col text-right">
                <span className="text-xs font-bold text-[#1e293b] truncate max-w-[120px]">
                  {user.name}
                </span>
                <span className="text-[11px] text-[#1e293b]/70 truncate max-w-[120px]">
                  @{user.username}
                </span>
              </div>

              {/* User Dropdown / Switcher */}
              <div className="flex items-center gap-1.5 bg-[#d7e3fc] border border-[#ccdbfd] rounded-xl p-1">
                <div className="w-7 h-7 rounded-lg bg-[#b6ccfe] text-[#1e293b] flex items-center justify-center font-bold text-xs">
                  {user.name.charAt(0).toUpperCase()}
                </div>

                <button
                  id="user-logout-btn"
                  onClick={onLogout}
                  title="Sign Out"
                  className="p-1 rounded-lg text-[#1e293b]/80 hover:text-[#1e293b] hover:bg-[#c1d3fe] transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : (
            <button
              id="sign-in-btn"
              onClick={onOpenAuth}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-[#1e293b] text-sm font-semibold transition-colors shadow-xs"
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
