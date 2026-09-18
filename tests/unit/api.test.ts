import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('resolveApiUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('returns the path unchanged when no base URL is configured', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    const { resolveApiUrl } = await import('../../src/lib/api');
    expect(resolveApiUrl('/api/health')).toBe('/api/health');
  });

  it('prefixes the path with the base URL when one is set', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com');
    const { resolveApiUrl } = await import('../../src/lib/api');
    expect(resolveApiUrl('/api/health')).toBe('https://api.example.com/api/health');
  });

  it('strips a trailing slash from the base URL before prefixing', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/');
    const { resolveApiUrl } = await import('../../src/lib/api');
    expect(resolveApiUrl('/api/health')).toBe('https://api.example.com/api/health');
  });

  it('leaves absolute URLs that do not start with "/" untouched, even with a base URL set', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com');
    const { resolveApiUrl } = await import('../../src/lib/api');
    expect(resolveApiUrl('https://other.example.com/foo')).toBe('https://other.example.com/foo');
  });
});
