import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  X,
  Clock,
  PoundSterling,
  TrendingUp,
  User as UserIcon,
  Phone,
  Trophy,
  AlertCircle,
  CheckCircle2,
  Copy,
  Check,
  Flame,
  History,
  ShieldCheck,
  Send,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
} from 'lucide-react';
import { AuctionItem, User } from '../types';
import {
  buildWhatsAppUrl,
  formatCurrency,
  formatCurrencyPrecise,
  formatTimeRemaining,
  formatTimestamp,
} from '../lib/formatters';
import { apiFetch } from '../lib/api';
import { startPolling } from '../lib/realtime';

const FALLBACK_IMAGE_URL =
  'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=800&q=80';

// Minimum horizontal travel (px) before a touch counts as a swipe rather than a tap or a
// vertical scroll that happened to drift sideways.
const SWIPE_THRESHOLD_PX = 50;

// The API appends a machine-readable " [Code: SOME_CODE]" suffix to error messages for API
// consumers and logs (see workers/index.ts). That suffix is not meant for end users, so strip
// it before rendering the message in the UI.
function stripErrorCode(message: string): string {
  return message.replace(/\s*\[Code:\s*[^\]]+\]\s*$/, '');
}

interface AuctionDetailModalProps {
  auction: AuctionItem;
  user: User | null;
  onClose: () => void;
  onPromptAuth: () => void;
  onAuctionUpdated: (updated: AuctionItem) => void;
}

