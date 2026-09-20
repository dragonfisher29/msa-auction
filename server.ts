/**
 * LOCAL DEV SERVER ONLY.
 *
 * Production runs the Cloudflare Worker in `workers/index.ts`, which is a plain
 * fetch handler with no Socket.io server attached. The client no longer speaks
 * Socket.io at all: it talks to the REST API (`/api/...`) and polls for updates
 * via `src/lib/realtime.ts`.
 *
 * The Socket.io handlers below are therefore legacy and local-only — nothing in
 * the current client emits or listens to them. The Express REST routes here still
 * mirror the Worker's routes and are what `npm run dev` actually serves.
 */
import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { Server as SocketIOServer } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import fs from 'fs/promises';
import {
  AUCTION_LIST_COLUMNS,
  AUCTION_META_COLUMNS,
  AUCTION_STATUS,
  applyBidLock,
  bannedMessage,
  bidLockUpdate,
  buildAuctionMetaTags,
  buildNotifications,
  createAuctionReport,
  createPasswordResetRequest,
  fetchAuctionListPage,
  hashPassword,
  hideAuction,
  injectAuctionMeta,
  isAdminUser,
  isAuctionVisible,
  isBannedUser,
  isBearerTokenAdmin,
  isFailure,
  listPendingResetRequests,
  listReportsForAdmin,
  mapAuctionSummaryRow,
  mergeAuctionEdit,
  NOTIFICATION_COLUMNS,
  readBidLock,
  resetPasswordWithToken,
  selectActivity,
  setUserBan,
  setUserEmail,
  settleEndedAuctions,
  toNullableMoney,
  toStringArray,
  USER_ROLE,
  validateOptionalEmail,
  verifyAndUpgradePassword,
  type SharedFailure,
} from './workers/shared';

interface User {
  id: string;
  name: string;
  username: string;
  passwordHash: string;
  token: string;
  createdAt: number;
  email: string | null;
  /** 'member' | 'admin'. Read from the database row only, never from a body. */
  role: string;
  bannedAt: number | null;
  bannedReason: string | null;
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
  status: 'active' | 'ended' | 'cancelled' | 'hidden';
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
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseSecretKey) {
  throw new Error(
    'Missing Supabase environment variables. Set SUPABASE_URL and SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) before running the app.',
  );
}

const supabase = createClient(supabaseUrl, supabaseSecretKey, {
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
    email: row.email ?? null,
    // Carried through so `isAdminUser` / `isBannedUser` can be applied to the
    // sanitized user exactly as they are to a raw row in the Worker.
    role: row.role ?? 'member',
    bannedAt: row.banned_at ?? row.bannedAt ?? null,
    bannedReason: row.banned_reason ?? row.bannedReason ?? null,
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
    winningBid: toNullableMoney(row.winning_bid ?? row.winningBid),
    createdAt: Number(row.created_at ?? row.createdAt),
  };
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

interface AuthResult {
  user: User | null;
  error: { error: string; code: string } | null;
  /** The status to send with `error`. 401 for auth, 403 for a ban or a role. */
  status: number;
}

/**
 * Resolves the caller from `Authorization: Bearer <token>`. Returns the user,
 * or the body and status to send back. Mirrors `requireUser` in
 * workers/index.ts.
 */
async function authenticateRequest(req: express.Request, missingHeaderMessage: string): Promise<AuthResult> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { user: null, error: makeError(missingHeaderMessage, 'UNAUTHORIZED'), status: 401 };
  }

  const token = authHeader.replace('Bearer ', '').trim();
  const user = await getAuthenticatedUser(token);

  if (!user) {
    return {
      user: null,
      error: makeError('Your session has expired. Please sign in again.', 'SESSION_EXPIRED'),
      status: 401,
    };
  }

  // A ban is enforced HERE, at authentication, so that it takes effect on every
  // authenticated route at once instead of having to be remembered route by
  // route. The banned user's session token is deliberately left valid so this
  // answers 403 ACCOUNT_BANNED rather than a misleading "session expired".
  if (isBannedUser(user)) {
    return { user: null, error: makeError(bannedMessage(user), 'ACCOUNT_BANNED'), status: 403 };
  }

  return { user, error: null, status: 200 };
}

/**
 * `authenticateRequest` plus a role check. The role comes from the DATABASE ROW
 * - never from the request body, which a caller controls. Mirrors
 * `requireAdmin` in workers/index.ts.
 */
