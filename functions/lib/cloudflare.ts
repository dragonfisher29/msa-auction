export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first(): Promise<Record<string, any> | null> | Record<string, any> | null;
  run(): Promise<unknown> | unknown;
  all(): Promise<Record<string, any>[]> | Record<string, any>[];
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface R2Bucket {
  put(
    key: string,
    value: Uint8Array | ArrayBuffer | string,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };
    },
  ): Promise<unknown>;
}

export interface CloudflareEnv {
  DB: D1Database;
  R2_BUCKET?: R2Bucket;
  R2_PUBLIC_BASE_URL?: string;
  MAX_LISTINGS_PER_USER?: string;
  MAX_IMAGES_PER_LISTING?: string;
}

export interface CloudflareContext {
  request: Request;
  env: CloudflareEnv;
  params: Record<string, string>;
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });

export async function hashSecret(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function getAuthenticatedUser(env: CloudflareEnv, authHeader?: string | null) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return null;
  }

  const row = await env.DB.prepare('SELECT * FROM users WHERE token = ?').bind(token).first();
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    username: row.username,
    passwordHash: row.passwordHash,
    token: row.token,
    createdAt: row.createdAt,
  };
}

export function parseAuctionRow(row: Record<string, any>) {
  const imageUrls = Array.isArray(JSON.parse(row.imageUrls ?? '[]')) ? JSON.parse(row.imageUrls ?? '[]') : [];

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    phoneNumber: row.phoneNumber,
    startingPrice: Number(row.startingPrice),
    currentPrice: Number(row.currentPrice),
    sellerId: row.sellerId,
    sellerName: row.sellerName,
    highestBidderId: row.highestBidderId ?? null,
    highestBidderName: row.highestBidderName ?? null,
    durationMinutes: Number(row.durationMinutes),
    startTime: Number(row.startTime),
    endTime: Number(row.endTime),
    status: row.status,
    category: row.category ?? 'General',
    imageUrl: row.imageUrl || imageUrls[0],
    imageUrls,
    bids: Array.isArray(JSON.parse(row.bids ?? '[]')) ? JSON.parse(row.bids ?? '[]') : [],
    winnerId: row.winnerId ?? null,
    winnerName: row.winnerName ?? null,
    winningBid: row.winningBid ?? null,
    createdAt: Number(row.createdAt),
  };
}

export function getMonthStart() {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

export function normalizeImageUrls(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function uploadImageToR2(imageDataUrl: string, env: CloudflareEnv, keyPrefix = 'auction-images') {
  if (!imageDataUrl.startsWith('data:image/')) {
    throw new Error('Invalid image payload.');
  }

  const [meta, base64Data] = imageDataUrl.split(',');
  const match = meta.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64$/i);

  if (!match || !base64Data) {
    throw new Error('Invalid image payload format.');
  }

  const mimeType = match[1];
  const extension = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const binary = Uint8Array.from(atob(base64Data), (char) => char.charCodeAt(0));

  if (binary.byteLength > 5 * 1024 * 1024) {
    throw new Error('Each image must be 5MB or smaller.');
  }

  const key = `${keyPrefix}/${Date.now()}-${crypto.randomUUID()}.${extension}`;

  if (!env.R2_BUCKET) {
    throw new Error('R2 bucket is not configured.');
  }

  await env.R2_BUCKET.put(key, binary, {
    httpMetadata: {
      contentType: mimeType,
    },
  });

  return `${env.R2_PUBLIC_BASE_URL || 'https://example.invalid'}/${key}`;
}
