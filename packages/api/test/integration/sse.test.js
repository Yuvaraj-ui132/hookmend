/**
 * packages/api/test/integration/sse.test.js
 * Integration tests for GET /api/sse (D33-D37).
 * Uses MongoMemoryReplSet for change stream support.
 *
 * NOTE: These tests run the server on an ephemeral port and make real HTTP
 * requests using node fetch so SSE streaming is exercised end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { createServer } from 'node:http';
import { createApp } from '../../src/server.js';
import { createIndexes, createSseWatcher } from '@hookmend/common';

const ADMIN_TOKEN = 'test-sse-token';
const AUTH_HEADER = `Bearer ${ADMIN_TOKEN}`;
const HEARTBEAT_MS = 100;

let replSet;
let mongoClient;
let db;
let server;
let baseUrl;
let watcher;
let config;

function getUrl(path) {
  return `${baseUrl}${path}`;
}

/**
 * Read SSE lines from a response, collecting N events within timeoutMs.
 * Resolves with array of { event, data } objects.
 */
async function collectSseEvents(url, options = {}, count = 1, timeoutMs = 5000) {
  const { headers = {}, token = ADMIN_TOKEN } = options;
  const collected = [];

  const resp = await fetch(url, {
    headers: {
      Authorization: token ? `Bearer ${token}` : '',
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs + 500),
  });

  if (!resp.ok && resp.status !== 200) {
    return { status: resp.status, events: [], headers: Object.fromEntries(resp.headers) };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';
  let resolved = false;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reader.cancel();
      resolve({ status: resp.status, events: collected, headers: Object.fromEntries(resp.headers) });
    }, timeoutMs);

    async function read() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line

          for (const line of lines) {
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              currentData = line.slice(5).trim();
            } else if (line === '') {
              // blank line = end of SSE message
              if (currentEvent || currentData) {
                collected.push({ event: currentEvent, data: currentData });
                currentEvent = '';
                currentData = '';
                if (collected.length >= count && !resolved) {
                  resolved = true;
                  clearTimeout(timeout);
                  reader.cancel();
                  resolve({ status: resp.status, events: collected, headers: Object.fromEntries(resp.headers) });
                  return;
                }
              }
            }
          }
        }
      } catch {
        // AbortError or cancel — resolve with what we have
        clearTimeout(timeout);
        resolve({ status: resp.status, events: collected, headers: Object.fromEntries(resp.headers) });
      }
    }
    read();
  });
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  mongoClient = new MongoClient(uri);
  await mongoClient.connect();
  db = mongoClient.db('test_sse');
  await createIndexes(db);

  config = {
    NODE_ENV: 'test',
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    MONGODB_URI: uri,
    REDIS_URL: 'redis://localhost:6379',
    QUEUE_PREFIX: 'hookmend-test-sse',
    MAX_SCHEMA_BYTES: 102400,
    REPLAY_MAX_EVENTS: 1000,
    SSE_HEARTBEAT_MS: HEARTBEAT_MS,
    MAX_SSE_CLIENTS: 3,
    ENABLE_SIMULATOR_API: false,
    SIMULATOR_SOURCES: 'sim-payments',
    DASHBOARD_ORIGINS: 'http://localhost:5173',
  };

  watcher = createSseWatcher({ db, config });
  await watcher.start();

  const queue = {
    enqueue: async () => ({ id: 'mock-job' }),
    close: async () => {},
    getQueue: () => ({
      getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0 }),
    }),
  };

  const app = createApp({ db, queue, config, watcher });

  await new Promise((resolve) => {
    server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}, 60000);

afterAll(async () => {
  if (watcher) await watcher.stop();
  await new Promise((resolve) => server.close(resolve));
  await mongoClient.close();
  await replSet.stop();
}, 30000);

beforeEach(async () => {
  await db.collection('events').deleteMany({});
  await db.collection('proposals').deleteMany({});
  await db.collection('sources').deleteMany({});
});

