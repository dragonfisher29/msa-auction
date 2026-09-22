import { describe, it, expect, vi } from 'vitest';
import { resolveWinner, settleEndedAuctions, selectActivity, buildNotifications } from '../../workers/shared';
import { createFakeSupabase } from './helpers/fake-supabase';

const NOW = 1_700_000_000_000;

function auctionRow(overrides: Record<string, any> = {}) {
  return {
    id: 'auc_1',
    title: 'Vintage lamp',
    starting_price: 100,
    current_price: 100,
    seller_id: 'usr_seller',
    seller_name: 'Seller',
    highest_bidder_id: null,
    highest_bidder_name: null,
    end_time: NOW - 1000,
    start_time: NOW - 60_000,
    created_at: NOW - 60_000,
    status: 'active',
    bids: [],
    winner_id: null,
    winner_name: null,
    winning_bid: null,
    ...overrides,
  };
}

function bid(userId: string, amount: number, timestamp: number) {
  return { id: `bid_${timestamp}`, auctionId: 'auc_1', userId, userName: userId.toUpperCase(), amount, timestamp };
}

describe('resolveWinner', () => {
  it('picks the highest bid, not the most recent one', () => {
    const row = auctionRow({
      bids: [bid('usr_c', 150, 3), bid('usr_b', 400, 2), bid('usr_a', 120, 1)],
      current_price: 150,
    });

    expect(resolveWinner(row)).toEqual({ winnerId: 'usr_b', winnerName: 'USR_B', winningBid: 400 });
  });

  it('breaks ties in favour of the earlier bid', () => {
    const row = auctionRow({ bids: [bid('usr_late', 200, 50), bid('usr_early', 200, 10)] });

    expect(resolveWinner(row).winnerId).toBe('usr_early');
  });

  it('returns nulls when the auction has no bids', () => {
    expect(resolveWinner(auctionRow({ bids: [] }))).toEqual({
      winnerId: null,
      winnerName: null,
      winningBid: null,
    });
  });

  it('trusts current_price over a bids array damaged by the old race when a highest bidder is on record', () => {
    const row = auctionRow({
      bids: [bid('usr_y', 400, 1)],
      current_price: 500,
      highest_bidder_id: 'usr_x',
      highest_bidder_name: 'USR_X',
    });

    expect(resolveWinner(row)).toEqual({ winnerId: 'usr_x', winnerName: 'USR_X', winningBid: 500 });
  });

  it('falls back to the top bid when current_price is higher but no highest bidder is on record', () => {
    const row = auctionRow({
      bids: [bid('usr_y', 400, 1)],
      current_price: 500,
      highest_bidder_id: null,
    });

    expect(resolveWinner(row)).toEqual({ winnerId: 'usr_y', winnerName: 'USR_Y', winningBid: 400 });
  });

  it('is unaffected on a healthy row where current_price matches the top bid', () => {
    const row = auctionRow({
      bids: [bid('usr_b', 400, 2), bid('usr_a', 120, 1)],
      current_price: 400,
      highest_bidder_id: 'usr_b',
      highest_bidder_name: 'USR_B',
    });

    expect(resolveWinner(row)).toEqual({ winnerId: 'usr_b', winnerName: 'USR_B', winningBid: 400 });
  });
});

