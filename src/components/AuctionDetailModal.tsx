import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Clock,
  DollarSign,
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
} from 'lucide-react';
import { AuctionItem, User, Bid, BidUpdatePayload, AuctionEndedPayload } from '../types';
import { formatCurrency, formatTimeRemaining, formatTimestamp } from '../lib/formatters';
import { getSocket } from '../lib/socket';

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

  const bidHistoryEndRef = useRef<HTMLDivElement | null>(null);

  // Suggested minimum next bid
  const minRequiredBid = auction.bids.length === 0
    ? auction.startingPrice
    : auction.currentPrice + 5;

  // Initialize input with suggested minimum bid
  useEffect(() => {
    setBidAmount(minRequiredBid.toString());
  }, [minRequiredBid]);

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

  // Real-Time Socket.io Connection & Room Events
  useEffect(() => {
    const socket = getSocket();

    // 1. Join room for this specific auction
    socket.emit('join_auction', { auctionId: auction.id });

    // Handle full snapshot if sent
    const handleSnapshot = (snapshot: AuctionItem) => {
      if (snapshot && snapshot.id === auction.id) {
        setAuction(snapshot);
        onAuctionUpdated(snapshot);
      }
    };

    // 2. Real-time live bid update received
    const handleBidUpdated = (payload: BidUpdatePayload) => {
      if (payload.auctionId === auction.id) {
        setAuction(payload.auction);
        onAuctionUpdated(payload.auction);
        setFlashNewBid(true);
        setTimeout(() => setFlashNewBid(false), 2000);
        setError(null);
      }
    };

    // 3. Real-time auction ended event
    const handleAuctionEnded = (payload: AuctionEndedPayload) => {
      if (payload.auctionId === auction.id) {
        setAuction(payload.auction);
        onAuctionUpdated(payload.auction);
      }
    };

    // 4. Real-time bid errors
    const handleBidError = (err: { message: string }) => {
      setError(err.message || 'Bid rejected');
      setIsSubmitting(false);
    };

    socket.on('auction_snapshot', handleSnapshot);
    socket.on('bid_updated', handleBidUpdated);
    socket.on('auction_ended', handleAuctionEnded);
    socket.on('bid_error', handleBidError);

    return () => {
      // Leave auction room on unmount
      socket.emit('leave_auction', { auctionId: auction.id });
      socket.off('auction_snapshot', handleSnapshot);
      socket.off('bid_updated', handleBidUpdated);
      socket.off('auction_ended', handleAuctionEnded);
      socket.off('bid_error', handleBidError);
    };
  }, [auction.id, onAuctionUpdated]);

  const isEnded = auction.status === 'ended' || timeInfo.isEnded;
  const isSeller = user && user.id === auction.sellerId;
  const isTopBidder = user && user.id === auction.highestBidderId;

  // Handle Placing a Bid via Socket.io
  const handlePlaceBid = (e: React.FormEvent) => {
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
        setError(`Bid must be at least the starting price of ${formatCurrency(auction.startingPrice)}.`);
        return;
      }
    } else {
      if (numericAmount <= auction.currentPrice) {
        setError(`Bid must be strictly higher than current bid of ${formatCurrency(auction.currentPrice)}.`);
        return;
      }
    }

    setIsSubmitting(true);
    const socket = getSocket();

    // Emit place_bid event to the server
    socket.emit('place_bid', {
      auctionId: auction.id,
      userId: user.id,
      userName: user.name,
      amount: numericAmount,
    });

    setSuccessMessage(`Placed bid of ${formatCurrency(numericAmount)}!`);
    setTimeout(() => {
      setIsSubmitting(false);
      setSuccessMessage(null);
    }, 1500);
  };

  const handleIncrement = (inc: number) => {
    const currentBase = parseFloat(bidAmount) || minRequiredBid;
    setBidAmount((currentBase + inc).toString());
    setError(null);
  };

  const copyPhoneNumber = () => {
    navigator.clipboard.writeText(auction.phoneNumber);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[#1e293b]/50 backdrop-blur-xs overflow-y-auto">
      <div className="relative w-full max-w-4xl bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl shadow-2xl overflow-hidden text-[#1e293b] my-4 flex flex-col max-h-[92vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#ccdbfd] bg-[#d7e3fc] shrink-0">
          <div className="flex items-center gap-3">
            <span className={`px-2.5 py-1 rounded-full text-xs font-extrabold flex items-center gap-1.5 ${
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
            className="p-1.5 rounded-lg text-[#1e293b]/70 hover:text-[#1e293b] hover:bg-[#c1d3fe] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Scrollable Content */}
        <div className="overflow-y-auto p-5 sm:p-6 space-y-6">
          
          {/* Winner Announcement Banner (If Ended) */}
          {isEnded && (
            <div className="p-4 rounded-2xl bg-[#d7e3fc] border-2 border-[#abc4ff] shadow-sm flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-[#abc4ff] text-[#1e293b] flex items-center justify-center shrink-0 shadow-xs">
                <Trophy className="w-6 h-6 text-amber-700" />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-extrabold text-[#1e293b] flex items-center gap-2">
                  Auction Concluded!
                  {auction.winnerId === user?.id && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold">
                      You Won!
                    </span>
                  )}
                </h3>
                <p className="text-xs text-[#1e293b]/80 mt-0.5">
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
          <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
            
            {/* Left: Image & Description */}
            <div className="md:col-span-6 space-y-4">
              <div className="relative rounded-2xl overflow-hidden border border-[#ccdbfd] bg-[#d7e3fc] shadow-xs">
                <img
                  src={auction.imageUrl || 'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=800&q=80'}
                  alt={auction.title}
                  referrerPolicy="no-referrer"
                  className="w-full h-64 object-cover"
                />
                
                {/* Live Floating Timer Banner */}
                <div className={`absolute bottom-3 left-3 right-3 py-2 px-3 rounded-xl backdrop-blur-md flex items-center justify-between shadow-md ${
                  isEnded
                    ? 'bg-slate-800/90 text-white'
                    : timeInfo.isUrgent
                    ? 'bg-rose-900/90 text-white animate-pulse'
                    : 'bg-[#1e293b]/85 text-white'
                }`}>
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-[#b6ccfe]" />
                    <span className="text-xs uppercase font-bold tracking-wider opacity-80">
                      {isEnded ? 'Status' : 'Time Remaining'}
                    </span>
                  </div>
                  <span className="text-sm font-extrabold tracking-tight">
                    {timeInfo.formatted}
                  </span>
                </div>
              </div>

              {/* Title & Description */}
              <div className="bg-[#d7e3fc] p-4 rounded-2xl border border-[#ccdbfd]">
                <h2 className="text-lg font-extrabold text-[#1e293b] leading-snug">
                  {auction.title}
                </h2>
                <p className="text-xs text-[#1e293b]/80 mt-2 leading-relaxed whitespace-pre-line">
                  {auction.description}
                </p>

                {/* Seller & Contact Section */}
                <div className="mt-4 pt-3 border-t border-[#ccdbfd] flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-[#b6ccfe] flex items-center justify-center font-bold text-xs text-[#1e293b]">
                      {auction.sellerName.charAt(0)}
                    </div>
                    <div>
                      <span className="text-[#1e293b]/60 block text-[10px]">Seller</span>
                      <span className="font-bold text-[#1e293b]">{auction.sellerName}</span>
                    </div>
                  </div>

                  {/* Phone Contact Badge with Copy Action */}
                  <div className="flex items-center gap-1.5 bg-[#edf2fb] px-3 py-1.5 rounded-xl border border-[#ccdbfd]">
                    <Phone className="w-3.5 h-3.5 text-[#1e293b]/70" />
                    <a
                      href={`tel:${auction.phoneNumber}`}
                      className="font-bold text-[#1e293b] hover:underline"
                    >
                      {auction.phoneNumber}
                    </a>
                    <button
                      type="button"
                      onClick={copyPhoneNumber}
                      title="Copy phone number"
                      className="p-1 rounded-md text-[#1e293b]/60 hover:text-[#1e293b] hover:bg-[#d7e3fc] transition-colors ml-1"
                    >
                      {copiedPhone ? (
                        <Check className="w-3 h-3 text-emerald-600" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

            </div>

            {/* Right: Bidding Console & Live History Log */}
            <div className="md:col-span-6 space-y-4 flex flex-col justify-between">
              
              {/* Current Price Banner */}
              <div className={`p-4 rounded-2xl border transition-all duration-300 ${
                flashNewBid
                  ? 'bg-[#abc4ff] border-[#b6ccfe] scale-101 shadow-md'
                  : 'bg-[#d7e3fc] border-[#ccdbfd]'
              }`}>
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-[11px] font-bold uppercase tracking-wider text-[#1e293b]/70 flex items-center gap-1">
                      {isEnded ? 'Final Winning Bid' : 'Current Highest Bid'}
                      {flashNewBid && (
                        <span className="px-1.5 py-0.5 rounded-full bg-emerald-500 text-white text-[9px] font-extrabold uppercase animate-bounce">
                          NEW BID!
                        </span>
                      )}
                    </span>
                    <div className="text-3xl font-black text-[#1e293b] mt-1 tracking-tight">
                      {formatCurrency(auction.currentPrice)}
                    </div>
                  </div>

                  <div className="text-right">
                    <span className="text-[11px] text-[#1e293b]/60 block font-medium">Starting</span>
                    <span className="text-sm font-bold text-[#1e293b]">
                      {formatCurrency(auction.startingPrice)}
                    </span>
                  </div>
                </div>

                {/* Top Bidder status */}
                <div className="mt-3 pt-2.5 border-t border-[#ccdbfd] flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <UserIcon className="w-3.5 h-3.5 text-[#1e293b]/60" />
                    <span className="text-[#1e293b]/70">Highest Bidder:</span>
                    <span className="font-bold text-[#1e293b]">
                      {auction.highestBidderName || 'No bids yet'}
                    </span>
                  </div>
                  {isTopBidder && !isEnded && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-extrabold border border-emerald-300">
                      You are Top Bidder
                    </span>
                  )}
                </div>
              </div>

              {/* Bid Placement Form */}
              <div className="p-4 rounded-2xl bg-[#d7e3fc] border border-[#ccdbfd]">
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
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                      {[5, 25, 50, 100].map((inc) => (
                        <button
                          key={inc}
                          type="button"
                          onClick={() => handleIncrement(inc)}
                          className="px-2.5 py-1 rounded-lg bg-[#edf2fb] hover:bg-[#b6ccfe] border border-[#ccdbfd] text-xs font-bold text-[#1e293b] transition-colors shrink-0"
                        >
                          +${inc}
                        </button>
                      ))}
                      <span className="text-[10px] text-[#1e293b]/60 ml-auto whitespace-nowrap">
                        Min: {formatCurrency(minRequiredBid)}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <DollarSign className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/60" />
                        <input
                          id="place-bid-amount-input"
                          type="number"
                          step="any"
                          required
                          min={minRequiredBid}
                          value={bidAmount}
                          onChange={(e) => {
                            setBidAmount(e.target.value);
                            setError(null);
                          }}
                          className="w-full pl-8 pr-3 py-2 text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] font-bold"
                          placeholder={minRequiredBid.toString()}
                        />
                      </div>

                      <button
                        id="place-bid-submit-btn"
                        type="submit"
                        disabled={isSubmitting}
                        className="px-5 py-2 rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-[#1e293b] text-sm font-extrabold shadow-xs transition-all cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>{isSubmitting ? 'Bidding...' : 'Submit Bid'}</span>
                      </button>
                    </div>

                    {!user && (
                      <p className="text-[11px] text-[#1e293b]/70 text-center">
                        You will be asked to sign in or pick a test bidder to place your bid.
                      </p>
                    )}
                  </form>
                )}
              </div>

              {/* Real-Time Live Bid History Feed */}
              <div className="p-4 rounded-2xl bg-[#d7e3fc] border border-[#ccdbfd] flex-1 flex flex-col min-h-[160px] max-h-[220px]">
                <div className="flex items-center justify-between mb-2">
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
                          className={`flex items-center justify-between p-2 rounded-xl text-xs transition-all ${
                            isWinning
                              ? 'bg-[#b6ccfe] border border-[#abc4ff] font-bold text-[#1e293b] shadow-2xs'
                              : 'bg-[#edf2fb] border border-[#ccdbfd]/60 text-[#1e293b]/85'
                          }`}
                        >
                          <div className="flex items-center gap-2 truncate">
                            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                              isWinning ? 'bg-[#abc4ff] text-[#1e293b]' : 'bg-[#d7e3fc] text-[#1e293b]'
                            }`}>
                              #{auction.bids.length - index}
                            </span>
                            <span className="truncate font-semibold">{bid.userName}</span>
                            {isWinning && (
                              <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-[#abc4ff] text-[#1e293b] font-extrabold uppercase">
                                Top
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-3 shrink-0">
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
