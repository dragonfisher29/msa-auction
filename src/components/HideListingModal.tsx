import React, { useState } from 'react';
import { AlertCircle, AlertTriangle, EyeOff, X } from 'lucide-react';
import { User } from '../types';
import { apiFetchAuthed } from '../lib/api';
import { describeModerationError } from '../lib/apiErrors';
import { MODERATION_REASON_MAX_LENGTH } from '../lib/moderation';

interface HideListingModalProps {
  auctionId: string;
  /** Null when hiding a listing entered by ID rather than picked out of the reports queue. */
  auctionTitle: string | null;
  user: User;
  onClose: () => void;
  /** Called once the hide succeeds, with how many open reports the server closed with it. */
  onHidden: (result: { auctionId: string; reportsActioned: number }) => void;
}

/**
 * `POST /api/admin/auctions/:id/hide` behind a confirmation step.
 *
 * Hiding is a takedown, so it is never one click away: this states in plain words what happens
 * to the listing and requires a reason, which the server records against the row (`hidden_by` /
 * `hidden_reason`) so a takedown is always attributable afterwards.
 */
export const HideListingModal: React.FC<HideListingModalProps> = ({
  auctionId,
  auctionTitle,
  user,
  onClose,
  onHidden,
}) => {
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!reason.trim()) {
      setError('A reason is required. It is recorded against the takedown.');
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await apiFetchAuthed(`/api/admin/auctions/${auctionId}/hide`, user.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(describeModerationError(data, 'Unable to hide this listing. Please try again.'));
        return;
      }

      onHidden({
        auctionId,
        reportsActioned: typeof data?.reportsActioned === 'number' ? data.reportsActioned : 0,
      });
    } catch (err) {
      console.error('Failed to hide listing:', err);
      setError('Network error while hiding this listing. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[#1e293b]/50 backdrop-blur-xs overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hide-listing-heading"
        className="relative w-full max-w-md bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl shadow-2xl overflow-hidden text-[#1e293b] my-2 sm:my-4"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#ccdbfd] bg-[#d7e3fc]">
          <h2 id="hide-listing-heading" className="text-sm font-extrabold flex items-center gap-2 min-w-0">
            <EyeOff className="w-4 h-4 text-red-600 shrink-0" />
            <span className="truncate">Hide Listing</span>
          </h2>
          <button
            id="close-hide-listing-btn"
            type="button"
            onClick={onClose}
            aria-label="Close hide listing dialog"
            className="shrink-0 inline-flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg text-[#1e293b]/70 hover:text-[#1e293b] hover:bg-[#c1d3fe] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleConfirm} className="p-4 space-y-3">
          <p className="text-sm text-[#1e293b]">
            Hide{' '}
            {auctionTitle ? (
              <strong className="font-bold break-words">"{auctionTitle}"</strong>
            ) : (
              <strong className="font-bold break-all">{auctionId}</strong>
            )}
            ?
          </p>

          <div
            role="alert"
            className="p-2.5 rounded-xl bg-amber-100/90 border border-amber-300 text-amber-900 text-xs flex items-start gap-2"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              This removes the listing from the public grid immediately. Anyone holding a direct
              link can still open it, and every open report on it will be closed as actioned.
            </span>
          </div>

          <div>
            <label htmlFor="hide-listing-reason-input" className="block text-xs font-bold text-[#1e293b] mb-1">
              Reason <span className="font-medium text-[#1e293b]/60">(required, recorded)</span>
            </label>
            <textarea
              id="hide-listing-reason-input"
              rows={3}
              required
              maxLength={MODERATION_REASON_MAX_LENGTH}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setError(null);
              }}
              placeholder="e.g. confirmed scam - seller asked for a bank transfer off-platform"
              className="w-full px-3 py-2 text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] placeholder-[#1e293b]/40 font-medium resize-y"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="p-2.5 rounded-xl bg-red-100/95 border border-red-200 text-red-800 text-xs flex items-center gap-2"
            >
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              id="hide-listing-keep-btn"
              type="button"
              onClick={onClose}
              className="flex-1 inline-flex items-center justify-center px-3 min-h-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] text-xs font-bold text-[#1e293b] transition-colors cursor-pointer"
            >
              Leave It Up
            </button>
            <button
              id="hide-listing-confirm-btn"
              type="submit"
              disabled={isSubmitting}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-red-600 hover:bg-red-700 text-xs font-extrabold text-white transition-colors disabled:opacity-60 cursor-pointer"
            >
              <EyeOff className="w-3.5 h-3.5" />
              <span>{isSubmitting ? 'Hiding...' : 'Yes, Hide It'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
