import React from 'react';
import { ArrowLeft, SearchX, X } from 'lucide-react';

interface ListingUnavailableNoticeProps {
  /** `'missing'`: the server answered 404 (deleted, or hidden by the committee).
   *  `'failed'`: the lookup itself failed, so we genuinely do not know -- say so rather than
   *  claiming the listing is gone. */
  reason: 'missing' | 'failed';
  onClose: () => void;
}

/**
 * What a link to a listing shows when there is no listing to show. A shared `/auction/:id` link
 * outlives the listing it points at (hidden, or simply gone), and landing on the plain grid with
 * no explanation reads as a broken site -- so the visitor gets told, and gets one obvious way on.
 */
export const ListingUnavailableNotice: React.FC<ListingUnavailableNoticeProps> = ({ reason, onClose }) => {
  const heading = reason === 'missing' ? 'This listing is no longer available' : "We couldn't load this listing";
  const body =
    reason === 'missing'
      ? 'It may have been removed, or the link may be wrong. Everything still for sale is on the browse page.'
      : 'Please check your connection and try the link again in a moment.';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1e293b]/50 backdrop-blur-xs">
      <div
        id="listing-unavailable-notice"
        role="dialog"
        aria-modal="true"
        aria-labelledby="listing-unavailable-heading"
        aria-describedby="listing-unavailable-body"
        className="relative w-full max-w-sm bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl shadow-2xl overflow-hidden text-[#1e293b]"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#ccdbfd] bg-[#d7e3fc]">
          <h2 id="listing-unavailable-heading" className="text-sm font-extrabold flex items-center gap-2 min-w-0">
            <SearchX className="w-4 h-4 shrink-0" />
            <span>{heading}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 inline-flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg text-[#1e293b]/70 hover:bg-[#c1d3fe]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p id="listing-unavailable-body" className="text-sm text-[#1e293b]/85">
            {body}
          </p>
          <button
            id="listing-unavailable-browse-btn"
            type="button"
            onClick={onClose}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-sm font-bold text-[#1e293b] transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Browse Listings</span>
          </button>
        </div>
      </div>
    </div>
  );
};
