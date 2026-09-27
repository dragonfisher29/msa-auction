import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  X,
  Phone,
  AlertCircle,
  Copy,
  Check,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  Link as LinkIcon,
  Flag,
  LogIn,
  CalendarDays,
  RefreshCw,
  ShieldCheck,
  Tag,
} from 'lucide-react';
import { AuctionItem, User } from '../types';
import { buildWhatsAppUrl, formatExpiresIn, formatListedAgo, formatPrice } from '../lib/formatters';
import { apiFetchAuthed } from '../lib/api';
import { AUTH_ERROR_CODES, readErrorCode } from '../lib/apiErrors';
import { fetchAuctionImages, imagesVersionOf } from '../lib/images';
import { getListingStatus, LISTING_STATUS_EXPLANATION, LISTING_STATUS_LABEL } from '../lib/listing';
import { PLACEHOLDER_IMAGE_URL } from '../lib/placeholder';
import { SITE_NAME } from '../lib/site';
import { ListingActions } from './ListingActions';
import { CreateListingModal } from './CreateListingModal';
import { CancelListingModal } from './CancelListingModal';
import { MarkSoldModal } from './MarkSoldModal';
import { ReportListingModal } from './ReportListingModal';
import { ListingUnavailableNotice } from './ListingUnavailableNotice';

// Minimum horizontal travel (px) before a touch counts as a swipe rather than a tap or a
// vertical scroll that happened to drift sideways.
const SWIPE_THRESHOLD_PX = 50;

/**
 * Real image data already present on an `AuctionItem`, if any - the multi-image array first,
 * then the legacy single `imageUrl`, otherwise `null` (meaning "nothing inline, go fetch"). Blank
 * strings are dropped so a stored "" can never render an empty frame. Pulled out to a plain
 * function (rather than a `useMemo` reading component state) so it can be called both as the
 * `resolvedImages` state initializer and inside the resolve effect.
 */