async function authenticateAdmin(req: express.Request): Promise<AuthResult> {
  const auth = await authenticateRequest(req, 'Authentication required.');
  if (auth.error) {
    return auth;
  }

  if (!isAdminUser(auth.user)) {
    return {
      user: null,
      error: makeError('This area is for committee admins only.', 'NOT_ADMIN'),
      status: 403,
    };
  }

  return auth;
}

/**
 * Lazy settle backstop, mirroring workers/index.ts. A settle failure must
 * never fail the read.
 */
async function settleBeforeRead(auctionId?: string) {
  try {
    await settleEndedAuctions(supabase, auctionId ? { auctionId } : {});
  } catch (error) {
    console.error('Lazy settle failed:', error);
  }
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

function getErrorMessageAndCode(fallbackMessage: string, defaultCode: string, error?: unknown): { error: string; code: string } {
  if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, any>;
    const code = String(errObj.code || defaultCode);
    const detailMsg = errObj.message || errObj.details || errObj.error_description;
    const baseMsg = detailMsg ? String(detailMsg) : (error instanceof Error ? error.message : fallbackMessage);
    return {
      error: `${baseMsg} [Code: ${code}]`,
      code,
    };
  }
  if (error instanceof Error) {
    return {
      error: `${error.message} [Code: ${defaultCode}]`,
      code: defaultCode,
    };
  }
  return {
    error: `${fallbackMessage} [Code: ${defaultCode}]`,
    code: defaultCode,
  };
}

function makeError(message: string, code: string): { error: string; code: string } {
  return {
    error: `${message} [Code: ${code}]`,
    code,
  };
}

/** Maps a `SharedFailure` from `workers/shared.ts` onto the wire format. */
function sendFailure(res: express.Response, failure: SharedFailure) {
  return res.status(failure.status).json(makeError(failure.message, failure.code));
}

/** Optimistic-lock retries before a concurrent bid is reported as a conflict. */
const MAX_BID_ATTEMPTS = 3;

