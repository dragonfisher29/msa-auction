import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationBell } from '../../src/components/NotificationBell';
import { AppNotification, User } from '../../src/types';

vi.mock('../../src/lib/api', () => ({
  apiFetch: vi.fn(),
  resolveApiUrl: (path: string) => path,
  apiFetchAuthed: vi.fn(),
}));

// The live poll is exercised by tests/unit/realtime.test.ts; here it is stubbed so the badge
// is driven purely by the initial load.
vi.mock('../../src/lib/realtime', () => ({
  startPolling: vi.fn(() => () => {}),
  checkHealth: vi.fn(async () => true),
}));

import { apiFetchAuthed } from '../../src/lib/api';
import { startPolling } from '../../src/lib/realtime';
import { notificationReadIdsKey } from '../../src/lib/notificationStorage';

const mockedApiFetchAuthed = apiFetchAuthed as unknown as ReturnType<typeof vi.fn>;
const mockedStartPolling = startPolling as unknown as ReturnType<typeof vi.fn>;

const NOW = Date.now();

const signedInUser: User = {
  id: 'user_1',
  name: 'Alex Bidder',
  username: 'alex_bidder',
  token: 'tok_abc',
  createdAt: NOW - 60 * 60 * 1000,
};

// Offsets carry a spare 30s so the coarsest-unit label ("2h ago") cannot flip to the unit
// below while the test runs.
const NOTIFICATIONS: AppNotification[] = [
  {
    id: 'ntf_1',
    type: 'outbid',
    auctionId: 'auc_1',
    auctionTitle: 'Vintage Film Camera',
    amount: 155,
    timestamp: NOW - 3 * 1000,
  },
  {
    id: 'ntf_2',
    type: 'won',
    auctionId: 'auc_2',
    auctionTitle: 'Desk Lamp',
    amount: 40,
    timestamp: NOW - (30 * 60 + 30) * 1000,
  },
  {
    id: 'ntf_3',
    type: 'sold',
    auctionId: 'auc_3',
    auctionTitle: 'Road Bike',
    amount: 220,
    timestamp: NOW - (2 * 60 * 60 + 30) * 1000,
  },
];

function mockFeed(notifications: AppNotification[] | 'not_found') {
  mockedApiFetchAuthed.mockImplementation(async (path: string) => {
    if (path !== '/api/notifications') {
      throw new Error(`Unexpected apiFetchAuthed call: ${path}`);
    }
    if (notifications === 'not_found') {
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => notifications } as Response;
  });
}

function renderBell(user: User = signedInUser) {
  const onOpenAuction = vi.fn();
  render(<NotificationBell user={user} onOpenAuction={onOpenAuction} />);
  return { onOpenAuction };
}

const badge = () => screen.queryByTestId('notification-unread-count');

