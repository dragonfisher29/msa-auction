import React from 'react';
import { Ban, Pencil } from 'lucide-react';
import { AuctionItem } from '../types';

interface ListingActionsProps {
  auction: AuctionItem;
  onEdit: () => void;
  onCancel: () => void;
}

// Mirrors the server's own 409 LISTING_HAS_BIDS message (see the API contract): the UI should
// not offer an action that cannot succeed, but the reason it's unavailable still has to be
// visible rather than the control simply vanishing.
const HAS_BIDS_REASON = 'This listing already has bids and can no longer be edited. You can cancel it instead.';

/**
 * Edit / Cancel controls for a listing the signed-in viewer owns. Rendered from two places:
 * AccountView's "My Listings" section, and AuctionDetailModal when the viewer is the seller.
 *
 * A listing that is no longer active (ended or already cancelled) has nothing actionable left --
 * the server rejects both PATCH and DELETE on it with LISTING_NOT_EDITABLE -- so this renders
 * nothing at all in that case rather than a pair of buttons that only fail when clicked.
 */
export const ListingActions: React.FC<ListingActionsProps> = ({ auction, onEdit, onCancel }) => {
  if (auction.status !== 'active') {
    return null;
  }

  const hasBids = auction.bids.length > 0;

  return (
    <div className="p-3 rounded-2xl bg-[#d7e3fc] border border-[#ccdbfd] space-y-2">
      <div className="flex items-center gap-2">
        <button
          id={`edit-listing-btn-${auction.id}`}
          type="button"
          onClick={onEdit}
          disabled={hasBids}
          title={hasBids ? HAS_BIDS_REASON : undefined}
          aria-label={`Edit ${auction.title}`}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-[#edf2fb] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-xs font-bold text-[#1e293b] transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[#edf2fb] cursor-pointer"
        >
          <Pencil className="w-3.5 h-3.5" />
          <span>Edit</span>
        </button>

        <button
          id={`cancel-listing-btn-${auction.id}`}
          type="button"
          onClick={onCancel}
          aria-label={`Cancel ${auction.title}`}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-red-50 hover:bg-red-100 border border-red-200 text-xs font-bold text-red-700 transition-colors cursor-pointer"
        >
          <Ban className="w-3.5 h-3.5" />
          <span>Cancel Listing</span>
        </button>
      </div>

      {hasBids && (
        <p id={`edit-disabled-reason-${auction.id}`} className="text-[11px] text-[#1e293b]/70">
          {HAS_BIDS_REASON}
        </p>
      )}
    </div>
  );
};
