const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '';

export function resolveApiUrl(path: string): string {
  if (!path.startsWith('/')) {
    return path;
  }

  if (!API_BASE_URL) {
    return path;
  }

  return `${API_BASE_URL}${path}`;
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(resolveApiUrl(input), init);
}

/**
 * The single place the session bearer token is turned into a request header.
 *
 * Every authenticated endpoint (create/edit listing, mark sold, account activity, admin)
 * goes through here so there is exactly one mechanism to change if the scheme ever moves.
 * A missing token still produces the header (as `Bearer undefined` would have before) only
 * when a token is actually present -- otherwise the header is omitted entirely and the
 * server answers with its own UNAUTHORIZED error, which the UI already renders.
 */
export function authHeaders(token?: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** `apiFetch` plus the session bearer token, merged over any caller-supplied headers. */
export async function apiFetchAuthed(
  input: string,
  token: string | null | undefined,
  init?: RequestInit,
): Promise<Response> {
  return apiFetch(input, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      ...authHeaders(token),
    },
  });
}
