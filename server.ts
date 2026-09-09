import express from 'express';
import http from 'http';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import { createServer as createViteServer } from 'vite';

// --- Types & Interfaces ---
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
  bids: Bid[];
  winnerId?: string | null;
  winnerName?: string | null;
  winningBid?: number | null;
  createdAt: number;
}

// --- In-Memory Database Storage ---
// Stores active user sessions, auction listings, and live bid histories.
const users: Map<string, User> = new Map();
const tokens: Map<string, string> = new Map(); // token -> userId
const auctions: Map<string, AuctionItem> = new Map();

// Helper to seed demo users
function seedUsers() {
  const demoUsers = [
    { id: 'usr_demo_1', username: 'alex_r', name: 'Alex Rivera', password: 'password123' },
    { id: 'usr_demo_2', username: 'sarah_m', name: 'Sarah Miller', password: 'password123' },
    { id: 'usr_demo_3', username: 'david_k', name: 'David Kim', password: 'password123' },
    { id: 'usr_demo_4', username: 'elena_v', name: 'Elena Vance', password: 'password123' },
  ];

  for (const u of demoUsers) {
    const token = `tok_${u.id}_${Date.now()}`;
    const user: User = {
      id: u.id,
      name: u.name,
      username: u.username,
      passwordHash: u.password,
      token,
      createdAt: Date.now(),
    };
    users.set(u.id, user);
    tokens.set(token, u.id);
  }
}

