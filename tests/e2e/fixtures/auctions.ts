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

const LIFETIME = 30 * DAY;

/** Fills in the fields every fixture shares, so each entry below only states what is distinct. */
function listing(fields: Omit<AuctionItem, 'status' | 'expiresAt' | 'soldAt'> & Partial<AuctionItem>): AuctionItem {
  return {
    status: 'active',
    expiresAt: fields.createdAt + LIFETIME,
    soldAt: null,
    ...fields,
  };
}

/**
 * A realistic set of demo listings for a student marketplace: a mix of categories, prices with
 * and without pence, and ages. Six are for sale; `auc_lotr` has been sold, so the browse feed
 * never returns it but a direct link to it still resolves (and must render as sold).
 */
export const demoAuctions: AuctionItem[] = [
  listing({
    id: 'auc_macbook',
    title: 'MacBook Air M2 13" (2023, 256GB)',
    description: 'Barely used MacBook Air, still under AppleCare. Comes with the original charger and box.',
    phoneNumber: '+44 7700 900111',
    price: 640,
    sellerId: 'usr_alice',
    sellerName: 'Alice Ng',
    category: 'Electronics',
    imageUrl: placeholderImage('MacBook Air M2', '#9fb3c8'),
    imageUrls: [placeholderImage('MacBook Air M2', '#9fb3c8')],
    createdAt: NOW - 2 * DAY,
  }),
  listing({
    id: 'auc_bike',
    title: 'Trek Marlin 5 Mountain Bike (Size M)',
    description: 'Great condition hardtail mountain bike, serviced last month. Ideal for campus commuting.',
    phoneNumber: '+44 7700 900222',
    price: 205,
    sellerId: 'usr_dana',
    sellerName: 'Dana Osei',
    category: 'Vehicles',
    imageUrl: placeholderImage('Trek Marlin 5 Bike', '#9cc2a3'),
    imageUrls: [placeholderImage('Trek Marlin 5 Bike', '#9cc2a3')],
    createdAt: NOW - 6 * DAY,
  }),
  listing({
    id: 'auc_lotr',
    title: 'The Lord of the Rings Illustrated Boxset',
    description: 'Full illustrated hardback boxset, excellent condition, smoke-free home.',
    phoneNumber: '+44 7700 900333',
    price: 62,
    sellerId: 'usr_farah',
    sellerName: 'Farah Iqbal',
    category: 'Books & Media',
    imageUrl: placeholderImage('LOTR Boxset', '#c99a9a'),
    imageUrls: [placeholderImage('LOTR Boxset', '#c99a9a')],
    createdAt: NOW - 12 * DAY,
    status: 'sold',
    soldAt: NOW - 3 * DAY,
  }),
  listing({
    id: 'auc_desk',
    title: 'IKEA Desk & Ergonomic Chair Bundle',
    description: 'Moving out sale: IKEA Bekant desk plus an ergonomic mesh chair. Pickup only.',
    phoneNumber: '+44 7700 900444',
    price: 60,
    sellerId: 'usr_harper',
    sellerName: 'Harper Singh',
    category: 'General',
    imageUrl: placeholderImage('IKEA Desk & Chair', '#d9be8c'),
    imageUrls: [placeholderImage('IKEA Desk & Chair', '#d9be8c')],
    createdAt: NOW - 10 * MINUTE,
  }),
  listing({
    id: 'auc_canon',
    title: 'Canon EOS M50 Camera + Lens Kit',
    description: 'Mirrorless camera with 15-45mm kit lens, extra battery, and a 32GB SD card included.',
    phoneNumber: '+44 7700 900555',
    price: 310,
    sellerId: 'usr_ivy',
    sellerName: 'Ivy Zhang',
    category: 'Electronics',
    imageUrl: placeholderImage('Canon EOS M50', '#b3a7cc'),
    imageUrls: [placeholderImage('Canon EOS M50', '#b3a7cc'), placeholderImage('Canon EOS M50 lens', '#a7b8cc')],
    createdAt: NOW - 1 * DAY,
  }),
  listing({
    id: 'auc_jacket',
    title: "Vintage Levi's Denim Jacket (Size M)",
    description: 'Classic vintage denim trucker jacket, minor fading for that authentic look.',
    phoneNumber: '+44 7700 900666',
    price: 24.5,
    sellerId: 'usr_george',
    sellerName: 'George Popescu',
    category: 'Fashion',
    imageUrl: placeholderImage('Denim Jacket', '#8fb3d9'),
    imageUrls: [placeholderImage('Denim Jacket', '#8fb3d9')],
    createdAt: NOW - 20 * DAY,
  }),
  // Owned by the identity the mocked /api/auth/login hands out, so the owner flows (edit, mark
  // as sold, cancel) can be exercised end to end.
  listing({
    id: 'auc_ellie_lamp',
    title: 'Anglepoise Desk Lamp',
    description: 'Works perfectly, bulb included. Collect from Highfield campus.',
    phoneNumber: '+44 7700 900777',
    price: 18,
    sellerId: 'usr_e2e_tester',
    sellerName: 'Ellie Tester',
    category: 'General',
    imageUrl: placeholderImage('Desk Lamp', '#c7d3a4'),
    imageUrls: [placeholderImage('Desk Lamp', '#c7d3a4')],
    createdAt: NOW - 4 * DAY,
  }),
];

/** Every fixture a signed-out visitor sees on the browse page: still active, not yet expired. */
export const browseableDemoAuctions = demoAuctions.filter((a) => a.status === 'active' && a.expiresAt > NOW);