describe('GET /api/sse', () => {
  it('returns 401 without a token', async () => {
    const resp = await fetch(getUrl('/api/sse'), {
      signal: AbortSignal.timeout(3000),
      headers: {},
    });
    expect(resp.status).toBe(401);
  });

  it('returns 401 with wrong token', async () => {
    const resp = await fetch(getUrl('/api/sse'), {
      headers: { Authorization: 'Bearer wrong-token' },
      signal: AbortSignal.timeout(3000),
    });
    expect(resp.status).toBe(401);
  });

  it('connects with valid token and returns SSE headers', async () => {
    const resp = await fetch(getUrl('/api/sse'), {
      headers: { Authorization: AUTH_HEADER },
      signal: AbortSignal.timeout(3000),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch('text/event-stream');
    expect(resp.headers.get('cache-control')).toMatch('no-cache');
    resp.body.cancel();
  });

  it('delivers event.received after insert into events collection', async () => {
    const sourceResult = await db.collection('sources').insertOne({
      slug: 'test-src',
      name: 'Test',
      adapter: 'generic-hmac',
      secretEnvVar: 'TEST_SECRET',
      downstreamUrl: 'http://127.0.0.1:9999/receive',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Start collecting SSE, then insert a document
    const collectPromise = collectSseEvents(getUrl('/api/sse'), {}, 1, 8000);

    // Give SSE connection time to establish
    await new Promise((r) => setTimeout(r, 300));

    await db.collection('events').insertOne({
      eventId: 'evt-sse-test-1',
      sourceId: sourceResult.insertedId,
      sourceSlug: 'test-src',
      eventType: 'payment.created',
      status: 'received',
      deliveryAttempts: 0,
      lastErrorCode: null,
      driftFingerprint: null,
      receivedAt: new Date(),
      schemaVersion: 1,
      payload: { secret: 'should_not_appear' },
      headers: { authorization: 'Bearer should_not_appear' },
      rawBodyHash: 'hash_should_not_appear',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await collectPromise;
    expect(result.events.length).toBeGreaterThanOrEqual(1);
    const evt = result.events.find((e) => e.event === 'event.received');
    expect(evt).toBeDefined();

    // Verify no sensitive data in any SSE message
    const allData = result.events.map((e) => e.data).join('');
    expect(allData).not.toContain('should_not_appear');
    expect(allData).not.toContain('rawBodyHash');
    expect(allData).not.toContain('payload');
  }, 15000);

  it('delivers event.delivered after status update', async () => {
    // Insert event first
    const insertRes = await db.collection('events').insertOne({
      eventId: 'evt-sse-update-1',
      sourceSlug: 'test-src',
      eventType: 'payment.created',
      status: 'received',
      deliveryAttempts: 0,
      lastErrorCode: null,
      driftFingerprint: null,
      receivedAt: new Date(),
      schemaVersion: 1,
      payload: { amount: 100 },
      headers: {},
      rawBodyHash: 'hash123',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await new Promise((r) => setTimeout(r, 200));

    const collectPromise = collectSseEvents(getUrl('/api/sse'), {}, 1, 8000);
    await new Promise((r) => setTimeout(r, 300));

    // Update status to delivered
    await db.collection('events').updateOne(
      { _id: insertRes.insertedId },
      { $set: { status: 'delivered', updatedAt: new Date() } }
    );

    const result = await collectPromise;
    expect(result.events.some((e) => e.event === 'event.delivered')).toBe(true);
  }, 15000);

  it('returns 503 when MAX_SSE_CLIENTS is exceeded', async () => {
    const conns = [];
    // Open MAX_SSE_CLIENTS connections
    for (let i = 0; i < 3; i++) {
      const resp = await fetch(getUrl('/api/sse'), {
        headers: { Authorization: AUTH_HEADER },
        signal: AbortSignal.timeout(5000),
      });
      expect(resp.status).toBe(200);
      conns.push(resp);
    }

    // Next one should get 503
    const overflow = await fetch(getUrl('/api/sse'), {
      headers: { Authorization: AUTH_HEADER },
      signal: AbortSignal.timeout(3000),
    });
    expect(overflow.status).toBe(503);

    // Cleanup
    for (const c of conns) c.body.cancel();
  }, 20000);

  it('heartbeat comment arrives within SSE_HEARTBEAT_MS*3', async () => {
    // We check that within 3 heartbeat periods, data arrives (comment lines)
    // We collect raw bytes by looking for ': heartbeat' in the stream
    let foundHeartbeat = false;
    const resp = await fetch(getUrl('/api/sse'), {
      headers: { Authorization: AUTH_HEADER },
      signal: AbortSignal.timeout(5000),
    });
    expect(resp.status).toBe(200);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        reader.cancel();
        resolve();
      }, HEARTBEAT_MS * 5);

      async function read() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (text.includes(': heartbeat')) {
              foundHeartbeat = true;
              clearTimeout(timeout);
              reader.cancel();
              resolve();
              return;
            }
          }
        } catch {
          // cancelled
          resolve();
        }
      }
      read();
    });

    expect(foundHeartbeat).toBe(true);
  }, 15000);

  it('SSE data never contains "payload" or "headers" substring', async () => {
    const collectPromise = collectSseEvents(getUrl('/api/sse'), {}, 1, 3000);
    await new Promise((r) => setTimeout(r, 200));

    await db.collection('events').insertOne({
      eventId: 'evt-no-leak',
      sourceSlug: 'test-src',
      eventType: 'payment.created',
      status: 'received',
      deliveryAttempts: 0,
      lastErrorCode: null,
      driftFingerprint: null,
      receivedAt: new Date(),
      schemaVersion: 1,
      payload: { orderId: 'ORD-SECRET-123', amount: 999 },
      headers: { 'x-secret': 'should-not-leak' },
      rawBodyHash: 'secret_hash_value',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await collectPromise;
    for (const evt of result.events) {
      if (evt.data) {
        expect(evt.data).not.toContain('payload');
        expect(evt.data).not.toContain('headers');
        expect(evt.data).not.toContain('rawBodyHash');
        expect(evt.data).not.toContain('ORD-SECRET-123');
        expect(evt.data).not.toContain('should-not-leak');
      }
    }
  }, 12000);
});