// Helper to seed initial realistic auction items
function seedAuctions() {
  const now = Date.now();

  const demoItems: Partial<AuctionItem>[] = [
    {
      id: 'auc_1',
      title: 'Vintage Leica M3 Rangefinder Camera (1956)',
      description: 'Single stroke original chrome finish in pristine cosmetic condition. Fully tested shutter speeds, clear rangefinder patch, and original leather case included. Collector grade.',
      phoneNumber: '+1 (555) 234-8901',
      startingPrice: 850,
      currentPrice: 1250,
      sellerId: 'usr_demo_1',
      sellerName: 'Alex Rivera',
      highestBidderId: 'usr_demo_2',
      highestBidderName: 'Sarah Miller',
      durationMinutes: 15,
      startTime: now - 5 * 60 * 1000,
      endTime: now + 10 * 60 * 1000, // 10 mins remaining
      status: 'active',
      category: 'Photography',
      imageUrl: 'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=800&q=80',
      bids: [
        { id: 'bid_1_1', auctionId: 'auc_1', userId: 'usr_demo_3', userName: 'David Kim', amount: 950, timestamp: now - 4 * 60 * 1000 },
        { id: 'bid_1_2', auctionId: 'auc_1', userId: 'usr_demo_4', userName: 'Elena Vance', amount: 1100, timestamp: now - 3 * 60 * 1000 },
        { id: 'bid_1_3', auctionId: 'auc_1', userId: 'usr_demo_2', userName: 'Sarah Miller', amount: 1250, timestamp: now - 1 * 60 * 1000 },
      ],
      createdAt: now - 5 * 60 * 1000,
    },
    {
      id: 'auc_2',
      title: 'Apple MacBook Pro 16" M3 Max (36GB / 1TB SSD)',
      description: 'Space Black edition with 16-core CPU and 40-core GPU. Battery health is at 99%, only 14 cycles. Comes in original factory packaging with 140W MagSafe 3 power adapter.',
      phoneNumber: '+1 (555) 789-4321',
      startingPrice: 1800,
      currentPrice: 2450,
      sellerId: 'usr_demo_3',
      sellerName: 'David Kim',
      highestBidderId: 'usr_demo_1',
      highestBidderName: 'Alex Rivera',
      durationMinutes: 45,
      startTime: now - 15 * 60 * 1000,
      endTime: now + 30 * 60 * 1000, // 30 mins remaining
      status: 'active',
      category: 'Electronics',
      imageUrl: 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=800&q=80',
      bids: [
        { id: 'bid_2_1', auctionId: 'auc_2', userId: 'usr_demo_4', userName: 'Elena Vance', amount: 2000, timestamp: now - 12 * 60 * 1000 },
        { id: 'bid_2_2', auctionId: 'auc_2', userId: 'usr_demo_2', userName: 'Sarah Miller', amount: 2200, timestamp: now - 8 * 60 * 1000 },
        { id: 'bid_2_3', auctionId: 'auc_2', userId: 'usr_demo_1', userName: 'Alex Rivera', amount: 2450, timestamp: now - 2 * 60 * 1000 },
      ],
      createdAt: now - 15 * 60 * 1000,
    },
    {
      id: 'auc_3',
      title: 'Gibson Custom 1959 Les Paul Standard Reissue',
      description: 'Custom Shop Historic Select in Washed Cherry VOS. Solid lightweight mahogany body, hand-picked flame maple top, and CustomBucker Alnico III pickups. Hardcase & COA included.',
      phoneNumber: '+1 (555) 456-1122',
      startingPrice: 2400,
      currentPrice: 3200,
      sellerId: 'usr_demo_2',
      sellerName: 'Sarah Miller',
      highestBidderId: 'usr_demo_4',
      highestBidderName: 'Elena Vance',
      durationMinutes: 120,
      startTime: now - 30 * 60 * 1000,
      endTime: now + 90 * 60 * 1000, // 90 mins remaining
      status: 'active',
      category: 'Instruments',
      imageUrl: 'https://images.unsplash.com/photo-1550291652-6ea9114a47b1?auto=format&fit=crop&w=800&q=80',
      bids: [
        { id: 'bid_3_1', auctionId: 'auc_3', userId: 'usr_demo_1', userName: 'Alex Rivera', amount: 2700, timestamp: now - 20 * 60 * 1000 },
        { id: 'bid_3_2', auctionId: 'auc_3', userId: 'usr_demo_4', userName: 'Elena Vance', amount: 3200, timestamp: now - 10 * 60 * 1000 },
      ],
      createdAt: now - 30 * 60 * 1000,
    },
    {
      id: 'auc_4',
      title: 'Rolex Submariner Date 41mm (Ref. 126610LN)',
      description: 'Oystersteel with black Cerachrom ceramic bezel and black dial. Complete collector set with green box, warranty card dated late 2023, white tag, and manuals. Unpolished.',
      phoneNumber: '+1 (555) 998-3344',
      startingPrice: 6500,
      currentPrice: 8900,
      sellerId: 'usr_demo_4',
      sellerName: 'Elena Vance',
      highestBidderId: 'usr_demo_3',
      highestBidderName: 'David Kim',
      durationMinutes: 6,
      startTime: now - 4 * 60 * 1000,
      endTime: now + 2 * 60 * 1000, // Ending very soon (2 mins)
      status: 'active',
      category: 'Luxury Watches',
      imageUrl: 'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?auto=format&fit=crop&w=800&q=80',
      bids: [
        { id: 'bid_4_1', auctionId: 'auc_4', userId: 'usr_demo_2', userName: 'Sarah Miller', amount: 7200, timestamp: now - 3 * 60 * 1000 },
        { id: 'bid_4_2', auctionId: 'auc_4', userId: 'usr_demo_3', userName: 'David Kim', amount: 8900, timestamp: now - 1 * 60 * 1000 },
      ],
      createdAt: now - 4 * 60 * 1000,
    },
    {
      id: 'auc_5',
      title: 'Sony FX3 Cinema Line Full-Frame Camera Kit',
      description: 'Features 4K 120p recording, 15+ stops dynamic range, S-Cinetone, XLR top audio handle unit, 2x Sony Tough 160GB CFexpress Type A cards, and 3x NP-FZ100 batteries.',
      phoneNumber: '+1 (555) 345-6789',
      startingPrice: 1500,
      currentPrice: 1500,
      sellerId: 'usr_demo_1',
      sellerName: 'Alex Rivera',
      highestBidderId: null,
      highestBidderName: null,
      durationMinutes: 60,
      startTime: now - 2 * 60 * 1000,
      endTime: now + 58 * 60 * 1000,
      status: 'active',
      category: 'Photography',
      imageUrl: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=800&q=80',
      bids: [],
      createdAt: now - 2 * 60 * 1000,
    },
    {
      id: 'auc_6',
      title: 'Herman Miller Eames Lounge Chair & Ottoman',
      description: 'Authentic Palisander santos rosewood veneer with premium black MCL leather. Manufactured in Michigan, certified authentic with embossed medal badge on underside.',
      phoneNumber: '+1 (555) 654-3210',
      startingPrice: 3200,
      currentPrice: 4850,
      sellerId: 'usr_demo_2',
      sellerName: 'Sarah Miller',
      highestBidderId: 'usr_demo_1',
      highestBidderName: 'Alex Rivera',
      durationMinutes: 60,
      startTime: now - 70 * 60 * 1000,
      endTime: now - 10 * 60 * 1000, // Completed auction example
      status: 'ended',
      winnerId: 'usr_demo_1',
      winnerName: 'Alex Rivera',
      winningBid: 4850,
      category: 'Furniture & Design',
      imageUrl: 'https://images.unsplash.com/photo-1580481077195-c3a821a58875?auto=format&fit=crop&w=800&q=80',
      bids: [
        { id: 'bid_6_1', auctionId: 'auc_6', userId: 'usr_demo_4', userName: 'Elena Vance', amount: 3700, timestamp: now - 50 * 60 * 1000 },
        { id: 'bid_6_2', auctionId: 'auc_6', userId: 'usr_demo_3', userName: 'David Kim', amount: 4300, timestamp: now - 35 * 60 * 1000 },
        { id: 'bid_6_3', auctionId: 'auc_6', userId: 'usr_demo_1', userName: 'Alex Rivera', amount: 4850, timestamp: now - 15 * 60 * 1000 },
      ],
      createdAt: now - 70 * 60 * 1000,
    },
  ];

  for (const item of demoItems) {
    auctions.set(item.id!, item as AuctionItem);
  }
}

