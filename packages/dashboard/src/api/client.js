/**
 * src/api/client.js — (D44)
 * Fetch wrapper that adds Bearer header, parses flat error format,
 * maps known error codes, supports AbortSignal.
 *
 * NEVER logs or renders the token.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

/** Human-readable messages for known API error codes */
const ERROR_MESSAGES = {
  STALE_BASE: 'The base schema version has changed — refresh and try again.',
  REPLAY_FAILURES: 'Some events failed replay against the proposed schema.',
  NEEDS_SCHEMA: 'No proposed schema is set on this proposal.',
  INVALID_STATE: 'This action is not allowed in the current state.',
  INVALID_SCHEMA: 'The schema is invalid and could not be compiled.',
  RATE_LIMITED: 'Too many requests — please slow down.',
  TOO_MANY_STREAMS: 'Maximum SSE connections reached — try again later.',
  SSE_UNAVAILABLE: 'Live updates are unavailable on this server.',
  UNAUTHORIZED: 'Authentication failed — check your token.',
  NOT_FOUND: 'The requested resource was not found.',
  SLUG_EXISTS: 'A source with that slug already exists.',
  SCHEMA_EXISTS: 'A schema already exists for this source and event type.',
  INVALID_URL: 'The downstream URL is invalid or forbidden.',
  FORBIDDEN: 'Access denied for this operation.',
};

export class ApiError extends Error {
  constructor(code, message, status, requestId) {
    super(message);
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.friendlyMessage = ERROR_MESSAGES[code] || message;
  }
}

/**
 * @param {string} path - API path (e.g. '/api/events')
 * @param {{ token: string, method?: string, body?: object, signal?: AbortSignal }} opts
 */
export async function apiFetch(path, opts = {}) {
  const { token, method = 'GET', body, signal } = opts;

  const headers = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    signal,
  });

  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(
      data.error || 'UNAUTHORIZED',
      data.message || 'Unauthorized',
      401,
      data.requestId
    );
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(
      data.error || 'UNKNOWN',
      data.message || `HTTP ${res.status}`,
      res.status,
      data.requestId
    );
  }

  if (res.status === 204) return null;

  return res.json();
}

/** Convenience helpers */
export const apiGet  = (path, token, signal) => apiFetch(path, { token, signal });
export const apiPost = (path, token, body)   => apiFetch(path, { token, method: 'POST', body });
export const apiPatch= (path, token, body)   => apiFetch(path, { token, method: 'PATCH', body });
export const apiDel  = (path, token)          => apiFetch(path, { token, method: 'DELETE' });
