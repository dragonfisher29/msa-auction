import React, { useState, useEffect, useMemo, useRef } from 'react';
import { BrowserRouter, useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom';
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
  Star,
  ChevronDown,
} from 'lucide-react';
import { AuctionItem, User } from './types';
import { Header } from './components/Header';
import { AuctionCard } from './components/AuctionCard';
import { AuctionDetailModal } from './components/AuctionDetailModal';
import { CreateListingModal } from './components/CreateListingModal';
import { AuthModal, AuthModalMode } from './components/AuthModal';
import { AccountView } from './components/AccountView';
import { AdminView } from './components/AdminView';
import { ResetPasswordView } from './components/ResetPasswordView';
import { apiFetch, apiFetchAuthed } from './lib/api';
import { clearReadNotificationIds } from './lib/notificationStorage';
import { startPolling, checkHealth } from './lib/realtime';
import { CATEGORIES } from './lib/categories';
import { INVALID_CURSOR, readErrorCode } from './lib/apiErrors';

type StatusFilter = 'all' | 'active' | 'ending_soon' | 'ended' | 'watchlist';
type SortBy = 'ending_soonest' | 'price_high' | 'price_low' | 'most_bids';

const AUCTIONS_PAGE_SIZE = 24;

/** Builds the `GET /api/auctions` query string for one page. */
function auctionsPageUrl(cursor: string | null): string {
  const params = new URLSearchParams({ limit: String(AUCTIONS_PAGE_SIZE) });
  if (cursor) {
    params.set('cursor', cursor);
  }
  return `/api/auctions?${params.toString()}`;
}

// react-router-dom needs a Router ancestor for its hooks; wrapping here (rather than in
// main.tsx) keeps every existing `render(<App />)` in the test suite working unchanged.
export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}