describe('NotificationBell', () => {
  beforeEach(() => {
    mockedApiFetchAuthed.mockReset();
    mockedStartPolling.mockClear();
    localStorage.clear();
  });

  describe('unread count', () => {
    it('shows every notification as unread on a first visit', async () => {
      mockFeed(NOTIFICATIONS);
      renderBell();

      expect(await screen.findByTestId('notification-unread-count')).toHaveTextContent('3');
      expect(
        screen.getByRole('button', { name: 'Notifications, 3 unread' }),
      ).toBeInTheDocument();
    });

    it('does not count ids already stored as read for this user', async () => {
      localStorage.setItem(
        notificationReadIdsKey(signedInUser.id),
        JSON.stringify(['ntf_1', 'ntf_3']),
      );
      mockFeed(NOTIFICATIONS);
      renderBell();

      expect(await screen.findByTestId('notification-unread-count')).toHaveTextContent('1');
    });

    it('ignores another account read state stored on the same browser', async () => {
      // The known watchlist bug is exactly this: one global key shared by two accounts. The
      // notification key is per user id, so a second account's read ids must not silence
      // this account's badge.
      localStorage.setItem(
        notificationReadIdsKey('someone_else'),
        JSON.stringify(['ntf_1', 'ntf_2', 'ntf_3']),
      );
      mockFeed(NOTIFICATIONS);
      renderBell();

      expect(await screen.findByTestId('notification-unread-count')).toHaveTextContent('3');
    });

    it('renders no badge at all when there is nothing unread', async () => {
      mockFeed([]);
      renderBell();

      await waitFor(() => expect(mockedApiFetchAuthed).toHaveBeenCalled());
      expect(badge()).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Notifications, none unread' }),
      ).toBeInTheDocument();
    });

    it('caps the badge at 9+ rather than overflowing the bell', async () => {
      mockFeed(
        Array.from({ length: 12 }, (_, i) => ({
          ...NOTIFICATIONS[0],
          id: `ntf_bulk_${i}`,
        })),
      );
      renderBell();

      expect(await screen.findByTestId('notification-unread-count')).toHaveTextContent('9+');
    });

    it('drops the count and persists the read id when a notification is opened', async () => {
      mockFeed(NOTIFICATIONS);
      const { onOpenAuction } = renderBell();

      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Notifications, 3 unread' }));
      await user.click(document.getElementById('notification-item-ntf_2') as HTMLButtonElement);

      expect(onOpenAuction).toHaveBeenCalledWith('auc_2');
      await waitFor(() => expect(badge()).toHaveTextContent('2'));

      expect(
        JSON.parse(localStorage.getItem(notificationReadIdsKey(signedInUser.id)) as string),
      ).toEqual(['ntf_2']);
    });

    it('prunes a stored read id once its notification ages out of the feed', async () => {
      localStorage.setItem(
        notificationReadIdsKey(signedInUser.id),
        JSON.stringify(['ntf_1', 'ntf_stale']),
      );
      mockFeed(NOTIFICATIONS);
      renderBell();

      await waitFor(() =>
        expect(
          JSON.parse(localStorage.getItem(notificationReadIdsKey(signedInUser.id)) as string),
        ).toEqual(['ntf_1']),
      );
    });

    it('clears the badge on "Mark all read" and stores every id', async () => {
      mockFeed(NOTIFICATIONS);
      renderBell();

      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Notifications, 3 unread' }));
      await user.click(
        screen.getByRole('button', { name: 'Mark all notifications as read' }),
      );

      await waitFor(() => expect(badge()).not.toBeInTheDocument());
      expect(
        JSON.parse(localStorage.getItem(notificationReadIdsKey(signedInUser.id)) as string),
      ).toEqual(['ntf_1', 'ntf_2', 'ntf_3']);
    });
  });

  describe('panel contents', () => {
    it('renders type-appropriate copy and relative timestamps from the shared formatter', async () => {
      mockFeed(NOTIFICATIONS);
      renderBell();

      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Notifications, 3 unread' }));

      expect(screen.getByText('You were outbid on Vintage Film Camera')).toBeInTheDocument();
      expect(screen.getByText('The leading bid is now £155.')).toBeInTheDocument();
      expect(screen.getByText('You won Desk Lamp')).toBeInTheDocument();
      expect(screen.getByText('Your listing Road Bike sold')).toBeInTheDocument();

      expect(screen.getByText('Just now')).toBeInTheDocument();
      expect(screen.getByText('30m ago')).toBeInTheDocument();
      expect(screen.getByText('2h ago')).toBeInTheDocument();
    });

    it('degrades to a calm message when the endpoint is not deployed yet (404)', async () => {
      mockFeed('not_found');
      renderBell();

      await waitFor(() => expect(mockedApiFetchAuthed).toHaveBeenCalled());
      expect(badge()).not.toBeInTheDocument();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Notifications, none unread' }));

      expect(screen.getByText('Notifications are not available yet')).toBeInTheDocument();
    });
  });

  describe('polling', () => {
    it('reuses the shared startPolling helper instead of its own timer', async () => {
      mockFeed(NOTIFICATIONS);
      renderBell();

      await waitFor(() => expect(mockedStartPolling).toHaveBeenCalled());
      expect(mockedStartPolling.mock.calls[0][1]).toBe(15000);
    });
  });
});
