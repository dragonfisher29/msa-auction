export interface User {
  id: string;
  name: string;
  username: string;
  token?: string;
  createdAt: number;
}

export interface Bid {
  id: string;
  auctionId: string;
  userId: string;
  userName: string;
  amount: number;
  timestamp: number;
}

export interface AuctionItem {
  id: string;
  title: string;
  description: string;
  phoneNumber: string;
  startingPrice: number;
  currentPrice: number;
  sellerId: string;
  sellerName: string;
  highestBidderId: string | null;
  highestBidderName: string | null;
  durationMinutes: number;
  startTime: number;
  endTime: number;
  status: 'active' | 'ended';
  category?: string;
  imageUrl?: string;
  imageUrls?: string[];
  bids: Bid[];
  winnerId?: string | null;
  winnerName?: string | null;
  winningBid?: number | null;
  createdAt: number;
}

export interface PlaceBidPayload {
  auctionId: string;
  userId: string;
  userName: string;
  amount: number;
}

export interface BidUpdatePayload {
  auctionId: string;
  currentPrice: number;
  highestBidderId: string;
  highestBidderName: string;
  bid: Bid;
  auction: AuctionItem;
}

export interface AuctionEndedPayload {
  auctionId: string;
  winnerId: string | null;
  winnerName: string | null;
  winningBid: number | null;
  auction: AuctionItem;
}
