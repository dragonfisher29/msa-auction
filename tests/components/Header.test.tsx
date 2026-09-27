import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Header } from '../../src/components/Header';
import { SITE_NAME } from '../../src/lib/site';

function renderHeader(overrides: Partial<React.ComponentProps<typeof Header>> = {}) {
  const props: React.ComponentProps<typeof Header> = {
    user: null,
    isAccountViewOpen: false,
    onOpenAuth: vi.fn(),
    onOpenCreate: vi.fn(),
    onLogout: vi.fn(),
    onToggleAccountView: vi.fn(),
    ...overrides,
  };

  render(<Header {...props} />);
  return props;
}

describe('Header', () => {
  describe('copy', () => {
    it('renders the site name from the single SITE_NAME constant', () => {
      renderHeader();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(SITE_NAME);
    });

    it('makes no real-time / bidding claims and has no connection indicator', () => {
      renderHeader();
      expect(document.body.textContent).not.toMatch(/real-time|bi-directional|bidding|reconnecting|socket\.io/i);
      expect(screen.queryByTestId('connection-status')).toBeNull();
    });
  });

  describe('signed-in controls', () => {
    it('shows no notification bell', () => {
      renderHeader({
        user: { id: 'u1', name: 'Alex', username: 'alex', token: 't', createdAt: 0 },
      });
      expect(screen.queryByRole('button', { name: /notification/i })).toBeNull();
      expect(screen.getByRole('button', { name: /my account/i })).toBeInTheDocument();
    });
  });

  describe('branding', () => {
    it('renders the logo image with the expected src and a non-empty alt', () => {
      renderHeader();
      const logo = screen.getByRole('img') as HTMLImageElement;
      expect(logo.getAttribute('src')).toBe('/MSA_Logo.png');
      expect(logo.getAttribute('alt')).toBeTruthy();
    });
  });
});
