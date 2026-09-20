import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportListingModal } from '../../src/components/ReportListingModal';
import { REPORT_REASONS } from '../../src/lib/moderation';
import { AuctionItem, User } from '../../src/types';

vi.mock('../../src/lib/api', () => {
  const apiFetch = vi.fn();
  return {
    apiFetch,
    resolveApiUrl: (path: string) => path,
    // Mirrors the real helper so the assertions below see the request exactly as it goes to
    // the network, Authorization header included, through the single apiFetch spy.
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

const reporter: User = {
  id: 'user_1',
  name: 'Alex Bidder',
  username: 'alex_bidder',
  token: 'tok_abc',
  createdAt: NOW - 60 * 60 * 1000,
};

const auction: AuctionItem = {
  id: 'auc_1',
  title: 'Definitely Real iPhone',
  description: 'Pay by bank transfer only.',
  phoneNumber: '+44 7700 900000',
  startingPrice: 50,
  currentPrice: 50,
  sellerId: 'seller_1',
  sellerName: 'Sam Seller',
  highestBidderId: null,
  highestBidderName: null,
  durationMinutes: 60,
  startTime: NOW - 5 * 60 * 1000,
  endTime: NOW + 60 * 60 * 1000,
  status: 'active',
  category: 'Electronics',
  bids: [],
  createdAt: NOW - 10 * 60 * 1000,
};

function renderModal(onClose = vi.fn()) {
  return render(<ReportListingModal auction={auction} user={reporter} onClose={onClose} />);
}

describe('ReportListingModal', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it('offers exactly the five reasons the server accepts, labelled in English', () => {
    renderModal();

    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(REPORT_REASONS.length);
    expect(radios.map((radio) => radio.value).sort()).toEqual([...REPORT_REASONS].sort());

    // The raw enum values are database tokens, not copy: every option reads as a sentence.
    expect(screen.getByLabelText(/scam or fraud/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/prohibited item/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/offensive content/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/listed in the wrong category/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/something else/i)).toBeInTheDocument();
    expect(screen.queryByText('wrong_category')).not.toBeInTheDocument();
  });

  it('refuses to submit without a reason, and never calls the API', async () => {
    renderModal();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /send report/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/choose a reason/i);
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('sends the chosen reason from the fixed set, with the optional details', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, duplicate: false }),
    } as Response);

    renderModal();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/scam or fraud/i));
    await user.type(screen.getByLabelText(/anything else/i), 'Asked me to pay by bank transfer.');
    await user.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(mockedApiFetch).toHaveBeenCalledTimes(1));

    const [url, init] = mockedApiFetch.mock.calls[0];
    expect(url).toBe('/api/auctions/auc_1/report');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok_abc' });
    expect(JSON.parse(init.body)).toEqual({
      reason: 'scam',
      details: 'Asked me to pay by bank transfer.',
    });
  });

  it('treats a duplicate report as a success, not a failure', async () => {
    // The server answers a second open report from the same user with 200 and duplicate: true,
    // precisely so the reporter is never told whether their earlier report is still open. The
    // UI must not undo that by rendering it as an error -- someone told "that failed" may well
    // give up on reporting a real scam.
    mockedApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, duplicate: true, message: 'Thanks - the committee has been notified.' }),
    } as Response);

    renderModal();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/scam or fraud/i));
    await user.click(screen.getByRole('button', { name: /send report/i }));

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent(/committee has been notified/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Nothing anywhere hints that this report was a repeat.
    expect(screen.queryByText(/already reported/i)).not.toBeInTheDocument();
  });

  it('surfaces a real failure as an error', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Failed to report the listing. [Code: REPORT_FAILED]', code: 'REPORT_FAILED' }),
    } as Response);

    renderModal();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/offensive content/i));
    await user.click(screen.getByRole('button', { name: /send report/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Failed to report the listing.');
    // The machine-readable suffix is for logs, not for students.
    expect(alert).not.toHaveTextContent('[Code:');
  });
});
