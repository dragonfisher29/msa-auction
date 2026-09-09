import React, { useState, useEffect } from 'react';
import { Clock, TrendingUp, User as UserIcon, Phone, ArrowUpRight, Trophy } from 'lucide-react';
import { AuctionItem } from '../types';
import { formatCurrency, formatTimeRemaining } from '../lib/formatters';

interface AuctionCardProps {
  auction: AuctionItem;
  onSelect: (auction: AuctionItem) => void;
}

export const AuctionCard: React.FC<AuctionCardProps> = ({ auction, onSelect }) => {
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

  return (
    <div
      id={`auction-card-${auction.id}`}
      className="group flex flex-col bg-[#e2eafc] hover:bg-[#d7e3fc] border border-[#ccdbfd] hover:border-[#b6ccfe] rounded-2xl overflow-hidden shadow-xs hover:shadow-md transition-all duration-200 text-[#1e293b]"
    >
      {/* Card Image Banner */}
      <div className="relative h-48 w-full overflow-hidden bg-[#d7e3fc]">
        <img
          src={auction.imageUrl || 'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=800&q=80'}
          alt={auction.title}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover group-hover:scale-103 transition-transform duration-300"
        />

        {/* Top Status & Category Badges */}
        <div className="absolute top-3 left-3 flex items-center gap-1.5">
          {isEnded ? (
            <span className="px-2.5 py-1 rounded-full text-xs font-extrabold bg-slate-700 text-slate-100 shadow-xs flex items-center gap-1">
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
              Live Auction
            </span>
          )}
          {auction.category && (
            <span className="px-2 py-1 rounded-full text-[11px] font-semibold bg-[#e2eafc]/90 text-[#1e293b] backdrop-blur-xs border border-[#ccdbfd]">
              {auction.category}
            </span>
          )}
        </div>

        {/* Floating Countdown Pill on Image */}
        <div className="absolute bottom-3 right-3 px-2.5 py-1 rounded-xl bg-[#1e293b]/85 backdrop-blur-xs text-white text-xs font-bold tracking-tight flex items-center gap-1.5 shadow-sm">
          <Clock className="w-3.5 h-3.5 opacity-80" />
          <span>{timeInfo.formatted}</span>
        </div>
      </div>

      {/* Card Content */}
      <div className="p-4 flex-1 flex flex-col justify-between">
        <div>
          <h3 className="font-bold text-base text-[#1e293b] line-clamp-1 group-hover:text-black transition-colors" title={auction.title}>
            {auction.title}
          </h3>
          <p className="text-xs text-[#1e293b]/75 line-clamp-2 mt-1 min-h-[32px] leading-relaxed">
            {auction.description}
          </p>
        </div>

        {/* Pricing & Highest Bid Info */}
        <div className="mt-4 pt-3 border-t border-[#ccdbfd]/80 space-y-2.5">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[#1e293b]/65">
                {isEnded ? 'Winning / Final Bid' : 'Current Highest Bid'}
              </p>
              <div className="flex items-center gap-1.5">
                <span className="text-xl font-extrabold text-[#1e293b]">
                  {formatCurrency(auction.currentPrice)}
                </span>
                {auction.bids.length > 0 && (
                  <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-md bg-[#b6ccfe] text-[#1e293b] border border-[#c1d3fe]">
                    {auction.bids.length} {auction.bids.length === 1 ? 'bid' : 'bids'}
                  </span>
                )}
              </div>
            </div>

            <div className="text-right">
              <span className="text-[11px] text-[#1e293b]/65 block">Starting</span>
              <span className="text-xs font-semibold text-[#1e293b]/85">
                {formatCurrency(auction.startingPrice)}
              </span>
            </div>
          </div>

          {/* Top Bidder or Winner Pill */}
          <div className="flex items-center justify-between text-xs py-1.5 px-2.5 rounded-xl bg-[#d7e3fc] border border-[#ccdbfd]">
            <div className="flex items-center gap-1.5 truncate">
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

            <span className="text-[11px] text-[#1e293b]/60 shrink-0 pl-2">
              Seller: {auction.sellerName.split(' ')[0]}
            </span>
          </div>

          {/* Action Button */}
          <button
            id={`view-auction-btn-${auction.id}`}
            onClick={() => onSelect(auction)}
            className="w-full py-2.5 px-4 rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-xs font-extrabold text-[#1e293b] shadow-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer mt-1"
          >
            <span>{isEnded ? 'View Result & Logs' : 'View & Place Bid'}</span>
            <ArrowUpRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
