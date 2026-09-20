import React, { useState } from 'react';
import { AlertCircle, AlertTriangle, Ban, X } from 'lucide-react';
import { AuctionItem, User } from '../types';
import { apiFetchAuthed } from '../lib/api';
import {
  AUTH_ERROR_CODES,
  LISTING_NOT_EDITABLE,
  NOT_LISTING_OWNER,
  readErrorCode,
  stripErrorCode,
} from '../lib/apiErrors';

interface CancelListingModalProps {
  auction: AuctionItem;
  user: User;
  onClose: () => void;
  /** Called with the server's updated (now-cancelled) auction once the DELETE succeeds. */
  onCancelled: (updated: AuctionItem) => void;
}

/**
 * A confirmation step for cancelling a listing -- it is not undoable, so a click on "Cancel
 * Listing" in ListingActions opens this rather than firing the DELETE straight away. Names the
 * listing explicitly and, when it already has bids, warns that those bidders will still be able
 * to see the cancelled listing (the server allows cancelling with bids; it just cannot be
 * un-done from the bidder's side).
 */
export const CancelListingModal: React.FC<CancelListingModalProps> = ({ auction, user, onClose, onCancelled }) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasBids = auction.bids.length > 0;

  const handleConfirm = async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      const res = await apiFetchAuthed(`/api/auctions/${auction.id}`, user.token, { method: 'DELETE' });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const code = readErrorCode(data);

        if (code && AUTH_ERROR_CODES.has(code)) {
          setError('Your session has expired. Please sign in again to cancel this listing.');
          return;
        }
        if (code === NOT_LISTING_OWNER) {
          setError('You are not the seller of this listing, so it cannot be cancelled from here.');
          return;
        }
        if (code === LISTING_NOT_EDITABLE) {
          setError('This listing has already ended and can no longer be cancelled.');
          return;
        }

        setError(data?.error ? stripErrorCode(data.error) : 'Unable to cancel this listing. Please try again.');
        return;
      }

      // The server is expected to return the updated (cancelled) auction, matching the
      // convention every other write endpoint in this app follows. Fall back to patching the
      // status locally if a response body wasn't provided, so the UI still reflects the
      // cancellation even if that convention isn't followed exactly.
      const updated: AuctionItem = data?.auction ?? { ...auction, status: 'cancelled' };
      onCancelled(updated);
    } catch (err) {
      console.error('Failed to cancel listing:', err);
      setError('Network error while cancelling this listing. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1e293b]/50 backdrop-blur-xs">
      <div className="relative w-full max-w-sm bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl shadow-2xl overflow-hidden text-[#1e293b]">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#ccdbfd] bg-[#d7e3fc]">
          <h2 className="text-sm font-extrabold flex items-center gap-2">
            <Ban className="w-4 h-4 text-red-600" />
            Cancel Listing
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg text-[#1e293b]/70 hover:bg-[#c1d3fe]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-sm text-[#1e293b]">
            Cancel <strong className="font-bold break-words">"{auction.title}"</strong>? This cannot be undone.
          </p>

          {hasBids && (
            <div
              role="alert"
              className="p-2.5 rounded-xl bg-amber-100/90 border border-amber-300 text-amber-900 text-xs flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                This listing already has {auction.bids.length} {auction.bids.length === 1 ? 'bid' : 'bids'}.
                Bidders will still be able to see the cancelled listing.
              </span>
            </div>
          )}

          {error && (
            <div role="alert" className="p-2.5 rounded-xl bg-red-100/95 border border-red-200 text-red-800 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              id="cancel-listing-keep-btn"
              type="button"
              onClick={onClose}
              className="flex-1 inline-flex items-center justify-center px-3 min-h-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] text-xs font-bold text-[#1e293b] transition-colors"
            >
              Keep Listing
            </button>
            <button
              id="cancel-listing-confirm-btn"
              type="button"
              onClick={handleConfirm}
              disabled={isSubmitting}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-red-600 hover:bg-red-700 text-xs font-extrabold text-white transition-colors disabled:opacity-60 cursor-pointer"
            >
              <Ban className="w-3.5 h-3.5" />
              <span>{isSubmitting ? 'Cancelling...' : 'Yes, Cancel It'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
