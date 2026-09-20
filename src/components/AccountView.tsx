import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Gavel,
  MessageCircle,
  Phone,
  RefreshCw,
  Tag,
  Trophy,
  UserCircle,
} from 'lucide-react';
import { AuctionItem, User, UserActivity } from '../types';
import { AuctionCard } from './AuctionCard';
import { AddEmailPrompt } from './AddEmailPrompt';
import { ListingActions } from './ListingActions';
import { CreateListingModal } from './CreateListingModal';
import { CancelListingModal } from './CancelListingModal';
import { apiFetchAuthed } from '../lib/api';
import { buildWhatsAppUrl, formatCurrencyPrecise } from '../lib/formatters';

interface AccountViewProps {
  /** Non-null by construction: App only renders this view for a signed-in user. */
  user: User;
  watchlistIds: string[];
  onToggleWatchlist: (auctionId: string) => void;
  onSelectAuction: (auction: AuctionItem) => void;
  onClose: () => void;
  onPromptAuth: () => void;
  /** Notifies the caller (App) that a listing changed here, so the main grid / any open detail
   *  modal for the same auction stay in sync with an edit or cancellation made from this view.
   *  Optional (defaults to a no-op) so existing callers/tests that don't touch editing keep working. */
  onAuctionUpdated?: (updated: AuctionItem) => void;
  /** Called when the recovery-email prompt saves an address, so App can update the session. */
  onEmailSaved?: (email: string) => void;
}

const EMPTY_ACTIVITY: UserActivity = { listings: [], bids: [], wins: [] };

