/**
 * src/api/client.js — (D44)
 * Fetch wrapper that adds Bearer header, parses flat error format,
 * maps known error codes, supports AbortSignal.
 *
 * NEVER logs or renders the token.
 */

let API_BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) || 'http://localhost:3000';

export function setApiBase(url) {
  API_BASE_URL = url;
}

export function getApiBase() {
  return API_BASE_URL;
}

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
 * Normalises list responses to an array.
 * Throws a clear error if the shape is unexpected.
 */
export function asList(data, key = 'items', endpoint = '') {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'object') {
    if (key && Array.isArray(data[key])) {
      return data[key];
    }
    if (key !== 'items' && Array.isArray(data.items)) {
      return data.items;
    }
    if (Array.isArray(data.events)) return data.events;
    if (Array.isArray(data.proposals)) return data.proposals;
    if (Array.isArray(data.sources)) return data.sources;
    if (Array.isArray(data.schemas)) return data.schemas;
  }
  const epLabel = endpoint ? ` for ${endpoint}` : '';
  throw new Error(`Unexpected response shape${epLabel}: expected array or object with '${key}' array`);
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

  const res = await fetch(`${API_BASE_URL}${path}`, {
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

/** Typed and normalised domain API fetchers */
export async function getEvents(token, query = {}) {
  const params = new URLSearchParams();
  if (query.limit) params.set('limit', String(query.limit));
  if (query.page) params.set('page', String(query.page));
  if (query.status) params.set('status', query.status);
  if (query.sourceSlug) params.set('sourceSlug', query.sourceSlug);
  const qStr = params.toString() ? `?${params.toString()}` : '';
  const data = await apiGet(`/api/events${qStr}`, token);
  return asList(data, 'items', '/api/events').map((ev) => ({
    ...ev,
    id: ev._id || ev.id || ev.eventId,
  }));
}

export async function getQuarantine(token, query = {}) {
  const params = new URLSearchParams();
  if (query.limit) params.set('limit', String(query.limit));
  const qStr = params.toString() ? `?${params.toString()}` : '';
  const data = await apiGet(`/api/quarantine${qStr}`, token);
  return asList(data, 'items', '/api/quarantine');
}

export async function getProposals(token, query = {}) {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.limit) params.set('limit', String(query.limit));
  const qStr = params.toString() ? `?${params.toString()}` : '';
  const data = await apiGet(`/api/proposals${qStr}`, token);
  return asList(data, 'items', '/api/proposals').map((p) => ({
    ...p,
    id: p._id || p.id,
  }));
}

export async function getProposal(id, token) {
  const p = await apiGet(`/api/proposals/${id}`, token);
  if (!p) return null;
  return {
    ...p,
    id: p._id || p.id,
  };
}

export async function getSchemas(token) {
  const data = await apiGet('/api/schemas', token);
  return asList(data, 'schemas', '/api/schemas').map((s) => ({
    ...s,
    id: s._id || s.id,
  }));
}

export async function getSources(token) {
  const data = await apiGet('/api/sources', token);
  return asList(data, 'sources', '/api/sources').map((s) => ({
    ...s,
    id: s._id || s.id,
  }));
}

export async function getStats(token) {
  const data = await apiGet('/api/stats', token);
  const byStatus = data?.byStatus || {};
  const eventCounts = {
    received: Number(byStatus.received || 0),
    processing: Number(byStatus.processing || 0),
    delivered: Number(byStatus.delivered || 0),
    quarantined: Number(byStatus.quarantined || 0),
    failed: Number(byStatus.failed || 0),
    dead: Number(byStatus.dead || 0),
    requeue_pending: Number(byStatus.requeue_pending || 0),
  };
  return {
    ...data,
    byStatus,
    eventCounts,
    pendingProposals: Number(data?.pendingProposals || 0),
    sseClients: Number(data?.sseClients || 0),
    queues: data?.queues || {},
    last24h: Array.isArray(data?.last24h) ? data.last24h : [],
  };
}

export async function simulate(token, payload) {
  return apiPost('/api/simulate', token, payload);
}
