import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddEmailPrompt } from '../../src/components/AddEmailPrompt';
import { emailPromptDismissedKey } from '../../src/lib/emailPromptStorage';
import { User } from '../../src/types';

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

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'usr_1',
    name: 'Alex Bidder',
    username: 'alex_bidder',
    token: 'tok_abc',
    createdAt: Date.now() - 60 * 60 * 1000,
    ...overrides,
  };
}

function renderPrompt(user: User, onEmailSaved = vi.fn()) {
  return render(<AddEmailPrompt user={user} onEmailSaved={onEmailSaved} />);
}

describe('AddEmailPrompt', () => {
  beforeEach(() => {
    localStorage.clear();
    mockedApiFetch.mockReset();
  });

  it('explains what an account with no email loses', () => {
    renderPrompt(makeUser());

    expect(screen.getByRole('heading', { name: /add an email/i })).toBeInTheDocument();
    expect(screen.getByText(/no way to reset it on your own/i)).toBeInTheDocument();
  });

  it('renders nothing for an account that already has an email', () => {
    const { container } = renderPrompt(makeUser({ email: 'alex@example.com' }));

    expect(container).toBeEmptyDOMElement();
  });

  it('is hidden once dismissed, and stays hidden on the next visit', async () => {
    const user = makeUser();
    renderPrompt(user);

    await userEvent.setup().click(screen.getByRole('button', { name: /dismiss the add email prompt/i }));

    expect(document.getElementById('add-email-prompt')).not.toBeInTheDocument();

    // A fresh mount reads the persisted flag, so it does not come straight back.
    cleanup();
    const { container } = renderPrompt(user);
    expect(container).toBeEmptyDOMElement();
  });

  it('keys the dismissal per account, so two students on one browser do not share it', async () => {
    const alex = makeUser({ id: 'usr_alex' });
    const sam = makeUser({ id: 'usr_sam', name: 'Sam Seller', username: 'sam' });

    renderPrompt(alex);
    await userEvent.setup().click(screen.getByRole('button', { name: /dismiss the add email prompt/i }));
    cleanup();

    // Alex's dismissal is under Alex's key only...
    expect(localStorage.getItem(emailPromptDismissedKey('usr_alex'))).toBe('1');
    expect(localStorage.getItem(emailPromptDismissedKey('usr_sam'))).toBeNull();

    // ...so Sam, who may be the one who actually needs it, still sees the prompt.
    renderPrompt(sam);
    expect(screen.getByRole('heading', { name: /add an email/i })).toBeInTheDocument();
  });

  it('saves an address and tells the caller', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, email: 'alex@example.com' }),
    } as Response);

    const onEmailSaved = vi.fn();
    renderPrompt(makeUser(), onEmailSaved);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email address/i), 'alex@example.com');
    await user.click(screen.getByRole('button', { name: /save email/i }));

    await waitFor(() => expect(onEmailSaved).toHaveBeenCalledWith('alex@example.com'));

    const [url, init] = mockedApiFetch.mock.calls[0];
    expect(url).toBe('/api/auth/email');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok_abc' });
    expect(JSON.parse(init.body)).toEqual({ email: 'alex@example.com' });
    expect(await screen.findByRole('status')).toHaveTextContent(/alex@example\.com/);
  });

  it('names the reason when the address belongs to someone else', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'That email address is already attached to another account. [Code: EMAIL_TAKEN]',
        code: 'EMAIL_TAKEN',
      }),
    } as Response);

    renderPrompt(makeUser());

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email address/i), 'taken@example.com');
    await user.click(screen.getByRole('button', { name: /save email/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already attached to another account/i);
  });
});
