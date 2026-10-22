import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, apiGet, apiPost, apiPatch, apiDel, ApiError } from '../src/api/client.js';

describe('Dashboard API Client (D44)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('attaches Bearer token in Authorization header', async () => {
    let capturedHeaders = null;
    globalThis.fetch = vi.fn().mockImplementation((url, init) => {
      capturedHeaders = init.headers;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });
    });

    const res = await apiGet('/api/stats', 'test-secret-token-123');
    expect(res).toEqual({ success: true });
    expect(capturedHeaders['Authorization']).toBe('Bearer test-secret-token-123');
  });

  it('omits Authorization header when token is not provided', async () => {
    let capturedHeaders = null;
    globalThis.fetch = vi.fn().mockImplementation((url, init) => {
      capturedHeaders = init.headers;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      });
    });

    await apiFetch('/health');
    expect(capturedHeaders['Authorization']).toBeUndefined();
  });

  it('handles 204 No Content response gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.reject(new Error('no json')),
    });

    const res = await apiDel('/api/sources/123', 'tok');
    expect(res).toBeNull();
  });

  it('maps known error codes to friendly messages (D44)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: 'STALE_BASE', message: 'Version conflict', requestId: 'req-1' }),
    });

    try {
      await apiPost('/api/proposals/1/approve', 'tok', { currentSchemaVersion: 1 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('STALE_BASE');
      expect(err.status).toBe(409);
      expect(err.requestId).toBe('req-1');
      expect(err.friendlyMessage).toContain('base schema version has changed');
    }
  });

  it('throws UNAUTHORIZED on 401 status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'UNAUTHORIZED', message: 'Missing token' }),
    });

    await expect(apiGet('/api/sources', 'bad-tok')).rejects.toThrow(ApiError);
  });

  it('supports AbortSignal for cancellation', async () => {
    const controller = new AbortController();
    let passedSignal = null;
    globalThis.fetch = vi.fn().mockImplementation((url, init) => {
      passedSignal = init.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });
    });

    await apiGet('/api/events', 'tok', controller.signal);
    expect(passedSignal).toBe(controller.signal);
  });
});
