import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, Flag, X } from 'lucide-react';
import { AuctionItem, User } from '../types';
import { apiFetchAuthed } from '../lib/api';
import {
  AUTH_ERROR_CODES,
  AUCTION_NOT_FOUND,
  INVALID_REPORT_REASON,
  readErrorCode,
  stripErrorCode,
} from '../lib/apiErrors';
import {
  REPORT_DETAILS_MAX_LENGTH,
  REPORT_REASON_OPTIONS,
  ReportReason,
} from '../lib/moderation';

interface ReportListingModalProps {
  auction: AuctionItem;
  /** Non-null by construction: the Report control only renders for a signed-in non-seller. */
  user: User;
  onClose: () => void;
}

/**
 * `POST /api/auctions/:id/report`.
 *
 * The reason is a closed set of five (see `src/lib/moderation.ts`) rendered as real radio
 * inputs in a `radiogroup`, so arrow keys work and a screen reader announces "3 of 5" without
 * any ARIA of our own. There is no free-text reason field on purpose: the admin queue is
 * triaged by reason, and free text there would make it uncountable.
 *
 * The duplicate case matters more than it looks. The server answers a second open report from
 * the same user with 200 and `duplicate: true` rather than a conflict, precisely so a reporter
 * is never told whether their earlier report is still open. This modal therefore renders it as
 * an ordinary success: telling someone "you already reported this" leaks queue state, and
 * telling them it failed would be a lie that might stop them reporting a real scam.
 */
export const ReportListingModal: React.FC<ReportListingModalProps> = ({ auction, user, onClose }) => {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!reason) {
      setError('Please choose a reason for the report.');
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await apiFetchAuthed(`/api/auctions/${auction.id}/report`, user.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, details: details.trim() || undefined }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const code = readErrorCode(data);

        if (code && AUTH_ERROR_CODES.has(code)) {
          setError('Your session has expired. Please sign in again to report this listing.');
          return;
        }
        if (code === INVALID_REPORT_REASON) {
          // Only reachable if this list and the server's have drifted apart.
          setError('That reason is no longer accepted. Please pick another one.');
          return;
        }
        if (code === AUCTION_NOT_FOUND) {
          setError('This listing no longer exists, so there is nothing to report.');
          return;
        }

        setError(data?.error ? stripErrorCode(data.error) : 'Unable to send your report. Please try again.');
        return;
      }

      // 200 covers both a new report and a duplicate. Both are a success here -- see above.
      setIsSubmitted(true);
    } catch (err) {
      console.error('Failed to report listing:', err);
      setError('Network error while sending your report. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[#1e293b]/50 backdrop-blur-xs overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-listing-heading"
        className="relative w-full max-w-md bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl shadow-2xl overflow-hidden text-[#1e293b] my-2 sm:my-4 flex flex-col modal-max-h"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#ccdbfd] bg-[#d7e3fc] shrink-0">
          <h2 id="report-listing-heading" className="text-sm font-extrabold flex items-center gap-2 min-w-0">
            <Flag className="w-4 h-4 text-red-600 shrink-0" />
            <span className="truncate">Report this listing</span>
          </h2>
          <button
            id="close-report-modal-btn"
            type="button"
            onClick={onClose}
            aria-label="Close report dialog"
            className="shrink-0 inline-flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg text-[#1e293b]/70 hover:text-[#1e293b] hover:bg-[#c1d3fe] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain p-4">
          {isSubmitted ? (
            <div className="space-y-4">
              <div
                id="report-listing-success"
                role="status"
                className="p-3 rounded-xl bg-emerald-100/95 border border-emerald-200 text-emerald-900 text-xs flex items-start gap-2"
              >
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  Thanks — the committee has been notified. They will review this listing and take
                  it down if it breaks the rules.
                </span>
              </div>

              <button
                id="report-listing-done-btn"
                type="button"
                onClick={onClose}
                className="w-full inline-flex items-center justify-center px-3 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-sm font-bold text-[#1e293b] transition-colors cursor-pointer"
              >
                Done
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-xs text-[#1e293b]/80">
                Reporting <strong className="font-bold break-words">"{auction.title}"</strong> by{' '}
                {auction.sellerName}. Only the MSA committee sees this.
              </p>

              {error && (
                <div
                  role="alert"
                  className="p-2.5 rounded-xl bg-red-100/95 border border-red-200 text-red-800 text-xs flex items-center gap-2"
                >
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <fieldset className="space-y-2">
                <legend className="text-xs font-bold text-[#1e293b] mb-1">What is wrong with it?</legend>

                {REPORT_REASON_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    htmlFor={`report-reason-${option.value}`}
                    className={`flex items-start gap-2.5 p-2.5 min-h-[44px] rounded-xl border cursor-pointer transition-colors ${
                      reason === option.value
                        ? 'bg-[#abc4ff] border-[#c1d3fe]'
                        : 'bg-[#edf2fb] border-[#ccdbfd] hover:bg-[#d7e3fc]'
                    }`}
                  >
                    <input
                      id={`report-reason-${option.value}`}
                      type="radio"
                      name="report-reason"
                      value={option.value}
                      checked={reason === option.value}
                      onChange={() => {
                        setReason(option.value);
                        setError(null);
                      }}
                      className="mt-0.5 w-4 h-4 shrink-0 accent-[#1e293b] cursor-pointer"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-bold text-[#1e293b]">{option.label}</span>
                      <span className="block text-[11px] text-[#1e293b]/70 mt-0.5">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <div>
                <label htmlFor="report-details-input" className="block text-xs font-bold text-[#1e293b] mb-1">
                  Anything else? <span className="font-medium text-[#1e293b]/60">(optional)</span>
                </label>
                <textarea
                  id="report-details-input"
                  rows={3}
                  maxLength={REPORT_DETAILS_MAX_LENGTH}
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  placeholder="e.g. the same photos appear on another listing under a different name"
                  className="w-full px-3 py-2 text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] placeholder-[#1e293b]/40 font-medium resize-y"
                />
                <p className="text-[11px] text-[#1e293b]/60 mt-1">
                  {details.length}/{REPORT_DETAILS_MAX_LENGTH} characters
                </p>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  id="report-listing-cancel-btn"
                  type="button"
                  onClick={onClose}
                  className="flex-1 inline-flex items-center justify-center px-3 min-h-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] text-xs font-bold text-[#1e293b] transition-colors cursor-pointer"
                >
                  Never Mind
                </button>
                <button
                  id="report-listing-submit-btn"
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-red-600 hover:bg-red-700 text-xs font-extrabold text-white transition-colors disabled:opacity-60 cursor-pointer"
                >
                  <Flag className="w-3.5 h-3.5" />
                  <span>{isSubmitting ? 'Sending...' : 'Send Report'}</span>
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
