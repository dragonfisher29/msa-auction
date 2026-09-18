import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Header } from '../../src/components/Header';

function renderHeader(overrides: Partial<React.ComponentProps<typeof Header>> = {}) {
  const props: React.ComponentProps<typeof Header> = {
    user: null,
    isConnected: true,
    onOpenAuth: vi.fn(),
    onOpenCreate: vi.fn(),
    onLogout: vi.fn(),
    onQuickSwitchUser: vi.fn(),
    ...overrides,
  };

  render(<Header {...props} />);
  return props;
}

describe('Header', () => {
  describe('connection status', () => {
    it('renders "Live" in the connection-status pill when isConnected is true', () => {
      renderHeader({ isConnected: true });
      expect(screen.getByTestId('connection-status')).toHaveTextContent('Live');
      expect(screen.queryByText('Reconnecting...')).not.toBeInTheDocument();
    });

    it('renders "Reconnecting..." in the connection-status pill when isConnected is false', () => {
      renderHeader({ isConnected: false });
      expect(screen.getByTestId('connection-status')).toHaveTextContent('Reconnecting...');
    });
  });

  describe('regression guard', () => {
    it('never renders the string "Socket.io"', () => {
      renderHeader({ isConnected: true });
      expect(screen.queryByText(/Socket\.io/i)).not.toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/Socket\.io/i);
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
