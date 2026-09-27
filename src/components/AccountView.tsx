import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Archive, RefreshCw, Tag } from 'lucide-react';
import { AuctionItem, User, UserActivity } from '../types';
import { AuctionCard } from './AuctionCard';
import { AddEmailPrompt } from './AddEmailPrompt';
import { ListingActions } from './ListingActions';
import { CreateListingModal } from './CreateListingModal';
import { CancelListingModal } from './CancelListingModal';
import { MarkSoldModal } from './MarkSoldModal';
import { apiFetchAuthed } from '../lib/api';
import { isListingAvailable } from '../lib/listing';

interface AccountViewProps {
  /** Non-null by construction: App only renders this view for a signed-in user. */
  user: User;
  watchlistIds: string[];
  onToggleWatchlist: (auctionId: string) => void;
  onSelectAuction: (auction: AuctionItem) => void;
  onClose: () => void;
  onPromptAuth: () => void;
  /** Notifies the caller (App) that a listing changed here, so the main grid / any open detail
   *  modal for the same listing stay in sync with an edit, sale or cancellation made from this
   *  view. Optional (defaults to a no-op) so callers/tests that don't touch editing keep working. */
  onAuctionUpdated?: (updated: AuctionItem) => void;
  /** Called when the recovery-email prompt saves an address, so App can update the session. */
  onEmailSaved?: (email: string) => void;
}

const EMPTY_ACTIVITY: UserActivity = { listings: [] };

type SectionKey = 'active' | 'past';

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

  // Edit / Mark as sold / Cancel for one of the seller's listings. Kept local to this view
  // (rather than lifted to App) because the write and its result only need to patch
  // `activity.listings` here; `onAuctionUpdated` above is how that result also reaches the main
  // grid / an open detail modal for the same listing.
  const [editingListing, setEditingListing] = useState<AuctionItem | null>(null);
  const [sellingListing, setSellingListing] = useState<AuctionItem | null>(null);
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
        setError('Your session has expired. Please sign in again to see your listings.');
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
        setError('We could not load your listings. Please try again.');
        setActivity(EMPTY_ACTIVITY);
        return;
      }

      const data = await res.json().catch(() => null);
      setActivity({
        listings: Array.isArray(data?.listings) ? data.listings : [],
      });
    } catch (err) {
      console.error('Failed to load account activity:', err);
      setError('Network error while loading your listings. Please try again.');
      setActivity(EMPTY_ACTIVITY);
    } finally {
      setIsLoading(false);
    }
  }, [user.token]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  // Split client-side rather than asked for twice: one request, and a listing that sells or
  // lapses while this view is open moves between the two sections on its own.
  const activeListings = activity.listings.filter((a) => isListingAvailable(a));
  const pastListings = activity.listings.filter((a) => !isListingAvailable(a));

  const renderSection = (
    key: SectionKey,
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
                isWatchlisted={watchlistIds.includes(auction.id)}
                onToggleWatchlist={onToggleWatchlist}
                onSelect={onSelectAuction}
              />
              {/* Renders nothing for a sold/expired/cancelled listing. */}
              <ListingActions
                auction={auction}
                onEdit={() => setEditingListing(auction)}
                onMarkSold={() => setSellingListing(auction)}
                onCancel={() => setCancellingListing(auction)}
              />
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
              My Listings
            </h2>
            <p className="text-xs sm:text-sm text-[#1e293b]/75 mt-1 truncate">
              Everything {user.name} has put up for sale.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              id="account-refresh-btn"
              type="button"
              onClick={() => void loadActivity()}
              aria-label="Refresh my listings"
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
              <span>Back to Browse</span>
            </button>
          </div>
        </div>
      </div>

      {/* Renders nothing once an address is on file or the prompt has been dismissed by THIS
          account (the dismissal is keyed per user id). Placed above the listings so it is seen,
          but below the header so it never displaces what the page is for. */}
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
          Your listings are not available yet. They will appear here once the feed is live.
        </p>
      )}

      {isLoading ? (
        <div className="py-20 text-center bg-[#e2eafc] rounded-2xl border border-[#ccdbfd]">
          <RefreshCw className="w-8 h-8 mx-auto animate-spin text-[#abc4ff] mb-3" />
          <p className="text-sm font-bold text-[#1e293b]">Loading your listings...</p>
        </div>
      ) : (
        <>
          {renderSection(
            'active',
            'For Sale',
            Tag,
            "You have nothing for sale right now. Create a listing to start selling.",
            activeListings,
          )}
          {renderSection(
            'past',
            'Sold & Past Listings',
            Archive,
            'Listings you mark as sold, cancel, or that expire will show up here.',
            pastListings,
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

      {sellingListing && (
        <MarkSoldModal
          auction={sellingListing}
          user={user}
          onClose={() => setSellingListing(null)}
          onSold={(updated) => {
            patchListing(updated);
            setSellingListing(null);
          }}
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