function extractInlineImages(source: AuctionItem): string[] | null {
  const fromArray = Array.isArray(source.imageUrls)
    ? source.imageUrls.filter((url) => typeof url === 'string' && url.trim() !== '')
    : [];

  if (fromArray.length > 0) {
    return fromArray;
  }

  if (source.imageUrl && source.imageUrl.trim() !== '') {
    return [source.imageUrl];
  }

  return null;
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
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isMarkSoldOpen, setIsMarkSoldOpen] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);
  // State of the one authed detail fetch below: the only way a signed-in buyer gets the
  // seller's phone number, and the moment we learn a listing opened from the grid has since
  // been taken down. Every outcome of that fetch lands in a terminal state, so the contact area
  // can never sit on the loading spinner forever:
  //   failed      - network/server error; offers Try Again
  //   expired     - 401 with an auth code: the stored session is dead (e.g. signed in elsewhere)
  //   unavailable - 200, but the server withheld the number (it decides; see the detail route)
  const [contactState, setContactState] = useState<'idle' | 'loading' | 'failed' | 'expired' | 'unavailable'>('idle');
  const [isGone, setIsGone] = useState(false);

  const touchStartXRef = useRef<number | null>(null);

  // Held in a ref so the detail fetch below does not depend on the parent's callback identity.
  const onAuctionUpdatedRef = useRef(onAuctionUpdated);
  useEffect(() => {
    onAuctionUpdatedRef.current = onAuctionUpdated;
  }, [onAuctionUpdated]);

  // Latest `auction`, read by the async fetch below after it resolves.
  const auctionRef = useRef(auction);
  useEffect(() => {
    auctionRef.current = auction;
  }, [auction]);

  const status = getListingStatus(auction);
  const isAvailable = status === 'active';
  const isSeller = Boolean(user && user.id === auction.sellerId);

  // Absent when the viewer isn't signed in - GET /api/auctions/:id only puts phoneNumber on the
  // wire for an authenticated request (see mapAuctionDetailRow in workers/index.ts) - and on
  // every row of the public list, which is where most modals are opened from.
  const hasPhoneNumber = typeof auction.phoneNumber === 'string' && auction.phoneNumber.trim() !== '';

  // Bumped by the "Try again" button to re-run the detail fetch after a failure.
  const [contactAttempt, setContactAttempt] = useState(0);

  // ONE authed `GET /api/auctions/:id` per (listing, session), and only when it can tell us
  // something: a signed-in buyer looking at a row that has no phone number yet. There is no
  // interval -- a fixed-price listing does not change under the viewer's feet the way a live
  // auction did, and every poll here was a request against the free tier's daily budget for
  // nothing. Signed-out visitors never trigger it (the server would withhold the number anyway),
  // and neither does the seller, who does not need their own number.
  const token = user?.token;
  useEffect(() => {
    if (!token || isSeller || hasPhoneNumber || !isAvailable) {
      return;
    }

    let cancelled = false;
    setContactState('loading');

    (async () => {
      try {
        const res = await apiFetchAuthed(`/api/auctions/${auction.id}`, token);
        if (cancelled) return;

        if (res.status === 404) {
          setIsGone(true);
          return;
        }
        if (res.status === 401) {
          const code = readErrorCode(await res.json().catch(() => null));
          if (cancelled) return;
          setContactState(code && AUTH_ERROR_CODES.has(code) ? 'expired' : 'failed');
          return;
        }
        if (!res.ok) {
          setContactState('failed');
          return;
        }

        const data = await res.json().catch(() => null);
        if (cancelled) return;
        const fresh = data?.auction as AuctionItem | undefined;
        if (!fresh || fresh.id !== auction.id) {
          setContactState('failed');
          return;
        }

        // Merged over what is already on screen rather than replacing it: the detail row
        // carries no image data (only imageCount), so a straight replace would throw away any
        // inline images the modal was opened with.
        const merged = { ...auctionRef.current, ...fresh };
        setAuction(merged);
        onAuctionUpdatedRef.current(merged);
        // A signed-in 200 with no number is the server's decision, not a pending load - show that
        // instead of spinning. (A listing that stopped being live leaves the contact area entirely.)
        const freshHasPhone = typeof fresh.phoneNumber === 'string' && fresh.phoneNumber.trim() !== '';
        setContactState(freshHasPhone ? 'idle' : 'unavailable');
      } catch (err) {
        console.warn('Could not load the seller contact details:', err);
        if (!cancelled) {
          setContactState('failed');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auction.id, token, isSeller, contactAttempt]);

  // Resolved, real image data - held in its OWN state rather than derived from `auction` on every
  // render. The detail fetch above merges in the slim row `GET /api/auctions/:id` sends (no
  // imageUrls at all, only imageCount), and keeping the resolved array in state that only the
  // effect below writes means an update that carries no image data of its own simply leaves
  // whatever was already resolved alone.
  const [resolvedImages, setResolvedImages] = useState<string[] | null>(() => extractInlineImages(initialAuction));

  // Re-resolves when the listing id, its imageCount or its imagesVersion changes (the version is
  // the server's signal that the photos themselves changed). The gallery needs every photo, so
  // this fetches the full set; fetchAuctionImages caches on (id, version), so this stays free
  // once resolved.
  const imagesVersion = imagesVersionOf(auction);
  useEffect(() => {
    const inline = extractInlineImages(auction);
    if (inline) {
      setResolvedImages(inline);
      return;
    }
    let cancelled = false;
    fetchAuctionImages(auction.id, { version: imagesVersion }).then((urls) => {
      if (!cancelled) {
        setResolvedImages(urls);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auction.id, auction.imageCount, imagesVersion]);

  // Gallery source of truth: the resolved images, or the local placeholder when there are none.
  const galleryImages = useMemo(() => {
    return resolvedImages && resolvedImages.length > 0 ? resolvedImages : [PLACEHOLDER_IMAGE_URL];
  }, [resolvedImages]);

  // The modal instance is reused across listings, so a new listing starts at its first image.
  useEffect(() => {
    setActiveImageIndex(0);
  }, [auction.id]);

  // An edit can return fewer images than the render currently on screen (e.g. the seller
  // deleted one), which would otherwise leave the index pointing past the end.
  useEffect(() => {
    setActiveImageIndex((prev) => (prev > galleryImages.length - 1 ? 0 : prev));
  }, [galleryImages.length]);

  const hasMultipleImages = galleryImages.length > 1;

  const goToImage = (delta: number) => {
    setActiveImageIndex((prev) => (prev + delta + galleryImages.length) % galleryImages.length);
  };

  // Scoped to the gallery container rather than window, so arrow keys elsewhere in the modal
  // (e.g. inside a form opened from it) keep their normal meaning.
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

  const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}/auction/${auction.id}` : `/auction/${auction.id}`;

  const copyShareLink = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const whatsAppUrl = buildWhatsAppUrl(
    auction.phoneNumber ?? '',
    `Hi, I'm interested in "${auction.title}" on ${SITE_NAME}.`,
  );

  const copyPhoneNumber = () => {
    if (!auction.phoneNumber) return;
    navigator.clipboard.writeText(auction.phoneNumber);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  };

  // Applies a write made from this modal (edit / sold / cancel) here and in the parent.
  const applyUpdate = (updated: AuctionItem) => {
    setAuction(updated);
    onAuctionUpdated(updated);
  };

  if (isGone) {
    return <ListingUnavailableNotice reason="missing" onClose={onClose} />;
  }

  const renderContact = () => {
    if (!user) {
      return (
        <button
          id="contact-sign-in-btn"
          type="button"
          onClick={onPromptAuth}
          className="w-full inline-flex items-center justify-center gap-2 px-4 min-h-[48px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-sm font-extrabold text-[#1e293b] shadow-xs transition-colors cursor-pointer"
        >
          <LogIn className="w-4 h-4" />
          <span>Sign in to contact the seller</span>
        </button>
      );
    }

    if (!hasPhoneNumber) {
      if (contactState === 'failed') {
        return (
          <div role="alert" className="p-3 rounded-xl bg-red-100/95 border border-red-200 text-red-800 text-xs flex flex-wrap items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="min-w-0 flex-1">We couldn't load the seller's contact details.</span>
            <button
              id="contact-retry-btn"
              type="button"
              onClick={() => setContactAttempt((n) => n + 1)}
              className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-[#1e293b] font-extrabold transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Try Again</span>
            </button>
          </div>
        );
      }
      if (contactState === 'expired') {
        // Signing in again replaces the token, which re-runs the detail fetch above.
        return (
          <div role="alert" className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex flex-wrap items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="min-w-0 flex-1">Your session has expired. Sign in again to see the seller's contact details.</span>
            <button
              id="contact-reauth-btn"
              type="button"
              onClick={onPromptAuth}
              className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-[#1e293b] font-extrabold transition-colors cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Sign In Again</span>
            </button>
          </div>
        );
      }
      if (contactState === 'unavailable') {
        return (
          <div role="status" className="p-3 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] text-xs font-semibold text-[#1e293b]/75 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>The seller's contact details aren't available for this listing.</span>
          </div>
        );
      }
      return (
        <div role="status" className="p-3 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] text-xs font-semibold text-[#1e293b]/75 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
          <span>Loading the seller's contact details…</span>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {/* Rendered only when the seller's number parses to a usable wa.me target, so buyers
            never land on WhatsApp's "invalid number" page. green-700 rather than WhatsApp's own
            #25D366: white text on that brand green is ~2:1, well under WCAG AA. */}
        {whatsAppUrl && (
          <a
            id="contact-whatsapp-btn"
            href={whatsAppUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full flex items-center justify-center gap-2 min-h-[48px] px-4 rounded-xl bg-green-700 hover:bg-green-800 text-white text-sm font-extrabold shadow-xs transition-colors"
          >
            <MessageCircle className="w-4 h-4" />
            <span>Message the Seller on WhatsApp</span>
          </a>
        )}

        <div className="flex items-center gap-1.5 min-w-0 bg-[#edf2fb] pl-3 pr-1.5 py-1 rounded-xl border border-[#ccdbfd] text-xs">
          <Phone className="w-3.5 h-3.5 text-[#1e293b]/70 shrink-0" />
          <a href={`tel:${auction.phoneNumber}`} className="font-bold text-[#1e293b] hover:underline truncate">
            {auction.phoneNumber}
          </a>
          <button
            type="button"
            onClick={copyPhoneNumber}
            title="Copy phone number"
            aria-label="Copy phone number"
            className="shrink-0 inline-flex items-center justify-center p-2 min-h-[38px] min-w-[38px] rounded-md text-[#1e293b]/60 hover:text-[#1e293b] hover:bg-[#d7e3fc] transition-colors ml-auto"
          >
            {copiedPhone ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-[#1e293b]/50 backdrop-blur-xs overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="listing-detail-title"
        className="relative w-full max-w-4xl bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl shadow-2xl overflow-hidden text-[#1e293b] my-2 sm:my-4 flex flex-col modal-max-h"
      >

        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-3 sm:px-6 py-2 sm:py-4 border-b border-[#ccdbfd] bg-[#d7e3fc] shrink-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <span
              id="listing-status-pill"
              className={`px-2.5 py-1 rounded-full text-[10px] sm:text-xs font-extrabold flex items-center gap-1.5 whitespace-nowrap ${
                isAvailable
                  ? 'bg-[#abc4ff] text-[#1e293b] border border-[#c1d3fe]'
                  : status === 'sold'
                  ? 'bg-emerald-700 text-white'
                  : 'bg-slate-700 text-white'
              }`}
            >
              <Tag className="w-3.5 h-3.5" />
              {isAvailable ? 'For Sale' : LISTING_STATUS_LABEL[status]}
            </span>

            {auction.category && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-lg bg-[#b6ccfe] text-[#1e293b] hidden sm:inline">
                {auction.category}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              id="copy-auction-link-btn"
              type="button"
              onClick={copyShareLink}
              title="Copy link to this listing"
              aria-label="Copy link to this listing"
              className="inline-flex items-center justify-center gap-1.5 px-2.5 min-h-[44px] rounded-lg text-[#1e293b]/70 hover:text-[#1e293b] hover:bg-[#c1d3fe] transition-colors"
            >
              {copiedLink ? <Check className="w-4 h-4 text-emerald-600" /> : <LinkIcon className="w-4 h-4" />}
              <span className="text-xs font-bold hidden sm:inline">{copiedLink ? 'Copied!' : 'Copy Link'}</span>
            </button>

            <button
              id="close-auction-detail-btn"
              type="button"
              onClick={onClose}
              aria-label="Close listing details"
              className="shrink-0 inline-flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg text-[#1e293b]/70 hover:text-[#1e293b] hover:bg-[#c1d3fe] transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Scrollable Content */}
        <div className="overflow-y-auto overscroll-contain p-4 sm:p-6 space-y-4 sm:space-y-6">

          {/* No longer for sale: say so up front, in words, so nobody tries to buy it. */}
          {!isAvailable && (
            <div
              id="listing-status-banner"
              role="status"
              className="p-3 sm:p-4 rounded-2xl bg-[#d7e3fc] border-2 border-[#abc4ff] shadow-sm flex items-center gap-3"
            >
              <AlertCircle className="w-5 h-5 shrink-0 text-[#1e293b]" />
              <div className="min-w-0">
                <h3 className="text-sm sm:text-base font-extrabold text-[#1e293b]">
                  {status === 'sold' ? 'This item has been sold' : `This listing is ${LISTING_STATUS_LABEL[status].toLowerCase()}`}
                </h3>
                <p className="text-xs text-[#1e293b]/80 mt-0.5 break-words">{LISTING_STATUS_EXPLANATION[status]}</p>
              </div>
            </div>
          )}

          {/* Top Section: 2 Columns (Image + Details) */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 sm:gap-6">

            {/* Left: Image & Description */}
            <div className="md:col-span-7 space-y-4 min-w-0">
              {/* Image Gallery: arrows, counter, thumbnails, arrow keys and touch swipe */}
              <div
                tabIndex={0}
                onKeyDown={handleGalleryKeyDown}
                aria-label={hasMultipleImages ? 'Photo gallery. Use the left and right arrow keys to browse.' : undefined}
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
                    className="w-full h-52 sm:h-72 object-cover"
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
                <h2 id="listing-detail-title" className="text-base sm:text-lg font-extrabold text-[#1e293b] leading-snug break-words">
                  {auction.title}
                </h2>
                <p className="text-xs text-[#1e293b]/80 mt-2 leading-relaxed whitespace-pre-line break-words">
                  {auction.description}
                </p>
              </div>
            </div>

            {/* Right: Price, seller, contact */}
            <div className="md:col-span-5 space-y-4 min-w-0">

              {/* Price */}
              <div className="p-3 sm:p-4 rounded-2xl bg-[#d7e3fc] border border-[#ccdbfd]">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#1e293b]/70">
                  {status === 'sold' ? 'Sold For' : 'Asking Price'}
                </span>
                <div
                  id="listing-detail-price"
                  className={`text-2xl sm:text-3xl font-black mt-1 tracking-tight break-words ${
                    isAvailable || status === 'sold' ? 'text-[#1e293b]' : 'text-[#1e293b]/60'
                  }`}
                >
                  {formatPrice(auction.price)}
                </div>

                <div className="mt-3 pt-2.5 border-t border-[#ccdbfd] flex items-center flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#1e293b]/70">
                  <span className="flex items-center gap-1">
                    <CalendarDays className="w-3.5 h-3.5" />
                    {formatListedAgo(auction.createdAt)}
                  </span>
                  {isAvailable && typeof auction.expiresAt === 'number' && (
                    <span id="listing-detail-expiry">{formatExpiresIn(auction.expiresAt)}</span>
                  )}
                </div>
              </div>

              {/* Seller & Contact */}
              <div className="p-3 sm:p-4 rounded-2xl bg-[#d7e3fc] border border-[#ccdbfd] space-y-3">
                <div className="flex items-center gap-2 min-w-0 text-xs">
                  <div className="w-8 h-8 rounded-lg bg-[#b6ccfe] flex items-center justify-center font-bold text-xs text-[#1e293b] shrink-0">
                    {auction.sellerName.charAt(0)}
                  </div>
                  <div className="min-w-0">
                    <span className="text-[#1e293b]/60 block text-[10px]">Seller</span>
                    <span className="font-bold text-[#1e293b] block truncate" title={auction.sellerName}>
                      {auction.sellerName}
                    </span>
                  </div>
                </div>

                {isSeller ? (
                  <div className="p-3 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] text-xs font-semibold text-[#1e293b]/75 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 shrink-0 text-[#1e293b]" />
                    <span>
                      {isAvailable
                        ? 'This is your listing. Buyers will message you on WhatsApp.'
                        : 'This is your listing.'}
                    </span>
                  </div>
                ) : isAvailable ? (
                  renderContact()
                ) : (
                  <p
                    id="listing-contact-closed"
                    className="p-3 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] text-center text-xs font-semibold text-[#1e293b]/70"
                  >
                    This listing is no longer for sale, so the seller's contact details are not shown.
                  </p>
                )}
              </div>

              {/* Seller-only Edit / Mark as sold / Cancel. Renders nothing once the listing is no
                  longer available -- there's nothing left to change on it. */}
              {isSeller && (
                <ListingActions
                  auction={auction}
                  onEdit={() => setIsEditOpen(true)}
                  onMarkSold={() => setIsMarkSoldOpen(true)}
                  onCancel={() => setIsCancelOpen(true)}
                />
              )}

              {/* Report: any signed-in user EXCEPT the seller, who has Cancel above and does
                  not need to report themselves. Deliberately still available on a sold or
                  expired listing -- a scam is often only recognised after the fact, and the
                  committee still wants to know about the account behind it. Left out entirely
                  for signed-out visitors rather than bounced to sign-in: the server needs a
                  reporter id, and an anonymous report queue is a spam queue. */}
              {user && !isSeller && (
                <div className="flex justify-end">
                  <button
                    id="report-listing-btn"
                    type="button"
                    onClick={() => setIsReportOpen(true)}
                    aria-label={`Report the listing ${auction.title} to the committee`}
                    className="inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-xs font-bold text-[#1e293b] transition-colors cursor-pointer"
                  >
                    <Flag className="w-3.5 h-3.5 text-red-600" />
                    <span>Report Listing</span>
                  </button>
                </div>
              )}
            </div>
          </div>

        </div>

      </div>

      {isEditOpen && (
        <CreateListingModal
          isOpen={isEditOpen}
          user={user}
          mode="edit"
          initialAuction={auction}
          onClose={() => setIsEditOpen(false)}
          onCreated={() => {}}
          onUpdated={(updated) => {
            applyUpdate(updated);
            setIsEditOpen(false);
          }}
          onPromptAuth={onPromptAuth}
        />
      )}

      {isReportOpen && user && (
        <ReportListingModal auction={auction} user={user} onClose={() => setIsReportOpen(false)} />
      )}

      {isMarkSoldOpen && user && (
        <MarkSoldModal
          auction={auction}
          user={user}
          onClose={() => setIsMarkSoldOpen(false)}
          onSold={(updated) => {
            applyUpdate(updated);
            setIsMarkSoldOpen(false);
          }}
        />
      )}

      {isCancelOpen && user && (
        <CancelListingModal
          auction={auction}
          user={user}
          onClose={() => setIsCancelOpen(false)}
          onCancelled={(updated) => {
            applyUpdate(updated);
            setIsCancelOpen(false);
          }}
        />
      )}
    </div>
  );
};
