import express from 'express';
import http from 'http';
import path from 'path';
import Database from 'better-sqlite3';
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

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'auction.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? []);
}

function sanitizeUser(row: any): User {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    passwordHash: row.passwordHash,
    token: row.token,
    createdAt: row.createdAt,
  };
}

function sanitizeAuction(row: any): AuctionItem {
  const imageUrls = parseJsonArray<string>(row.imageUrls);

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
    bids: parseJsonArray<Bid>(row.bids),
    winnerId: row.winnerId ?? null,
    winnerName: row.winnerName ?? null,
    winningBid: row.winningBid ?? null,
    createdAt: Number(row.createdAt),
  };
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      token TEXT,
      createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auctions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      phoneNumber TEXT NOT NULL,
      startingPrice REAL NOT NULL,
      currentPrice REAL NOT NULL,
      sellerId TEXT NOT NULL,
      sellerName TEXT NOT NULL,
      highestBidderId TEXT,
      highestBidderName TEXT,
      durationMinutes INTEGER NOT NULL,
      startTime INTEGER NOT NULL,
      endTime INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      category TEXT,
      imageUrl TEXT,
      imageUrls TEXT NOT NULL DEFAULT '[]',
      bids TEXT NOT NULL DEFAULT '[]',
      winnerId TEXT,
      winnerName TEXT,
      winningBid REAL,
      createdAt INTEGER NOT NULL
    );
  `);
}

createTables();

function getAuthenticatedUser(token: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE token = ?').get(token);
  return row ? sanitizeUser(row) : null;
}

function getAuctionById(id: string): AuctionItem | null {
  const row = db.prepare('SELECT * FROM auctions WHERE id = ?').get(id);
  return row ? sanitizeAuction(row) : null;
}

function getAuctions(): AuctionItem[] {
  const rows = db.prepare('SELECT * FROM auctions ORDER BY CASE WHEN status = "active" THEN 0 ELSE 1 END, endTime ASC').all();
  return rows.map((row: any) => sanitizeAuction(row));
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
    const now = Date.now();
    const rows = db.prepare('SELECT * FROM auctions WHERE status = ?').all('active');

    for (const row of rows) {
      const auction = sanitizeAuction(row);

      if (auction.endTime <= now) {
        const winnerId = auction.highestBidderId ?? null;
        const winnerName = auction.highestBidderName ?? null;
        const winningBid = auction.highestBidderId ? auction.currentPrice : null;

        db.prepare(`
          UPDATE auctions
          SET status = ?, winnerId = ?, winnerName = ?, winningBid = ?
          WHERE id = ?
        `).run('ended', winnerId, winnerName, winningBid, auction.id);

        const updatedAuction = getAuctionById(auction.id)!;

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
    }
  }, 1000);

  io.on('connection', (socket) => {
    socket.on('join_auction', ({ auctionId }: { auctionId: string }) => {
      if (!auctionId) return;

      socket.join(`auction:${auctionId}`);
      const auction = getAuctionById(auctionId);
      if (auction) {
        socket.emit('auction_snapshot', auction);
      }
    });

    socket.on('leave_auction', ({ auctionId }: { auctionId: string }) => {
      if (!auctionId) return;
      socket.leave(`auction:${auctionId}`);
    });

    socket.on('place_bid', ({ auctionId, userId, userName, amount }: { auctionId: string; userId: string; userName: string; amount: number }) => {
      const auction = getAuctionById(auctionId);

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

      const minRequired = auction.bids.length === 0 ? auction.startingPrice : auction.currentPrice;
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

      db.prepare(`
        UPDATE auctions
        SET bids = ?, currentPrice = ?, highestBidderId = ?, highestBidderName = ?
        WHERE id = ?
      `).run(stringifyJson(updatedBids), numericAmount, userId, userName, auctionId);

      const updatedAuction = getAuctionById(auctionId)!;

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
    });
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', serverTime: Date.now(), activeAuctions: getAuctions().length });
  });

  app.post('/api/auth/register', (req, res) => {
    const { username, name, password } = req.body;

    if (!username || !name || !password) {
      return res.status(400).json({ error: 'Username, name, and password are required.' });
    }

    const trimmedUsername = String(username).trim().toLowerCase();
    const trimmedName = String(name).trim();

    if (!trimmedUsername || !trimmedName || !String(password).trim()) {
      return res.status(400).json({ error: 'Username, name, and password are required.' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = ?').get(trimmedUsername);
    if (existing) {
      return res.status(409).json({ error: 'Username is already taken. Please choose another.' });
    }

    const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const token = `tok_${id}_${Date.now()}`;

    db.prepare(`
      INSERT INTO users (id, name, username, passwordHash, token, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, trimmedName, trimmedUsername, String(password), token, Date.now());

    res.status(201).json({
      user: {
        id,
        name: trimmedName,
        username: trimmedUsername,
        token,
      },
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const trimmedUsername = String(username).trim().toLowerCase();
    const storedUser = db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(trimmedUsername);

    if (!storedUser || storedUser.passwordHash !== String(password)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = `tok_${storedUser.id}_${Date.now()}`;
    db.prepare('UPDATE users SET token = ? WHERE id = ?').run(token, storedUser.id);

    res.json({
      user: {
        id: storedUser.id,
        name: storedUser.name,
        username: storedUser.username,
        token,
      },
    });
  });

  app.get('/api/auth/me', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    const user = getAuthenticatedUser(token);

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
  });

  app.get('/api/auctions', (req, res) => {
    const list = getAuctions();
    res.json({ auctions: list });
  });

  app.get('/api/auctions/:id', (req, res) => {
    const auction = getAuctionById(req.params.id);
    if (!auction) {
      return res.status(404).json({ error: 'Auction not found' });
    }

    res.json({ auction });
  });

  app.post('/api/auctions', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required to create a listing.' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    const user = getAuthenticatedUser(token);
    if (!user) {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }

    const validated = validateAuctionInput(req.body);
    if ('error' in validated) {
      return res.status(400).json({ error: validated.error });
    }

    const now = Date.now();
    const id = `auc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

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
      imageUrl: validated.imageUrls[0],
      imageUrls: validated.imageUrls,
      bids: [],
      winnerId: null,
      winnerName: null,
      winningBid: null,
      createdAt: now,
    };

    db.prepare(`
      INSERT INTO auctions (
        id, title, description, phoneNumber, startingPrice, currentPrice,
        sellerId, sellerName, highestBidderId, highestBidderName,
        durationMinutes, startTime, endTime, status, category,
        imageUrl, imageUrls, bids, winnerId, winnerName, winningBid, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
      stringifyJson(auction.imageUrls),
      stringifyJson(auction.bids),
      auction.winnerId,
      auction.winnerName,
      auction.winningBid,
      auction.createdAt,
    );

    io.emit('auction_list_updated', {
      type: 'created',
      auction,
    });

    res.status(201).json({ auction });
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
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[MSA Auction] Full-Stack server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
