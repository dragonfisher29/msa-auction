import { createClient } from '@supabase/supabase-js';

function getSupabaseClient(env: Record<string, any>) {
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!supabaseUrl || !supabaseServiceRoleKey || supabaseUrl.includes('your-project')) {
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(body: any, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      ...corsHeaders(),
      ...(init?.headers ?? {}),
    },
    ...init,
  });
}

async function getAuthenticatedUser(supabase: any, token: string) {
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}

async function hashSecret(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function validateAuctionInput(raw: any) {
  if (!raw || typeof raw !== 'object') {
    return { error: 'Invalid auction payload.' };
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const phoneNumber = typeof raw.phoneNumber === 'string' ? raw.phoneNumber.trim() : '';

  if (!title || !description || !phoneNumber) {
    return { error: 'Title, description, and phone number are required.' };
  }

  const parsedPrice = Number(raw.startingPrice);
  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
    return { error: 'Starting price must be greater than $0.' };
  }

  const parsedDuration = Number(raw.durationMinutes);
  if (!Number.isInteger(parsedDuration) || parsedDuration <= 0) {
    return { error: 'Auction duration must be at least 1 minute.' };
  }

  const normalizedImageUrls = Array.isArray(raw.imageUrls)
    ? raw.imageUrls
        .filter((value: unknown): value is string => typeof value === 'string')
        .map((value: string) => value.trim())
        .filter((value: string) => value.length > 0)
    : [];

  const fallbackImage = typeof raw.imageUrl === 'string' ? raw.imageUrl.trim() : '';
  if (fallbackImage && normalizedImageUrls.length === 0) {
    normalizedImageUrls.push(fallbackImage);
  }

  if (normalizedImageUrls.length === 0) {
    return { error: 'Please upload at least one image for the listing.' };
  }

  if (normalizedImageUrls.length > 3) {
    return { error: 'You can upload up to 3 images per listing.' };
  }

  return {
    title,
    description,
    phoneNumber,
    parsedPrice,
    parsedDuration,
    imageUrls: normalizedImageUrls,
    category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'General',
  };
}

export default {
  async fetch(request: Request, env: Record<string, any>): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight OPTIONS request
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // Serve static frontend assets for non-API routes
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        return env.ASSETS.fetch(request);
      }
    }

    const supabase = getSupabaseClient(env);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return jsonResponse({ status: 'ok', serverTime: Date.now() });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
      if (!supabase) {
        return jsonResponse({ error: 'Supabase env vars are not configured.' }, { status: 500 });
      }

      try {
        const body = await request.json();
        const username = String(body.username ?? '').trim().toLowerCase();
        const name = String(body.name ?? '').trim();
        const password = String(body.password ?? '').trim();

        if (!username || !name || !password) {
          return jsonResponse({ error: 'Username, name, and password are required.' }, { status: 400 });
        }

        const { data: existingUser, error: existingError } = await supabase
          .from('users')
          .select('id')
          .eq('username', username)
          .maybeSingle();

        if (existingError) {
          throw existingError;
        }

        if (existingUser) {
          return jsonResponse({ error: 'Username is already taken. Please choose another.' }, { status: 409 });
        }

        const passwordHash = await hashSecret(password);
        const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const token = `tok_${crypto.randomUUID()}`;

        const { error: insertError } = await supabase.from('users').insert([
          {
            id,
            name,
            username,
            password_hash: passwordHash,
            token,
            created_at: Date.now(),
          },
        ]);

        if (insertError) {
          throw insertError;
        }

        return jsonResponse({ user: { id, name, username, token } }, { status: 201 });
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Registration failed.' }, { status: 500 });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      if (!supabase) {
        return jsonResponse({ error: 'Supabase env vars are not configured.' }, { status: 500 });
      }

      try {
        const body = await request.json();
        const username = String(body.username ?? '').trim().toLowerCase();
        const password = String(body.password ?? '').trim();

        if (!username || !password) {
          return jsonResponse({ error: 'Username and password are required.' }, { status: 400 });
        }

        const { data: storedUser, error: fetchError } = await supabase
          .from('users')
          .select('*')
          .eq('username', username)
          .maybeSingle();

        if (fetchError) {
          throw fetchError;
        }

        if (!storedUser) {
          return jsonResponse({ error: 'Invalid username or password.' }, { status: 401 });
        }

        const passwordHash = await hashSecret(password);
        if (storedUser.password_hash !== passwordHash) {
          return jsonResponse({ error: 'Invalid username or password.' }, { status: 401 });
        }

        const token = `tok_${crypto.randomUUID()}`;
        const { error: updateError } = await supabase.from('users').update({ token }).eq('id', storedUser.id);

        if (updateError) {
          throw updateError;
        }

        return jsonResponse({
          user: {
            id: storedUser.id,
            name: storedUser.name,
            username: storedUser.username,
            token,
          },
        });
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Login failed.' }, { status: 500 });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      try {
        const authHeader = request.headers.get('authorization') ?? '';
        if (!authHeader.startsWith('Bearer ')) {
          return jsonResponse({ error: 'Not authenticated' }, { status: 401 });
        }

        const token = authHeader.replace('Bearer ', '').trim();
        const user = await getAuthenticatedUser(supabase, token);

        if (!user) {
          return jsonResponse({ error: 'Session expired or invalid' }, { status: 401 });
        }

        return jsonResponse({ user: { id: user.id, name: user.name, username: user.username, token } });
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Failed to load your session.' }, { status: 500 });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/auctions') {
      if (!supabase) {
        return jsonResponse({ error: 'Supabase env vars are not configured.' }, { status: 500 });
      }

      try {
        const { data, error } = await supabase.from('auctions').select('*');

        if (error) {
          throw error;
        }

        return jsonResponse({ auctions: (data ?? []).map((row: any) => ({
          id: row.id,
          title: row.title,
          description: row.description,
          phoneNumber: row.phone_number ?? row.phoneNumber,
          startingPrice: Number(row.starting_price ?? row.startingPrice),
          currentPrice: Number(row.current_price ?? row.currentPrice),
          sellerId: row.seller_id ?? row.sellerId,
          sellerName: row.seller_name ?? row.sellerName,
          highestBidderId: row.highest_bidder_id ?? row.highestBidderId ?? null,
          highestBidderName: row.highest_bidder_name ?? row.highestBidderName ?? null,
          durationMinutes: Number(row.duration_minutes ?? row.durationMinutes),
          startTime: Number(row.start_time ?? row.startTime),
          endTime: Number(row.end_time ?? row.endTime),
          status: row.status,
          category: row.category ?? 'General',
          imageUrl: row.image_url || row.imageUrl || (Array.isArray(row.image_urls) ? row.image_urls[0] : undefined),
          imageUrls: Array.isArray(row.image_urls) ? row.image_urls : [],
          bids: Array.isArray(row.bids) ? row.bids : [],
          winnerId: row.winner_id ?? row.winnerId ?? null,
          winnerName: row.winner_name ?? row.winnerName ?? null,
          winningBid: row.winning_bid ?? row.winningBid ?? null,
          createdAt: Number(row.created_at ?? row.createdAt),
        })) });
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Failed to load auctions.' }, { status: 500 });
      }
    }

    const singleAuctionMatch = url.pathname.match(/^\/api\/auctions\/([^/]+)$/);
    if (request.method === 'GET' && singleAuctionMatch) {
      if (!supabase) {
        return jsonResponse({ error: 'Supabase env vars are not configured.' }, { status: 500 });
      }

      try {
        const auctionId = singleAuctionMatch[1];
        const { data: row, error } = await supabase.from('auctions').select('*').eq('id', auctionId).maybeSingle();

        if (error) throw error;
        if (!row) return jsonResponse({ error: 'Auction not found' }, { status: 404 });

        return jsonResponse({
          auction: {
            id: row.id,
            title: row.title,
            description: row.description,
            phoneNumber: row.phone_number ?? row.phoneNumber,
            startingPrice: Number(row.starting_price ?? row.startingPrice),
            currentPrice: Number(row.current_price ?? row.currentPrice),
            sellerId: row.seller_id ?? row.sellerId,
            sellerName: row.seller_name ?? row.sellerName,
            highestBidderId: row.highest_bidder_id ?? row.highestBidderId ?? null,
            highestBidderName: row.highest_bidder_name ?? row.highestBidderName ?? null,
            durationMinutes: Number(row.duration_minutes ?? row.durationMinutes),
            startTime: Number(row.start_time ?? row.startTime),
            endTime: Number(row.end_time ?? row.endTime),
            status: row.status,
            category: row.category ?? 'General',
            imageUrl: row.image_url || row.imageUrl || (Array.isArray(row.image_urls) ? row.image_urls[0] : undefined),
            imageUrls: Array.isArray(row.image_urls) ? row.image_urls : [],
            bids: Array.isArray(row.bids) ? row.bids : [],
            winnerId: row.winner_id ?? row.winnerId ?? null,
            winnerName: row.winner_name ?? row.winnerName ?? null,
            winningBid: row.winning_bid ?? row.winningBid ?? null,
            createdAt: Number(row.created_at ?? row.createdAt),
          },
        });
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Failed to load auction.' }, { status: 500 });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/auctions') {
      if (!supabase) {
        return jsonResponse({ error: 'Supabase env vars are not configured.' }, { status: 500 });
      }

      try {
        const authHeader = request.headers.get('authorization') ?? '';
        if (!authHeader.startsWith('Bearer ')) {
          return jsonResponse({ error: 'Authentication required to create a listing.' }, { status: 401 });
        }

        const token = authHeader.replace('Bearer ', '').trim();
        const user = await getAuthenticatedUser(supabase, token);

        if (!user) {
          return jsonResponse({ error: 'Your session has expired. Please sign in again.' }, { status: 401 });
        }

        const rawBody = await request.json();
        const validated = validateAuctionInput(rawBody);
        if ('error' in validated) {
          return jsonResponse({ error: validated.error }, { status: 400 });
        }

        const maxListingsPerUser = Number(env.MAX_LISTINGS_PER_USER ?? '20');
        const { count, error: countError } = await supabase
          .from('auctions')
          .select('*', { count: 'exact' })
          .eq('seller_id', user.id);

        if (countError) throw countError;
        if ((count ?? 0) >= maxListingsPerUser) {
          return jsonResponse({ error: `You have reached the limit of ${maxListingsPerUser} listings per user.` }, { status: 429 });
        }

        const now = Date.now();
        const id = `auc_${now}_${Math.random().toString(36).slice(2, 6)}`;
        const imageUrls = validated.imageUrls;

        const auction = {
          id,
          title: validated.title,
          description: validated.description,
          phoneNumber: validated.phoneNumber,
          startingPrice: validated.parsedPrice,
          currentPrice: validated.parsedPrice,
          sellerId: user.id,
          sellerName: user.name,
          highestBidderId: null,
          highestBidderName: null,
          durationMinutes: validated.parsedDuration,
          startTime: now,
          endTime: now + validated.parsedDuration * 60 * 1000,
          status: 'active',
          category: validated.category,
          imageUrl: imageUrls[0],
          imageUrls,
          bids: [],
          winnerId: null,
          winnerName: null,
          winningBid: null,
          createdAt: now,
        };

        const { error: insertError } = await supabase.from('auctions').insert([
          {
            id: auction.id,
            title: auction.title,
            description: auction.description,
            phone_number: auction.phoneNumber,
            starting_price: auction.startingPrice,
            current_price: auction.currentPrice,
            seller_id: auction.sellerId,
            seller_name: auction.sellerName,
            highest_bidder_id: auction.highestBidderId,
            highest_bidder_name: auction.highestBidderName,
            duration_minutes: auction.durationMinutes,
            start_time: auction.startTime,
            end_time: auction.endTime,
            status: auction.status,
            category: auction.category,
            image_url: auction.imageUrl,
            image_urls: auction.imageUrls,
            bids: auction.bids,
            winner_id: auction.winnerId,
            winner_name: auction.winnerName,
            winning_bid: auction.winningBid,
            created_at: auction.createdAt,
          },
        ]);

        if (insertError) throw insertError;

        return jsonResponse({ auction }, { status: 201 });
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Failed to create auction.' }, { status: 500 });
      }
    }

    const bidMatch = url.pathname.match(/^\/api\/auctions\/([^/]+)\/bids$/);
    if (request.method === 'POST' && bidMatch) {
      if (!supabase) {
        return jsonResponse({ error: 'Supabase env vars are not configured.' }, { status: 500 });
      }

      try {
        const auctionId = bidMatch[1];
        const body = await request.json();
        const { userId, userName, amount } = body;

        const { data: rawAuction, error: fetchErr } = await supabase
          .from('auctions')
          .select('*')
          .eq('id', auctionId)
          .maybeSingle();

        if (fetchErr || !rawAuction) {
          return jsonResponse({ error: 'Auction listing was not found.' }, { status: 404 });
        }

        const bids = Array.isArray(rawAuction.bids) ? rawAuction.bids : [];
        const startingPrice = Number(rawAuction.starting_price ?? rawAuction.startingPrice);
        const currentPrice = Number(rawAuction.current_price ?? rawAuction.currentPrice);
        const sellerId = rawAuction.seller_id ?? rawAuction.sellerId;
        const endTime = Number(rawAuction.end_time ?? rawAuction.endTime);

        if (rawAuction.status === 'ended' || Date.now() >= endTime) {
          return jsonResponse({ error: 'This auction has already ended.' }, { status: 400 });
        }

        if (sellerId === userId) {
          return jsonResponse({ error: 'You cannot place a bid on your own listing.' }, { status: 400 });
        }

        const numericAmount = Number(amount);
        if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
          return jsonResponse({ error: 'Please enter a valid bid amount.' }, { status: 400 });
        }

        if (bids.length === 0) {
          if (numericAmount < startingPrice) {
            return jsonResponse({ error: `Starting bid must be at least $${startingPrice.toLocaleString()}.` }, { status: 400 });
          }
        } else if (numericAmount <= currentPrice) {
          return jsonResponse({ error: `Bid must be strictly higher than current bid of $${currentPrice.toLocaleString()}.` }, { status: 400 });
        }

        const newBid = {
          id: `bid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          auctionId,
          userId,
          userName,
          amount: numericAmount,
          timestamp: Date.now(),
        };

        const updatedBids = [newBid, ...bids];

        const { error: updateErr } = await supabase
          .from('auctions')
          .update({
            bids: updatedBids,
            current_price: numericAmount,
            highest_bidder_id: userId,
            highest_bidder_name: userName,
          })
          .eq('id', auctionId);

        if (updateErr) {
          return jsonResponse({ error: 'Unable to place the bid right now.' }, { status: 500 });
        }

        return jsonResponse({ success: true, bid: newBid });
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Failed to place bid.' }, { status: 500 });
      }
    }

    return jsonResponse({ error: 'Not found' }, { status: 404 });
  },
};
