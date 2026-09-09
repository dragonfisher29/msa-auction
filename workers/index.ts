import { createClient } from '@supabase/supabase-js';

function getSupabaseClient(env: Record<string, string | undefined>) {
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function jsonResponse(body: any, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
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

export default {
  async fetch(request: Request, env: Record<string, string | undefined>): Promise<Response> {
    const supabase = getSupabaseClient(env);
    const url = new URL(request.url);

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

    return jsonResponse({ error: 'Not found' }, { status: 404 });
  },
};
