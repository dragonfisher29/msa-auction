import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminView } from '../../src/components/AdminView';
import { AdminReport, User } from '../../src/types';

vi.mock('../../src/lib/api', () => {
  const apiFetch = vi.fn();
  return {
    apiFetch,
    resolveApiUrl: (path: string) => path,
    apiFetchAuthed: (input: string, token: string | null | undefined, init?: RequestInit) =>
      apiFetch(input, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }),
  };
});

import { apiFetch } from '../../src/lib/api';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const NOW = Date.now();

const admin: User = {
  id: 'usr_admin',
  name: 'Cass Committee',
  username: 'cass',
  token: 'tok_admin',
  createdAt: NOW - 30 * 24 * 60 * 60 * 1000,
  role: 'admin',
};

const report: AdminReport = {
  id: 'rep_1',
  auctionId: 'auc_1',
  auctionTitle: 'Definitely Real iPhone',
  sellerId: 'usr_seller',
  sellerName: 'Sam Seller',
  reporterId: 'usr_reporter',
  reason: 'scam',
  details: 'Asked me to pay by bank transfer.',
  status: 'open',
  createdAt: NOW - 20 * 60 * 1000,
  resolvedBy: null,
  resolvedAt: null,
};

function jsonResponse(body: any, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function renderPanel(props: Partial<React.ComponentProps<typeof AdminView>> = {}) {
  return render(
    <AdminView user={admin} onClose={vi.fn()} onOpenAuctionById={vi.fn()} {...props} />,
  );
}

describe('AdminView', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/admin/reports') {
        return jsonResponse({ reports: [report] });
      }
      throw new Error(`Unexpected call: ${url}`);
    });
  });

  it('lists an open report with its reason, details, reporter, listing and seller', async () => {
    renderPanel();

    const row = await screen.findByTestId('admin-report-rep_1');
    // Human label, not the raw `scam` enum value.
    expect(within(row).getByText('Scam or fraud')).toBeInTheDocument();
    expect(within(row).getByText('Definitely Real iPhone')).toBeInTheDocument();
    expect(within(row).getByText(/Sam Seller/)).toBeInTheDocument();
    expect(within(row).getByText(/usr_reporter/)).toBeInTheDocument();
    expect(within(row).getByText('Asked me to pay by bank transfer.')).toBeInTheDocument();
    expect(within(row).getByText(/^Filed /)).toBeInTheDocument();
  });

  it('links a report through to the listing it is about', async () => {
    const onOpenAuctionById = vi.fn();
    renderPanel({ onOpenAuctionById });

    const row = await screen.findByTestId('admin-report-rep_1');
    await userEvent.setup().click(within(row).getByRole('button', { name: /open the reported listing/i }));

    expect(onOpenAuctionById).toHaveBeenCalledWith('auc_1');
  });

  describe('pending password resets', () => {
    it('warns that loading the list re-issues every token BEFORE anything is fetched', async () => {
      renderPanel();

      // The warning is on screen from first paint -- an admin must be able to read it and decide
      // NOT to load the list, because loading it is what breaks links already handed out.
      const warning = screen.getByRole('note');
      expect(warning).toHaveTextContent(/issues a brand new link for every pending request/i);
      expect(warning).toHaveTextContent(/stops working/i);
      expect(warning).toHaveTextContent(/60-minute/i);
      expect(warning).toHaveTextContent(/email delivery is not set up|not set up yet/i);

      // And nothing has been fetched from the reset route just by opening the panel.
      await waitFor(() => expect(mockedApiFetch).toHaveBeenCalled());
      const resetCalls = mockedApiFetch.mock.calls.filter(([url]) => url === '/api/admin/reset-requests');
      expect(resetCalls).toHaveLength(0);
      expect(screen.queryByTestId('admin-reset-usr_forgetful')).not.toBeInTheDocument();
    });

    it('only fetches on an explicit click, and never polls afterwards', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      mockedApiFetch.mockImplementation(async (url: string) => {
        if (url === '/api/admin/reports') {
          return jsonResponse({ reports: [] });
        }
        if (url === '/api/admin/reset-requests') {
          return jsonResponse({
            resetRequests: [
              {
                userId: 'usr_forgetful',
                username: 'forgetful',
                name: 'Fran Forgetful',
                email: 'fran@example.com',
                token: 'raw-token-abc',
                expiresAt: NOW + 60 * 60 * 1000,
              },
            ],
          });
        }
        throw new Error(`Unexpected call: ${url}`);
      });

      try {
        renderPanel();

        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.click(screen.getByRole('button', { name: /load pending resets/i }));

        const row = await screen.findByTestId('admin-reset-usr_forgetful');
        expect(within(row).getByText(/fran forgetful/i)).toBeInTheDocument();
        expect(within(row).getByText(/raw-token-abc/)).toBeInTheDocument();
        expect(within(row).getByText(/Expires/)).toBeInTheDocument();
        expect(within(row).getByRole('button', { name: /copy the reset link for @forgetful/i })).toBeInTheDocument();

        const callsAfterLoad = mockedApiFetch.mock.calls.filter(([url]) => url === '/api/admin/reset-requests').length;
        expect(callsAfterLoad).toBe(1);

        // Two minutes of wall clock later: still one call. Nothing re-mints tokens behind the
        // admin's back.
        await vi.advanceTimersByTimeAsync(120_000);
        const callsLater = mockedApiFetch.mock.calls.filter(([url]) => url === '/api/admin/reset-requests').length;
        expect(callsLater).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('hiding a listing', () => {
    it('confirms first, states what hiding does, and refreshes the queue afterwards', async () => {
      const hideCalls: any[] = [];
      let reportsCallCount = 0;

      mockedApiFetch.mockImplementation(async (url: string, init?: any) => {
        if (url === '/api/admin/reports') {
          reportsCallCount += 1;
          return jsonResponse({ reports: reportsCallCount === 1 ? [report] : [] });
        }
        if (url === '/api/admin/auctions/auc_1/hide') {
          hideCalls.push(JSON.parse(init.body));
          return jsonResponse({ success: true, auctionId: 'auc_1', reportsActioned: 2 });
        }
        throw new Error(`Unexpected call: ${url}`);
      });

      renderPanel();
      const user = userEvent.setup();

      const row = await screen.findByTestId('admin-report-rep_1');
      await user.click(within(row).getByRole('button', { name: /hide the listing/i }));

      // Confirmation step, with the consequence spelled out rather than implied.
      const dialog = await screen.findByRole('dialog', { name: /hide listing/i });
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/removes the listing from the public grid/i);

      // A reason is required: clicking through without one does not call the server.
      await user.click(within(dialog).getByRole('button', { name: /yes, hide it/i }));
      expect(hideCalls).toHaveLength(0);

      await user.type(within(dialog).getByLabelText(/reason/i), 'Confirmed scam.');
      await user.click(within(dialog).getByRole('button', { name: /yes, hide it/i }));

      await waitFor(() => expect(hideCalls).toEqual([{ reason: 'Confirmed scam.' }]));

      // Hiding closes that listing's open reports server-side, so the queue is refetched.
      await waitFor(() => expect(reportsCallCount).toBe(2));
      expect(await screen.findByText(/2 open reports were closed with it/i)).toBeInTheDocument();
    });
  });

  describe('banning', () => {
    async function attemptBan(responseBody: any) {
      mockedApiFetch.mockImplementation(async (url: string) => {
        if (url === '/api/admin/reports') {
          return jsonResponse({ reports: [] });
        }
        if (url.startsWith('/api/admin/users/')) {
          return jsonResponse(responseBody, false, 403);
        }
        throw new Error(`Unexpected call: ${url}`);
      });

      renderPanel();
      const user = userEvent.setup();

      await user.type(screen.getByLabelText(/account id/i), 'usr_target');
      await user.type(screen.getByLabelText(/reason/i), 'Because.');
      await user.click(screen.getByRole('button', { name: /^ban account$/i }));

      return screen.findByText((_, element) => element?.id === 'admin-ban-error');
    }

    it('says plainly that you cannot ban yourself', async () => {
      const error = await attemptBan({
        error: 'You cannot ban your own account. [Code: CANNOT_BAN_SELF]',
        code: 'CANNOT_BAN_SELF',
      });

      expect(error).toHaveTextContent(/cannot ban your own account/i);
      expect(error).not.toHaveTextContent(/\[Code:/);
    });

    it('says plainly that another admin cannot be banned', async () => {
      const error = await attemptBan({
        error: 'Admin accounts cannot be banned from here. [Code: CANNOT_BAN_ADMIN]',
        code: 'CANNOT_BAN_ADMIN',
      });

      expect(error).toHaveTextContent(/committee admin and cannot be banned/i);
      // Distinct from the self-ban message: two different situations, two different next steps.
      expect(error).not.toHaveTextContent(/your own account/i);
    });

    it('refuses to send a ban with no reason', async () => {
      mockedApiFetch.mockImplementation(async (url: string) => {
        if (url === '/api/admin/reports') {
          return jsonResponse({ reports: [] });
        }
        throw new Error(`Unexpected call: ${url}`);
      });

      renderPanel();
      const user = userEvent.setup();

      await user.type(screen.getByLabelText(/account id/i), 'usr_target');
      await user.click(screen.getByRole('button', { name: /^ban account$/i }));

      expect(await screen.findByText(/a reason is required to ban an account/i)).toBeInTheDocument();
      expect(mockedApiFetch.mock.calls.filter(([url]) => url.startsWith('/api/admin/users/'))).toHaveLength(0);
    });
  });
});
