import { CloudflareContext, getAuthenticatedUser, json, normalizeImageUrls, parseAuctionRow, uploadImageToR2 } from '../lib/cloudflare';

export async function onRequestGet({ env }: CloudflareContext) {
  const rows = await env.DB.prepare('SELECT * FROM auctions ORDER BY CASE WHEN status = "active" THEN 0 ELSE 1 END, endTime ASC').all();
  return json({ auctions: rows.map((row) => parseAuctionRow(row)) });
}

export async function onRequestPost({ request, env }: CloudflareContext) {
  const authHeader = request.headers.get('authorization');
  const user = await getAuthenticatedUser(env, authHeader);

  if (!user) {
    return json({ error: 'Authentication required to create a listing.' }, 401);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : '';

  if (!title || !description || !phoneNumber) {
    return json({ error: 'Title, description, and phone number are required.' }, 400);
  }

  const parsedPrice = Number(body.startingPrice);
  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
    return json({ error: 'Starting price must be greater than $0.' }, 400);
  }

  const parsedDuration = Number(body.durationMinutes);
  if (!Number.isInteger(parsedDuration) || parsedDuration <= 0) {
    return json({ error: 'Auction duration must be at least 1 minute.' }, 400);
  }

  const normalizedImageUrls = normalizeImageUrls(body.imageUrls || []);

  if (normalizedImageUrls.length === 0 && typeof body.imageUrl === 'string' && body.imageUrl.trim()) {
    normalizedImageUrls.push(body.imageUrl.trim());
  }

  if (normalizedImageUrls.length === 0) {
    return json({ error: 'Please upload at least one image for the listing.' }, 400);
  }

  if (normalizedImageUrls.length > 3) {
    return json({ error: 'You can upload up to 3 images per listing.' }, 400);
  }

  const maxListingsPerUser = Number(env.MAX_LISTINGS_PER_USER ?? '20');
  const existingListings = await env.DB.prepare('SELECT COUNT(*) as count FROM auctions WHERE sellerId = ?').bind(user.id).first();

  if (Number(existingListings?.count ?? 0) >= maxListingsPerUser) {
    return json({ error: `You have reached the limit of ${maxListingsPerUser} listings per user.` }, 429);
  }

  const uploadedUrls: string[] = [];

  for (const imageUrl of normalizedImageUrls) {
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      uploadedUrls.push(imageUrl);
      continue;
    }

    if (imageUrl.startsWith('data:image/')) {
      const uploaded = await uploadImageToR2(imageUrl, env);
      uploadedUrls.push(uploaded);
    }
  }

  if (uploadedUrls.length === 0) {
    return json({ error: 'Please upload at least one valid image.' }, 400);
  }

  const now = Date.now();
  const id = `auc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const auction = {
    id,
    title,
    description,
    phoneNumber,
    startingPrice: parsedPrice,
    currentPrice: parsedPrice,
    sellerId: user.id,
    sellerName: user.name,
    highestBidderId: null,
    highestBidderName: null,
    durationMinutes: parsedDuration,
    startTime: now,
    endTime: now + parsedDuration * 60 * 1000,
    status: 'active',
    category: typeof body.category === 'string' && body.category.trim() ? body.category.trim() : 'General',
    imageUrl: uploadedUrls[0],
    imageUrls: uploadedUrls,
    bids: [],
    winnerId: null,
    winnerName: null,
    winningBid: null,
    createdAt: now,
  };

  await env.DB.prepare(`
    INSERT INTO auctions (
      id, title, description, phoneNumber, startingPrice, currentPrice,
      sellerId, sellerName, highestBidderId, highestBidderName,
      durationMinutes, startTime, endTime, status, category,
      imageUrl, imageUrls, bids, winnerId, winnerName, winningBid, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    auction.id,
    auction.title,
    auction.description,
    auction.phoneNumber,
    auction.startingPrice,
    auction.currentPrice,
    auction.sellerId,
    auction.sellerName,
    auction.highestBidderId,
    auction.highestBidderName,
    auction.durationMinutes,
    auction.startTime,
    auction.endTime,
    auction.status,
    auction.category,
    auction.imageUrl,
    JSON.stringify(auction.imageUrls),
    JSON.stringify(auction.bids),
    auction.winnerId,
    auction.winnerName,
    auction.winningBid,
    auction.createdAt,
  ).run();

  return json({ auction }, 201);
}