function validateAuctionInput(raw: any) {
  if (!raw || typeof raw !== 'object') {
    return makeError('Invalid auction payload.', 'INVALID_PAYLOAD');
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const phoneNumber = typeof raw.phoneNumber === 'string' ? raw.phoneNumber.trim() : '';

  if (!title || !description || !phoneNumber) {
    return makeError('Title, description, and phone number are required.', 'MISSING_FIELDS');
  }

  const parsedPrice = Number(raw.startingPrice);
  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
    return makeError('Starting price must be greater than £0.', 'INVALID_PRICE');
  }

  const parsedDuration = Number(raw.durationMinutes);
  if (!Number.isInteger(parsedDuration) || parsedDuration <= 0) {
    return makeError('Auction duration must be at least 1 minute.', 'INVALID_DURATION');
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
    return makeError('Please upload at least one image for the listing.', 'MISSING_IMAGES');
  }

  if (normalizedImageUrls.length > 3) {
    return makeError('You can upload up to 3 images per listing.', 'TOO_MANY_IMAGES');
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

/**
 * Dev-server sweep. The settle itself lives in `workers/shared.ts` and is the
 * same code the Worker's cron trigger runs, so dev and prod cannot drift. This
 * wrapper only adds the Socket.io broadcasts.
 */
async function updateEndedAuctions(io: SocketIOServer) {
  try {
    const settledRows = await settleEndedAuctions(supabase);

    for (const row of settledRows) {
      const updatedAuction = sanitizeAuction(row);

      io.to(`auction:${updatedAuction.id}`).emit('auction_ended', {
        auctionId: updatedAuction.id,
        winnerId: updatedAuction.winnerId ?? null,
        winnerName: updatedAuction.winnerName ?? null,
        winningBid: updatedAuction.winningBid ?? null,
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

async function cleanupStaleImages(): Promise<number> {
  try {
    const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
    const { data, error } = await supabase
      .from('auctions')
      .select('id, created_at, image_url, image_urls')
      .lt('created_at', ninetyDaysAgo);

    if (error || !data) return 0;

    let cleanedCount = 0;
    for (const row of data) {
      const hasMainImage = typeof row.image_url === 'string' && row.image_url.trim().length > 0;
      const imageUrls = parseJsonArray<string>(row.image_urls);
      if (hasMainImage || imageUrls.length > 0) {
        await supabase
          .from('auctions')
          .update({
            image_url: null,
            image_urls: '[]',
          })
          .eq('id', row.id);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      console.log(`[Maintenance] Cleaned stale images for ${cleanedCount} auction(s) older than 90 days.`);
    }
    return cleanedCount;
  } catch (err) {
    console.error('Failed to clean up stale images:', err);
    return 0;
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

  // Run stale image cleanup on startup and every 6 hours
  void cleanupStaleImages();
  setInterval(() => {
    void cleanupStaleImages();
  }, 6 * 60 * 60 * 1000);

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
              message: `Starting bid must be at least £${auction.startingPrice.toLocaleString()}.`,
            });
          }
        } else if (numericAmount <= auction.currentPrice) {
          return socket.emit('bid_error', {
            message: `Bid must be strictly higher than current bid of £${auction.currentPrice.toLocaleString()}.`,
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
      res.status(500).json(getErrorMessageAndCode('Health check failed.', 'HEALTH_CHECK_FAILED', error));
    }
  });

  app.post('/api/auth/register', async (req, res) => {
    try {
      const { username, name, password } = req.body;

      if (!username || !name || !password) {
        return res.status(400).json(makeError('Username, name, and password are required.', 'MISSING_FIELDS'));
      }

      const trimmedUsername = String(username).trim().toLowerCase();
      const trimmedName = String(name).trim();
      const trimmedPassword = String(password).trim();

      if (!trimmedUsername || !trimmedName || !trimmedPassword) {
        return res.status(400).json(makeError('Username, name, and password are required.', 'MISSING_FIELDS'));
      }

      // Optional: an account with no email simply has no way to self-recover.
      const emailResult = validateOptionalEmail(req.body.email);
      if (isFailure(emailResult)) {
        return sendFailure(res, emailResult);
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
        return res.status(409).json(makeError('Username is already taken. Please choose another.', 'USERNAME_TAKEN'));
      }

      // PBKDF2 with a fresh per-user salt. See hashPassword in workers/shared.ts.
      const passwordHash = await hashPassword(trimmedPassword);
      const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const token = `tok_${crypto.randomUUID()}`;
      const email = emailResult.data;

      const { error: insertError } = await supabase.from('users').insert([
        {
          id,
          name: trimmedName,
          username: trimmedUsername,
          password_hash: passwordHash,
          token,
          created_at: Date.now(),
          // Only sent when supplied, so registration still works on a schema
          // where migration 002 has not been applied yet. `role` is left to the
          // column default from migration 003 and is NEVER taken from the body.
          ...(email ? { email } : {}),
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
          email,
          // Reported, never accepted: the INSERT above sends no `role`, so a new account is
          // always the column default. Echoed only so the client can decide whether to SHOW
          // admin controls -- enforcement is `requireAdminRequest`, below.
          role: USER_ROLE.member,
          token,
        },
      });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Registration failed.', 'REGISTER_FAILED', error));
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json(makeError('Username and password are required.', 'MISSING_FIELDS'));
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
        return res.status(401).json(makeError('Invalid username or password.', 'INVALID_CREDENTIALS'));
      }

      // Accepts BOTH the PBKDF2 format and the legacy unsalted SHA-256 hex
      // digest, and silently rewrites a legacy row to PBKDF2 on success.
      // Constant-time comparison lives in verifyPassword.
      const passwordValid = await verifyAndUpgradePassword(supabase, storedUser, trimmedPassword);
      if (!passwordValid) {
        return res.status(401).json(makeError('Invalid username or password.', 'INVALID_CREDENTIALS'));
      }

      if (isBannedUser(storedUser)) {
        return res.status(403).json(makeError(bannedMessage(storedUser), 'ACCOUNT_BANNED'));
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
          email: storedUser.email ?? null,
          // Read from the DATABASE ROW. Display-only for the client; every admin route is
          // gated server-side against this same column.
          role: storedUser.role ?? USER_ROLE.member,
          token,
        },
      });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Login failed.', 'LOGIN_FAILED', error));
    }
  });

  app.get('/api/auth/me', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json(makeError('Not authenticated', 'UNAUTHORIZED'));
      }

      const token = authHeader.replace('Bearer ', '').trim();
      const user = await getAuthenticatedUser(token);

      if (!user) {
        return res.status(401).json(makeError('Session expired or invalid', 'SESSION_INVALID'));
      }

      // Checked inline rather than via authenticateRequest so the existing 401
      // codes this route returns (UNAUTHORIZED / SESSION_INVALID) are unchanged.
      if (isBannedUser(user)) {
        return res.status(403).json(makeError(bannedMessage(user), 'ACCOUNT_BANNED'));
      }

      res.json({
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          email: user.email ?? null,
          // Display-only for the client (see the login route). The admin routes re-read this
          // column on every request, so a tampered client copy grants nothing.
          role: user.role ?? USER_ROLE.member,
          token,
        },
      });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Failed to load your session.', 'SESSION_ERROR', error));
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Account recovery                                                          */
  /* ------------------------------------------------------------------------ */

  app.post('/api/auth/email', async (req, res) => {
    try {
      const auth = await authenticateRequest(req, 'Authentication required to set an email address.');
      if (auth.error) {
        return res.status(auth.status).json(auth.error);
      }

      const result = await setUserEmail(supabase, auth.user!.id, req.body.email);
      if (isFailure(result)) {
        return sendFailure(res, result);
      }

      res.json({ success: true, email: result.data.email });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Failed to save your email address.', 'SET_EMAIL_FAILED', error));
    }
  });

  app.post('/api/auth/request-reset', async (req, res) => {
    // ALWAYS the same answer, whatever happened. Telling the caller whether the
    // account existed would turn this into a username/email oracle, and a 500 on
    // a database blip would leak the same thing by omission - hence the catch
    // that still returns 200.
    try {
      await createPasswordResetRequest(supabase, req.body.usernameOrEmail);
    } catch (error) {
      console.error('Password reset request failed:', error);
    }

    res.json({ success: true, message: 'If that account exists, a reset link has been created.' });
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    try {
      const result = await resetPasswordWithToken(supabase, req.body.token, req.body.newPassword);
      if (isFailure(result)) {
        return sendFailure(res, result);
      }

      res.json({ user: result.data.user });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Failed to reset your password.', 'RESET_PASSWORD_FAILED', error));
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Reporting and admin                                                       */
  /* ------------------------------------------------------------------------ */

  app.post('/api/auctions/:id/report', async (req, res) => {
    try {
      const auth = await authenticateRequest(req, 'Authentication required to report a listing.');
      if (auth.error) {
        return res.status(auth.status).json(auth.error);
      }

      const result = await createAuctionReport(supabase, {
        auctionId: req.params.id,
        reporterId: auth.user!.id,
        reason: req.body.reason,
        details: req.body.details,
      });

      if (isFailure(result)) {
        return sendFailure(res, result);
      }

      // A duplicate is deliberately a 200, not a 409: the reporter did nothing
      // wrong, and the response must not differ enough to reveal whether an
      // earlier report of theirs is still open.
      res.json({
        success: true,
        duplicate: result.data.duplicate,
        report: result.data.report,
        message: 'Thanks - the committee has been notified.',
      });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Failed to report the listing.', 'REPORT_FAILED', error));
    }
  });

  app.get('/api/admin/reports', async (req, res) => {
    try {
      const auth = await authenticateAdmin(req);
      if (auth.error) {
        return res.status(auth.status).json(auth.error);
      }

      res.json({ reports: await listReportsForAdmin(supabase) });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Admin request failed.', 'ADMIN_REQUEST_FAILED', error));
    }
  });

  // INTERIM MEASURE - DELETE THIS ROUTE ONCE A MAIL PROVIDER IS WIRED UP.
  //
  // There is no way to send a reset link yet, so a committee member reads the
  // pending requests here and passes the link to the student out of band.
  // `POST /api/auth/request-reset` deliberately does NOT return the token,
  // because that would let anyone reset anyone's password.
  //
  // Only the token HASH is stored, so a pending request's original token cannot
  // be read back: this MINTS a new token per pending request and returns it
  // once. Reading this list therefore invalidates any link handed out from a
  // previous read and restarts the 60-minute window.
  app.get('/api/admin/reset-requests', async (req, res) => {
    try {
      const auth = await authenticateAdmin(req);
      if (auth.error) {
        return res.status(auth.status).json(auth.error);
      }

      res.json({
        resetRequests: await listPendingResetRequests(supabase),
        notice:
          'Interim: no mail provider is configured. Pass the link to the student yourself. Reading this list re-issues each token, so any link from an earlier read stops working.',
      });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Admin request failed.', 'ADMIN_REQUEST_FAILED', error));
    }
  });

  app.post('/api/admin/auctions/:id/hide', async (req, res) => {
    try {
      const auth = await authenticateAdmin(req);
      if (auth.error) {
        return res.status(auth.status).json(auth.error);
      }

      const result = await hideAuction(supabase, {
        auctionId: req.params.id,
        adminId: auth.user!.id,
        reason: req.body.reason,
      });

      if (isFailure(result)) {
        return sendFailure(res, result);
      }

      const hidden = await getAuctionById(req.params.id);
      if (hidden) {
        io.emit('auction_list_updated', { type: 'hidden', auction: hidden });
      }

      res.json({ success: true, ...result.data });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Admin request failed.', 'ADMIN_REQUEST_FAILED', error));
    }
  });

  // Ban and unban share one handler; two plain paths rather than one regex
  // param, so nothing here depends on Express 4's path-to-regexp syntax.
  async function handleBanRoute(req: express.Request, res: express.Response, banned: boolean) {
    try {
      const auth = await authenticateAdmin(req);
      if (auth.error) {
        return res.status(auth.status).json(auth.error);
      }

      const result = await setUserBan(supabase, {
        userId: req.params.id,
        adminId: auth.user!.id,
        banned,
        reason: req.body.reason,
      });

      if (isFailure(result)) {
        return sendFailure(res, result);
      }

      res.json({ success: true, user: result.data.user });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Admin request failed.', 'ADMIN_REQUEST_FAILED', error));
    }
  }

  app.post('/api/admin/users/:id/ban', (req, res) => {
    void handleBanRoute(req, res, true);
  });

  app.post('/api/admin/users/:id/unban', (req, res) => {
    void handleBanRoute(req, res, false);
  });

  app.get('/api/auctions', async (req, res) => {
    try {
      await settleBeforeRead();

      // Slim rows (no image payload) + keyset page. See fetchAuctionListPage.
      const page = await fetchAuctionListPage(supabase, {
        limit: req.query.limit,
        cursor: req.query.cursor,
      });

      res.json(page);
    } catch (error) {
      if ((error as any)?.code === 'INVALID_CURSOR') {
        return res.status(400).json(makeError('Invalid pagination cursor.', 'INVALID_CURSOR'));
      }
      res.status(500).json(getErrorMessageAndCode('Failed to load auctions.', 'FETCH_AUCTIONS_FAILED', error));
    }
  });

  app.get('/api/auctions/:id/images', async (req, res) => {
    try {
      const { data: row, error } = await supabase
        .from('auctions')
        .select('id,image_urls,status')
        .eq('id', req.params.id)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!row) {
        return res.status(404).json(makeError('Auction not found', 'AUCTION_NOT_FOUND'));
      }

      const isAdmin = await isBearerTokenAdmin(supabase, req.headers.authorization);
      if (!isAuctionVisible(row, isAdmin)) {
        return res.status(404).json(makeError('Auction not found', 'AUCTION_NOT_FOUND'));
      }

      // A listing's images are immutable once it has bids, and this is the
      // heaviest response the API serves - let clients and the edge keep it.
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ imageUrls: toStringArray(row.image_urls) });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Failed to load auction images.', 'FETCH_AUCTION_IMAGES_FAILED', error));
    }
  });

  app.get('/api/auctions/:id', async (req, res) => {
    try {
      await settleBeforeRead(req.params.id);
      const auction = await getAuctionById(req.params.id);

      if (!auction) {
        return res.status(404).json(makeError('Auction not found', 'AUCTION_NOT_FOUND'));
      }

      // A hidden listing is invisible to everyone but an admin - it must not
      // survive a takedown via its direct link. Reported the same as an
      // unknown id so a probe cannot tell "hidden" from "never existed".
      const isAdmin = await isBearerTokenAdmin(supabase, req.headers.authorization);
      if (!isAuctionVisible(auction, isAdmin)) {
        return res.status(404).json(makeError('Auction not found', 'AUCTION_NOT_FOUND'));
      }

      res.json({ auction });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Failed to load the auction.', 'FETCH_AUCTION_FAILED', error));
    }
  });

  app.patch('/api/auctions/:id', async (req, res) => {
    try {
      const auctionId = req.params.id;

      const auth = await authenticateRequest(req, 'Authentication required to edit a listing.');
      if (auth.error) {
        return res.status(auth.status).json(auth.error);
      }

      const { data: row, error: fetchError } = await supabase
        .from('auctions')
        .select('*')
        .eq('id', auctionId)
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      if (!row) {
        return res.status(404).json(makeError('Auction not found', 'AUCTION_NOT_FOUND'));
      }

      if ((row.seller_id ?? row.sellerId) !== auth.user!.id) {
        return res.status(403).json(makeError('Only the seller can edit this listing.', 'NOT_LISTING_OWNER'));
      }

      if (row.status !== AUCTION_STATUS.active) {
        return res
          .status(409)
          .json(makeError('This listing is no longer active and can no longer be edited.', 'LISTING_NOT_EDITABLE'));
      }

      // Once money is on the table the terms are frozen - a seller must not be
      // able to move the price out from under a standing bid.
      if (parseJsonArray<Bid>(row.bids).length > 0) {
        return res
          .status(409)
          .json(
            makeError(
              'This listing already has bids and can no longer be edited. You can cancel it instead.',
              'LISTING_HAS_BIDS',
            ),
          );
      }

      // Same validator as listing creation, run over row + patch merged.
      const validated = validateAuctionInput(mergeAuctionEdit(row, req.body));
      if ('error' in validated) {
        return res.status(400).json(validated);
      }

      const patch = {
        title: validated.title,
        description: validated.description,
        phone_number: validated.phoneNumber,
        category: validated.category,
        image_url: validated.imageUrls[0],
        image_urls: validated.imageUrls,
        starting_price: validated.parsedPrice,
        // No bids exist, so current_price tracks starting_price exactly.
        current_price: validated.parsedPrice,
      };

      // Optimistic lock: a bid landing between the read above and this write
      // sets highest_bidder_id, so guarding on it still being NULL means the
      // edit matches zero rows rather than overwriting a live auction.
      const { data: updated, error: updateError } = await supabase
        .from('auctions')
        .update(patch)
        .eq('id', auctionId)
        .eq('status', AUCTION_STATUS.active)
        .is('highest_bidder_id', null)
        .select();

      if (updateError) {
        throw updateError;
      }

      if (!Array.isArray(updated) || updated.length === 0) {
        return res
          .status(409)
          .json(
            makeError(
              'This listing already has bids and can no longer be edited. You can cancel it instead.',
              'LISTING_HAS_BIDS',
            ),
          );
      }

      const updatedAuction = sanitizeAuction(updated[0]);

      io.emit('auction_list_updated', {
        type: 'updated',
        auction: updatedAuction,
      });

      res.json({ auction: updatedAuction });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Failed to update the listing.', 'UPDATE_LISTING_FAILED', error));
    }
  });

  app.delete('/api/auctions/:id', async (req, res) => {
    try {
      const auctionId = req.params.id;

      const auth = await authenticateRequest(req, 'Authentication required to cancel a listing.');
      if (auth.error) {
        return res.status(auth.status).json(auth.error);
      }

      const { data: row, error: fetchError } = await supabase
        .from('auctions')
        .select('*')
        .eq('id', auctionId)
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      if (!row) {
        return res.status(404).json(makeError('Auction not found', 'AUCTION_NOT_FOUND'));
      }

      if ((row.seller_id ?? row.sellerId) !== auth.user!.id) {
        return res.status(403).json(makeError('Only the seller can cancel this listing.', 'NOT_LISTING_OWNER'));
      }

      if (row.status === AUCTION_STATUS.ended) {
        return res
          .status(409)
          .json(makeError('This listing has already ended and can no longer be cancelled.', 'LISTING_NOT_EDITABLE'));
      }

      const hadBids = parseJsonArray<Bid>(row.bids).length > 0;

      // SOFT delete, always. The bids array is the only record a bidder has of
      // what they offered and when - hard-deleting the row destroys their
      // history along with the seller's listing.
      if (row.status === AUCTION_STATUS.active) {
        const { error: updateError } = await supabase
          .from('auctions')
          .update({ status: AUCTION_STATUS.cancelled })
          .eq('id', auctionId)
          .eq('status', AUCTION_STATUS.active);

        if (updateError) {
          throw updateError;
        }
      }

      const cancelledAuction = sanitizeAuction({ ...row, status: AUCTION_STATUS.cancelled });

      io.emit('auction_list_updated', {
        type: 'cancelled',
        auction: cancelledAuction,
      });

      res.json({
        success: true,
        auction: cancelledAuction,
        hadBids,
        bidsPreserved: true,
        message: hadBids
          ? 'Listing withdrawn. It no longer appears in the auction list, but everyone who bid can still open it and see their bid history.'
          : 'Listing withdrawn. It no longer appears in the auction list, but anyone holding a direct link can still open it.',
      });
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Failed to cancel the listing.', 'CANCEL_LISTING_FAILED', error));
    }
  });

  app.post('/api/auctions', async (req, res) => {
    try {
      // Routed through authenticateRequest so a banned account is refused here
      // by the same check that guards every other authenticated route.
      const auth = await authenticateRequest(req, 'Authentication required to create a listing.');
      if (auth.error) {
        return res.status(auth.status).json(auth.error);
      }

      const user = auth.user!;

      const validated = validateAuctionInput(req.body);
      if ('error' in validated) {
        return res.status(400).json(validated);
      }

      const maxListingsPerUser = Number(process.env.MAX_LISTINGS_PER_USER ?? '20');
      // Counts ACTIVE listings only. Counting every row the user had ever
      // created meant 20 successful sales locked the account out of the site
      // permanently. `head: true` also stops this pulling every base64 image
      // the seller owns just to produce a number.
      const { count, error: countError } = await supabase
        .from('auctions')
        .select('id', { count: 'exact', head: true })
        .eq('seller_id', user.id)
        .eq('status', AUCTION_STATUS.active);

      if (countError) {
        throw countError;
      }

      if ((count ?? 0) >= maxListingsPerUser) {
        return res.status(429).json(makeError(`You have reached the limit of ${maxListingsPerUser} active listings. End or cancel a listing before creating another.`, 'LISTING_LIMIT_REACHED'));
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
      res.status(500).json(getErrorMessageAndCode('Failed to create the auction.', 'CREATE_AUCTION_FAILED', error));
    }
  });

  // Mirrors the `place_bid` Socket.io handler above so bidding works over the
  // REST API in local dev, matching the Cloudflare Worker's contract.
  app.post('/api/auctions/:id/bids', async (req, res) => {
    try {
      const auctionId = req.params.id;

      // The bidder is whoever holds the token. Any userId/userName in the
      // request body is ignored outright - trusting it let anyone bid as
      // anyone and spoof past the own-listing check below.
      const auth = await authenticateRequest(req, 'Authentication required to place a bid.');
      if (auth.error) {
        return res.status(auth.status).json(auth.error);
      }

      const userId = auth.user.id;
      const userName = auth.user.name;
      const { amount } = req.body;

      // Optimistic lock: the UPDATE is guarded on the bid_version we read, so a
      // bid that lands between our read and our write makes the write match
      // zero rows instead of silently clobbering its bids array. See
      // readBidLock/applyBidLock in workers/shared.ts for why the guard is an
      // integer version rather than the price it used to be.
      for (let attempt = 0; attempt < MAX_BID_ATTEMPTS; attempt += 1) {
        const { data: rawAuction, error: fetchErr } = await supabase
          .from('auctions')
          .select('*')
          .eq('id', auctionId)
          .maybeSingle();

        if (fetchErr || !rawAuction) {
          return res.status(404).json(makeError('Auction listing was not found.', 'AUCTION_NOT_FOUND'));
        }

        const auction = sanitizeAuction(rawAuction);

        const lock = readBidLock(rawAuction, auction.startingPrice);
        const currentPrice = lock.currentPrice;

        if (auction.status === 'ended' || Date.now() >= auction.endTime) {
          return res.status(400).json(makeError('This auction has already ended.', 'AUCTION_ENDED'));
        }

        if (auction.sellerId === userId) {
          return res.status(400).json(makeError('You cannot place a bid on your own listing.', 'CANNOT_BID_OWN_LISTING'));
        }

        const numericAmount = Number(amount);
        if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
          return res.status(400).json(makeError('Please enter a valid bid amount.', 'INVALID_BID_AMOUNT'));
        }

        if (auction.bids.length === 0) {
          if (numericAmount < auction.startingPrice) {
            return res.status(400).json(makeError(`Starting bid must be at least £${auction.startingPrice.toLocaleString()}.`, 'BID_TOO_LOW'));
          }
        } else if (numericAmount <= currentPrice) {
          return res.status(400).json(makeError(`Bid must be strictly higher than current bid of £${currentPrice.toLocaleString()}.`, 'BID_TOO_LOW'));
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

        let updateQuery = supabase
          .from('auctions')
          .update({
            bids: updatedBids,
            current_price: numericAmount,
            highest_bidder_id: userId,
            highest_bidder_name: userName,
            ...bidLockUpdate(lock),
          })
          .eq('id', auctionId);

        updateQuery = applyBidLock(updateQuery, lock);

        const { data: updatedRows, error } = await updateQuery.select();

        if (error) {
          return res.status(500).json(getErrorMessageAndCode('Unable to place the bid right now.', 'BID_UPDATE_FAILED', error));
        }

        // Zero rows affected: someone else bid first. Re-read and revalidate.
        if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
          continue;
        }

        const updatedAuction = sanitizeAuction(updatedRows[0]);

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

        return res.json({ success: true, bid: newBid });
      }

      res.status(409).json(makeError('Another bid landed at the same moment. Please try again.', 'BID_CONFLICT'));
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Failed to place the bid.', 'PLACE_BID_FAILED', error));
    }
  });

  app.get('/api/users/me/activity', async (req, res) => {
    try {
      const auth = await authenticateRequest(req, 'Authentication required.');
      if (auth.error) {
        return res.status(auth.status).json(auth.error);
      }

      await settleBeforeRead();

      const { data, error } = await supabase.from('auctions').select(AUCTION_LIST_COLUMNS);
      if (error) throw error;

      const auctions = (data ?? []).map((row: any) => mapAuctionSummaryRow(row));
      res.json(selectActivity(auctions, auth.user.id));
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Failed to load your activity.', 'FETCH_ACTIVITY_FAILED', error));
    }
  });

  app.get('/api/notifications', async (req, res) => {
    try {
      const auth = await authenticateRequest(req, 'Authentication required.');
      if (auth.error) {
        return res.status(auth.status).json(auth.error);
      }

      await settleBeforeRead();

      const { data, error } = await supabase.from('auctions').select(NOTIFICATION_COLUMNS);
      if (error) throw error;

      const auctions = (data ?? []).map((row: any) => sanitizeAuction(row));
      res.json(buildNotifications(auctions, auth.user.id));
    } catch (error) {
      res.status(500).json(getErrorMessageAndCode('Failed to load notifications.', 'FETCH_NOTIFICATIONS_FAILED', error));
    }
  });

  // Mirrors `renderAuctionShare` in workers/index.ts: serve the SPA shell for
  // /auction/:id with that auction's Open Graph tags baked in, so a shared link
  // previews as the listing instead of as the generic site. Registered before
  // the Vite / static middleware so it wins the route. Any failure falls
  // through to the normal shell via next().
  let viteServer: Awaited<ReturnType<typeof createViteServer>> | null = null;

  app.get('/auction/:id', async (req, res, next) => {
    try {
      const { data: row, error } = await supabase
        .from('auctions')
        .select(AUCTION_META_COLUMNS)
        .eq('id', req.params.id)
        .maybeSingle();

      // A hidden listing gets the default shell, same as an unknown id: the
      // whole point of a takedown is that its title and description must
      // never land in HTML a crawler can cache.
      if (error || !row || !isAuctionVisible(row, false)) {
        return next();
      }

      const shellPath =
        process.env.NODE_ENV === 'production'
          ? path.join(process.cwd(), 'dist', 'index.html')
          : path.join(process.cwd(), 'index.html');

      let html = await fs.readFile(shellPath, 'utf-8');
      if (viteServer) {
        // Without this the dev shell is missing Vite's client and HMR wiring.
        html = await viteServer.transformIndexHtml(req.originalUrl, html);
      }

      const meta = buildAuctionMetaTags(row, `${req.protocol}://${req.get('host')}/auction/${encodeURIComponent(req.params.id)}`);

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(injectAuctionMeta(html, meta));
    } catch (metaError) {
      console.error('OG injection failed:', metaError);
      next();
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    viteServer = vite;
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