describe('settleEndedAuctions', () => {
  it('ends an auction and records the highest bidder as the winner', async () => {
    const db = createFakeSupabase({
      auctions: [auctionRow({ bids: [bid('usr_b', 400, 2), bid('usr_a', 120, 1)], current_price: 400 })],
    });

    const settled = await settleEndedAuctions(db, { now: NOW });

    expect(settled).toHaveLength(1);
    expect(db.rows('auctions')[0]).toMatchObject({
      status: 'ended',
      winner_id: 'usr_b',
      winner_name: 'USR_B',
      winning_bid: 400,
    });
  });

  it('ends an auction with no bids and leaves the winner columns null', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow({ bids: [] })] });

    await settleEndedAuctions(db, { now: NOW });

    expect(db.rows('auctions')[0]).toMatchObject({
      status: 'ended',
      winner_id: null,
      winner_name: null,
      winning_bid: null,
    });
  });

  it('guards the settle UPDATE on status=active so a concurrent settle cannot double-write', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow({ bids: [bid('usr_b', 400, 2)] })] });

    await settleEndedAuctions(db, { now: NOW });

    expect(db.updateFilters('auctions')[0]).toContainEqual({ op: 'eq', column: 'status', value: 'active' });
  });

  it('skips an auction another settler already ended (zero rows affected)', async () => {
    const db = createFakeSupabase(
      { auctions: [auctionRow({ bids: [bid('usr_b', 400, 2)] })] },
      {
        beforeUpdate: ({ table }) => {
          if (table === 'auctions') {
            // Another worker settles the row between our SELECT and our UPDATE.
            db.rows('auctions')[0].status = 'ended';
            db.rows('auctions')[0].winner_id = 'usr_other';
          }
        },
      },
    );

    const settled = await settleEndedAuctions(db, { now: NOW });

    expect(settled).toHaveLength(0);
    expect(db.rows('auctions')[0].winner_id).toBe('usr_other');
  });

  it('leaves auctions that have not reached end_time alone', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow({ end_time: NOW + 60_000 })] });

    const settled = await settleEndedAuctions(db, { now: NOW });

    expect(settled).toHaveLength(0);
    expect(db.rows('auctions')[0].status).toBe('active');
  });

  it('does not let one row\'s failing UPDATE abort the rest of the batch', async () => {
    let updateCalls = 0;
    const db = createFakeSupabase(
      {
        auctions: [
          // Oldest end_time first (see the settle query's own ordering) - this is the row whose
          // UPDATE will be made to fail.
          auctionRow({ id: 'auc_oldest', end_time: NOW - 3000, bids: [bid('usr_a', 200, 1)] }),
          auctionRow({ id: 'auc_newer', end_time: NOW - 1000, bids: [bid('usr_b', 400, 2)] }),
        ],
      },
      {
        errorOn: ({ table, op }) => {
          if (table === 'auctions' && op === 'update') {
            updateCalls += 1;
            if (updateCalls === 1) {
              return new Error('simulated DB failure on the first row');
            }
          }
          return null;
        },
      },
    );

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const settled = await settleEndedAuctions(db, { now: NOW });

    // The failing row was skipped, not thrown - the second, healthy row still settled.
    expect(settled).toHaveLength(1);
    expect(settled[0].id).toBe('auc_newer');

    expect(db.rows('auctions').find((row: any) => row.id === 'auc_oldest')).toMatchObject({ status: 'active' });
    expect(db.rows('auctions').find((row: any) => row.id === 'auc_newer')).toMatchObject({
      status: 'ended',
      winner_id: 'usr_b',
    });

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('auc_oldest'), expect.anything());

    consoleError.mockRestore();
  });
});

const mapped = (overrides: Record<string, any> = {}) => ({
  id: 'auc_1',
  title: 'Vintage lamp',
  sellerId: 'usr_seller',
  status: 'active',
  currentPrice: 100,
  highestBidderId: null,
  endTime: NOW,
  createdAt: NOW,
  bids: [] as any[],
  winnerId: null,
  winningBid: null,
  ...overrides,
});

describe('selectActivity', () => {
  it('splits auctions into listings, bids, and wins for the caller', () => {
    const auctions = [
      mapped({ id: 'a_listing', sellerId: 'me', createdAt: 10 }),
      mapped({ id: 'a_bid', bids: [bid('me', 120, 5)], createdAt: 20 }),
      mapped({ id: 'a_win', status: 'ended', winnerId: 'me', bids: [bid('me', 300, 7)], endTime: 30 }),
      mapped({ id: 'a_other', bids: [bid('usr_x', 120, 5)] }),
    ];

    const activity = selectActivity(auctions, 'me');

    expect(activity.listings.map((a) => a.id)).toEqual(['a_listing']);
    expect(activity.bids.map((a) => a.id)).toEqual(['a_win', 'a_bid']);
    expect(activity.wins.map((a) => a.id)).toEqual(['a_win']);
  });
});

describe('buildNotifications', () => {
  it('derives outbid, won, lost, and sold events with stable ids', () => {
    const auctions = [
      mapped({
        id: 'a_outbid',
        status: 'active',
        highestBidderId: 'usr_x',
        currentPrice: 250,
        bids: [bid('usr_x', 250, 20), bid('me', 200, 10)],
      }),
      mapped({ id: 'a_won', status: 'ended', winnerId: 'me', winningBid: 500, endTime: 40, bids: [bid('me', 500, 15)] }),
      mapped({
        id: 'a_lost',
        status: 'ended',
        winnerId: 'usr_x',
        winningBid: 600,
        endTime: 30,
        bids: [bid('usr_x', 600, 16), bid('me', 100, 12)],
      }),
      mapped({ id: 'a_sold', status: 'ended', sellerId: 'me', winnerId: 'usr_x', winningBid: 700, endTime: 50 }),
    ];

    const notifications = buildNotifications(auctions, 'me');

    expect(notifications.map((n) => [n.type, n.id, n.amount])).toEqual([
      ['sold', 'sold_a_sold', 700],
      ['won', 'won_a_won', 500],
      ['lost', 'lost_a_lost', 600],
      ['outbid', 'outbid_a_outbid_20', 250],
    ]);
  });

  it('keeps the outbid id stable when further bids arrive', () => {
    const base = {
      id: 'a_outbid',
      status: 'active',
      highestBidderId: 'usr_x',
      currentPrice: 250,
      bids: [bid('usr_x', 250, 20), bid('me', 200, 10)],
    };

    const first = buildNotifications([mapped(base)], 'me')[0];
    const later = buildNotifications(
      [mapped({ ...base, currentPrice: 900, bids: [bid('usr_y', 900, 90), ...base.bids] })],
      'me',
    )[0];

    expect(later.id).toBe(first.id);
    expect(later.amount).toBe(900);
  });
});
