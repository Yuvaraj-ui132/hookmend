/**
 * phase4-hardening.test.js — Phase 4 STEP 1 tests for D54
 * (D49 worker knob test is in packages/worker/test/)
 *
 * Tests:
 * (a) D54(a): Body > MAX_BODY_SIZE -> 413 and nothing stored
 * (b) D54(d): Secure-headers middleware on /api responses
 * (c) D54(e): Production-token startup guard
 * (d) D54(c): Admin auth 401 checks
 * (e) D50: Receiver slow mode
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import supertest from 'supertest';
import crypto from 'node:crypto';

// ────────────────────────────────────────────────────────────────────────────────
// Test app factory
// ────────────────────────────────────────────────────────────────────────────────

async function buildApp(configOverrides = {}) {
  const { createApp } = await import('../../src/server.js');

  const config = {
    PORT: 0,
    NODE_ENV: 'test',
    MAX_BODY_SIZE: 512,
    TIMESTAMP_TOLERANCE_SECONDS: 300,
    INGEST_RATE_LIMIT_MAX: 1000,
    INGEST_RATE_LIMIT_WINDOW_MS: 60000,
    EVENT_TTL_DAYS: 14,
    LOG_LEVEL: 'silent',
    REDIS_URL: 'redis://localhost:6379',
    QUEUE_PREFIX: 'test',
    ADMIN_API_TOKEN: 'test-token-for-hardening-tests-xxxx',
    DOWNSTREAM_TIMEOUT_MS: 10000,
    ENABLE_AI: false,
    SSE_HEARTBEAT_MS: 25000,
    MAX_SSE_CLIENTS: 20,
    DASHBOARD_ORIGINS: 'http://localhost:5173',
    ENABLE_SIMULATOR_API: false,
    SIMULATOR_SOURCES: '',
    ALLOW_PRIVATE_DOWNSTREAM: false,
    GEMINI_RPM_LIMIT: 10,
    GEMINI_RPD_LIMIT: 100,
    MAX_SCHEMA_BYTES: 102400,
    REPLAY_MAX_EVENTS: 1000,
    ...configOverrides,
  };

  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  const db = client.db('hardening_test');

  const queue = {
    enqueue: vi.fn().mockResolvedValue({ id: 'test-job' }),
    ping: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
    getQueue: vi.fn().mockReturnValue({ getJobCounts: vi.fn().mockResolvedValue({}) }),
    redisConnection: { status: 'ready' },
  };

  const watcher = {
    start: vi.fn(),
    stop: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    getClientCount: vi.fn().mockReturnValue(0),
  };

  const app = createApp({ db, queue, config, watcher });

  return { app, mongod, client, db, queue, config };
}

// ────────────────────────────────────────────────────────────────────────────────
// (a) D54(a): 413 on oversized body
// ────────────────────────────────────────────────────────────────────────────────

describe('D54(a): 413 on oversized body', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await buildApp({ MAX_BODY_SIZE: 512 });
    const SECRET = 'test-secret-413-xyz';
    process.env['HMAC_413_SECRET'] = SECRET;
    await ctx.db.collection('sources').insertOne({
      slug: 'test-413',
      adapter: 'generic-hmac',
      secretEnvVar: 'HMAC_413_SECRET',
      active: true,
      downstreamUrl: 'http://localhost:9999/receive',
    });
  });

  afterAll(async () => {
    await ctx.client?.close();
    await ctx.mongod?.stop();
  });

  it('returns 413 when body exceeds MAX_BODY_SIZE', async () => {
    const oversized = JSON.stringify({ data: 'x'.repeat(600) });
    const res = await supertest(ctx.app)
      .post('/ingest/test-413')
      .set('content-type', 'application/json')
      .set('x-gateway-delivery-id', crypto.randomUUID())
      .set('x-gateway-timestamp', String(Date.now()))
      .set('x-gateway-signature', 'sha256=invalid')
      .send(oversized);

    expect(res.status).toBe(413);
  });

  it('stores nothing in DB when body exceeds MAX_BODY_SIZE', async () => {
    const before = await ctx.db.collection('events').countDocuments({});
    const oversized = JSON.stringify({ data: 'y'.repeat(600) });

    await supertest(ctx.app)
      .post('/ingest/test-413')
      .set('content-type', 'application/json')
      .set('x-gateway-delivery-id', crypto.randomUUID())
      .set('x-gateway-timestamp', String(Date.now()))
      .set('x-gateway-signature', 'sha256=invalid')
      .send(oversized);

    const after = await ctx.db.collection('events').countDocuments({});
    expect(after).toBe(before);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// (b) D54(d): Secure headers middleware
// ────────────────────────────────────────────────────────────────────────────────

describe('D54(d): Secure headers middleware', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await buildApp();
  });

  afterAll(async () => {
    await ctx.client?.close();
    await ctx.mongod?.stop();
  });

  it('sets X-Content-Type-Options: nosniff on /api responses', async () => {
    const res = await supertest(ctx.app)
      .get('/api/admin/status')
      .set('Authorization', `Bearer ${ctx.config.ADMIN_API_TOKEN}`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options: DENY on /api responses', async () => {
    const res = await supertest(ctx.app)
      .get('/api/admin/status')
      .set('Authorization', `Bearer ${ctx.config.ADMIN_API_TOKEN}`);
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets Referrer-Policy: no-referrer on /api responses', async () => {
    const res = await supertest(ctx.app)
      .get('/api/admin/status')
      .set('Authorization', `Bearer ${ctx.config.ADMIN_API_TOKEN}`);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('sets Cache-Control: no-store on /api responses', async () => {
    const res = await supertest(ctx.app)
      .get('/api/admin/status')
      .set('Authorization', `Bearer ${ctx.config.ADMIN_API_TOKEN}`);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// (c) D54(e): Production-token startup guard
// (note: config is ESM without cache busting; each test mutates env before calling getConfig())
// ────────────────────────────────────────────────────────────────────────────────

describe('D54(e): Production ADMIN_API_TOKEN startup guard', () => {
  // Save originals
  const savedEnv = {};

  beforeAll(() => {
    savedEnv.NODE_ENV = process.env.NODE_ENV;
    savedEnv.ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
    savedEnv.MONGODB_URI = process.env.MONGODB_URI;
  });

  afterAll(() => {
    if (savedEnv.NODE_ENV !== undefined) process.env.NODE_ENV = savedEnv.NODE_ENV;
    else delete process.env.NODE_ENV;
    if (savedEnv.ADMIN_API_TOKEN !== undefined) process.env.ADMIN_API_TOKEN = savedEnv.ADMIN_API_TOKEN;
    else delete process.env.ADMIN_API_TOKEN;
    if (savedEnv.MONGODB_URI !== undefined) process.env.MONGODB_URI = savedEnv.MONGODB_URI;
    else delete process.env.MONGODB_URI;
  });

  it('throws when NODE_ENV=production and ADMIN_API_TOKEN is missing', async () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
    process.env.NODE_ENV = 'production';
    delete process.env.ADMIN_API_TOKEN;

    const { default: getConfig } = await import('../../src/config.js');
    expect(() => getConfig()).toThrow(/ADMIN_API_TOKEN/);
  });

  it('throws when NODE_ENV=production and ADMIN_API_TOKEN equals "change-me"', async () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_API_TOKEN = 'change-me';

    const { default: getConfig } = await import('../../src/config.js');
    expect(() => getConfig()).toThrow(/ADMIN_API_TOKEN/);
  });

  it('throws when NODE_ENV=production and ADMIN_API_TOKEN is shorter than 24 characters', async () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_API_TOKEN = 'short';

    const { default: getConfig } = await import('../../src/config.js');
    expect(() => getConfig()).toThrow(/ADMIN_API_TOKEN/);
  });

  it('succeeds when NODE_ENV=production and ADMIN_API_TOKEN is a long secure value', async () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_API_TOKEN = 'secure-token-that-is-at-least-24-chars';

    const { default: getConfig } = await import('../../src/config.js');
    expect(() => getConfig()).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// (d) D54(c): Admin auth 401 checks
// ────────────────────────────────────────────────────────────────────────────────

describe('D54(c): Admin auth 401 checks', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await buildApp();
  });

  afterAll(async () => {
    await ctx.client?.close();
    await ctx.mongod?.stop();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await supertest(ctx.app).get('/api/admin/status');
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization header is malformed (no Bearer)', async () => {
    const res = await supertest(ctx.app)
      .get('/api/admin/status')
      .set('Authorization', 'Token sometoken');
    expect(res.status).toBe(401);
  });

  it('returns 401 when wrong token is provided', async () => {
    const res = await supertest(ctx.app)
      .get('/api/admin/status')
      .set('Authorization', 'Bearer wrong-token-here');
    expect(res.status).toBe(401);
  });

  it('returns non-401 with correct token (auth passes)', async () => {
    const res = await supertest(ctx.app)
      .get('/api/admin/status')
      .set('Authorization', `Bearer ${ctx.config.ADMIN_API_TOKEN}`);
    // Auth passes — may be 200 or 500 depending on Redis being available in test
    expect(res.status).not.toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// (e) D50: Receiver slow mode
// ────────────────────────────────────────────────────────────────────────────────

describe('D50: Receiver slow mode', () => {
  it('slow mode: setMode programmatically responds after delayMs', async () => {
    const { startReceiver } = await import('../../../simulator/src/receiver.js');
    const receiver = await startReceiver({ port: 0 });

    try {
      receiver.setMode('slow', 80);

      const start = Date.now();
      const res = await fetch(`http://localhost:${receiver.port}/receive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hookmend-event-id': 'slow-test-prog' },
        body: JSON.stringify({ test: 1 }),
      });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      expect(elapsed).toBeGreaterThanOrEqual(60);
    } finally {
      await receiver.close();
    }
  });

  it('slow mode: POST /__mode {mode:"slow", delayMs} and deliver after delay', async () => {
    const { startReceiver } = await import('../../../simulator/src/receiver.js');
    const receiver = await startReceiver({ port: 0 });

    try {
      const modeRes = await fetch(`http://localhost:${receiver.port}/__mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'slow', delayMs: 80 }),
      });
      expect(modeRes.status).toBe(200);
      const body = await modeRes.json();
      expect(body.mode).toBe('slow');

      const start = Date.now();
      const res = await fetch(`http://localhost:${receiver.port}/receive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hookmend-event-id': 'slow-test-http' },
        body: JSON.stringify({ test: 1 }),
      });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      expect(elapsed).toBeGreaterThanOrEqual(60);
    } finally {
      await receiver.close();
    }
  });

  it('/__stats tracks counts by x-hookmend-event-id', async () => {
    const { startReceiver } = await import('../../../simulator/src/receiver.js');
    const receiver = await startReceiver({ port: 0 });

    try {
      const evId = 'stats-test-' + Date.now();
      await fetch(`http://localhost:${receiver.port}/receive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hookmend-event-id': evId },
        body: JSON.stringify({}),
      });
      await fetch(`http://localhost:${receiver.port}/receive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hookmend-event-id': evId },
        body: JSON.stringify({}),
      });

      const statsRes = await fetch(`http://localhost:${receiver.port}/__stats`);
      const stats = await statsRes.json();
      expect(stats.stats[evId]).toBe(2);
      expect(stats.totalRequests).toBeGreaterThanOrEqual(2);
    } finally {
      await receiver.close();
    }
  });
});
