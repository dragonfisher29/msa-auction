import React, { useState, useEffect, useMemo, useRef } from 'react';
import { BrowserRouter, useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Search,
  AlertCircle,
  RefreshCw,
  Star,
  ChevronDown,
  Store,
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
import { ListingUnavailableNotice } from './components/ListingUnavailableNotice';
import { apiFetch, apiFetchAuthed } from './lib/api';
import { startPolling } from './lib/realtime';
import { CATEGORIES } from './lib/categories';
import { INVALID_CURSOR, readErrorCode } from './lib/apiErrors';
import { isListingAvailable } from './lib/listing';
import { SITE_NAME } from './lib/site';

type StatusFilter = 'all' | 'watchlist';
type SortBy = 'newest' | 'price_low' | 'price_high';

const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'watchlist'];
const SORT_OPTIONS: { id: SortBy; label: string }[] = [
  { id: 'newest', label: 'Newest' },
  { id: 'price_low', label: 'Price: low to high' },
  { id: 'price_high', label: 'Price: high to low' },
];

const AUCTIONS_PAGE_SIZE = 24;

// The browse feed refreshes at most this often while the tab is visible, plus once when the
// visitor comes back to the tab (no more than every FEED_WAKE_MIN_GAP_MS). Every request counts
// against the Worker's free-tier budget of 100k/day, shared by every member -- see
// src/lib/realtime.ts. At 60s, one visitor leaving a tab open all day costs ~1.4k requests.
const FEED_REFRESH_INTERVAL_MS = 60_000;
const FEED_WAKE_MIN_GAP_MS = 30_000;

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
  // The listing behind a deep link (`/auction/:id`) that isn't part of any loaded page -- fetched
  // directly by id so a shared link still opens even if the item has scrolled off the list.
  const [deepLinkedAuction, setDeepLinkedAuction] = useState<AuctionItem | null>(null);
  // Set when that deep-link lookup came back empty-handed, so the visitor sees why nothing
  // opened instead of the plain grid: 'missing' on a 404 (deleted/hidden), 'failed' otherwise.
  const [deepLinkError, setDeepLinkError] = useState<'missing' | 'failed' | null>(null);
  const [user, setUser] = useState<User | null>(null);
  // Flips true once the stored-session bootstrap below has resolved one way or the other, so the
  // `/account` sign-out redirect (further down) never fires against the momentarily-null `user`
  // that exists before that check has had a chance to run.
  const [isSessionChecked, setIsSessionChecked] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  // True when the very first feed load failed, so the empty grid can say "could not load"
  // rather than "no listings match your filters".
  const [loadFailed, setLoadFailed] = useState<boolean>(false);
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

  // My Listings lives at `/account`, driven entirely by the route rather than its own boolean:
  // that keeps the browser's back button and a bookmarked/shared link working for it exactly
  // like the listing detail modal below.
  const isAccountViewOpen = Boolean(accountRouteMatch);

  // `/admin` follows exactly the same route-driven pattern as `/account` above, including its
  // redirect when the visitor is not entitled to it (see the effect further down).
  const isAdminViewOpen = Boolean(adminRouteMatch);

  // `/reset-password?token=...` is reachable SIGNED OUT by design -- someone who has forgotten
  // their password has no session to check.
  const isResetPasswordOpen = Boolean(resetPasswordRouteMatch);
  const resetPasswordToken = searchParams.get('token') ?? '';

  // The selected listing id also comes from the route (`/auction/:id`, a path kept from the
  // auction days so links already shared keep working) rather than local state,
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
  // Unknown values (including bookmarks from the auction days, e.g. `?sort=ending_soonest` or
  // `?status=ended`) fall back to the defaults rather than silently filtering everything out.
  const rawStatus = searchParams.get('status');
  const statusFilter: StatusFilter = STATUS_FILTERS.includes(rawStatus as StatusFilter) ? (rawStatus as StatusFilter) : 'all';
  const rawSort = searchParams.get('sort');
  const sortBy: SortBy = SORT_OPTIONS.some((o) => o.id === rawSort) ? (rawSort as SortBy) : 'newest';

  // Applies one filter change to the query string, dropping the key entirely when it's back to
  // its default so the URL stays clean (no `?status=all&sort=newest&...` on every load).
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
  const setSortBy = (value: SortBy) => updateFilterParam('sort', value, 'newest');

  function openAuction(auction: AuctionItem) {
    openedViaInAppNavRef.current = true;
    navigate(`/auction/${auction.id}${location.search}`);
  }

  function openAuctionById(auctionId: string) {
    openedViaInAppNavRef.current = true;
    navigate(`/auction/${auctionId}${location.search}`);
  }

  function closeAuctionModal() {
    setDeepLinkError(null);
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

    // Every write requires a bearer token, but a session stored before that change (or one
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
    // The watchlist above is knowingly device-local and is left alone -- that is a separate,
    // already-tracked issue.
    setUser(null);
    if (isAccountViewOpen || isAdminViewOpen) {
      navigate('/', { replace: true });
    }
    localStorage.removeItem('msa_auction_user');
  };

  // Fetch the first page of listings, replacing whatever was loaded before (used on mount and by
  // the manual refresh button -- both are "start over from the top" actions).
  const fetchAuctions = async () => {
    try {
      setIsLoading(true);
      const res = await apiFetch(auctionsPageUrl(null));
      if (res.ok) {
        const data = await res.json();
        setAuctions(data.auctions || []);
        setNextCursor(data.nextCursor ?? null);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
    } catch (err) {
      console.error('Failed to load listings:', err);
      setLoadFailed(true);
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
      console.error('Failed to load more listings:', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Background refresh of the browse feed: the Cloudflare Worker is REST-only, so this is a slow
  // poll (see FEED_REFRESH_INTERVAL_MS and src/lib/realtime.ts for why it is slow). Always
  // re-fetches just the first page and merges it into whatever's loaded rather than replacing it,
  // so pages fetched via "Load More" are left alone, and it deliberately leaves `nextCursor`
  // untouched so an in-progress "Load More" sequence doesn't get reset by a background refresh.
  useEffect(() => {
    return startPolling<{ auctions: AuctionItem[]; nextCursor: string | null }>(
      async () => {
        const res = await apiFetch(auctionsPageUrl(null));
        if (!res.ok) {
          throw new Error(`Listing feed responded with ${res.status}`);
        }
        const data = await res.json();
        return { auctions: (data.auctions || []) as AuctionItem[], nextCursor: data.nextCursor ?? null };
      },
      FEED_REFRESH_INTERVAL_MS,
      ({ auctions: firstPage, nextCursor: firstPageCursor }) => {
        setLoadFailed(false);

        setAuctions((prev) => {
          const serverById = new Map(firstPage.map((a) => [a.id, a]));
          const knownIds = new Set(prev.map((a) => a.id));
          // The feed is newest-first and only ever returns listings still for sale. So a loaded
          // row missing from this page is gone (sold, cancelled, expired or hidden) if it is newer
          // than the oldest row on the page -- or if this page is the whole feed. Anything older
          // may simply live on a later page and is kept; the client-side availability filter
          // below still drops it the moment its own `expiresAt` passes.
          const oldestOnPage = firstPage.length > 0 ? Math.min(...firstPage.map((a) => a.createdAt)) : Infinity;
          const isWholeFeed = firstPageCursor === null;
          const kept = prev
            .filter((a) => serverById.has(a.id) || (!isWholeFeed && a.createdAt < oldestOnPage))
            .map((a) => {
              const fresh = serverById.get(a.id);
              // List rows never carry a phone number; keep one a detail fetch already added.
              return fresh ? { ...fresh, phoneNumber: fresh.phoneNumber ?? a.phoneNumber } : a;
            });
          const added = firstPage.filter((a) => !knownIds.has(a.id));
          return [...added, ...kept];
        });
      },
      { minGapMs: FEED_WAKE_MIN_GAP_MS },
    );
  }, []);

  // Read inside the effect below without making every refresh-driven `auctions` update re-run
  // it -- only a genuine change of *which* listing id is selected should trigger a new fetch.
  const auctionsRef = useRef(auctions);
  useEffect(() => {
    auctionsRef.current = auctions;
  }, [auctions]);

  // Resolves the listing behind `/auction/:id`: the copy already in the loaded pages when there
  // is one, otherwise a direct `GET /api/auctions/:id` fetch -- this is what makes a link to an
  // item outside the current page (or shared from someone else's browser entirely) still open.
  // When that fetch finds nothing, `deepLinkError` puts a visible "no longer available" notice
  // up instead of silently showing the grid.
  useEffect(() => {
    setDeepLinkError(null);
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
        // Authed when a session exists -- GET /api/auctions/:id only sends phoneNumber back for
        // a signed-in caller (see mapAuctionDetailRow in workers/index.ts), so a signed-in
        // visitor opening a shared link can contact the seller straight away, and the detail
        // modal has no reason to fetch the same row a second time.
        const res = await apiFetchAuthed(`/api/auctions/${selectedAuctionId}`, user?.token);
        if (cancelled) return;
        if (!res.ok) {
          setDeepLinkError(res.status === 404 ? 'missing' : 'failed');
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (data?.auction) {
          setDeepLinkedAuction(data.auction as AuctionItem);
        } else {
          setDeepLinkError('missing');
        }
      } catch (err) {
        console.warn('Could not open the linked listing:', err);
        if (!cancelled) {
          setDeepLinkError('failed');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Keyed on the token rather than the whole `user` object: an unrelated session update (e.g.
    // saving a recovery email) must not refetch the listing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAuctionId, user?.token]);

  const selectedAuction = selectedAuctionId
    ? auctions.find((a) => a.id === selectedAuctionId) ?? (deepLinkedAuction?.id === selectedAuctionId ? deepLinkedAuction : null)
    : null;

  // Handle single item update from the detail modal, the account view's edit/sold/cancel flows,
  // or any other place a listing gets patched -- keeps both the main list and a deep-linked-only
  // listing (which isn't part of `auctions` at all) in sync.
  const handleAuctionUpdated = (updated: AuctionItem) => {
    setAuctions((prev) => (prev.some((a) => a.id === updated.id) ? prev.map((a) => (a.id === updated.id ? updated : a)) : prev));
    setDeepLinkedAuction((curr) => (curr && curr.id === updated.id ? updated : curr));
  };

  // Only listings still for sale belong on the browse page. The server already sends nothing
  // else, but a row held locally can go stale: the seller marks it sold in this tab, or it
  // passes `expiresAt` between refreshes.
  const browseableAuctions = useMemo(() => {
    const now = Date.now();
    return auctions.filter((item) => isListingAvailable(item, now));
  }, [auctions]);

  const filteredAuctions = useMemo(() => {
    return browseableAuctions
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

        if (statusFilter === 'watchlist') {
          return watchlistIds.includes(item.id);
        }

        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'price_low') {
          return a.price - b.price || b.createdAt - a.createdAt;
        }
        if (sortBy === 'price_high') {
          return b.price - a.price || b.createdAt - a.createdAt;
        }
        return b.createdAt - a.createdAt;
      });
  }, [browseableAuctions, searchQuery, selectedCategory, statusFilter, sortBy, watchlistIds]);

  const watchlistCount = browseableAuctions.filter((a) => watchlistIds.includes(a.id)).length;

  return (
    <div className="min-h-screen bg-[#edf2fb] text-[#1e293b] flex flex-col selection:bg-[#abc4ff] selection:text-[#1e293b]">

      {/* Top Navigation Header */}
      <Header
        user={user}
        isAccountViewOpen={isAccountViewOpen}
        isAdminViewOpen={isAdminViewOpen}
        onOpenAuth={() => openAuthModal('login')}
        onOpenCreate={() => setIsCreateModalOpen(true)}
        onLogout={handleLogout}
        onToggleAccountView={toggleAccountView}
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

        {/* Overview Bar */}
        <div className="bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl p-4 sm:p-5 shadow-xs">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">

            <div className="min-w-0">
              <h2 className="text-lg sm:text-2xl font-black text-[#1e293b] tracking-tight">
                Browse Listings
              </h2>
              <p className="text-xs sm:text-sm text-[#1e293b]/75 mt-1">
                A marketplace for MSA Southampton members. Every item has a fixed price in £ (GBP);
                sign in to message the seller on WhatsApp.
              </p>
            </div>

            {/* Quick Metrics */}
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
              <div className="px-3.5 py-2 rounded-xl bg-[#d7e3fc] border border-[#ccdbfd] text-center shrink-0">
                <span className="text-[11px] font-bold text-[#1e293b]/70 block uppercase tracking-wider">
                  For Sale
                </span>
                <span data-testid="for-sale-count" className="text-lg font-extrabold text-[#1e293b]">
                  {browseableAuctions.length}
                  {nextCursor ? '+' : ''}
                </span>
              </div>

              <button
                id="refresh-auctions-btn"
                type="button"
                onClick={fetchAuctions}
                title="Refresh listings"
                aria-label="Refresh listings"
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
                ? browseableAuctions.length
                : browseableAuctions.filter((a) => a.category?.toLowerCase() === cat.id.toLowerCase()).length;

              return (
                <button
                  key={cat.id}
                  id={`category-btn-${cat.id.toLowerCase().replace(/\s+/g, '-')}`}
                  type="button"
                  onClick={() => setSelectedCategory(cat.id)}
                  aria-pressed={isSelected}
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

        {/* Search, Watchlist Tab & Sorting Controls */}
        <div className="bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl p-3 sm:p-4 shadow-xs space-y-3">
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">

            {/* Search Input */}
            <div className="relative flex-1 min-w-0">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
              <input
                id="search-auctions-input"
                type="text"
                aria-label="Search listings"
                placeholder="Search items by title, description, category, or seller..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-sm text-[#1e293b] placeholder-[#1e293b]/45 font-medium min-h-[44px]"
              />
            </div>

            {/* Sort Dropdown */}
            <div className="flex items-center gap-2 shrink-0">
              <label htmlFor="sort-auctions-select" className="text-xs font-bold text-[#1e293b]/70 hidden sm:inline">Sort:</label>
              <select
                id="sort-auctions-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                className="flex-1 md:flex-none px-3 py-2.5 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] text-xs font-bold text-[#1e293b] focus:border-[#abc4ff] focus:outline-hidden cursor-pointer min-h-[44px]"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

          </div>

          {/* Filter Tabs */}
          <div className="flex items-center gap-2 overflow-x-auto overscroll-x-contain pt-1 pb-0.5 no-scrollbar">
            {[
              { id: 'all' as const, label: 'All Listings', count: browseableAuctions.length, icon: undefined },
              { id: 'watchlist' as const, label: 'Watchlist', count: watchlistCount, icon: Star },
            ].map((tab) => {
              const TabIcon = tab.icon;
              return (
                <button
                  key={tab.id}
                  id={`filter-tab-${tab.id}`}
                  type="button"
                  onClick={() => setStatusFilter(tab.id)}
                  aria-pressed={statusFilter === tab.id}
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

        {/* Listings Grid Layout: Fully Responsive (1 col -> 2 col -> 3 col -> 4 col) */}
        {isLoading && auctions.length === 0 ? (
          <div className="py-20 text-center bg-[#e2eafc] rounded-2xl border border-[#ccdbfd]">
            <RefreshCw className="w-8 h-8 mx-auto animate-spin text-[#abc4ff] mb-3" />
            <p className="text-sm font-bold text-[#1e293b]">Loading listings...</p>
          </div>
        ) : loadFailed && auctions.length === 0 ? (
          <div id="feed-load-error" role="alert" className="py-12 sm:py-16 text-center bg-[#e2eafc] rounded-2xl border border-[#ccdbfd] p-4 sm:p-6">
            <AlertCircle className="w-10 h-10 mx-auto text-[#1e293b]/50 mb-3" />
            <h3 className="text-base font-bold text-[#1e293b]">We couldn't load the listings</h3>
            <p className="text-xs text-[#1e293b]/70 mt-1 max-w-sm mx-auto">
              Please check your connection and try again.
            </p>
            <button
              type="button"
              onClick={fetchAuctions}
              className="mt-4 px-4 py-2.5 rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] text-xs font-bold text-[#1e293b] min-h-[44px]"
            >
              Try Again
            </button>
          </div>
        ) : filteredAuctions.length === 0 ? (
          <div className="py-12 sm:py-16 text-center bg-[#e2eafc] rounded-2xl border border-[#ccdbfd] p-4 sm:p-6">
            <AlertCircle className="w-10 h-10 mx-auto text-[#1e293b]/50 mb-3" />
            {browseableAuctions.length === 0 ? (
              <>
                <h3 className="text-base font-bold text-[#1e293b]">Nothing for sale yet</h3>
                <p className="text-xs text-[#1e293b]/70 mt-1 max-w-sm mx-auto">
                  Be the first: use Create Listing to put an item up for sale.
                </p>
              </>
            ) : (
              <>
                <h3 className="text-base font-bold text-[#1e293b]">No listings match your filters</h3>
                <p className="text-xs text-[#1e293b]/70 mt-1 max-w-sm mx-auto">
                  Try adjusting your category or search terms, or view all listings.
                </p>
                <button
                  type="button"
                  onClick={() => { setSearchQuery(''); setSelectedCategory('All'); setStatusFilter('all'); }}
                  className="mt-4 px-4 py-2.5 rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] text-xs font-bold text-[#1e293b] min-h-[44px]"
                >
                  Reset All Filters
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6">
            {filteredAuctions.map((auction) => (
              <AuctionCard
                key={auction.id}
                auction={auction}
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
              <span>{isLoadingMore ? 'Loading more...' : 'Load More Listings'}</span>
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
            <Store className="w-4 h-4 text-[#1e293b]" aria-hidden="true" />
            <span className="font-extrabold text-[#1e293b]">{SITE_NAME}</span>
            <span>— a marketplace for MSA Southampton members (£ / GBP)</span>
          </div>
          <p className="text-[11px]">
            Built by{' '}
            <a
              href="https://github.com/dragonfisher29"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold underline underline-offset-2 hover:text-[#1e293b]"
            >
              dragonfisher29 on GitHub
            </a>
          </p>
          <p className="text-[11px]">
            Got a suggestion?{' '}
            <a
              href="https://docs.google.com/forms/d/e/1FAIpQLSdp-VsPtay7wMH34NLl0ru_3bEMJbYCzw5RC0J6AJs7qXP3wQ/viewform?usp=header"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold underline underline-offset-2 hover:text-[#1e293b]"
            >
              Send us your feedback
            </a>
          </p>
        </div>
      </footer>

      {/* Modals. Keyed by id so opening a different listing (e.g. via back/forward) starts from
          a fresh modal rather than one still holding the previous listing's state. */}
      {selectedAuction && (
        <AuctionDetailModal
          key={selectedAuction.id}
          auction={selectedAuction}
          user={user}
          onClose={closeAuctionModal}
          onPromptAuth={() => openAuthModal('login')}
          onAuctionUpdated={handleAuctionUpdated}
        />
      )}

      {!selectedAuction && selectedAuctionId && deepLinkError && (
        <ListingUnavailableNotice reason={deepLinkError} onClose={closeAuctionModal} />
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