seedUsers();
seedAuctions();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware
  app.use(express.json());

  // Create HTTP server & Socket.io server
  const server = http.createServer(app);
  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // --- Background Countdown & Auction Expiration Checker ---
  // Runs every 1000ms to check if any active auction has expired.
  // When an auction ends, marks it as ended, declares the winner, and emits real-time events.
  setInterval(() => {
    const now = Date.now();
    for (const auction of auctions.values()) {
      if (auction.status === 'active' && now >= auction.endTime) {
        auction.status = 'ended';
        if (auction.highestBidderId) {
          auction.winnerId = auction.highestBidderId;
          auction.winnerName = auction.highestBidderName;
          auction.winningBid = auction.currentPrice;
        } else {
          auction.winnerId = null;
          auction.winnerName = null;
          auction.winningBid = null;
        }

        // Notify all clients in the auction room
        io.to(`auction:${auction.id}`).emit('auction_ended', {
          auctionId: auction.id,
          winnerId: auction.winnerId,
          winnerName: auction.winnerName,
          winningBid: auction.winningBid,
          auction,
        });

        // Broadcast general update so dashboard listing cards reflect the ended state
        io.emit('auction_list_updated', {
          type: 'ended',
          auction,
        });
      }
    }
  }, 1000);

  // --- Real-Time Socket.io Event Handling ---
  io.on('connection', (socket) => {
    // 1. Client joins a specific auction listing room
    socket.on('join_auction', ({ auctionId }) => {
      if (!auctionId) return;
      const room = `auction:${auctionId}`;
      socket.join(room);

      const auction = auctions.get(auctionId);
      if (auction) {
        // Send current auction snapshot directly to this socket
        socket.emit('auction_snapshot', auction);
      }
    });

    // 2. Client leaves an auction room
    socket.on('leave_auction', ({ auctionId }) => {
      if (!auctionId) return;
      socket.leave(`auction:${auctionId}`);
    });

    // 3. User places a bid
    socket.on('place_bid', ({ auctionId, userId, userName, amount }: { auctionId: string; userId: string; userName: string; amount: number }) => {
      const auction = auctions.get(auctionId);

      // Validation 1: Auction exists
      if (!auction) {
        return socket.emit('bid_error', { message: 'Auction listing was not found.' });
      }

      // Validation 2: Auction is active
      if (auction.status === 'ended' || Date.now() >= auction.endTime) {
        auction.status = 'ended';
        return socket.emit('bid_error', { message: 'This auction has already ended.' });
      }

      // Validation 3: Prevent users from bidding on their own listings
      if (auction.sellerId === userId) {
        return socket.emit('bid_error', { message: 'You cannot place a bid on your own listing.' });
      }

      // Validation 4: Bid amount must be greater than current highest bid (or starting price if no bids)
      const minRequired = auction.bids.length === 0 ? auction.startingPrice : auction.currentPrice;
      const numericAmount = Number(amount);

      if (isNaN(numericAmount) || numericAmount <= 0) {
        return socket.emit('bid_error', { message: 'Please enter a valid bid amount.' });
      }

      // If no bids placed yet, bid must be >= startingPrice; if bids exist, strictly > currentPrice
      if (auction.bids.length === 0) {
        if (numericAmount < auction.startingPrice) {
          return socket.emit('bid_error', {
            message: `Starting bid must be at least $${auction.startingPrice.toLocaleString()}.`,
          });
        }
      } else {
        if (numericAmount <= auction.currentPrice) {
          return socket.emit('bid_error', {
            message: `Bid must be strictly higher than current bid of $${auction.currentPrice.toLocaleString()}.`,
          });
        }
      }

      // Record new bid
      const newBid: Bid = {
        id: `bid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        auctionId,
        userId,
        userName,
        amount: numericAmount,
        timestamp: Date.now(),
      };

      auction.bids.unshift(newBid); // Most recent bid first
      auction.currentPrice = numericAmount;
      auction.highestBidderId = userId;
      auction.highestBidderName = userName;

      // Real-Time Broadcast to all clients viewing this specific auction room
      io.to(`auction:${auctionId}`).emit('bid_updated', {
        auctionId,
        currentPrice: auction.currentPrice,
        highestBidderId: auction.highestBidderId,
        highestBidderName: auction.highestBidderName,
        bid: newBid,
        auction,
      });

      // Broadcast update to all dashboard listing cards
      io.emit('auction_list_updated', {
        type: 'bid',
        auction,
      });
    });

    socket.on('disconnect', () => {
      // Clean disconnect
    });
  });

  // --- REST API Endpoints ---

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', serverTime: Date.now(), activeAuctions: auctions.size });
  });

  // Auth: Register
  app.post('/api/auth/register', (req, res) => {
    const { username, name, password } = req.body;
    if (!username || !name || !password) {
      return res.status(400).json({ error: 'Username, name, and password are required.' });
    }

    const trimmedUsername = username.trim().toLowerCase();
    for (const u of users.values()) {
      if (u.username.toLowerCase() === trimmedUsername) {
        return res.status(409).json({ error: 'Username is already taken. Please choose another.' });
      }
    }

    const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const token = `tok_${id}_${Date.now()}`;
    const newUser: User = {
      id,
      name: name.trim(),
      username: trimmedUsername,
      passwordHash: password,
      token,
      createdAt: Date.now(),
    };

    users.set(id, newUser);
    tokens.set(token, id);

    res.status(201).json({
      user: {
        id: newUser.id,
        name: newUser.name,
        username: newUser.username,
        token: newUser.token,
      },
    });
  });

  // Auth: Login
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const trimmedUsername = username.trim().toLowerCase();
    let foundUser: User | null = null;

    for (const u of users.values()) {
      if (u.username.toLowerCase() === trimmedUsername) {
        foundUser = u;
        break;
      }
    }

    if (!foundUser || foundUser.passwordHash !== password) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = `tok_${foundUser.id}_${Date.now()}`;
    foundUser.token = token;
    tokens.set(token, foundUser.id);

    res.json({
      user: {
        id: foundUser.id,
        name: foundUser.name,
        username: foundUser.username,
        token: foundUser.token,
      },
    });
  });

  // Auth: Verify current session
  app.get('/api/auth/me', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    const userId = tokens.get(token);
    if (!userId || !users.has(userId)) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }

    const user = users.get(userId)!;
    res.json({
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        token,
      },
    });
  });

  // Get Demo Users (for instant 1-click test login)
  app.get('/api/auth/demo-users', (req, res) => {
    const list = Array.from(users.values()).slice(0, 4).map((u) => ({
      id: u.id,
      name: u.name,
      username: u.username,
      password: u.passwordHash,
    }));
    res.json({ demoUsers: list });
  });

  // Auctions: List all
  app.get('/api/auctions', (req, res) => {
    const list = Array.from(auctions.values()).sort((a, b) => {
      // Active first, then by closest end time
      if (a.status === 'active' && b.status === 'ended') return -1;
      if (a.status === 'ended' && b.status === 'active') return 1;
      return a.endTime - b.endTime;
    });
    res.json({ auctions: list });
  });

  // Auctions: Get single by ID
  app.get('/api/auctions/:id', (req, res) => {
    const auction = auctions.get(req.params.id);
    if (!auction) {
      return res.status(404).json({ error: 'Auction not found' });
    }
    res.json({ auction });
  });

  // Auctions: Create new listing
  app.post('/api/auctions', (req, res) => {
    const { title, description, phoneNumber, startingPrice, durationMinutes, sellerId, sellerName, imageUrl, category } = req.body;

    if (!title || !description || !phoneNumber || startingPrice === undefined || !durationMinutes) {
      return res.status(400).json({ error: 'All listing fields are required.' });
    }

    const parsedPrice = parseFloat(startingPrice);
    if (isNaN(parsedPrice) || parsedPrice <= 0) {
      return res.status(400).json({ error: 'Starting price must be greater than $0.' });
    }

    const parsedDuration = parseInt(durationMinutes, 10);
    if (isNaN(parsedDuration) || parsedDuration <= 0) {
      return res.status(400).json({ error: 'Auction duration must be at least 1 minute.' });
    }

    const now = Date.now();
    const durationMs = parsedDuration * 60 * 1000;
    const id = `auc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    // Fallback image if none provided
    const defaultImages = [
      'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=800&q=80',
      'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80',
      'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=800&q=80',
      'https://images.unsplash.com/photo-1546868871-7041f2a55e12?auto=format&fit=crop&w=800&q=80',
      'https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=800&q=80',
    ];
    const finalImage = imageUrl && imageUrl.trim().length > 5
      ? imageUrl.trim()
      : defaultImages[Math.floor(Math.random() * defaultImages.length)];

    const newAuction: AuctionItem = {
      id,
      title: title.trim(),
      description: description.trim(),
      phoneNumber: phoneNumber.trim(),
      startingPrice: parsedPrice,
      currentPrice: parsedPrice,
      sellerId: sellerId || 'usr_anonymous',
      sellerName: sellerName || 'Auction Seller',
      highestBidderId: null,
      highestBidderName: null,
      durationMinutes: parsedDuration,
      startTime: now,
      endTime: now + durationMs,
      status: 'active',
      category: category || 'General',
      imageUrl: finalImage,
      bids: [],
      winnerId: null,
      winnerName: null,
      winningBid: null,
      createdAt: now,
    };

    auctions.set(id, newAuction);

    // Broadcast new listing to all clients
    io.emit('auction_list_updated', {
      type: 'created',
      auction: newAuction,
    });

    res.status(201).json({ auction: newAuction });
  });

  // --- Vite Dev & Production Static Middleware ---
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

  // Bind to port 3000 and 0.0.0.0
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[MSA Auction] Full-Stack server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
