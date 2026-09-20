import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthModal } from '../../src/components/AuthModal';

vi.mock('../../src/lib/api', () => ({
  apiFetch: vi.fn(),
  resolveApiUrl: (path: string) => path,
  apiFetchAuthed: vi.fn(),
}));

import { apiFetch } from '../../src/lib/api';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function renderModal(props: Partial<React.ComponentProps<typeof AuthModal>> = {}) {
  return render(
    <AuthModal isOpen onClose={vi.fn()} onAuthSuccess={vi.fn()} {...props} />,
  );
}

/** Walks the sign-in tab to the recovery form and submits `identifier`. */
async function requestReset(identifier: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /forgot password\?/i }));
  await user.type(screen.getByLabelText(/username or email/i), identifier);
  await user.click(screen.getByRole('button', { name: /request reset link/i }));
  return screen.findByRole('status');
}

describe('AuthModal password recovery', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it('offers "Forgot password?" on the sign-in tab only', async () => {
    renderModal();

    expect(screen.getByRole('button', { name: /forgot password\?/i })).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: /^register$/i }));
    expect(screen.queryByRole('button', { name: /forgot password\?/i })).not.toBeInTheDocument();
  });

  it('shows the SAME confirmation for a known and an unknown account', async () => {
    // The server answers an identical 200 either way, on purpose: a different answer here
    // would turn the box into a "does @someone have an account" oracle. Both branches of this
    // test send the same server response, because that is what the server really does -- the
    // point being asserted is that the UI adds no distinguishing signal of its own.
    mockedApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message: 'If that account exists, a reset link has been created.' }),
    } as Response);

    renderModal();
    const known = await requestReset('alex_bidder');
    const knownText = known.textContent;
    expect(knownText).toMatch(/if that account exists/i);

    cleanup();

    renderModal();
    const unknown = await requestReset('nobody_at_all');

    expect(unknown.textContent).toBe(knownText);
    // Nothing anywhere says whether the account was found.
    expect(screen.queryByText(/we could not find/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no account/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the same confirmation even when the request fails outright', async () => {
    // A network error shown for one identifier and not another would leak by omission exactly
    // what the generic 200 exists to hide.
    mockedApiFetch.mockRejectedValue(new Error('network blip'));

    renderModal();
    const confirmation = await requestReset('alex_bidder');

    expect(confirmation).toHaveTextContent(/if that account exists/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('warns that no email will arrive and to ask a committee member', async () => {
    mockedApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) } as Response);

    renderModal();
    await requestReset('alex_bidder');

    expect(screen.getByText(/no email will arrive/i)).toBeInTheDocument();
    expect(screen.getByText(/committee member/i)).toBeInTheDocument();
  });

  it('opens straight onto the recovery form when asked to', () => {
    renderModal({ initialMode: 'forgot' });

    expect(screen.getByLabelText(/username or email/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
  });

  it('sends the request with the identifier the user typed', async () => {
    mockedApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) } as Response);

    renderModal();
    await requestReset('  alex_bidder  ');

    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/api/auth/request-reset',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(mockedApiFetch.mock.calls[0][1].body)).toEqual({ usernameOrEmail: 'alex_bidder' });
  });
});

describe('AuthModal registration email', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ user: { id: 'usr_1', name: 'Jordan', username: 'jordan', token: 'tok_1' } }),
    } as Response);
  });

  async function submitRegistration(email?: string) {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^register$/i }));
    await user.type(screen.getByLabelText(/full name/i), 'Jordan Hayes');
    await user.type(screen.getByLabelText(/username/i), 'jordan');
    if (email) {
      await user.type(screen.getByLabelText(/email/i), email);
    }
    await user.type(screen.getByLabelText(/^password$/i), 'hunter22');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(mockedApiFetch).toHaveBeenCalled());
    return JSON.parse(mockedApiFetch.mock.calls[0][1].body);
  }

  it('sends an email when one is given', async () => {
    renderModal();
    const body = await submitRegistration('jordan@example.com');

    expect(body).toMatchObject({ username: 'jordan', name: 'Jordan Hayes', email: 'jordan@example.com' });
  });

  it('omits the field entirely when left blank, rather than sending an empty string', async () => {
    renderModal();
    const body = await submitRegistration();

    expect(body).not.toHaveProperty('email');
  });

  it('says what leaving it blank costs', async () => {
    renderModal();
    await userEvent.setup().click(screen.getByRole('button', { name: /^register$/i }));

    expect(screen.getByText(/forgotten password cannot be recovered/i)).toBeInTheDocument();
  });
});
