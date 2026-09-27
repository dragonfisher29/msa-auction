import React, { useState, useEffect, useMemo } from 'react';
import { ArrowUpRight, CalendarDays, Star, Images, ImageOff, User as UserIcon } from 'lucide-react';
import { AuctionItem } from '../types';
import { formatListedAgo, formatPrice } from '../lib/formatters';
import { fetchAuctionImages } from '../lib/images';
import { getListingStatus, LISTING_STATUS_LABEL } from '../lib/listing';
import { PLACEHOLDER_IMAGE_URL } from '../lib/placeholder';
import { useInViewport } from '../lib/useInViewport';

interface AuctionCardProps {
  auction: AuctionItem;
  isWatchlisted?: boolean;
  onToggleWatchlist?: (auctionId: string) => void;
  onSelect: (auction: AuctionItem) => void;
}

export const AuctionCard: React.FC<AuctionCardProps> = ({
  auction,
  isWatchlisted = false,
  onToggleWatchlist,
  onSelect,
}) => {
  const status = getListingStatus(auction);
  const isAvailable = status === 'active';

  // The paginated list endpoint (`GET /api/auctions`) ships no image data at all on a row --
  // only `imageCount`, so the card knows whether to bother fetching before it has anything to
  // show. Some callers (AccountView's activity feed, a freshly created listing, a single-item
  // fetch) still hand over the full object with `imageUrls` inline; that path is preferred when
  // present since it needs no network round trip at all.
  const inlineImages = useMemo(
    () => (Array.isArray(auction.imageUrls) ? auction.imageUrls.filter((url) => typeof url === 'string' && url.trim() !== '') : null),
    [auction.imageUrls],
  );

  const knownImageCount = inlineImages ? inlineImages.length : (auction.imageCount ?? 0);

  const [fetchedImages, setFetchedImages] = useState<string[] | null>(null);
  const needsFetch = !inlineImages && knownImageCount > 0;
  const [containerRef, isInViewport] = useInViewport<HTMLDivElement>();

  // Fetch at most once per listing id: the feed refresh hands this card a brand-new `auction`
  // object each time, but the effect below only depends on `auction.id`, and `fetchAuctionImages`
  // itself caches by id -- so refreshing a page of cards triggers zero additional image requests
  // after the first load.
  useEffect(() => {
    if (!needsFetch || !isInViewport) {
      return;
    }
    let cancelled = false;
    fetchAuctionImages(auction.id).then((urls) => {
      if (!cancelled) {
        setFetchedImages(urls);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsFetch, isInViewport, auction.id]);

  const resolvedImages = inlineImages ?? fetchedImages;
  const primaryImageSrc = resolvedImages?.[0] || PLACEHOLDER_IMAGE_URL;
  const isImageLoading = needsFetch && fetchedImages === null;

  return (
    <div
      id={`auction-card-${auction.id}`}
      className="group flex flex-col bg-[#e2eafc] hover:bg-[#d7e3fc] border border-[#ccdbfd] hover:border-[#b6ccfe] rounded-2xl overflow-hidden shadow-xs hover:shadow-md transition-all duration-200 text-[#1e293b] relative"
    >
      {/* Card Image Banner: fixed height regardless of load state, so a card never reflows once
          its image (or the "no photos" placeholder) actually resolves. */}
      <div ref={containerRef} className="relative h-44 sm:h-48 w-full overflow-hidden bg-[#d7e3fc]">
        {isImageLoading ? (
          <div className="w-full h-full animate-pulse bg-[#ccdbfd]" aria-hidden="true" />
        ) : knownImageCount === 0 && !resolvedImages ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 bg-[#ccdbfd]/60 text-[#1e293b]/50">
            <ImageOff className="w-6 h-6" />
            <span className="text-[10px] font-bold uppercase tracking-wider">No photos</span>
          </div>
        ) : (
          <img
            src={primaryImageSrc}
            alt={auction.title}
            referrerPolicy="no-referrer"
            loading="lazy"
            decoding="async"
            className={`w-full h-full object-cover group-hover:scale-103 transition-transform duration-300 ${isAvailable ? '' : 'grayscale-[60%]'}`}
          />
        )}

        {/* Top row: a status badge only when the listing is no longer for sale (an available
            listing needs no badge -- that is the normal case), plus the watchlist toggle. */}
        <div className="absolute top-2.5 left-2.5 right-2.5 sm:top-3 sm:left-3 sm:right-3 flex items-start justify-between gap-1.5 pointer-events-none">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            {!isAvailable && (
              <span
                data-testid={`listing-status-badge-${auction.id}`}
                className={`px-2.5 py-1 rounded-full text-xs font-extrabold shadow-xs ${
                  status === 'sold' ? 'bg-emerald-700 text-white' : 'bg-slate-800 text-slate-100'
                }`}
              >
                {LISTING_STATUS_LABEL[status]}
              </span>
            )}
          </div>

          {/* Watchlist Toggle Button */}
          {onToggleWatchlist && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleWatchlist(auction.id);
              }}
              title={isWatchlisted ? 'Remove from Watchlist' : 'Add to Watchlist'}
              aria-label={isWatchlisted ? `Remove ${auction.title} from watchlist` : `Add ${auction.title} to watchlist`}
              aria-pressed={isWatchlisted}
              className={`pointer-events-auto shrink-0 inline-flex items-center justify-center p-2 min-h-[40px] min-w-[40px] rounded-full backdrop-blur-md transition-all shadow-xs cursor-pointer ${
                isWatchlisted
                  ? 'bg-amber-400 text-slate-900 hover:bg-amber-300'
                  : 'bg-[#1e293b]/60 text-white hover:bg-[#1e293b]/80'
              }`}
            >
              <Star className={`w-4 h-4 ${isWatchlisted ? 'fill-slate-900' : ''}`} />
            </button>
          )}
        </div>

        {/* Multi-image hint. Uses the server-reported count immediately -- it doesn't wait on the
            lazy image fetch. */}
        {knownImageCount > 1 && (
          <div
            id={`auction-card-image-count-${auction.id}`}
            title={`${knownImageCount} photos`}
            className="absolute bottom-3 left-3 px-2 py-1 rounded-xl bg-[#1e293b]/70 backdrop-blur-xs text-white text-[11px] font-bold flex items-center gap-1 shadow-sm"
          >
            <Images className="w-3.5 h-3.5 opacity-90" />
            <span>{knownImageCount}</span>
          </div>
        )}
      </div>

      {/* Card Content */}
      <div className="p-4 flex-1 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-bold text-sm sm:text-base text-[#1e293b] line-clamp-1 group-hover:text-black transition-colors flex-1 min-w-0 break-words" title={auction.title}>
              {auction.title}
            </h3>
            {auction.category && (
              <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-[#b6ccfe] text-[#1e293b] shrink-0 uppercase tracking-wider max-w-[45%] truncate">
                {auction.category}
              </span>
            )}
          </div>
          <p className="text-xs text-[#1e293b]/75 line-clamp-2 mt-1 min-h-[32px] leading-relaxed break-words">
            {auction.description}
          </p>
        </div>

        <div className="mt-4 pt-3 border-t border-[#ccdbfd]/80 space-y-2.5">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[#1e293b]/65">Price</p>
            <span
              data-testid={`listing-price-${auction.id}`}
              className={`text-lg sm:text-xl font-extrabold tracking-tight ${isAvailable ? 'text-[#1e293b]' : 'text-[#1e293b]/60 line-through decoration-2'}`}
            >
              {formatPrice(auction.price)}
            </span>
          </div>

          {/* Seller + age */}
          <div className="flex items-center justify-between gap-2 text-xs py-1.5 px-2.5 rounded-xl bg-[#d7e3fc] border border-[#ccdbfd]">
            <span className="flex items-center gap-1.5 min-w-0 truncate" title={auction.sellerName}>
              <UserIcon className="w-3.5 h-3.5 text-[#1e293b]/70 shrink-0" />
              <span className="text-xs font-bold text-[#1e293b] truncate">{auction.sellerName}</span>
            </span>
            <span className="flex items-center gap-1 text-[11px] text-[#1e293b]/65 shrink-0">
              <CalendarDays className="w-3.5 h-3.5" />
              <span>{formatListedAgo(auction.createdAt)}</span>
            </span>
          </div>

          <button
            id={`view-auction-btn-${auction.id}`}
            type="button"
            onClick={() => onSelect(auction)}
            aria-label={`View details for ${auction.title}`}
            className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-xs font-extrabold text-[#1e293b] shadow-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer mt-1 active:scale-98"
          >
            <span>View Details</span>
            <ArrowUpRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
