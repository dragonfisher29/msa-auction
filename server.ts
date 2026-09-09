import express from 'express';
import http from 'http';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { Server as SocketIOServer } from 'socket.io';
import { createServer as createViteServer } from 'vite';

interface User {
  id: string;
  name: string;
  username: string;
  passwordHash: string;
  token: string;
  createdAt: number;
}

interface Bid {
  id: string;
  auctionId: string;
  userId: string;
  userName: string;
  amount: number;
  timestamp: number;
}

interface AuctionItem {
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

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    'Missing Supabase environment variables. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running the app.',
  );
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }

  return [];
}

function sanitizeUser(row: any): User {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    passwordHash: row.password_hash ?? row.passwordHash,
    token: row.token,
    createdAt: Number(row.created_at ?? row.createdAt),
  };
}

function sanitizeAuction(row: any): AuctionItem {
  const imageUrls = parseJsonArray<string>(row.image_urls ?? row.imageUrls ?? '[]');

  return {
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
    imageUrl: row.image_url || row.imageUrl || imageUrls[0],
    imageUrls,
    bids: parseJsonArray<Bid>(row.bids),
    winnerId: row.winner_id ?? row.winnerId ?? null,
    winnerName: row.winner_name ?? row.winnerName ?? null,
    winningBid: row.winning_bid ?? row.winningBid ?? null,
    createdAt: Number(row.created_at ?? row.createdAt),
  };
}

async function hashSecret(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function getAuthenticatedUser(token: string): Promise<User | null> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? sanitizeUser(data) : null;
}

async function getAuctions(): Promise<AuctionItem[]> {
  const { data, error } = await supabase.from('auctions').select('*');

  if (error) {
    throw error;
  }

  return (data ?? [])
    .map((row: any) => sanitizeAuction(row))
    .sort((a, b) => {
      const aEnded = a.status === 'ended' || a.endTime <= Date.now();
      const bEnded = b.status === 'ended' || b.endTime <= Date.now();

      if (aEnded !== bEnded) {
        return aEnded ? 1 : -1;
      }

      return a.endTime - b.endTime;
    });
}

