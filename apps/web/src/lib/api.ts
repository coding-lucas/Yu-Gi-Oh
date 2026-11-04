export class ApiError extends Error {
  constructor(public status: number, public code: string, public details?: any) {
    super(code);
  }
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'x-athos-csrf': '1' } })
    .then((r) => r.ok)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

/**
 * Same-origin JSON client. Auth uses httpOnly cookies; mutations carry the CSRF header.
 * A 401 triggers one transparent refresh-token rotation and a retry.
 */
/** Static demo build (GitHub Pages): no server — requests are served by the in-browser backend. */
export const STATIC_DEMO = process.env.NEXT_PUBLIC_STATIC_DEMO === '1';

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}, retry = true): Promise<T> {
  if (STATIC_DEMO) {
    const { handle } = await import('./demo/backend');
    return handle(init.method ?? 'GET', path, init.json) as Promise<T>;
  }
  const headers: Record<string, string> = { 'x-athos-csrf': '1', ...(init.headers as Record<string, string>) };
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, { ...init, headers, credentials: 'include', body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await refresh()) return api<T>(path, init, false);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.code ?? 'GENERIC', body?.details);
  return body as T;
}
