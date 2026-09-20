import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResetPasswordView } from '../../src/components/ResetPasswordView';

vi.mock('../../src/lib/api', () => ({
  apiFetch: vi.fn(),
  resolveApiUrl: (path: string) => path,
  apiFetchAuthed: vi.fn(),
}));

import { apiFetch, apiFetchAuthed } from '../../src/lib/api';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedApiFetchAuthed = apiFetchAuthed as unknown as ReturnType<typeof vi.fn>;

function renderView(props: Partial<React.ComponentProps<typeof ResetPasswordView>> = {}) {
  const onResetComplete = vi.fn();
  const onRequestNewLink = vi.fn();
  render(
    <ResetPasswordView
      token="raw-token-abc"
      onResetComplete={onResetComplete}
      onRequestNewLink={onRequestNewLink}
      onClose={vi.fn()}
      {...props}
    />,
  );
  return { onResetComplete, onRequestNewLink };
}

async function submit(password: string, confirmation = password) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^new password$/i), password);
  await user.type(screen.getByLabelText(/confirm new password/i), confirmation);
  await user.click(screen.getByRole('button', { name: /set password & sign in/i }));
}

describe('ResetPasswordView', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetchAuthed.mockReset();
    mockedApiFetchAuthed.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);
  });

  it('refuses a mismatched confirmation without calling the server', async () => {
    renderView();
    await submit('hunter22', 'hunter23');

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i);
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('signs the user straight in with the fresh session the reset returns', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: 'usr_1', name: 'Alex', username: 'alex_bidder', token: 'tok_new' } }),
    } as Response);
    mockedApiFetchAuthed.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: 'usr_1', name: 'Alex', username: 'alex_bidder', email: 'a@b.co', role: 'member' } }),
    } as Response);

    const { onResetComplete } = renderView();
    await submit('hunter22');

    await waitFor(() => expect(onResetComplete).toHaveBeenCalledTimes(1));
    const signedIn = onResetComplete.mock.calls[0][0];
    // The fresh session token wins over anything /api/auth/me echoes back.
    expect(signedIn.token).toBe('tok_new');
    // ...and role/email are hydrated, so the header looks the same as after a normal sign-in.
    expect(signedIn.role).toBe('member');
    expect(signedIn.email).toBe('a@b.co');

    expect(JSON.parse(mockedApiFetch.mock.calls[0][1].body)).toEqual({
      token: 'raw-token-abc',
      newPassword: 'hunter22',
    });
  });

  it('still signs in when the follow-up session hydration fails', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: 'usr_1', name: 'Alex', username: 'alex_bidder', token: 'tok_new' } }),
    } as Response);
    mockedApiFetchAuthed.mockRejectedValue(new Error('network blip'));

    const { onResetComplete } = renderView();
    await submit('hunter22');

    await waitFor(() => expect(onResetComplete).toHaveBeenCalledTimes(1));
    expect(onResetComplete.mock.calls[0][0].token).toBe('tok_new');
  });

  for (const code of ['INVALID_RESET_TOKEN', 'RESET_TOKEN_EXPIRED', 'RESET_TOKEN_USED']) {
    it(`offers a way to request a new link when the token is rejected as ${code}`, async () => {
      mockedApiFetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: `Nope. [Code: ${code}]`, code }),
      } as Response);

      const { onRequestNewLink } = renderView();
      await submit('hunter22');

      const alert = await screen.findByRole('alert');
      // One shared message for all three: from the user's side they are the same situation,
      // and telling a link-holder that it was "already used" says something about what the
      // real owner did with it.
      expect(alert).toHaveTextContent(/no longer valid/i);
      expect(alert).toHaveTextContent(/60 minutes/i);

      await userEvent.setup().click(screen.getByRole('button', { name: /request a new link/i }));
      expect(onRequestNewLink).toHaveBeenCalled();

      cleanup();
    });
  }

  it('treats a missing ?token= as a dead link rather than posting an empty one', async () => {
    renderView({ token: '' });
    await submit('hunter22');

    expect(await screen.findByRole('alert')).toHaveTextContent(/incomplete/i);
    expect(screen.getByRole('button', { name: /request a new link/i })).toBeInTheDocument();
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });
});