async function getAuctionById(id: string): Promise<AuctionItem | null> {
  const { data, error } = await supabase
    .from('auctions')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? sanitizeAuction(data) : null;
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

async function updateEndedAuctions(io: SocketIOServer) {
  try {
    const now = Date.now();
    const { data, error } = await supabase.from('auctions').select('*').eq('status', 'active');

    if (error) {
      throw error;
    }

    for (const row of data ?? []) {
      const auction = sanitizeAuction(row);

      if (auction.endTime > now) {
        continue;
      }

      const winnerId = auction.highestBidderId ?? null;
      const winnerName = auction.highestBidderName ?? null;
      const winningBid = auction.highestBidderId ? auction.currentPrice : null;

      const { error: updateError } = await supabase
        .from('auctions')
        .update({
          status: 'ended',
          winner_id: winnerId,
          winner_name: winnerName,
          winning_bid: winningBid,
        })
        .eq('id', auction.id);

      if (updateError) {
        throw updateError;
      }

      const updatedAuction = await getAuctionById(auction.id);

      if (!updatedAuction) {
        continue;
      }

      io.to(`auction:${auction.id}`).emit('auction_ended', {
        auctionId: auction.id,
        winnerId,
        winnerName,
        winningBid,
        auction: updatedAuction,
      });

      io.emit('auction_list_updated', {
        type: 'ended',
        auction: updatedAuction,
      });
    }
  } catch (err) {
    console.error('Failed to update ended auctions:', err);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '20mb' }));

  const server = http.createServer(app);
  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  setInterval(() => {
    void updateEndedAuctions(io);
  }, 1000);

  io.on('connection', (socket) => {
    socket.on('join_auction', async ({ auctionId }: { auctionId: string }) => {
      if (!auctionId) return;

      socket.join(`auction:${auctionId}`);
      const auction = await getAuctionById(auctionId);
      if (auction) {
        socket.emit('auction_snapshot', auction);
      }
    });

    socket.on('leave_auction', ({ auctionId }: { auctionId: string }) => {
      if (!auctionId) return;
      socket.leave(`auction:${auctionId}`);
    });

    socket.on(
      'place_bid',
      async ({ auctionId, userId, userName, amount }: { auctionId: string; userId: string; userName: string; amount: number }) => {
        const auction = await getAuctionById(auctionId);

        if (!auction) {
          return socket.emit('bid_error', { message: 'Auction listing was not found.' });
        }

        if (auction.status === 'ended' || Date.now() >= auction.endTime) {
          return socket.emit('bid_error', { message: 'This auction has already ended.' });
        }

        if (auction.sellerId === userId) {
          return socket.emit('bid_error', { message: 'You cannot place a bid on your own listing.' });
        }

        const numericAmount = Number(amount);
        if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
          return socket.emit('bid_error', { message: 'Please enter a valid bid amount.' });
        }

        if (auction.bids.length === 0) {
          if (numericAmount < auction.startingPrice) {
            return socket.emit('bid_error', {
              message: `Starting bid must be at least $${auction.startingPrice.toLocaleString()}.`,
            });
          }
        } else if (numericAmount <= auction.currentPrice) {
          return socket.emit('bid_error', {
            message: `Bid must be strictly higher than current bid of $${auction.currentPrice.toLocaleString()}.`,
          });
        }

        const newBid: Bid = {
          id: `bid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          auctionId,
          userId,
          userName,
          amount: numericAmount,
          timestamp: Date.now(),
        };

        const updatedBids = [newBid, ...auction.bids];

        const { error } = await supabase
          .from('auctions')
          .update({
            bids: updatedBids,
            current_price: numericAmount,
            highest_bidder_id: userId,
            highest_bidder_name: userName,
          })
          .eq('id', auctionId);

        if (error) {
          return socket.emit('bid_error', { message: 'Unable to place the bid right now.' });
        }

        const updatedAuction = await getAuctionById(auctionId);

        if (!updatedAuction) {
          return socket.emit('bid_error', { message: 'Auction listing was not found after the bid update.' });
        }

        io.to(`auction:${auctionId}`).emit('bid_updated', {
          auctionId,
          currentPrice: updatedAuction.currentPrice,
          highestBidderId: updatedAuction.highestBidderId,
          highestBidderName: updatedAuction.highestBidderName,
          bid: newBid,
          auction: updatedAuction,
        });

        io.emit('auction_list_updated', {
          type: 'bid',
          auction: updatedAuction,
        });
      },
    );
  });

  app.get('/api/health', async (_req, res) => {
    try {
      const auctions = await getAuctions();
      res.json({
        status: 'ok',
        serverTime: Date.now(),
        activeAuctions: auctions.filter((auction) => auction.status === 'active').length,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Health check failed.' });
    }
  });

  app.post('/api/auth/register', async (req, res) => {
    try {
      const { username, name, password } = req.body;

      if (!username || !name || !password) {
        return res.status(400).json({ error: 'Username, name, and password are required.' });
      }

      const trimmedUsername = String(username).trim().toLowerCase();
      const trimmedName = String(name).trim();
      const trimmedPassword = String(password).trim();

      if (!trimmedUsername || !trimmedName || !trimmedPassword) {
        return res.status(400).json({ error: 'Username, name, and password are required.' });
      }

      const { data: existingUser, error: existingError } = await supabase
        .from('users')
        .select('id')
        .eq('username', trimmedUsername)
        .maybeSingle();

      if (existingError) {
        throw existingError;
      }

      if (existingUser) {
        return res.status(409).json({ error: 'Username is already taken. Please choose another.' });
      }

      const passwordHash = await hashSecret(trimmedPassword);
      const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const token = `tok_${crypto.randomUUID()}`;

      const { error: insertError } = await supabase.from('users').insert([
        {
          id,
          name: trimmedName,
          username: trimmedUsername,
          password_hash: passwordHash,
          token,
          created_at: Date.now(),
        },
      ]);

      if (insertError) {
        throw insertError;
      }

      res.status(201).json({
        user: {
          id,
          name: trimmedName,
          username: trimmedUsername,
          token,
        },
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Registration failed.' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
      }

      const trimmedUsername = String(username).trim().toLowerCase();
      const trimmedPassword = String(password).trim();

      const { data: storedUser, error: fetchError } = await supabase
        .from('users')
        .select('*')
        .eq('username', trimmedUsername)
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      if (!storedUser) {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }

      const passwordHash = await hashSecret(trimmedPassword);
      if (storedUser.password_hash !== passwordHash) {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }

      const token = `tok_${crypto.randomUUID()}`;
      const { error: updateError } = await supabase
        .from('users')
        .update({ token })
        .eq('id', storedUser.id);

      if (updateError) {
        throw updateError;
      }

      res.json({
        user: {
          id: storedUser.id,
          name: storedUser.name,
          username: storedUser.username,
          token,
        },
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Login failed.' });
    }
  });

  app.get('/api/auth/me', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const token = authHeader.replace('Bearer ', '').trim();
      const user = await getAuthenticatedUser(token);

      if (!user) {
        return res.status(401).json({ error: 'Session expired or invalid' });
      }

      res.json({
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          token,
        },
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load your session.' });
    }
  });

  app.get('/api/auctions', async (_req, res) => {
    try {
      const list = await getAuctions();
      res.json({ auctions: list });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load auctions.' });
    }
  });

  app.get('/api/auctions/:id', async (req, res) => {
    try {
      const auction = await getAuctionById(req.params.id);

      if (!auction) {
        return res.status(404).json({ error: 'Auction not found' });
      }

      res.json({ auction });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load the auction.' });
    }
  });

  app.post('/api/auctions', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required to create a listing.' });
      }

      const token = authHeader.replace('Bearer ', '').trim();
      const user = await getAuthenticatedUser(token);

      if (!user) {
        return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
      }

      const validated = validateAuctionInput(req.body);
      if ('error' in validated) {
        return res.status(400).json({ error: validated.error });
      }

      const maxListingsPerUser = Number(process.env.MAX_LISTINGS_PER_USER ?? '20');
      const { count, error: countError } = await supabase
        .from('auctions')
        .select('*', { count: 'exact' })
        .eq('seller_id', user.id);

      if (countError) {
        throw countError;
      }

      if ((count ?? 0) >= maxListingsPerUser) {
        return res.status(429).json({ error: `You have reached the limit of ${maxListingsPerUser} listings per user.` });
      }

      const now = Date.now();
      const id = `auc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const imageUrls = validated.imageUrls;

      const auction: AuctionItem = {
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

      if (insertError) {
        throw insertError;
      }

      io.emit('auction_list_updated', {
        type: 'created',
        auction,
      });

      res.status(201).json({ auction });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create the auction.' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[MSA Auction] Full-Stack server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
