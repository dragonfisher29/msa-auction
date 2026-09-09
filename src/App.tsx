import React, { useState, useEffect, useMemo } from 'react';
import {
  Gavel,
  Search,
  Filter,
  Flame,
  Clock,
  Sparkles,
  TrendingUp,
  Radio,
  PlusCircle,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { AuctionItem, User } from './types';
import { Header } from './components/Header';
import { AuctionCard } from './components/AuctionCard';
import { AuctionDetailModal } from './components/AuctionDetailModal';
import { CreateListingModal } from './components/CreateListingModal';
import { AuthModal } from './components/AuthModal';
import { apiFetch } from './lib/api';
import { getSocket } from './lib/socket';

export default function App() {
  // --- Application State ---
  const [auctions, setAuctions] = useState<AuctionItem[]>([]);
  const [selectedAuction, setSelectedAuction] = useState<AuctionItem | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Modals
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'ending_soon' | 'ended'>('all');
  const [sortBy, setSortBy] = useState<'ending_soonest' | 'price_high' | 'price_low' | 'most_bids'>('ending_soonest');

  // Load user session from localStorage on start
  useEffect(() => {
    try {
      const saved = localStorage.getItem('msa_auction_user');
      if (saved) {
        setUser(JSON.parse(saved));
      }
    } catch {
      // ignore
    }
  }, []);

  const handleAuthSuccess = (authUser: User) => {
    setUser(authUser);
    localStorage.setItem('msa_auction_user', JSON.stringify(authUser));
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('msa_auction_user');
  };

  // Fetch initial auctions
  const fetchAuctions = async () => {
    try {
      setIsLoading(true);
      const res = await apiFetch('/api/auctions');
      if (res.ok) {
        const data = await res.json();
        setAuctions(data.auctions || []);
      }
    } catch (err) {
      console.error('Failed to load auctions:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAuctions();
  }, []);

  // Real-time Global Socket.io listeners
  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);

    if (socket.connected) {
      setIsConnected(true);
    }

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    // Global listener for auction updates (new listing created, bid placed, auction ended)
    socket.on('auction_list_updated', ({ type, auction }: { type: string; auction: AuctionItem }) => {
      setAuctions((prev) => {
        const exists = prev.some((a) => a.id === auction.id);
        if (!exists) {
          return [auction, ...prev];
        }
        return prev.map((a) => (a.id === auction.id ? auction : a));
      });

      // Also update currently active modal if open
      setSelectedAuction((curr) => (curr && curr.id === auction.id ? auction : curr));
    });

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('auction_list_updated');
    };
  }, []);

  // Handle single item update from modal
  const handleAuctionUpdated = (updated: AuctionItem) => {
    setAuctions((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  // Compute live filtered and sorted auctions
  const filteredAuctions = useMemo(() => {
    const now = Date.now();

    return auctions
      .filter((item) => {
        // Search query
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const matchTitle = item.title.toLowerCase().includes(q);
          const matchDesc = item.description.toLowerCase().includes(q);
          const matchSeller = item.sellerName.toLowerCase().includes(q);
          const matchCategory = item.category?.toLowerCase().includes(q);
          if (!matchTitle && !matchDesc && !matchSeller && !matchCategory) {
            return false;
          }
        }

        // Status filter
        const isEnded = item.status === 'ended' || item.endTime <= now;
        const timeRemaining = item.endTime - now;

        if (statusFilter === 'active') {
          return !isEnded;
        }
        if (statusFilter === 'ending_soon') {
          return !isEnded && timeRemaining <= 15 * 60 * 1000;
        }
        if (statusFilter === 'ended') {
          return isEnded;
        }

        return true;
      })
      .sort((a, b) => {
        const now = Date.now();
        const aEnded = a.status === 'ended' || a.endTime <= now;
        const bEnded = b.status === 'ended' || b.endTime <= now;

        // Active items always appear above ended items unless filtered
        if (statusFilter === 'all') {
          if (!aEnded && bEnded) return -1;
          if (aEnded && !bEnded) return 1;
        }

        if (sortBy === 'ending_soonest') {
          return a.endTime - b.endTime;
        }
        if (sortBy === 'price_high') {
          return b.currentPrice - a.currentPrice;
        }
        if (sortBy === 'price_low') {
          return a.currentPrice - b.currentPrice;
        }
        if (sortBy === 'most_bids') {
          return b.bids.length - a.bids.length;
        }

        return 0;
      });
  }, [auctions, searchQuery, statusFilter, sortBy]);

  // Aggregate stats
  const activeCount = auctions.filter((a) => a.status === 'active' && a.endTime > Date.now()).length;
  const totalBidsCount = auctions.reduce((acc, curr) => acc + curr.bids.length, 0);

  return (
    <div className="min-h-screen bg-[#edf2fb] text-[#1e293b] flex flex-col selection:bg-[#abc4ff] selection:text-[#1e293b]">
      
      {/* Top Navigation Header */}
      <Header
        user={user}
        isConnected={isConnected}
        onOpenAuth={() => setIsAuthModalOpen(true)}
        onOpenCreate={() => setIsCreateModalOpen(true)}
        onLogout={handleLogout}
        onQuickSwitchUser={(username) => {}}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6">
        
        {/* Live Overview Bar */}
        <div className="bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl p-5 shadow-xs">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            
            {/* Title & Live Status */}
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl sm:text-2xl font-black text-[#1e293b] tracking-tight">
                  Live Bidding Dashboard
                </h2>
                <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#abc4ff] border border-[#c1d3fe] text-[#1e293b] text-xs font-bold">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
                  Active Room
                </span>
              </div>
              <p className="text-xs sm:text-sm text-[#1e293b]/75 mt-1">
                Participate in real-time auctions with instant bi-directional price broadcasts.
              </p>
            </div>

            {/* Quick Metrics */}
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
              <div className="px-3.5 py-2 rounded-xl bg-[#d7e3fc] border border-[#ccdbfd] text-center shrink-0">
                <span className="text-[11px] font-bold text-[#1e293b]/70 block uppercase tracking-wider">
                  Live Auctions
                </span>
                <span className="text-lg font-extrabold text-[#1e293b]">
                  {activeCount}
                </span>
              </div>

              <div className="px-3.5 py-2 rounded-xl bg-[#d7e3fc] border border-[#ccdbfd] text-center shrink-0">
                <span className="text-[11px] font-bold text-[#1e293b]/70 block uppercase tracking-wider">
                  Total Bids Placed
                </span>
                <span className="text-lg font-extrabold text-[#1e293b]">
                  {totalBidsCount}
                </span>
              </div>

              <button
                id="refresh-auctions-btn"
                onClick={fetchAuctions}
                title="Refresh Auctions"
                className="p-2.5 rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-[#1e293b] transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

          </div>
        </div>

        {/* Search, Status Tabs & Sorting Filter Controls */}
        <div className="bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl p-4 shadow-xs space-y-3">
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
            
            {/* Search Input */}
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
              <input
                id="search-auctions-input"
                type="text"
                placeholder="Search items by title, description, or seller..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-sm text-[#1e293b] placeholder-[#1e293b]/45 font-medium"
              />
            </div>

            {/* Sort Dropdown */}
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-bold text-[#1e293b]/70 hidden sm:inline">Sort:</span>
              <select
                id="sort-auctions-select"
                value={sortBy}
                onChange={(e: any) => setSortBy(e.target.value)}
                className="px-3 py-2.5 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] text-xs font-bold text-[#1e293b] focus:border-[#abc4ff] focus:outline-hidden cursor-pointer"
              >
                <option value="ending_soonest">Ending Soonest</option>
                <option value="price_high">Highest Price</option>
                <option value="price_low">Lowest Price</option>
                <option value="most_bids">Most Bids</option>
              </select>
            </div>

          </div>

          {/* Filter Tabs */}
          <div className="flex items-center gap-2 overflow-x-auto pt-1 pb-0.5">
            {[
              { id: 'all', label: 'All Listings', count: auctions.length },
              { id: 'active', label: 'Active Live', count: activeCount },
              { id: 'ending_soon', label: 'Ending Soon (<15m)', count: auctions.filter((a) => a.status === 'active' && a.endTime - Date.now() <= 15 * 60 * 1000 && a.endTime > Date.now()).length },
              { id: 'ended', label: 'Concluded', count: auctions.filter((a) => a.status === 'ended' || a.endTime <= Date.now()).length },
            ].map((tab) => (
              <button
                key={tab.id}
                id={`filter-tab-${tab.id}`}
                onClick={() => setStatusFilter(tab.id as any)}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all shrink-0 flex items-center gap-1.5 ${
                  statusFilter === tab.id
                    ? 'bg-[#abc4ff] border border-[#c1d3fe] text-[#1e293b] shadow-xs'
                    : 'bg-[#d7e3fc] border border-[#ccdbfd] text-[#1e293b]/75 hover:bg-[#c1d3fe]'
                }`}
              >
                <span>{tab.label}</span>
                <span className={`px-1.5 py-0.2 rounded-md text-[10px] ${
                  statusFilter === tab.id ? 'bg-[#b6ccfe]' : 'bg-[#e2eafc]'
                }`}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Auctions Grid Layout */}
        {isLoading && auctions.length === 0 ? (
          <div className="py-20 text-center bg-[#e2eafc] rounded-2xl border border-[#ccdbfd]">
            <RefreshCw className="w-8 h-8 mx-auto animate-spin text-[#abc4ff] mb-3" />
            <p className="text-sm font-bold text-[#1e293b]">Connecting to live auction feed...</p>
          </div>
        ) : filteredAuctions.length === 0 ? (
          <div className="py-16 text-center bg-[#e2eafc] rounded-2xl border border-[#ccdbfd] p-6">
            <AlertCircle className="w-10 h-10 mx-auto text-[#1e293b]/50 mb-3" />
            <h3 className="text-base font-bold text-[#1e293b]">No auctions match your filters</h3>
            <p className="text-xs text-[#1e293b]/70 mt-1 max-w-sm mx-auto">
              Try adjusting your search terms or view all active auctions to place bids.
            </p>
            <button
              onClick={() => { setSearchQuery(''); setStatusFilter('all'); }}
              className="mt-4 px-4 py-2 rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] text-xs font-bold text-[#1e293b]"
            >
              Reset Filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
            {filteredAuctions.map((auction) => (
              <AuctionCard
                key={auction.id}
                auction={auction}
                onSelect={(selected) => setSelectedAuction(selected)}
              />
            ))}
          </div>
        )}

      </main>

      {/* Footer */}
      <footer className="mt-12 border-t border-[#ccdbfd] bg-[#e2eafc] py-6 text-center text-xs text-[#1e293b]/70">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Gavel className="w-4 h-4 text-[#1e293b]" />
            <span className="font-extrabold text-[#1e293b]">MSA Auction</span>
            <span>— Bi-directional Real-Time Bidding</span>
          </div>
          <p className="text-[11px]">
            Built by <a href="https://github.com/dragonfisher29">dragonfisher29</a>
          </p>
        </div>
      </footer>

      {/* Modals */}
      {selectedAuction && (
        <AuctionDetailModal
          auction={selectedAuction}
          user={user}
          onClose={() => setSelectedAuction(null)}
          onPromptAuth={() => setIsAuthModalOpen(true)}
          onAuctionUpdated={handleAuctionUpdated}
        />
      )}

      {isCreateModalOpen && (
        <CreateListingModal
          isOpen={isCreateModalOpen}
          user={user}
          onClose={() => setIsCreateModalOpen(false)}
          onCreated={(newAuction) => {
            setAuctions((prev) => [newAuction, ...prev]);
            setSelectedAuction(newAuction);
          }}
          onPromptAuth={() => {
            setIsCreateModalOpen(false);
            setIsAuthModalOpen(true);
          }}
        />
      )}

      {isAuthModalOpen && (
        <AuthModal
          isOpen={isAuthModalOpen}
          onClose={() => setIsAuthModalOpen(false)}
          onAuthSuccess={handleAuthSuccess}
        />
      )}

    </div>
  );
}
