import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from '../../src/App';
import { User } from '../../src/types';

vi.mock('../../src/lib/api', () => ({
  apiFetch: vi.fn(),
  resolveApiUrl: (path: string) => path,
  apiFetchAuthed: vi.fn(),
}));

vi.mock('../../src/lib/realtime', () => ({
  startPolling: vi.fn(() => () => {}),
  checkHealth: vi.fn(async () => true),
}));

import { apiFetch, apiFetchAuthed } from '../../src/lib/api';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedApiFetchAuthed = apiFetchAuthed as unknown as ReturnType<typeof vi.fn>;

const STORAGE_KEY = 'msa_auction_user';

function storeSession(overrides: Partial<User> = {}) {
  const user: User = {
    id: 'user_1',
    name: 'Alex Bidder',
    username: 'alex_bidder',
    token: 'tok_abc',
    createdAt: Date.now() - 60 * 60 * 1000,
    ...overrides,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  return user;
}

describe('/admin route', () => {
  beforeEach(() => {
    localStorage.clear();
    mockedApiFetch.mockReset();
    mockedApiFetchAuthed.mockReset();

    mockedApiFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ auctions: [], nextCursor: null }),
    } as Response));

    // Covers both the session check (/api/auth/me) and the panel's own reports fetch.
    mockedApiFetchAuthed.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ reports: [] }),
    } as Response);
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('redirects a signed-in member away from /admin, exactly as /account does when signed out', async () => {
    storeSession({ role: 'member' });
    window.history.pushState({}, '', '/admin');

    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(document.getElementById('admin-view')).not.toBeInTheDocument();
    // The browse view is what they get instead, not a blank screen.
    expect(screen.getByText(/live bidding dashboard/i)).toBeInTheDocument();
  });

  it('redirects a signed-out visitor away from /admin', async () => {
    window.history.pushState({}, '', '/admin');

    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(document.getElementById('admin-view')).not.toBeInTheDocument();
  });

  it('redirects an account with no role at all (a session stored before roles existed)', async () => {
    storeSession();
    window.history.pushState({}, '', '/admin');

    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(document.getElementById('admin-view')).not.toBeInTheDocument();
  });

  it('renders the panel for an admin and links to it from the header', async () => {
    storeSession({ role: 'admin' });
    window.history.pushState({}, '', '/admin');

    render(<App />);

    await waitFor(() => expect(document.getElementById('admin-view')).toBeInTheDocument());
    expect(window.location.pathname).toBe('/admin');
    expect(screen.getByRole('button', { name: /committee admin/i })).toBeInTheDocument();
  });

  it('hides the header admin link from a member', async () => {
    storeSession({ role: 'member' });

    render(<App />);

    // Wait for the session to resolve so this is not just "the header has not rendered yet".
    await waitFor(() => expect(screen.getByText('Alex Bidder')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /committee admin/i })).not.toBeInTheDocument();
    expect(document.getElementById('admin-panel-btn')).not.toBeInTheDocument();
  });
});
