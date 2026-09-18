import type { AuctionItem } from '../../../src/types';

const NOW = Date.now();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Splits a label into short lines so it stays readable when centred on an
 * 800x600 placeholder image, without needing a real layout engine.
 */
function wrapLabel(label: string, maxCharsPerLine = 22): string[] {
  const words = label.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  return lines;
}

/**
 * Escapes characters that are unsafe inside SVG text content (`&`, `<`, `>`),
 * so the generated markup stays valid XML.
 */
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Builds a self-contained inline SVG placeholder (as a `data:` URI) so the E2E
 * fixtures never depend on the network. Renders `label` as centred text over
 * a solid `colour` background.
 */
function placeholderImage(label: string, colour: string): string {
  const lines = wrapLabel(label);
  const lineHeight = 44;
  const startY = 300 - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines
    .map((line, i) => `<tspan x="400" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">` +
    `<rect width="800" height="600" fill="${colour}" />` +
    `<text font-family="system-ui, sans-serif" font-size="36" font-weight="600" fill="#1e293b" text-anchor="middle" dominant-baseline="middle">${tspans}</text>` +
    `</svg>`;

  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/**
 * A realistic set of 6 demo auctions for a student-marketplace, covering a mix of
 * categories, bid histories, and countdown states (ending in minutes, ending in days,
 * and already ended).
 */
export const demoAuctions: AuctionItem[] = [
  {
    id: 'auc_macbook',
    title: 'MacBook Air M2 13" (2023, 256GB)',
    description: 'Barely used MacBook Air, still under AppleCare. Comes with the original charger and box.',
    phoneNumber: '+44 7700 900111',
    startingPrice: 500,
    currentPrice: 640,
    sellerId: 'usr_alice',
    sellerName: 'Alice Ng',
    highestBidderId: 'usr_bob',
    highestBidderName: 'Bob Ferreira',
    durationMinutes: 30,
    startTime: NOW - 25 * MINUTE,
    endTime: NOW + 4 * MINUTE,
    status: 'active',
    category: 'Electronics',
    imageUrl: placeholderImage('MacBook Air M2', '#9fb3c8'),
    imageUrls: [placeholderImage('MacBook Air M2', '#9fb3c8')],
    bids: [
      { id: 'bid_mb_2', auctionId: 'auc_macbook', userId: 'usr_bob', userName: 'Bob Ferreira', amount: 640, timestamp: NOW - 2 * MINUTE },
      { id: 'bid_mb_1', auctionId: 'auc_macbook', userId: 'usr_chen', userName: 'Chen Wu', amount: 580, timestamp: NOW - 10 * MINUTE },
    ],
    winnerId: null,
    winnerName: null,
    winningBid: null,
    createdAt: NOW - 25 * MINUTE,
  },
  {
    id: 'auc_bike',
    title: 'Trek Marlin 5 Mountain Bike (Size M)',
    description: 'Great condition hardtail mountain bike, serviced last month. Ideal for campus commuting.',
    phoneNumber: '+44 7700 900222',
    startingPrice: 180,
    currentPrice: 205,
    sellerId: 'usr_dana',
    sellerName: 'Dana Osei',
    highestBidderId: 'usr_evan',
    highestBidderName: 'Evan Clarke',
    durationMinutes: 4320,
    startTime: NOW - HOUR,
    endTime: NOW + 3 * DAY,
    status: 'active',
    category: 'Vehicles',
    imageUrl: placeholderImage('Trek Marlin 5 Bike', '#9cc2a3'),
    imageUrls: [placeholderImage('Trek Marlin 5 Bike', '#9cc2a3')],
    bids: [
      { id: 'bid_bike_1', auctionId: 'auc_bike', userId: 'usr_evan', userName: 'Evan Clarke', amount: 205, timestamp: NOW - 20 * MINUTE },
    ],
    winnerId: null,
    winnerName: null,
    winningBid: null,
    createdAt: NOW - HOUR,
  },
  {
    id: 'auc_lotr',
    title: 'The Lord of the Rings Illustrated Boxset',
    description: 'Full illustrated hardback boxset, excellent condition, smoke-free home.',
    phoneNumber: '+44 7700 900333',
    startingPrice: 40,
    currentPrice: 62,
    sellerId: 'usr_farah',
    sellerName: 'Farah Iqbal',
    highestBidderId: 'usr_george',
    highestBidderName: 'George Popescu',
    durationMinutes: 60,
    startTime: NOW - 2 * HOUR,
    endTime: NOW - HOUR,
    status: 'ended',
    category: 'Books & Media',
    imageUrl: placeholderImage('LOTR Boxset', '#c99a9a'),
    imageUrls: [placeholderImage('LOTR Boxset', '#c99a9a')],
    bids: [
      { id: 'bid_lotr_2', auctionId: 'auc_lotr', userId: 'usr_george', userName: 'George Popescu', amount: 62, timestamp: NOW - 70 * MINUTE },
      { id: 'bid_lotr_1', auctionId: 'auc_lotr', userId: 'usr_bob', userName: 'Bob Ferreira', amount: 48, timestamp: NOW - 100 * MINUTE },
    ],
    winnerId: 'usr_george',
    winnerName: 'George Popescu',
    winningBid: 62,
    createdAt: NOW - 2 * HOUR,
  },
  {
    id: 'auc_desk',
    title: 'IKEA Desk & Ergonomic Chair Bundle',
    description: 'Moving out sale: IKEA Bekant desk plus an ergonomic mesh chair. Pickup only.',
    phoneNumber: '+44 7700 900444',
    startingPrice: 60,
    currentPrice: 60,
    sellerId: 'usr_harper',
    sellerName: 'Harper Singh',
    highestBidderId: null,
    highestBidderName: null,
    durationMinutes: 2880,
    startTime: NOW - 10 * MINUTE,
    endTime: NOW + 2 * DAY,
    status: 'active',
    category: 'General',
    imageUrl: placeholderImage('IKEA Desk & Chair', '#d9be8c'),
    imageUrls: [placeholderImage('IKEA Desk & Chair', '#d9be8c')],
    bids: [],
    winnerId: null,
    winnerName: null,
    winningBid: null,
    createdAt: NOW - 10 * MINUTE,
  },
  {
    id: 'auc_canon',
    title: 'Canon EOS M50 Camera + Lens Kit',
    description: 'Mirrorless camera with 15-45mm kit lens, extra battery, and a 32GB SD card included.',
    phoneNumber: '+44 7700 900555',
    startingPrice: 250,
    currentPrice: 310,
    sellerId: 'usr_ivy',
    sellerName: 'Ivy Zhang',
    highestBidderId: 'usr_chen',
    highestBidderName: 'Chen Wu',
    durationMinutes: 360,
    startTime: NOW - 30 * MINUTE,
    endTime: NOW + 6 * HOUR,
    status: 'active',
    category: 'Electronics',
    imageUrl: placeholderImage('Canon EOS M50', '#b3a7cc'),
    imageUrls: [placeholderImage('Canon EOS M50', '#b3a7cc')],
    bids: [
      { id: 'bid_canon_3', auctionId: 'auc_canon', userId: 'usr_chen', userName: 'Chen Wu', amount: 310, timestamp: NOW - 5 * MINUTE },
      { id: 'bid_canon_2', auctionId: 'auc_canon', userId: 'usr_evan', userName: 'Evan Clarke', amount: 285, timestamp: NOW - 15 * MINUTE },
      { id: 'bid_canon_1', auctionId: 'auc_canon', userId: 'usr_bob', userName: 'Bob Ferreira', amount: 265, timestamp: NOW - 25 * MINUTE },
    ],
    winnerId: null,
    winnerName: null,
    winningBid: null,
    createdAt: NOW - 30 * MINUTE,
  },
  {
    id: 'auc_jacket',
    title: "Vintage Levi's Denim Jacket (Size M)",
    description: 'Classic vintage denim trucker jacket, minor fading for that authentic look.',
    phoneNumber: '+44 7700 900666',
    startingPrice: 25,
    currentPrice: 25,
    sellerId: 'usr_george',
    sellerName: 'George Popescu',
    highestBidderId: null,
    highestBidderName: null,
    durationMinutes: 720,
    startTime: NOW - 5 * MINUTE,
    endTime: NOW + 12 * HOUR,
    status: 'active',
    category: 'Fashion',
    imageUrl: placeholderImage('Denim Jacket', '#8fb3d9'),
    imageUrls: [placeholderImage('Denim Jacket', '#8fb3d9')],
    bids: [],
    winnerId: null,
    winnerName: null,
    winningBid: null,
    createdAt: NOW - 5 * MINUTE,
  },
];
