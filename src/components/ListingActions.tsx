import React from 'react';
import { Ban, CheckCircle2, Pencil } from 'lucide-react';
import { AuctionItem } from '../types';
import { isListingAvailable } from '../lib/listing';

interface ListingActionsProps {
  auction: AuctionItem;
  onEdit: () => void;
  onMarkSold: () => void;
  onCancel: () => void;
}

/**
 * Edit / Mark as sold / Cancel controls for a listing the signed-in viewer owns. Rendered from
 * two places: AccountView's "My Listings" section, and AuctionDetailModal when the viewer is the
 * seller.
 *
 * A listing that is no longer available (sold, expired, cancelled or hidden) has nothing
 * actionable left -- the server answers 409 to an edit, a sale or a cancel on it -- so this
 * renders nothing at all in that case rather than buttons that only fail when clicked.
 */
export const ListingActions: React.FC<ListingActionsProps> = ({ auction, onEdit, onMarkSold, onCancel }) => {
  if (!isListingAvailable(auction)) {
    return null;
  }

  return (
    <div className="p-3 rounded-2xl bg-[#d7e3fc] border border-[#ccdbfd] space-y-2">
      <button
        id={`mark-sold-btn-${auction.id}`}
        type="button"
        onClick={onMarkSold}
        aria-label={`Mark ${auction.title} as sold`}
        className="w-full inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-emerald-700 hover:bg-emerald-800 text-xs font-extrabold text-white transition-colors cursor-pointer"
      >
        <CheckCircle2 className="w-3.5 h-3.5" />
        <span>Mark as Sold</span>
      </button>

      <div className="flex items-center gap-2">
        <button
          id={`edit-listing-btn-${auction.id}`}
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${auction.title}`}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-[#edf2fb] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-xs font-bold text-[#1e293b] transition-colors cursor-pointer"
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
    </div>
  );
};