function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const auctionRouteMatch = useMatch('/auction/:id');
  const accountRouteMatch = useMatch('/account');
  const adminRouteMatch = useMatch('/admin');
  const resetPasswordRouteMatch = useMatch('/reset-password');

  // --- Application State ---
  const [auctions, setAuctions] = useState<AuctionItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  // The auction behind a deep link (`/auction/:id`) that isn't part of any loaded page -- fetched
  // directly by id so a shared link still opens even if the item has scrolled off the list.
  const [deepLinkedAuction, setDeepLinkedAuction] = useState<AuctionItem | null>(null);
  const [user, setUser] = useState<User | null>(null);
  // Flips true once the stored-session bootstrap below has resolved one way or the other, so the
  // `/account` sign-out redirect (further down) never fires against the momentarily-null `user`
  // that exists before that check has had a chance to run.
  const [isSessionChecked, setIsSessionChecked] = useState<boolean>(false);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [watchlistIds, setWatchlistIds] = useState<string[]>([]);

  // Modals
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  // Which form AuthModal opens on. `/reset-password` sends people here on a dead token, and it
  // has to land on the recovery form rather than a sign-in box they cannot get past.
  const [authModalMode, setAuthModalMode] = useState<AuthModalMode>('login');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);

  const openAuthModal = (mode: AuthModalMode = 'login') => {
    setAuthModalMode(mode);
    setIsAuthModalOpen(true);
  };

  // My Listings / My Bids / My Wins lives at `/account`, driven entirely by the route rather than
  // its own boolean: that keeps the browser's back button and a bookmarked/shared link working
  // for it exactly like the auction detail modal below.
  const isAccountViewOpen = Boolean(accountRouteMatch);

  // `/admin` follows exactly the same route-driven pattern as `/account` above, including its
  // redirect when the visitor is not entitled to it (see the effect further down).
  const isAdminViewOpen = Boolean(adminRouteMatch);

  // `/reset-password?token=...` is reachable SIGNED OUT by design -- someone who has forgotten
  // their password has no session to check.
  const isResetPasswordOpen = Boolean(resetPasswordRouteMatch);
  const resetPasswordToken = searchParams.get('token') ?? '';

  // The selected auction id also comes from the route (`/auction/:id`) rather than local state,
  // so opening one is a real navigation: shareable, deep-linkable, and closed by the browser's
  // own back button.
  const selectedAuctionId = auctionRouteMatch?.params.id ?? null;

  // True only when this tab's own click opened the current auction/account route (as opposed to
  // landing on it directly, e.g. a pasted deep link). Closing then prefers a real `navigate(-1)`
  // so the back button's "one step closes the modal" behaviour holds; a route reached by direct
  // navigation has no in-app history entry to go back to, so closing instead navigates straight
  // to `/` rather than leaving the app entirely.
  const openedViaInAppNavRef = useRef(false);

  // Search & Filter state: kept in the URL query string (rather than component state) so a
  // filtered/sorted view is shareable and survives a reload. The state *shape* is unchanged from
  // before -- only where it's read from and written to.
  const searchQuery = searchParams.get('q') ?? '';
  const selectedCategory = searchParams.get('category') ?? 'All';
  const statusFilter = (searchParams.get('status') as StatusFilter | null) ?? 'all';
  const sortBy = (searchParams.get('sort') as SortBy | null) ?? 'ending_soonest';

  // Applies one filter change to the query string, dropping the key entirely when it's back to
  // its default so the URL stays clean (no `?status=all&sort=ending_soonest&...` on every load).
  // `replace: true` so typing in the search box or flipping tabs doesn't flood browser history.
  function updateFilterParam(key: 'q' | 'category' | 'status' | 'sort', value: string, defaultValue: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === defaultValue || value === '') {
          next.delete(key);
        } else {
          next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  }

  const setSearchQuery = (value: string) => updateFilterParam('q', value, '');
  const setSelectedCategory = (value: string) => updateFilterParam('category', value, 'All');
  const setStatusFilter = (value: StatusFilter) => updateFilterParam('status', value, 'all');
  const setSortBy = (value: SortBy) => updateFilterParam('sort', value, 'ending_soonest');

  function openAuction(auction: AuctionItem) {
    openedViaInAppNavRef.current = true;
    navigate(`/auction/${auction.id}${location.search}`);
  }

  function openAuctionById(auctionId: string) {
    openedViaInAppNavRef.current = true;
    navigate(`/auction/${auctionId}${location.search}`);
  }

  function closeAuctionModal() {
    if (openedViaInAppNavRef.current) {
      navigate(-1);
    } else {
      navigate(`/${location.search}`);
    }
    openedViaInAppNavRef.current = false;
  }

  function toggleAccountView() {
    if (isAccountViewOpen) {
      if (openedViaInAppNavRef.current) {
        navigate(-1);
      } else {
        navigate(`/${location.search}`);
      }
      openedViaInAppNavRef.current = false;
    } else {
      openedViaInAppNavRef.current = true;
      navigate('/account');
    }
  }

  function toggleAdminView() {
    if (isAdminViewOpen) {
      if (openedViaInAppNavRef.current) {
        navigate(-1);
      } else {
        navigate(`/${location.search}`);
      }
      openedViaInAppNavRef.current = false;
    } else {
      openedViaInAppNavRef.current = true;
      navigate('/admin');
    }
  }

  // Load user session & watchlist from localStorage on start
  useEffect(() => {
    let savedUser: User | null = null;
    try {
      const raw = localStorage.getItem('msa_auction_user');
      if (raw) {
        savedUser = JSON.parse(raw);
      }
      const savedWatchlist = localStorage.getItem('msa_watchlist_ids');
      if (savedWatchlist) {
        setWatchlistIds(JSON.parse(savedWatchlist));
      }
    } catch {
      // ignore
    }

    if (!savedUser) {
      setIsSessionChecked(true);
      return;
    }

    // Bidding now requires a bearer token, but a session stored before that change (or one
    // that has simply expired) still looks signed-in to the header. Show it optimistically,
    // then confirm it against the server so the header is never lying: a missing token or a
    // real 401 drops back to signed-out, quietly. A network blip is not evidence the session
    // is bad, so it is left alone.
    setUser(savedUser);

    if (!savedUser.token) {
      setUser(null);
      localStorage.removeItem('msa_auction_user');
      setIsSessionChecked(true);
      return;
    }

    (async () => {
      try {
        const res = await apiFetchAuthed('/api/auth/me', savedUser!.token);
        if (res.status === 401) {
          setUser(null);
          localStorage.removeItem('msa_auction_user');
        }
      } catch (err) {
        console.warn('Could not verify the stored session:', err);
      } finally {
        setIsSessionChecked(true);
      }
    })();
  }, []);

  // `/account` is signed-in only; redirect to the dashboard (preserving any filter query string)
  // once we're sure there's no session, rather than on the very first render where `user` is
  // still momentarily null while the check above is in flight.
  useEffect(() => {
    if (isSessionChecked && !user && isAccountViewOpen) {
      navigate(`/${location.search}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSessionChecked, user, isAccountViewOpen]);

  // `/admin` is admin-only, redirected exactly like `/account` is for a signed-out visitor and
  // for the same reason: a route nobody can use should not sit there rendering an empty shell.
  //
  // This is NOT the security boundary. `user.role` came from the server but now lives in
  // localStorage, where the person at the browser can set it to anything; someone who does that
  // gets the panel to render and then watches every single action inside it come back
  // 403 NOT_ADMIN, because `requireAdmin` re-reads the role from the database on every
  // `/api/admin/*` request. Keep it that way -- nothing here should ever become the thing that
  // decides whether a moderation action is allowed.
  useEffect(() => {
    if (isSessionChecked && isAdminViewOpen && (!user || user.role !== 'admin')) {
      navigate(`/${location.search}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSessionChecked, user, isAdminViewOpen]);

  const handleToggleWatchlist = (auctionId: string) => {
    setWatchlistIds((prev) => {
      const next = prev.includes(auctionId) ? prev.filter((id) => id !== auctionId) : [...prev, auctionId];
      localStorage.setItem('msa_watchlist_ids', JSON.stringify(next));
      return next;
    });
  };

  const handleAuthSuccess = (authUser: User) => {
    setUser(authUser);
    localStorage.setItem('msa_auction_user', JSON.stringify(authUser));
  };

  // The recovery-email prompt in AccountView saved an address: fold it into the session held
  // here (and the stored copy), so the prompt stays gone on the next page load too.
  const handleEmailSaved = (email: string) => {
    setUser((prev) => {
      if (!prev) {
        return prev;
      }
      const next = { ...prev, email };
      localStorage.setItem('msa_auction_user', JSON.stringify(next));
      return next;
    });
  };

  const handleLogout = () => {
    // Notification read state is per-user and is dropped here, so the next account signing in
    // on this browser does not inherit it. (The watchlist above is knowingly device-local and
    // is left alone -- that is a separate, already-tracked issue.)
    if (user) {
      clearReadNotificationIds(user.id);
    }
    setUser(null);
    if (isAccountViewOpen || isAdminViewOpen) {
      navigate('/', { replace: true });
    }
    localStorage.removeItem('msa_auction_user');
  };

  // Fetch the first page of auctions, replacing whatever was loaded before (used on mount and by
  // the manual refresh button -- both are "start over from the top" actions).
  const fetchAuctions = async () => {
    try {
      setIsLoading(true);
      const res = await apiFetch(auctionsPageUrl(null));
      if (res.ok) {
        const data = await res.json();
        setAuctions(data.auctions || []);
        setNextCursor(data.nextCursor ?? null);
        // Resolve the header status from the very first fetch instead of waiting for a health tick
        setIsConnected(true);
      } else {
        setIsConnected(false);
      }
    } catch (err) {
      console.error('Failed to load auctions:', err);
      setIsConnected(false);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAuctions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Appends the next page onto the already-loaded list rather than replacing it, so scroll
  // position and everything already on screen is undisturbed. A button rather than infinite
  // scroll: filtering/sorting here is done client-side over whatever's been loaded, so an
  // explicit "Load More" keeps that pool -- and the resulting network usage -- predictable and
  // makes it obvious to the user when there's more to fetch, rather than silently loading pages
  // behind their back while they scroll past a long filtered result.
  const handleLoadMore = async () => {
    if (!nextCursor || isLoadingMore) {
      return;
    }
    setIsLoadingMore(true);
    try {
      const res = await apiFetch(auctionsPageUrl(nextCursor));
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        // A stale/tampered cursor (e.g. an old bookmarked state) is recovered from by dropping it
        // and starting over from page one, rather than leaving the grid stuck behind a dead-end
        // error with no way to see more listings at all.
        if (readErrorCode(data) === INVALID_CURSOR) {
          setNextCursor(null);
          await fetchAuctions();
        }
        return;
      }

      const newAuctions = (data?.auctions || []) as AuctionItem[];
      setAuctions((prev) => {
        const existingIds = new Set(prev.map((a) => a.id));
        return [...prev, ...newAuctions.filter((a) => !existingIds.has(a.id))];
      });
      setNextCursor(data?.nextCursor ?? null);
    } catch (err) {
      console.error('Failed to load more auctions:', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Live auction feed: the Cloudflare Worker is REST-only, so we poll instead of using sockets.
  // Always re-polls just the first page: it merges into whatever's loaded (see below) rather than
  // replacing it, so pages fetched via "Load More" are left alone, and it deliberately leaves
  // `nextCursor` untouched so an in-progress "Load More" sequence doesn't get reset by a
  // background refresh.
  useEffect(() => {
    const stopAuctionsPoll = startPolling<AuctionItem[]>(
      async () => {
        const res = await apiFetch(auctionsPageUrl(null));
        if (!res.ok) {
          throw new Error(`Auction feed responded with ${res.status}`);
        }
        const data = await res.json();
        return (data.auctions || []) as AuctionItem[];
      },
      5000,
      (nextAuctions) => {
        setIsConnected(true);

        setAuctions((prev) => {
          const serverById = new Map(nextAuctions.map((a) => [a.id, a]));
          const knownIds = new Set(prev.map((a) => a.id));
          // Server rows win; brand-new rows are prepended, local-only rows are kept
          const updated = prev.map((a) => serverById.get(a.id) ?? a);
          const added = nextAuctions.filter((a) => !knownIds.has(a.id));
          return [...added, ...updated];
        });

        // Also keep a deep-linked auction (fetched outside the list, see below) fresh if it
        // happens to also be on this page.
        setDeepLinkedAuction((curr) => {
          if (!curr) return curr;
          return nextAuctions.find((a) => a.id === curr.id) ?? curr;
        });
      },
    );

    // Slower health ping drives the connection indicator in the header
    const stopHealthPoll = startPolling<boolean>(checkHealth, 15000, (isHealthy) => {
      setIsConnected(isHealthy);
    });

    return () => {
      stopAuctionsPoll();
      stopHealthPoll();
    };
  }, []);

  // Read inside the effect below without making every poll-driven `auctions` update re-run it --
  // only a genuine change of *which* auction id is selected should trigger a new fetch.
  const auctionsRef = useRef(auctions);
  useEffect(() => {
    auctionsRef.current = auctions;
  }, [auctions]);

  // Resolves the auction behind `/auction/:id`: the copy already in the loaded pages when
  // there is one, otherwise a direct `GET /api/auctions/:id` fetch -- this is what makes a link
  // to an item outside the current page (or shared from someone else's browser entirely) still
  // open. A no-op on failure, same as the rest of this app's "degrade quietly" error handling.
  useEffect(() => {
    if (!selectedAuctionId) {
      setDeepLinkedAuction(null);
      return;
    }
    if (auctionsRef.current.some((a) => a.id === selectedAuctionId)) {
      setDeepLinkedAuction(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        // Authed when a session exists, same as AuctionDetailModal's own poll -- GET
        // /api/auctions/:id only sends phoneNumber back for a signed-in caller (see
        // mapAuctionDetailRow in workers/index.ts), so a signed-in visitor opening a shared link
        // sees the seller's contact details immediately instead of waiting on the modal's first
        // 3s poll to correct it.
        const res = await apiFetchAuthed(`/api/auctions/${selectedAuctionId}`, user?.token);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.auction) {
          setDeepLinkedAuction(data.auction as AuctionItem);
        }
      } catch (err) {
        console.warn('Could not open the linked auction:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedAuctionId, user]);

  const selectedAuction = selectedAuctionId
    ? auctions.find((a) => a.id === selectedAuctionId) ?? deepLinkedAuction
    : null;

  // Handle single item update from the detail modal, the account view's edit/cancel flows, or
  // any other place an auction gets patched -- keeps both the main list and a deep-linked-only
  // auction (which isn't part of `auctions` at all) in sync.
  const handleAuctionUpdated = (updated: AuctionItem) => {
    setAuctions((prev) => (prev.some((a) => a.id === updated.id) ? prev.map((a) => (a.id === updated.id ? updated : a)) : prev));
    setDeepLinkedAuction((curr) => (curr && curr.id === updated.id ? updated : curr));
  };

  // Compute live filtered and sorted auctions
  const filteredAuctions = useMemo(() => {
    const now = Date.now();

    return auctions
      .filter((item) => {
        // Category Filter
        if (selectedCategory !== 'All') {
          const itemCat = item.category?.toLowerCase() || 'general';
          const targetCat = selectedCategory.toLowerCase();
          if (!itemCat.includes(targetCat) && targetCat !== itemCat) {
            return false;
          }
        }

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
        const isEnded = item.status === 'ended' || item.status === 'cancelled' || item.endTime <= now;
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
        if (statusFilter === 'watchlist') {
          return watchlistIds.includes(item.id);
        }

        return true;
      })
      .sort((a, b) => {
        const now = Date.now();
        const aEnded = a.status === 'ended' || a.status === 'cancelled' || a.endTime <= now;
        const bEnded = b.status === 'ended' || b.status === 'cancelled' || b.endTime <= now;

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
  }, [auctions, searchQuery, selectedCategory, statusFilter, sortBy, watchlistIds]);

  // Aggregate stats
  const activeCount = auctions.filter((a) => a.status === 'active' && a.endTime > Date.now()).length;
  const totalBidsCount = auctions.reduce((acc, curr) => acc + curr.bids.length, 0);

  return (
    <div className="min-h-screen bg-[#edf2fb] text-[#1e293b] flex flex-col selection:bg-[#abc4ff] selection:text-[#1e293b]">
      
      {/* Top Navigation Header */}
      <Header
        user={user}
        isConnected={isConnected}
        isAccountViewOpen={isAccountViewOpen}
        isAdminViewOpen={isAdminViewOpen}
        onOpenAuth={() => openAuthModal('login')}
        onOpenCreate={() => setIsCreateModalOpen(true)}
        onLogout={handleLogout}
        onQuickSwitchUser={(username) => {}}
        onToggleAccountView={toggleAccountView}
        onOpenAuctionById={openAuctionById}
        onOpenAdminView={toggleAdminView}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6">

        {/* Signed-in account view replaces the browse experience while it is open. Clicking a
            card in it opens the same AuctionDetailModal the grid opens. */}
        {isResetPasswordOpen ? (
        <ResetPasswordView
          token={resetPasswordToken}
          onResetComplete={(resetUser) => {
            handleAuthSuccess(resetUser);
            navigate('/', { replace: true });
          }}
          onRequestNewLink={() => openAuthModal('forgot')}
          onClose={() => navigate('/', { replace: true })}
        />
        ) : user && user.role === 'admin' && isAdminViewOpen ? (
        <AdminView
          user={user}
          onClose={toggleAdminView}
          onOpenAuctionById={openAuctionById}
        />
        ) : user && isAccountViewOpen ? (
        <AccountView
          user={user}
          watchlistIds={watchlistIds}
          onToggleWatchlist={handleToggleWatchlist}
          onSelectAuction={openAuction}
          onClose={toggleAccountView}
          onPromptAuth={() => openAuthModal('login')}
          onAuctionUpdated={handleAuctionUpdated}
          onEmailSaved={handleEmailSaved}
        />
        ) : (
        <>

        {/* Live Overview Bar */}
        <div className="bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl p-4 sm:p-5 shadow-xs">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">

            {/* Title & Live Status */}
            <div className="min-w-0">
              <div className="flex items-center flex-wrap gap-2">
                <h2 className="text-lg sm:text-2xl font-black text-[#1e293b] tracking-tight">
                  Live Bidding Dashboard
                </h2>
                <span className="flex items-center gap-1 shrink-0 px-2.5 py-0.5 rounded-full bg-[#abc4ff] border border-[#c1d3fe] text-[#1e293b] text-xs font-bold">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
                  Active Room
                </span>
              </div>
              <p className="text-xs sm:text-sm text-[#1e293b]/75 mt-1">
                Participate in real-time auctions with instant bi-directional price broadcasts (£ / GBP).
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
                className="inline-flex items-center justify-center p-2.5 min-h-[44px] min-w-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-[#1e293b] transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

          </div>
        </div>

        {/* Horizontal Category Navigation Bar */}
        <div className="bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl p-2 sm:p-3 shadow-xs">
          <div className="flex items-center gap-2 overflow-x-auto overscroll-x-contain no-scrollbar scroll-smooth py-1 px-1">
            {CATEGORIES.map((cat) => {
              const IconComponent = cat.icon;
              const isSelected = selectedCategory === cat.id;
              const count = cat.id === 'All'
                ? auctions.length
                : auctions.filter((a) => a.category?.toLowerCase() === cat.id.toLowerCase()).length;

              return (
                <button
                  key={cat.id}
                  id={`category-btn-${cat.id.toLowerCase().replace(/\s+/g, '-')}`}
                  onClick={() => setSelectedCategory(cat.id)}
                  className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all shrink-0 flex items-center gap-2 cursor-pointer min-h-[44px] whitespace-nowrap ${
                    isSelected
                      ? 'bg-[#abc4ff] text-[#1e293b] border border-[#c1d3fe] shadow-xs'
                      : 'bg-[#d7e3fc] text-[#1e293b]/80 border border-[#ccdbfd] hover:bg-[#c1d3fe]'
                  }`}
                >
                  <IconComponent className="w-4 h-4 shrink-0" />
                  <span>{cat.label}</span>
                  <span className={`px-1.5 py-0.2 rounded-md text-[10px] ${isSelected ? 'bg-[#b6ccfe]' : 'bg-[#e2eafc]'}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Search, Status Tabs & Sorting Filter Controls */}
        <div className="bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl p-3 sm:p-4 shadow-xs space-y-3">
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">

            {/* Search Input */}
            <div className="relative flex-1 min-w-0">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
              <input
                id="search-auctions-input"
                type="text"
                placeholder="Search items by title, description, category, or seller..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-sm text-[#1e293b] placeholder-[#1e293b]/45 font-medium min-h-[44px]"
              />
            </div>

            {/* Sort Dropdown */}
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-bold text-[#1e293b]/70 hidden sm:inline">Sort:</span>
              <select
                id="sort-auctions-select"
                value={sortBy}
                onChange={(e: any) => setSortBy(e.target.value)}
                className="flex-1 md:flex-none px-3 py-2.5 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] text-xs font-bold text-[#1e293b] focus:border-[#abc4ff] focus:outline-hidden cursor-pointer min-h-[44px]"
              >
                <option value="ending_soonest">Ending Soonest</option>
                <option value="price_high">Highest Price</option>
                <option value="price_low">Lowest Price</option>
                <option value="most_bids">Most Bids</option>
              </select>
            </div>

          </div>

          {/* Filter Tabs */}
          <div className="flex items-center gap-2 overflow-x-auto overscroll-x-contain pt-1 pb-0.5 no-scrollbar">
            {[
              { id: 'all', label: 'All Listings', count: auctions.length },
              { id: 'active', label: 'Active Live', count: activeCount },
              { id: 'ending_soon', label: 'Ending Soon (<15m)', count: auctions.filter((a) => a.status === 'active' && a.endTime - Date.now() <= 15 * 60 * 1000 && a.endTime > Date.now()).length },
              { id: 'ended', label: 'Concluded', count: auctions.filter((a) => a.status === 'ended' || a.endTime <= Date.now()).length },
              { id: 'watchlist', label: 'Watchlist', count: watchlistIds.length, icon: Star },
            ].map((tab) => {
              const TabIcon = tab.icon;
              return (
                <button
                  key={tab.id}
                  id={`filter-tab-${tab.id}`}
                  onClick={() => setStatusFilter(tab.id as any)}
                  className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all shrink-0 flex items-center gap-1.5 min-h-[44px] whitespace-nowrap ${
                    statusFilter === tab.id
                      ? 'bg-[#abc4ff] border border-[#c1d3fe] text-[#1e293b] shadow-xs'
                      : 'bg-[#d7e3fc] border border-[#ccdbfd] text-[#1e293b]/75 hover:bg-[#c1d3fe]'
                  }`}
                >
                  {TabIcon && <TabIcon className="w-3.5 h-3.5 text-amber-500 fill-amber-400" />}
                  <span>{tab.label}</span>
                  <span className={`px-1.5 py-0.2 rounded-md text-[10px] ${
                    statusFilter === tab.id ? 'bg-[#b6ccfe]' : 'bg-[#e2eafc]'
                  }`}>
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Auctions Grid Layout: Fully Responsive (1 col -> 2 col -> 3 col -> 4 col) */}
        {isLoading && auctions.length === 0 ? (
          <div className="py-20 text-center bg-[#e2eafc] rounded-2xl border border-[#ccdbfd]">
            <RefreshCw className="w-8 h-8 mx-auto animate-spin text-[#abc4ff] mb-3" />
            <p className="text-sm font-bold text-[#1e293b]">Connecting to live auction feed...</p>
          </div>
        ) : filteredAuctions.length === 0 ? (
          <div className="py-12 sm:py-16 text-center bg-[#e2eafc] rounded-2xl border border-[#ccdbfd] p-4 sm:p-6">
            <AlertCircle className="w-10 h-10 mx-auto text-[#1e293b]/50 mb-3" />
            <h3 className="text-base font-bold text-[#1e293b]">No auctions match your filters</h3>
            <p className="text-xs text-[#1e293b]/70 mt-1 max-w-sm mx-auto">
              Try adjusting your category, search terms, or view all active auctions.
            </p>
            <button
              onClick={() => { setSearchQuery(''); setSelectedCategory('All'); setStatusFilter('all'); }}
              className="mt-4 px-4 py-2.5 rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] text-xs font-bold text-[#1e293b] min-h-[44px]"
            >
              Reset All Filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6">
            {filteredAuctions.map((auction) => (
              <AuctionCard
                key={auction.id}
                auction={auction}
                user={user}
                isWatchlisted={watchlistIds.includes(auction.id)}
                onToggleWatchlist={handleToggleWatchlist}
                onSelect={openAuction}
              />
            ))}
          </div>
        )}

        {/* Load More: appends the next page onto the grid rather than paginating away from it
            -- see the reasoning above `handleLoadMore`. Shown whenever the server says there's
            another page, regardless of the active filters (which apply to whatever's loaded). */}
        {!isLoading && nextCursor && (
          <div className="flex justify-center pt-2">
            <button
              id="load-more-auctions-btn"
              type="button"
              onClick={handleLoadMore}
              disabled={isLoadingMore}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-sm font-bold text-[#1e293b] transition-colors disabled:opacity-60 cursor-pointer"
            >
              <ChevronDown className={`w-4 h-4 ${isLoadingMore ? 'animate-bounce' : ''}`} />
              <span>{isLoadingMore ? 'Loading more...' : 'Load More Auctions'}</span>
            </button>
          </div>
        )}

        </>
        )}

      </main>

      {/* Footer */}
      <footer className="mt-12 border-t border-[#ccdbfd] bg-[#e2eafc] py-6 text-center text-xs text-[#1e293b]/70">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
          <div className="flex items-center justify-center flex-wrap gap-x-2 gap-y-1">
            <Gavel className="w-4 h-4 text-[#1e293b]" />
            <span className="font-extrabold text-[#1e293b]">MSA Auction</span>
            <span>— Bi-directional Real-Time Bidding (£ / GBP)</span>
          </div>
          <p className="text-[11px]">
            Built by <a href="https://github.com/dragonfisher29">dragonfisher29</a>
          </p>
          <p className="text-[11px]">
            Got a suggestion? <a href="https://docs.google.com/forms/d/e/1FAIpQLSdp-VsPtay7wMH34NLl0ru_3bEMJbYCzw5RC0J6AJs7qXP3wQ/viewform?usp=header">Click HERE</a>
          </p>
        </div>
      </footer>

      {/* Modals */}
      {selectedAuction && (
        <AuctionDetailModal
          auction={selectedAuction}
          user={user}
          onClose={closeAuctionModal}
          onPromptAuth={() => openAuthModal('login')}
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
            openAuction(newAuction);
          }}
          onPromptAuth={() => {
            setIsCreateModalOpen(false);
            openAuthModal('login');
          }}
        />
      )}

      {isAuthModalOpen && (
        <AuthModal
          isOpen={isAuthModalOpen}
          initialMode={authModalMode}
          onClose={() => setIsAuthModalOpen(false)}
          onAuthSuccess={handleAuthSuccess}
        />
      )}

    </div>
  );
}
