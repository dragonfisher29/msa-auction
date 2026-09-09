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