export const AuctionDetailModal: React.FC<AuctionDetailModalProps> = ({
  auction: initialAuction,
  user,
  onClose,
  onPromptAuth,
  onAuctionUpdated,
}) => {
  const [auction, setAuction] = useState<AuctionItem>(initialAuction);
  const [timeInfo, setTimeInfo] = useState(() => formatTimeRemaining(auction.endTime));
  const [bidAmount, setBidAmount] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [flashNewBid, setFlashNewBid] = useState(false);
  const [activeImageIndex, setActiveImageIndex] = useState(0);

  const bidHistoryEndRef = useRef<HTMLDivElement | null>(null);
  const touchStartXRef = useRef<number | null>(null);

  // Tracks whether the user has started typing or incrementing their own bid. While true, the
  // 3s poll's auto-fill effect below must not overwrite the input just because a rival's bid
  // changed the suggested amount.
  const hasUserEditedBidRef = useRef(false);

  // Last values seen from the server, used to detect a genuinely new bid
  const lastSeenRef = useRef({
    currentPrice: initialAuction.currentPrice,
    bidCount: initialAuction.bids.length,
  });

  // Held in a ref so a new parent callback identity does not restart the poll timer
  const onAuctionUpdatedRef = useRef(onAuctionUpdated);
  useEffect(() => {
    onAuctionUpdatedRef.current = onAuctionUpdated;
  }, [onAuctionUpdated]);

  // The true enforced minimum: what the server will actually accept.
  // Rounded to the nearest penny: raw float addition (e.g. 100.01 + 0.01) can land on a value
  // like 100.02000000000001, which the input's `min` attribute would then enforce even though
  // the "Min: £X" hint below renders the clean .toFixed(2) value. Rounding here keeps both in sync.
  const minRequiredBid = auction.bids.length === 0
    ? auction.startingPrice
    : Math.round((auction.currentPrice + 0.01) * 100) / 100;

  // A friendlier round-number suggestion, used only to pre-fill the input.
  const suggestedBid = auction.bids.length === 0
    ? auction.startingPrice
    : auction.currentPrice + 5;

  // Initialize input with the suggested bid, but only while the user hasn't started editing
  // it themselves -- otherwise a rival's bid landing mid-poll would silently clobber whatever
  // they've typed or incremented.
  useEffect(() => {
    if (!hasUserEditedBidRef.current) {
      setBidAmount(suggestedBid.toString());
    }
  }, [suggestedBid]);

  // Switching to a different auction is a fresh bidding session, so let the next suggestion
  // pre-fill again.
  useEffect(() => {
    hasUserEditedBidRef.current = false;
  }, [auction.id]);

  // Gallery source of truth: the multi-image array when the listing has one, otherwise the
  // legacy single imageUrl, otherwise the shared placeholder. Blank strings are dropped so a
  // stored "" can never render an empty frame the user has to swipe past.
  const galleryImages = useMemo(() => {
    const fromArray = Array.isArray(auction.imageUrls)
      ? auction.imageUrls.filter((url) => typeof url === 'string' && url.trim() !== '')
      : [];

    if (fromArray.length > 0) {
      return fromArray;
    }

    if (auction.imageUrl && auction.imageUrl.trim() !== '') {
      return [auction.imageUrl];
    }

    return [FALLBACK_IMAGE_URL];
  }, [auction.imageUrls, auction.imageUrl]);

  // The modal instance is reused across listings, so a new auction starts at its first image.
  useEffect(() => {
    setActiveImageIndex(0);
  }, [auction.id]);

  // A poll refresh can return fewer images than the render that is currently on screen
  // (e.g. the seller deleted one), which would otherwise leave the index pointing past the end.
  useEffect(() => {
    setActiveImageIndex((prev) => (prev > galleryImages.length - 1 ? 0 : prev));
  }, [galleryImages.length]);

  const hasMultipleImages = galleryImages.length > 1;

  const goToImage = (delta: number) => {
    setActiveImageIndex((prev) => (prev + delta + galleryImages.length) % galleryImages.length);
  };

  // Scoped to the gallery container rather than window: a window listener would steal the
  // arrow keys that nudge the bid-amount number input.
  const handleGalleryKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!hasMultipleImages) return;

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goToImage(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      goToImage(1);
    }
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    touchStartXRef.current = e.changedTouches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    const startX = touchStartXRef.current;
    touchStartXRef.current = null;

    if (startX === null || !hasMultipleImages) return;

    const deltaX = (e.changedTouches[0]?.clientX ?? startX) - startX;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return;

    // Swiping left (negative delta) drags the next image into view.
    goToImage(deltaX < 0 ? 1 : -1);
  };

  // Keep countdown updated every second
  useEffect(() => {
    const updateCountdown = () => {
      const info = formatTimeRemaining(auction.endTime);
      setTimeInfo(info);
      if (info.isEnded && auction.status === 'active') {
        // Local fallback if server interval has a slight latency
        setAuction((prev) => ({ ...prev, status: 'ended' }));
      }
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [auction.endTime, auction.status]);

  // Live room updates: poll this single listing while the modal is open
  useEffect(() => {
    const auctionId = auction.id;

    const stopPoll = startPolling<AuctionItem | null>(
      async () => {
        const res = await apiFetch(`/api/auctions/${auctionId}`);
        if (!res.ok) {
          throw new Error(`Auction listing responded with ${res.status}`);
        }
        const data = await res.json();
        return (data.auction ?? null) as AuctionItem | null;
      },
      3000,
      (fresh) => {
        if (!fresh || fresh.id !== auctionId) {
          return;
        }

        // Flash only when the price or the bid count actually moved
        const prev = lastSeenRef.current;
        const hasNewBid = fresh.currentPrice !== prev.currentPrice || fresh.bids.length !== prev.bidCount;
        lastSeenRef.current = { currentPrice: fresh.currentPrice, bidCount: fresh.bids.length };

        setAuction(fresh);
        onAuctionUpdatedRef.current(fresh);

        if (hasNewBid) {
          setFlashNewBid(true);
          setTimeout(() => setFlashNewBid(false), 2000);
        }
      },
    );

    return stopPoll;
  }, [auction.id]);

  const isEnded = auction.status === 'ended' || timeInfo.isEnded;
  const isSeller = user && user.id === auction.sellerId;
  const isTopBidder = user && user.id === auction.highestBidderId;

  // Handle Placing a Bid via the REST API
  const handlePlaceBid = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!user) {
      onPromptAuth();
      return;
    }

    if (isSeller) {
      setError('You cannot place a bid on your own listing.');
      return;
    }

    if (isEnded) {
      setError('This auction has concluded.');
      return;
    }

    const numericAmount = parseFloat(bidAmount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      setError('Please enter a valid numeric bid amount.');
      return;
    }

    if (auction.bids.length === 0) {
      if (numericAmount < auction.startingPrice) {
        setError(`Bid must be at least the starting price of ${formatCurrencyPrecise(auction.startingPrice)}.`);
        return;
      }
    } else {
      if (numericAmount <= auction.currentPrice) {
        setError(`Bid must be strictly higher than current bid of ${formatCurrencyPrecise(auction.currentPrice)}.`);
        return;
      }
    }

    setIsSubmitting(true);

    try {
      const res = await apiFetch(`/api/auctions/${auction.id}/bids`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          userName: user.name,
          amount: numericAmount,
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error ? stripErrorCode(data.error) : 'Unable to place your bid. Please try again.');
        return;
      }

      // The bid endpoint only returns the new bid, so pull the fresh auction back
      const refreshed = await apiFetch(`/api/auctions/${auction.id}`);
      if (refreshed.ok) {
        const refreshedData = await refreshed.json();
        const fresh = refreshedData.auction as AuctionItem | undefined;
        if (fresh) {
          lastSeenRef.current = { currentPrice: fresh.currentPrice, bidCount: fresh.bids.length };
          setAuction(fresh);
          onAuctionUpdated(fresh);
        }
      }

      setSuccessMessage(`Placed bid of ${formatCurrencyPrecise(numericAmount)}!`);
      setTimeout(() => setSuccessMessage(null), 2500);

      // A successful bid resolves the "editing" session; let the next suggestion pre-fill.
      hasUserEditedBidRef.current = false;
    } catch (err) {
      console.error('Failed to place bid:', err);
      setError('Network error while placing your bid. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleIncrement = (inc: number) => {
    hasUserEditedBidRef.current = true;
    const currentBase = parseFloat(bidAmount) || suggestedBid;
    setBidAmount((currentBase + inc).toString());
    setError(null);
  };

  const whatsAppUrl = buildWhatsAppUrl(
    auction.phoneNumber,
    `Hi ${auction.sellerName}, I'm interested in your "${auction.title}" listing on MSA Auction.`,
  );

  const copyPhoneNumber = () => {
    navigator.clipboard.writeText(auction.phoneNumber);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-[#1e293b]/50 backdrop-blur-xs overflow-y-auto">
      <div className="relative w-full max-w-4xl bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl shadow-2xl overflow-hidden text-[#1e293b] my-2 sm:my-4 flex flex-col modal-max-h">

        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-3 sm:px-6 py-2 sm:py-4 border-b border-[#ccdbfd] bg-[#d7e3fc] shrink-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <span className={`px-2.5 py-1 rounded-full text-[10px] sm:text-xs font-extrabold flex items-center gap-1.5 whitespace-nowrap ${
              isEnded
                ? 'bg-slate-700 text-white'
                : timeInfo.isUrgent
                ? 'bg-rose-500 text-white animate-pulse'
                : 'bg-[#abc4ff] text-[#1e293b] border border-[#c1d3fe]'
            }`}>
              {isEnded ? (
                <>
                  <Trophy className="w-3.5 h-3.5 text-amber-300" />
                  AUCTION ENDED
                </>
              ) : (
                <>
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
                  LIVE BIDDING ROOM
                </>
              )}
            </span>

            {auction.category && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-lg bg-[#b6ccfe] text-[#1e293b] hidden sm:inline">
                {auction.category}
              </span>
            )}
          </div>

          <button
            id="close-auction-detail-btn"
            onClick={onClose}
            aria-label="Close auction details"
            className="shrink-0 inline-flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg text-[#1e293b]/70 hover:text-[#1e293b] hover:bg-[#c1d3fe] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Scrollable Content */}
        <div className="overflow-y-auto overscroll-contain p-4 sm:p-6 space-y-4 sm:space-y-6">
          
          {/* Winner Announcement Banner (If Ended) */}
          {isEnded && (
            <div className="p-3 sm:p-4 rounded-2xl bg-[#d7e3fc] border-2 border-[#abc4ff] shadow-sm flex items-center gap-3 sm:gap-4">
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-[#abc4ff] text-[#1e293b] flex items-center justify-center shrink-0 shadow-xs">
                <Trophy className="w-5 h-5 sm:w-6 sm:h-6 text-amber-700" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm sm:text-base font-extrabold text-[#1e293b] flex items-center flex-wrap gap-2">
                  Auction Concluded!
                  {auction.winnerId === user?.id && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold">
                      You Won!
                    </span>
                  )}
                </h3>
                <p className="text-xs text-[#1e293b]/80 mt-0.5 break-words">
                  {auction.winnerName ? (
                    <>
                      Winner: <strong className="text-[#1e293b] font-bold">{auction.winnerName}</strong> with winning bid of{' '}
                      <strong className="text-[#1e293b] font-bold">{formatCurrency(auction.currentPrice)}</strong>.
                    </>
                  ) : (
                    'No bids were placed on this item before the countdown expired.'
                  )}
                </p>
              </div>
            </div>
          )}

          {/* Top Section: 2 Columns (Image + Overview) */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 sm:gap-6">

            {/* Left: Image & Description */}
            <div className="md:col-span-6 space-y-4 min-w-0">
              {/* Image Gallery: arrows, counter, thumbnails, arrow keys and touch swipe */}
              <div
                tabIndex={0}
                onKeyDown={handleGalleryKeyDown}
                className="space-y-2 focus:outline-hidden"
              >
                <div
                  className="relative rounded-2xl overflow-hidden border border-[#ccdbfd] bg-[#d7e3fc] shadow-xs"
                  onTouchStart={handleTouchStart}
                  onTouchEnd={handleTouchEnd}
                >
                  <img
                    src={galleryImages[activeImageIndex] ?? galleryImages[0]}
                    alt={
                      hasMultipleImages
                        ? `${auction.title} - image ${activeImageIndex + 1} of ${galleryImages.length}`
                        : auction.title
                    }
                    referrerPolicy="no-referrer"
                    className="w-full h-52 sm:h-64 object-cover"
                  />

                  {hasMultipleImages && (
                    <>
                      <button
                        id="gallery-prev-btn"
                        type="button"
                        aria-label="Previous image"
                        onClick={() => goToImage(-1)}
                        className="absolute left-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center p-2 min-h-[40px] min-w-[40px] rounded-full bg-[#1e293b]/60 hover:bg-[#1e293b]/85 text-white backdrop-blur-xs transition-colors cursor-pointer focus:outline-hidden"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>

                      <button
                        id="gallery-next-btn"
                        type="button"
                        aria-label="Next image"
                        onClick={() => goToImage(1)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center p-2 min-h-[40px] min-w-[40px] rounded-full bg-[#1e293b]/60 hover:bg-[#1e293b]/85 text-white backdrop-blur-xs transition-colors cursor-pointer focus:outline-hidden"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>

                      <span
                        id="gallery-counter"
                        className="absolute top-3 right-3 px-2.5 py-1 rounded-full bg-[#1e293b]/60 backdrop-blur-xs text-white text-[11px] font-bold tracking-tight"
                      >
                        {activeImageIndex + 1} / {galleryImages.length}
                      </span>
                    </>
                  )}

                  {/* Live Floating Timer Banner */}
                  <div className={`absolute bottom-2 left-2 right-2 sm:bottom-3 sm:left-3 sm:right-3 py-2 px-2.5 sm:px-3 rounded-xl backdrop-blur-md flex items-center justify-between gap-2 shadow-md ${
                    isEnded
                      ? 'bg-slate-800/90 text-white'
                      : timeInfo.isUrgent
                      ? 'bg-rose-900/90 text-white animate-pulse'
                      : 'bg-[#1e293b]/85 text-white'
                  }`}>
                    <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                      <Clock className="w-4 h-4 text-[#b6ccfe] shrink-0" />
                      <span className="text-[10px] sm:text-xs uppercase font-bold tracking-wider opacity-80 truncate">
                        {isEnded ? 'Status' : 'Time Remaining'}
                      </span>
                    </div>
                    <span className="text-xs sm:text-sm font-extrabold tracking-tight shrink-0">
                      {timeInfo.formatted}
                    </span>
                  </div>
                </div>

                {hasMultipleImages && (
                  <div className="flex items-center gap-2 overflow-x-auto overscroll-x-contain no-scrollbar pb-1">
                    {galleryImages.map((url, index) => (
                      <button
                        key={`${url}-${index}`}
                        id={`gallery-thumb-${index}`}
                        type="button"
                        aria-label={`View image ${index + 1}`}
                        onClick={() => setActiveImageIndex(index)}
                        className={`shrink-0 rounded-xl overflow-hidden border transition-colors cursor-pointer focus:outline-hidden ${
                          index === activeImageIndex
                            ? 'ring-2 ring-[#abc4ff] border-[#abc4ff]'
                            : 'border-[#ccdbfd] hover:border-[#b6ccfe] opacity-80 hover:opacity-100'
                        }`}
                      >
                        <img
                          src={url}
                          alt={`${auction.title} thumbnail ${index + 1}`}
                          referrerPolicy="no-referrer"
                          className="h-14 w-14 sm:h-16 sm:w-16 object-cover rounded-xl"
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Title & Description */}
              <div className="bg-[#d7e3fc] p-3 sm:p-4 rounded-2xl border border-[#ccdbfd]">
                <h2 className="text-base sm:text-lg font-extrabold text-[#1e293b] leading-snug break-words">
                  {auction.title}
                </h2>
                <p className="text-xs text-[#1e293b]/80 mt-2 leading-relaxed whitespace-pre-line break-words">
                  {auction.description}
                </p>

                {/* Seller & Contact Section */}
                <div className="mt-4 pt-3 border-t border-[#ccdbfd] flex flex-wrap items-center justify-between gap-2 sm:gap-3 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-lg bg-[#b6ccfe] flex items-center justify-center font-bold text-xs text-[#1e293b] shrink-0">
                      {auction.sellerName.charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <span className="text-[#1e293b]/60 block text-[10px]">Seller</span>
                      <span className="font-bold text-[#1e293b] block truncate" title={auction.sellerName}>
                        {auction.sellerName}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
                    {/* Phone Contact Badge with Copy Action */}
                    <div className="flex items-center gap-1.5 min-w-0 flex-1 sm:flex-none bg-[#edf2fb] pl-3 pr-1.5 py-1 rounded-xl border border-[#ccdbfd]">
                      <Phone className="w-3.5 h-3.5 text-[#1e293b]/70 shrink-0" />
                      <a
                        href={`tel:${auction.phoneNumber}`}
                        className="font-bold text-[#1e293b] hover:underline truncate"
                      >
                        {auction.phoneNumber}
                      </a>
                      <button
                        type="button"
                        onClick={copyPhoneNumber}
                        title="Copy phone number"
                        aria-label="Copy phone number"
                        className="shrink-0 inline-flex items-center justify-center p-2 min-h-[38px] min-w-[38px] rounded-md text-[#1e293b]/60 hover:text-[#1e293b] hover:bg-[#d7e3fc] transition-colors ml-auto"
                      >
                        {copiedPhone ? (
                          <Check className="w-3 h-3 text-emerald-600" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                    </div>

                    {/* Rendered only when the seller's number parses to a usable wa.me target,
                        so buyers never land on WhatsApp's "invalid number" page. */}
                    {whatsAppUrl && (
                      <a
                        id="contact-whatsapp-btn"
                        href={whatsAppUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-1.5 shrink-0 min-h-[44px] w-full sm:w-auto px-3 rounded-xl bg-[#25D366] hover:bg-[#1eb455] text-white text-xs font-bold shadow-xs transition-colors focus:outline-hidden"
                      >
                        <MessageCircle className="w-3.5 h-3.5" />
                        <span>
                          <span className="hidden sm:inline">Contact on </span>WhatsApp
                        </span>
                      </a>
                    )}
                  </div>
                </div>
              </div>

            </div>

            {/* Right: Bidding Console & Live History Log */}
            <div className="md:col-span-6 space-y-4 flex flex-col justify-between min-w-0">

              {/* Current Price Banner */}
              <div className={`p-3 sm:p-4 rounded-2xl border transition-all duration-300 ${
                flashNewBid
                  ? 'bg-[#abc4ff] border-[#b6ccfe] scale-101 shadow-md'
                  : 'bg-[#d7e3fc] border-[#ccdbfd]'
              }`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-[#1e293b]/70 flex items-center flex-wrap gap-1">
                      {isEnded ? 'Final Winning Bid' : 'Current Highest Bid'}
                      {flashNewBid && (
                        <span className="px-1.5 py-0.5 rounded-full bg-emerald-500 text-white text-[9px] font-extrabold uppercase animate-bounce">
                          NEW BID!
                        </span>
                      )}
                    </span>
                    <div className="text-2xl sm:text-3xl font-black text-[#1e293b] mt-1 tracking-tight break-words">
                      {formatCurrency(auction.currentPrice)}
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span className="text-[11px] text-[#1e293b]/60 block font-medium">Starting</span>
                    <span className="text-sm font-bold text-[#1e293b]">
                      {formatCurrency(auction.startingPrice)}
                    </span>
                  </div>
                </div>

                {/* Top Bidder status */}
                <div className="mt-3 pt-2.5 border-t border-[#ccdbfd] flex items-center flex-wrap justify-between gap-x-3 gap-y-1.5 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <UserIcon className="w-3.5 h-3.5 text-[#1e293b]/60 shrink-0" />
                    <span className="text-[#1e293b]/70 shrink-0">Highest Bidder:</span>
                    <span className="font-bold text-[#1e293b] truncate" title={auction.highestBidderName || undefined}>
                      {auction.highestBidderName || 'No bids yet'}
                    </span>
                  </div>
                  {isTopBidder && !isEnded && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-extrabold border border-emerald-300 shrink-0 whitespace-nowrap">
                      You are Top Bidder
                    </span>
                  )}
                </div>
              </div>

              {/* Bid Placement Form */}
              <div className="p-3 sm:p-4 rounded-2xl bg-[#d7e3fc] border border-[#ccdbfd]">
                <h4 className="text-xs font-bold uppercase tracking-wider text-[#1e293b] mb-2 flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-[#1e293b]" />
                  <span>Place Your Bid</span>
                </h4>

                {error && (
                  <div className="mb-3 p-2.5 rounded-xl bg-red-100/95 border border-red-200 text-red-800 text-xs flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                {successMessage && (
                  <div className="mb-3 p-2.5 rounded-xl bg-emerald-100/95 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>{successMessage}</span>
                  </div>
                )}

                {isEnded ? (
                  <div className="p-3 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] text-center text-xs font-semibold text-[#1e293b]/70">
                    Bidding is closed for this auction item.
                  </div>
                ) : isSeller ? (
                  <div className="p-3 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] text-center text-xs font-semibold text-[#1e293b]/70 flex items-center justify-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-[#1e293b]" />
                    <span>You are the seller of this listing and cannot bid on it.</span>
                  </div>
                ) : (
                  <form onSubmit={handlePlaceBid} className="space-y-3">
                    {/* Quick increment pills */}
                    <div className="flex items-center gap-1.5 overflow-x-auto overscroll-x-contain no-scrollbar pb-1">
                      {[5, 10, 25, 50, 100].map((inc) => (
                        <button
                          key={inc}
                          type="button"
                          onClick={() => handleIncrement(inc)}
                          className="inline-flex items-center justify-center px-3 min-h-[40px] rounded-lg bg-[#edf2fb] hover:bg-[#b6ccfe] border border-[#ccdbfd] text-xs font-bold text-[#1e293b] transition-colors shrink-0"
                        >
                          +£{inc}
                        </button>
                      ))}
                      <span className="text-[10px] text-[#1e293b]/60 ml-auto pl-2 shrink-0 whitespace-nowrap">
                        Min: £{minRequiredBid.toFixed(2)}
                      </span>
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <div className="relative w-full sm:flex-1 min-w-0">
                        <PoundSterling className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/60" />
                        <input
                          id="place-bid-amount-input"
                          type="number"
                          step="any"
                          required
                          min={minRequiredBid}
                          value={bidAmount}
                          onChange={(e) => {
                            hasUserEditedBidRef.current = true;
                            setBidAmount(e.target.value);
                            setError(null);
                          }}
                          className="w-full pl-8 pr-3 py-2 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] font-bold"
                          placeholder={suggestedBid.toString()}
                        />
                      </div>

                      <button
                        id="place-bid-submit-btn"
                        type="submit"
                        disabled={isSubmitting}
                        className="w-full sm:w-auto shrink-0 px-4 sm:px-5 py-2 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-[#1e293b] text-sm font-extrabold shadow-xs transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5 whitespace-nowrap"
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>{isSubmitting ? 'Bidding...' : 'Submit Bid'}</span>
                      </button>
                    </div>

                    {!user && (
                      <p className="text-[11px] text-[#1e293b]/70 text-center">
                        You need to be signed in to place a bid.
                      </p>
                    )}
                  </form>
                )}
              </div>

              {/* Real-Time Live Bid History Feed */}
              <div className="p-3 sm:p-4 rounded-2xl bg-[#d7e3fc] border border-[#ccdbfd] flex-1 flex flex-col min-h-[160px] max-h-[220px]">
                <div className="flex items-center justify-between flex-wrap gap-x-2 gap-y-1 mb-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-[#1e293b] flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5 text-[#1e293b]" />
                    <span>Live Bid History ({auction.bids.length})</span>
                  </span>
                  <span className="text-[11px] text-[#1e293b]/60 font-medium">
                    Auto-updating live
                  </span>
                </div>

                <div className="overflow-y-auto space-y-1.5 flex-1 pr-1">
                  {auction.bids.length === 0 ? (
                    <div className="text-center py-6 text-xs text-[#1e293b]/60 font-medium">
                      No bids yet. Be the first to start the auction!
                    </div>
                  ) : (
                    auction.bids.map((bid, index) => {
                      const isWinning = index === 0;
                      return (
                        <div
                          key={bid.id}
                          className={`flex items-center justify-between gap-2 p-2 rounded-xl text-xs transition-all ${
                            isWinning
                              ? 'bg-[#b6ccfe] border border-[#abc4ff] font-bold text-[#1e293b] shadow-2xs'
                              : 'bg-[#edf2fb] border border-[#ccdbfd]/60 text-[#1e293b]/85'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0 truncate">
                            <span className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold ${
                              isWinning ? 'bg-[#abc4ff] text-[#1e293b]' : 'bg-[#d7e3fc] text-[#1e293b]'
                            }`}>
                              #{auction.bids.length - index}
                            </span>
                            <span className="truncate font-semibold">{bid.userName}</span>
                            {isWinning && (
                              <span className="text-[10px] px-1.5 py-0.2 shrink-0 rounded-md bg-[#abc4ff] text-[#1e293b] font-extrabold uppercase">
                                Top
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                            <span className="font-extrabold text-[#1e293b]">
                              {formatCurrency(bid.amount)}
                            </span>
                            <span className="text-[10px] text-[#1e293b]/60">
                              {formatTimestamp(bid.timestamp)}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={bidHistoryEndRef} />
                </div>
              </div>

            </div>
          </div>

        </div>

      </div>
    </div>
  );
};
