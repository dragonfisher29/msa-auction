import React, { useState, useEffect } from 'react';
import { Clock, TrendingUp, User as UserIcon, Phone, ArrowUpRight, Trophy, Star, ShieldAlert, CheckCircle2, Images } from 'lucide-react';
import { AuctionItem, User } from '../types';
import { formatCurrency, formatTimeRemaining } from '../lib/formatters';

interface AuctionCardProps {
  auction: AuctionItem;
  user?: User | null;
  isWatchlisted?: boolean;
  onToggleWatchlist?: (auctionId: string) => void;
  onSelect: (auction: AuctionItem) => void;
}

export const AuctionCard: React.FC<AuctionCardProps> = ({
  auction,
  user,
  isWatchlisted = false,
  onToggleWatchlist,
  onSelect,
}) => {
  const [timeInfo, setTimeInfo] = useState(() => formatTimeRemaining(auction.endTime));

  // Dynamic live countdown updates every second
  useEffect(() => {
    const update = () => {
      setTimeInfo(formatTimeRemaining(auction.endTime));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [auction.endTime]);

  const isEnded = auction.status === 'ended' || timeInfo.isEnded;
  const isHighestBidder = Boolean(user && auction.highestBidderId === user.id);
  const hasUserBid = Boolean(user && auction.bids.some((b) => b.userId === user.id));
  const isOutbid = hasUserBid && !isHighestBidder && !isEnded;

  const imageCount = Array.isArray(auction.imageUrls)
    ? auction.imageUrls.filter((url) => typeof url === 'string' && url.trim() !== '').length
    : 0;

  return (
    <div
      id={`auction-card-${auction.id}`}
      className="group flex flex-col bg-[#e2eafc] hover:bg-[#d7e3fc] border border-[#ccdbfd] hover:border-[#b6ccfe] rounded-2xl overflow-hidden shadow-xs hover:shadow-md transition-all duration-200 text-[#1e293b] relative"
    >
      {/* Card Image Banner */}
      <div className="relative h-44 sm:h-48 w-full overflow-hidden bg-[#d7e3fc]">
        <img
          src={auction.imageUrl || 'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=800&q=80'}
          alt={auction.title}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover group-hover:scale-103 transition-transform duration-300"
        />

        {/* Top Badges (Status, Category, User Bid Status) */}
        <div className="absolute top-2.5 left-2.5 right-2.5 sm:top-3 sm:left-3 sm:right-3 flex items-start justify-between gap-1.5 pointer-events-none">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            {isEnded ? (
              <span className="px-2.5 py-1 rounded-full text-xs font-extrabold bg-slate-800 text-slate-100 shadow-xs flex items-center gap-1">
                <Trophy className="w-3.5 h-3.5 text-amber-300" />
                Ended
              </span>
            ) : timeInfo.isUrgent ? (
              <span className="px-2.5 py-1 rounded-full text-xs font-extrabold bg-rose-500 text-white shadow-xs animate-pulse flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                Ending Soon
              </span>
            ) : (
              <span className="px-2.5 py-1 rounded-full text-xs font-extrabold bg-[#abc4ff] text-[#1e293b] border border-[#c1d3fe] shadow-xs flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
                Live
              </span>
            )}

            {isHighestBidder && (
              <span className="px-2.5 py-1 rounded-full text-[11px] font-extrabold bg-emerald-600 text-white shadow-xs flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                Winning
              </span>
            )}

            {isOutbid && (
              <span className="px-2.5 py-1 rounded-full text-[11px] font-extrabold bg-amber-600 text-white shadow-xs flex items-center gap-1 animate-bounce">
                <ShieldAlert className="w-3 h-3" />
                Outbid!
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

        {/* Multi-image hint: bottom-left, clear of the top badges and the countdown pill */}
        {imageCount > 1 && (
          <div
            id={`auction-card-image-count-${auction.id}`}
            title={`${imageCount} photos`}
            className="absolute bottom-3 left-3 px-2 py-1 rounded-xl bg-[#1e293b]/70 backdrop-blur-xs text-white text-[11px] font-bold flex items-center gap-1 shadow-sm"
          >
            <Images className="w-3.5 h-3.5 opacity-90" />
            <span>{imageCount}</span>
          </div>
        )}

        {/* Floating Countdown Pill on Image */}
        <div className="absolute bottom-3 right-3 px-2.5 py-1 rounded-xl bg-[#1e293b]/85 backdrop-blur-xs text-white text-xs font-bold tracking-tight flex items-center gap-1.5 shadow-sm">
          <Clock className="w-3.5 h-3.5 opacity-80" />
          <span>{timeInfo.formatted}</span>
        </div>
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

        {/* Pricing & Highest Bid Info */}
        <div className="mt-4 pt-3 border-t border-[#ccdbfd]/80 space-y-2.5">
          <div className="flex items-end justify-between gap-2 flex-wrap sm:flex-nowrap">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[#1e293b]/65">
                {isEnded ? 'Winning / Final Bid' : 'Current Highest Bid'}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-lg sm:text-xl font-extrabold text-[#1e293b] tracking-tight">
                  {formatCurrency(auction.currentPrice)}
                </span>
                {auction.bids.length > 0 && (
                  <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-md bg-[#b6ccfe] text-[#1e293b] border border-[#c1d3fe]">
                    {auction.bids.length} {auction.bids.length === 1 ? 'bid' : 'bids'}
                  </span>
                )}
              </div>
            </div>

            <div className="text-right shrink-0">
              <span className="text-[11px] text-[#1e293b]/65 block">Starting</span>
              <span className="text-xs font-semibold text-[#1e293b]/85">
                {formatCurrency(auction.startingPrice)}
              </span>
            </div>
          </div>

          {/* Top Bidder or Winner Pill */}
          <div className="flex items-center justify-between gap-2 text-xs py-1.5 px-2.5 rounded-xl bg-[#d7e3fc] border border-[#ccdbfd]">
            <div className="flex items-center gap-1.5 min-w-0 truncate">
              {isEnded ? (
                <Trophy className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              ) : (
                <UserIcon className="w-3.5 h-3.5 text-[#1e293b]/70 shrink-0" />
              )}
              <span className="text-[11px] text-[#1e293b]/70 truncate">
                {isEnded ? 'Winner:' : 'Top Bidder:'}
              </span>
              <span className="text-xs font-bold text-[#1e293b] truncate">
                {isEnded
                  ? auction.winnerName || auction.highestBidderName || 'No Bids'
                  : auction.highestBidderName || 'No bids yet'}
              </span>
            </div>

            <span className="text-[11px] text-[#1e293b]/60 shrink-0 max-w-[45%] truncate" title={auction.sellerName}>
              Seller: {auction.sellerName.split(' ')[0]}
            </span>
          </div>

          {/* Action Button */}
          <button
            id={`view-auction-btn-${auction.id}`}
            onClick={() => onSelect(auction)}
            className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-xs font-extrabold text-[#1e293b] shadow-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer mt-1 active:scale-98"
          >
            <span>{isEnded ? 'View Result & Logs' : 'View & Place Bid'}</span>
            <ArrowUpRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
