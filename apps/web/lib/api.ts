/**
 * Browser API client for the console. The access token lives in memory only; the httpOnly refresh
 * cookie restores it after a reload. On a 401 we refresh once and retry.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
const listeners = new Set<(signedIn: boolean) => void>();

export const hasAccessToken = () => accessToken !== null;

export const setAccessToken = (token: string | null) => {
  accessToken = token;
  listeners.forEach((l) => l(!!token));
};
export const onAuthChange = (fn: (signedIn: boolean) => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

const CSRF = { 'x-datascribe-csrf': '1' };

async function toError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  return new ApiError(
    res.status,
    body?.error?.code ?? 'http_error',
    body?.error?.message ?? `Request failed (${res.status})`,
    body,
  );
}

export function refreshSession(): Promise<string | null> {
  refreshing ??= fetch('/api/v1/auth/refresh', {
    method: 'POST',
    headers: CSRF,
    credentials: 'same-origin',
  })
    .then(async (res) => {
      const token = res.ok ? ((await res.json()) as { accessToken: string }).accessToken : null;
      setAccessToken(token);
      return token;
    })
    .catch(() => {
      setAccessToken(null);
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

type Body = Record<string, unknown> | unknown[] | string | undefined;

export async function api<T>(
  path: string,
  opts: { method?: string; body?: Body; contentType?: string; raw?: boolean } = {},
): Promise<T> {
  const send = () => {
    const headers: Record<string, string> = {};
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    let body: BodyInit | undefined;
    if (typeof opts.body === 'string') {
      body = opts.body;
      headers['content-type'] = opts.contentType ?? 'text/plain';
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    return fetch(`/api/v1${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
    });
  };

  let res = await send();
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) res = await send();
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  if (opts.raw) return (await res.text()) as T;
  return (await res.json()) as T;
}

export async function logout() {
  await fetch('/api/v1/auth/logout', { method: 'POST', headers: CSRF, credentials: 'same-origin' });
  setAccessToken(null);
}

/** Download a binary file (e.g. an invoice PDF) with the bearer token. */
export async function downloadFile(path: string, filename: string) {
  const send = () =>
    fetch(`/api/v1${path}`, {
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
      credentials: 'same-origin',
    });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  if (!res.ok) throw await toError(res);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Fetch an image with the bearer token (an <img src> can't send it) as an object URL; null when the
 * API has none (404). The caller revokes the URL.
 */
export async function fetchObjectUrl(path: string, signal?: AbortSignal): Promise<string | null> {
  const send = () =>
    fetch(`/api/v1${path}`, {
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
      credentials: 'same-origin',
      signal,
    });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  if (res.status === 404) return null;
  if (!res.ok) throw await toError(res);
  return URL.createObjectURL(await res.blob());
}

/** Download a CSV export with the bearer token (a plain link can't send it). */
export async function downloadCsv(path: string, filename: string) {
  const text = await api<string>(path, { raw: true });
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