/** Contact strip shown under a won item: the winner needs the seller to arrange handover. */
const WinnerContactPanel: React.FC<{ auction: AuctionItem }> = ({ auction }) => {
  const winningAmount = auction.winningBid ?? auction.currentPrice;
  const whatsAppUrl = buildWhatsAppUrl(
    auction.phoneNumber,
    `Hi ${auction.sellerName}, I won your "${auction.title}" listing on MSA Auction. When can we arrange handover?`,
  );

  return (
    <div className="p-3 rounded-2xl bg-[#d7e3fc] border border-[#ccdbfd] space-y-2.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[11px] font-bold uppercase tracking-wider text-[#1e293b]/70 flex items-center gap-1.5">
          <Trophy className="w-3.5 h-3.5 text-amber-600" />
          <span>Your Winning Bid</span>
        </span>
        <span
          data-testid={`win-amount-${auction.id}`}
          className="text-base font-black tracking-tight text-[#1e293b]"
        >
          {formatCurrencyPrecise(winningAmount)}
        </span>
      </div>

      <div className="pt-2 border-t border-[#ccdbfd] space-y-2">
        <div className="flex items-center gap-2 min-w-0">
          <UserCircle className="w-3.5 h-3.5 text-[#1e293b]/70 shrink-0" />
          <span className="text-[11px] text-[#1e293b]/70 shrink-0">Seller:</span>
          <span className="text-xs font-bold text-[#1e293b] truncate" title={auction.sellerName}>
            {auction.sellerName}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={`tel:${auction.phoneNumber}`}
            aria-label={`Call ${auction.sellerName} on ${auction.phoneNumber}`}
            className="flex-1 min-w-0 inline-flex items-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-[#edf2fb] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-xs font-bold text-[#1e293b] transition-colors"
          >
            <Phone className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{auction.phoneNumber}</span>
          </a>

          {/* Only rendered when the number parses to a usable wa.me target, exactly as the
              detail modal does -- a dead WhatsApp button is worse than none. */}
          {whatsAppUrl && (
            <a
              href={whatsAppUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Message ${auction.sellerName} on WhatsApp about ${auction.title}`}
              className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-[#25D366] hover:bg-[#1eb455] text-white text-xs font-bold shadow-xs transition-colors"
            >
              <MessageCircle className="w-3.5 h-3.5" />
              <span>WhatsApp</span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
};

export const AccountView: React.FC<AccountViewProps> = ({
  user,
  watchlistIds,
  onToggleWatchlist,
  onSelectAuction,
  onClose,
  onPromptAuth,
  onAuctionUpdated = (_updated: AuctionItem) => {},
  onEmailSaved = (_email: string) => {},
}) => {
  const [activity, setActivity] = useState<UserActivity>(EMPTY_ACTIVITY);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Split from `error` because the only useful action differs: a dead session needs sign-in,
  // a missing endpoint needs nothing at all from the user.
  const [isAuthError, setIsAuthError] = useState(false);
  const [isUnavailable, setIsUnavailable] = useState(false);

  // Edit / Cancel for a listing in "My Listings". Kept local to this view (rather than lifted to
  // App) because the PATCH/DELETE call and its result only need to patch `activity.listings`
  // here; `onAuctionUpdated` above is how that result also reaches the main grid / an open
  // detail modal for the same auction.
  const [editingListing, setEditingListing] = useState<AuctionItem | null>(null);
  const [cancellingListing, setCancellingListing] = useState<AuctionItem | null>(null);

  const patchListing = useCallback((updated: AuctionItem) => {
    setActivity((prev) => ({
      ...prev,
      listings: prev.listings.map((a) => (a.id === updated.id ? updated : a)),
    }));
    onAuctionUpdated(updated);
  }, [onAuctionUpdated]);

  const loadActivity = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setIsAuthError(false);
    setIsUnavailable(false);

    try {
      const res = await apiFetchAuthed('/api/users/me/activity', user.token);

      if (res.status === 401) {
        setIsAuthError(true);
        setError('Your session has expired. Please sign in again to see your account activity.');
        setActivity(EMPTY_ACTIVITY);
        return;
      }

      // The endpoint may not be deployed yet; degrade to a calm empty state rather than a
      // red failure the user cannot act on.
      if (res.status === 404) {
        setIsUnavailable(true);
        setActivity(EMPTY_ACTIVITY);
        return;
      }

      if (!res.ok) {
        setError('We could not load your account activity. Please try again.');
        setActivity(EMPTY_ACTIVITY);
        return;
      }

      const data = await res.json().catch(() => null);
      setActivity({
        listings: Array.isArray(data?.listings) ? data.listings : [],
        bids: Array.isArray(data?.bids) ? data.bids : [],
        wins: Array.isArray(data?.wins) ? data.wins : [],
      });
    } catch (err) {
      console.error('Failed to load account activity:', err);
      setError('Network error while loading your account activity. Please try again.');
      setActivity(EMPTY_ACTIVITY);
    } finally {
      setIsLoading(false);
    }
  }, [user.token]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  const renderSection = (
    key: 'listings' | 'bids' | 'wins',
    title: string,
    Icon: React.ComponentType<{ className?: string }>,
    emptyCopy: string,
    items: AuctionItem[],
  ) => (
    <section
      key={key}
      id={`account-section-${key}`}
      aria-labelledby={`account-section-${key}-heading`}
      className="space-y-3"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <h3
          id={`account-section-${key}-heading`}
          className="text-base sm:text-lg font-black tracking-tight text-[#1e293b] flex items-center gap-2"
        >
          <Icon className="w-4 h-4 text-[#1e293b]" />
          <span>{title}</span>
        </h3>
        <span
          data-testid={`account-count-${key}`}
          className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-[#b6ccfe] text-[#1e293b] border border-[#c1d3fe]"
        >
          {items.length}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="py-8 text-center text-xs font-semibold text-[#1e293b]/70 bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl px-4">
          {emptyCopy}
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6">
          {items.map((auction) => (
            <div key={auction.id} className="flex flex-col gap-2.5">
              <AuctionCard
                auction={auction}
                user={user}
                isWatchlisted={watchlistIds.includes(auction.id)}
                onToggleWatchlist={onToggleWatchlist}
                onSelect={onSelectAuction}
              />
              {key === 'wins' && <WinnerContactPanel auction={auction} />}
              {key === 'listings' && (
                <ListingActions
                  auction={auction}
                  onEdit={() => setEditingListing(auction)}
                  onCancel={() => setCancellingListing(auction)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div id="account-view" className="space-y-6">
      {/* View header */}
      <div className="bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl p-4 sm:p-5 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg sm:text-2xl font-black text-[#1e293b] tracking-tight">
              My Account
            </h2>
            <p className="text-xs sm:text-sm text-[#1e293b]/75 mt-1 truncate">
              Everything {user.name} has listed, bid on, and won.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              id="account-refresh-btn"
              type="button"
              onClick={() => void loadActivity()}
              aria-label="Refresh account activity"
              className="inline-flex items-center justify-center p-2.5 min-h-[44px] min-w-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-[#1e293b] transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>

            <button
              id="account-back-btn"
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-[#1e293b] text-sm font-bold shadow-xs transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back to Auctions</span>
            </button>
          </div>
        </div>
      </div>

      {/* Renders nothing once an address is on file or the prompt has been dismissed by THIS
          account (the dismissal is keyed per user id). Placed above the activity sections so it
          is seen, but below the header so it never displaces what the page is for. */}
      <AddEmailPrompt user={user} onEmailSaved={onEmailSaved} />

      {error && (
        <div
          id="account-error"
          role="alert"
          className="p-3 rounded-2xl bg-red-100/95 border border-red-200 text-red-800 text-xs flex flex-wrap items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          {isAuthError && (
            <button
              id="account-sign-in-btn"
              type="button"
              onClick={onPromptAuth}
              className="shrink-0 inline-flex items-center justify-center px-3 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-[#1e293b] font-extrabold transition-colors cursor-pointer"
            >
              Sign In Again
            </button>
          )}
        </div>
      )}

      {isUnavailable && (
        <p
          id="account-unavailable"
          className="p-3 rounded-2xl bg-[#e2eafc] border border-[#ccdbfd] text-xs font-semibold text-[#1e293b]/75 text-center"
        >
          Account activity is not available yet. Your listings, bids and wins will appear here
          once the feed is live.
        </p>
      )}

      {isLoading ? (
        <div className="py-20 text-center bg-[#e2eafc] rounded-2xl border border-[#ccdbfd]">
          <RefreshCw className="w-8 h-8 mx-auto animate-spin text-[#abc4ff] mb-3" />
          <p className="text-sm font-bold text-[#1e293b]">Loading your account activity...</p>
        </div>
      ) : (
        <>
          {renderSection(
            'listings',
            'My Listings',
            Tag,
            "You haven't listed anything yet. Create a listing to start selling.",
            activity.listings,
          )}
          {renderSection(
            'bids',
            'My Bids',
            Gavel,
            "You haven't bid on anything yet. Open a live auction to place your first bid.",
            activity.bids,
          )}
          {renderSection(
            'wins',
            'My Wins',
            Trophy,
            "You haven't won an auction yet. Winning items show the seller's contact details here.",
            activity.wins,
          )}
        </>
      )}

      {editingListing && (
        <CreateListingModal
          isOpen={true}
          user={user}
          mode="edit"
          initialAuction={editingListing}
          onClose={() => setEditingListing(null)}
          onCreated={() => {}}
          onUpdated={(updated) => {
            patchListing(updated);
            setEditingListing(null);
          }}
          onPromptAuth={onPromptAuth}
        />
      )}

      {cancellingListing && (
        <CancelListingModal
          auction={cancellingListing}
          user={user}
          onClose={() => setCancellingListing(null)}
          onCancelled={(updated) => {
            patchListing(updated);
            setCancellingListing(null);
          }}
        />
      )}
    </div>
  );
};
