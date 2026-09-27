import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { AuctionItem, User } from '../types';
import { apiFetchAuthed } from '../lib/api';
import {
  AUTH_ERROR_CODES,
  LISTING_NOT_EDITABLE,
  NOT_LISTING_OWNER,
  readErrorCode,
  stripErrorCode,
} from '../lib/apiErrors';

interface MarkSoldModalProps {
  auction: AuctionItem;
  user: User;
  onClose: () => void;
  /** Called with the server's updated (now-sold) listing once `POST /sold` succeeds. */
  onSold: (updated: AuctionItem) => void;
}

/**
 * A confirmation step for marking a listing sold. Like cancelling, it cannot be undone (the
 * server refuses every later edit with a 409), and it takes the listing off the browse page at
 * once, so one stray tap on "Mark as Sold" must not be enough on its own.
 */
export const MarkSoldModal: React.FC<MarkSoldModalProps> = ({ auction, user, onClose, onSold }) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      const res = await apiFetchAuthed(`/api/auctions/${auction.id}/sold`, user.token, { method: 'POST' });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const code = readErrorCode(data);

        if (code && AUTH_ERROR_CODES.has(code)) {
          setError('Your session has expired. Please sign in again to mark this listing as sold.');
          return;
        }
        if (code === NOT_LISTING_OWNER) {
          setError('You are not the seller of this listing, so it cannot be marked as sold from here.');
          return;
        }
        if (code === LISTING_NOT_EDITABLE || res.status === 409) {
          setError('This listing is no longer active (it may already be sold, expired or cancelled).');
          return;
        }

        setError(data?.error ? stripErrorCode(data.error) : 'Unable to mark this listing as sold. Please try again.');
        return;
      }

      // Every other write endpoint answers `{ auction }`; fall back to patching the status
      // locally if this one ever does not, so the UI still reflects the sale.
      const updated: AuctionItem = data?.auction ?? { ...auction, status: 'sold', soldAt: Date.now() };
      onSold(updated);
    } catch (err) {
      console.error('Failed to mark listing as sold:', err);
      setError('Network error while marking this listing as sold. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1e293b]/50 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mark-sold-heading"
        className="relative w-full max-w-sm bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl shadow-2xl overflow-hidden text-[#1e293b]"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#ccdbfd] bg-[#d7e3fc]">
          <h2 id="mark-sold-heading" className="text-sm font-extrabold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            Mark as Sold
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
            Mark <strong className="font-bold break-words">"{auction.title}"</strong> as sold? It will be
            removed from the browse page straight away. This cannot be undone.
          </p>

          {error && (
            <div role="alert" className="p-2.5 rounded-xl bg-red-100/95 border border-red-200 text-red-800 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              id="mark-sold-keep-btn"
              type="button"
              onClick={onClose}
              className="flex-1 inline-flex items-center justify-center px-3 min-h-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] text-xs font-bold text-[#1e293b] transition-colors"
            >
              Not Yet
            </button>
            <button
              id="mark-sold-confirm-btn"
              type="button"
              onClick={handleConfirm}
              disabled={isSubmitting}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-emerald-600 hover:bg-emerald-700 text-xs font-extrabold text-white transition-colors disabled:opacity-60 cursor-pointer"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{isSubmitting ? 'Saving...' : 'Yes, It Sold'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
