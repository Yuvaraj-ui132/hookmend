import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import supertest from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createQueue } from '../../src/queue/stub.js';
import { connectDb } from '../../src/db/client.js';

// ─── Test Setup ───────────────────────────────────────────────────────────────

let mongod, mongoClient, db, app, request, queue;
const SECRET = 'integration-test-secret';
const SIM_SOURCE_SLUG = 'test-sim';
const GH_SOURCE_SLUG = 'test-github';
let simSourceId, ghSourceId;

function signGenericHmac(secret, timestamp, rawBodyStr) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBodyStr}`).digest('hex');
}

function signGithub(secret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function makeGenericHeaders(body, secret, opts = {}) {
  const ts = opts.timestamp ?? String(Date.now());
  return {
    'content-type': 'application/json',
    'x-gateway-signature': signGenericHmac(secret, ts, body),
    'x-gateway-timestamp': ts,
    'x-gateway-delivery-id': opts.deliveryId ?? crypto.randomUUID(),
  };
}

function makeGithubHeaders(body, secret, opts = {}) {
  return {
    'content-type': 'application/json',
    'x-hub-signature-256': signGithub(secret, Buffer.from(body)),
    'x-github-delivery': opts.deliveryId ?? crypto.randomUUID(),
    'x-github-event': opts.eventType ?? 'push',
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri() + 'hookmend_test';

  // Override MONGODB_URI for this test run
  process.env.MONGODB_URI = uri;
  process.env.INGEST_RATE_LIMIT_MAX = '1000';
  process.env.INGEST_RATE_LIMIT_WINDOW_MS = '60000';
  process.env[`SIM_TEST_SECRET`] = SECRET;
  process.env[`GITHUB_TEST_SECRET`] = SECRET;

  mongoClient = await connectDb(uri);
  db = mongoClient.db();

  // Seed two test sources
  const now = new Date();
  const simRes = await db.collection('sources').insertOne({
    slug: SIM_SOURCE_SLUG,
    name: 'Test Simulator',
    adapter: 'generic-hmac',
    secretEnvVar: 'SIM_TEST_SECRET',
    downstreamUrl: 'http://localhost:4001/receive',
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  simSourceId = simRes.insertedId;

  const ghRes = await db.collection('sources').insertOne({
    slug: GH_SOURCE_SLUG,
    name: 'Test GitHub',
    adapter: 'github',
    secretEnvVar: 'GITHUB_TEST_SECRET',
    downstreamUrl: 'http://localhost:4001/receive',
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  ghSourceId = ghRes.insertedId;

  // Inactive source
  await db.collection('sources').insertOne({
    slug: 'test-inactive',
    name: 'Inactive Source',
    adapter: 'generic-hmac',
    secretEnvVar: 'SIM_TEST_SECRET',
    downstreamUrl: 'http://localhost:4001/receive',
    active: false,
    createdAt: now,
    updatedAt: now,
  });

  // Source with missing env var
  await db.collection('sources').insertOne({
    slug: 'test-no-secret',
    name: 'No Secret Source',
    adapter: 'generic-hmac',
    secretEnvVar: 'THIS_ENV_VAR_DOES_NOT_EXIST_AT_ALL',
    downstreamUrl: 'http://localhost:4001/receive',
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  queue = createQueue();
  const cfg = {
    PORT: 0,
    NODE_ENV: 'test',
    MONGODB_URI: uri,
    MAX_BODY_SIZE: 524288,
    TIMESTAMP_TOLERANCE_SECONDS: 300,
    INGEST_RATE_LIMIT_MAX: 1000,
    INGEST_RATE_LIMIT_WINDOW_MS: 60000,
    EVENT_TTL_DAYS: 14,
    LOG_LEVEL: 'silent',
    VERSION: '0.2.0',
  };
  app = createApp({ db, queue, config: cfg });
  request = supertest(app);
});

afterAll(async () => {
  await mongoClient.close();
  await mongod.stop();
});

beforeEach(() => {
  queue.jobs.length = 0;
});

// ─── Happy Path: generic-hmac ─────────────────────────────────────────────────

describe('POST /ingest/:sourceSlug - generic-hmac happy path', () => {
  it('returns 200 ok:true deduplicated:false; doc stored; queue enqueued', async () => {
    const body = JSON.stringify({ event: 'payment.created', orderId: 'o-001', amount: 1000 });
    const headers = makeGenericHeaders(body, SECRET);

    const res = await request
      .post(`/ingest/${SIM_SOURCE_SLUG}`)
      .set(headers)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deduplicated).toBe(false);
    expect(typeof res.body.eventId).toBe('string');

    // Document stored
    const doc = await db.collection('events').findOne({ eventId: headers['x-gateway-delivery-id'] });
    expect(doc).not.toBeNull();
    expect(doc.status).toBe('received');
    expect(doc.expireAt).toBeUndefined(); // OMIT entirely, not null
    expect(doc.deliveryAttempts).toBe(0);

    // Queue enqueued
    expect(queue.jobs.length).toBe(1);
    expect(queue.jobs[0].jobName).toBe('process-event');

    // X-Request-Id in response
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

// ─── Happy Path: github ───────────────────────────────────────────────────────

describe('POST /ingest/:sourceSlug - github adapter happy path', () => {
  it('returns 200 for valid github webhook', async () => {
    const body = JSON.stringify({ ref: 'refs/heads/main', pusher: { name: 'octocat' } });
    const headers = makeGithubHeaders(body, SECRET);

    const res = await request
      .post(`/ingest/${GH_SOURCE_SLUG}`)
      .set(headers)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deduplicated).toBe(false);

    const doc = await db.collection('events').findOne({ eventId: headers['x-github-delivery'] });
    expect(doc).not.toBeNull();
    expect(doc.eventType).toBe('push');
    expect(doc.status).toBe('received');
  });
});

// ─── Deduplication: sequential ────────────────────────────────────────────────

describe('Deduplication', () => {
  it('sequential duplicate returns deduplicated:true with 1 document', async () => {
    const deliveryId = `dup-seq-${Date.now()}`;
    const body = JSON.stringify({ event: 'payment.created', orderId: 'dup-seq' });
    const headers = makeGenericHeaders(body, SECRET, { deliveryId });

    const res1 = await request.post(`/ingest/${SIM_SOURCE_SLUG}`).set(headers).send(body);
    expect(res1.status).toBe(200);
    expect(res1.body.deduplicated).toBe(false);

    // Second call must use same timestamp/signature (already signed) — but timestamp may be stale
    // So we need a fresh sig but same deliveryId
    const headers2 = makeGenericHeaders(body, SECRET, { deliveryId });
    const res2 = await request.post(`/ingest/${SIM_SOURCE_SLUG}`).set(headers2).send(body);
    expect(res2.status).toBe(200);
    expect(res2.body.deduplicated).toBe(true);

    const count = await db.collection('events').countDocuments({ eventId: deliveryId });
    expect(count).toBe(1);
  });

  it('10 concurrent identical requests produce exactly 1 document, exactly 1 deduplicated:false', async () => {
    const deliveryId = `dup-conc-${Date.now()}`;
    const body = JSON.stringify({ event: 'payment.created', orderId: 'dup-conc' });

    const promises = Array.from({ length: 10 }, () => {
      const headers = makeGenericHeaders(body, SECRET, { deliveryId });
      return request.post(`/ingest/${SIM_SOURCE_SLUG}`).set(headers).send(body);
    });

    const results = await Promise.all(promises);

    const notDups = results.filter(r => r.status === 200 && r.body.deduplicated === false);
    const dups = results.filter(r => r.status === 200 && r.body.deduplicated === true);

    expect(notDups.length).toBe(1);
    expect(dups.length).toBe(9);

    const count = await db.collection('events').countDocuments({ eventId: deliveryId });
    expect(count).toBe(1);
  });
});

// ─── Bad Signature ────────────────────────────────────────────────────────────

describe('Bad signature', () => {
  it('returns 401 SIGNATURE_INVALID and stores no document', async () => {
    const deliveryId = `badsig-${Date.now()}`;
    const body = JSON.stringify({ event: 'payment.created' });
    const headers = makeGenericHeaders(body, 'wrong-secret', { deliveryId });

    const res = await request.post(`/ingest/${SIM_SOURCE_SLUG}`).set(headers).send(body);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('SIGNATURE_INVALID');

    const count = await db.collection('events').countDocuments({ eventId: deliveryId });
    expect(count).toBe(0);
  });
});

// ─── Stale timestamps ─────────────────────────────────────────────────────────

describe('Timestamp validation', () => {
  it('returns 401 TIMESTAMP_STALE for too-old timestamp', async () => {
    const body = JSON.stringify({ event: 'payment.created' });
    const ts = String(Date.now() - 400_000);
    const headers = {
      'content-type': 'application/json',
      'x-gateway-signature': signGenericHmac(SECRET, ts, body),
      'x-gateway-timestamp': ts,
      'x-gateway-delivery-id': crypto.randomUUID(),
    };

    const res = await request.post(`/ingest/${SIM_SOURCE_SLUG}`).set(headers).send(body);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TIMESTAMP_STALE');
  });

  it('returns 401 TIMESTAMP_STALE for far-future timestamp', async () => {
    const body = JSON.stringify({ event: 'payment.created' });
    const ts = String(Date.now() + 400_000);
    const headers = {
      'content-type': 'application/json',
      'x-gateway-signature': signGenericHmac(SECRET, ts, body),
      'x-gateway-timestamp': ts,
      'x-gateway-delivery-id': crypto.randomUUID(),
    };

    const res = await request.post(`/ingest/${SIM_SOURCE_SLUG}`).set(headers).send(body);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TIMESTAMP_STALE');
  });

  it('returns 400 INVALID_TIMESTAMP for missing timestamp', async () => {
    const body = JSON.stringify({ event: 'payment.created' });
    const ts = String(Date.now());
    const headers = {
      'content-type': 'application/json',
      'x-gateway-signature': signGenericHmac(SECRET, ts, body),
      'x-gateway-delivery-id': crypto.randomUUID(),
    };

    const res = await request.post(`/ingest/${SIM_SOURCE_SLUG}`).set(headers).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_TIMESTAMP');
  });
});

// ─── Invalid JSON ─────────────────────────────────────────────────────────────

describe('Invalid JSON', () => {
  it('returns 400 INVALID_JSON and stores no document when JSON is invalid', async () => {
    const deliveryId = `badjson-${Date.now()}`;
    const rawStr = 'this is not json {{{';
    const ts = String(Date.now());
    const headers = {
      'content-type': 'application/json',
      'x-gateway-signature': signGenericHmac(SECRET, ts, rawStr),
      'x-gateway-timestamp': ts,
      'x-gateway-delivery-id': deliveryId,
    };

    const res = await request
      .post(`/ingest/${SIM_SOURCE_SLUG}`)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(rawStr);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_JSON');

    const count = await db.collection('events').countDocuments({ eventId: deliveryId });
    expect(count).toBe(0);
  });
});

// ─── Source not found / inactive ─────────────────────────────────────────────

describe('Source lookup', () => {
  it('returns 404 SOURCE_NOT_FOUND for unknown slug', async () => {
    const body = JSON.stringify({ event: 'test' });
    const headers = makeGenericHeaders(body, SECRET);
    const res = await request.post('/ingest/does-not-exist').set(headers).send(body);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SOURCE_NOT_FOUND');
  });

  it('returns 404 SOURCE_NOT_FOUND for inactive source', async () => {
    const body = JSON.stringify({ event: 'test' });
    const headers = makeGenericHeaders(body, SECRET);
    const res = await request.post('/ingest/test-inactive').set(headers).send(body);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SOURCE_NOT_FOUND');
  });
});

// ─── Missing secret env var ──────────────────────────────────────────────────

describe('Missing secretEnvVar', () => {
  it('returns 500 and response does not contain env var name', async () => {
    const body = JSON.stringify({ event: 'payment.created' });
    const headers = makeGenericHeaders(body, SECRET);

    const res = await request.post('/ingest/test-no-secret').set(headers).send(body);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
    // Must not leak the env var name
    expect(JSON.stringify(res.body)).not.toContain('THIS_ENV_VAR_DOES_NOT_EXIST_AT_ALL');
  });
});

// ─── Oversized body ──────────────────────────────────────────────────────────

describe('Oversized body', () => {
  it('returns 413 PAYLOAD_TOO_LARGE for body > MAX_BODY_SIZE', async () => {
    // MAX_BODY_SIZE default 524288; we send 1MB
    const bigBody = 'x'.repeat(600_000);
    const res = await request
      .post(`/ingest/${SIM_SOURCE_SLUG}`)
      .set('content-type', 'application/json')
      .set('x-gateway-signature', 'sha256=' + 'a'.repeat(64))
      .set('x-gateway-timestamp', String(Date.now()))
      .set('x-gateway-delivery-id', crypto.randomUUID())
      .send(bigBody);

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('PAYLOAD_TOO_LARGE');
  });
});

// ─── Header sanitization ─────────────────────────────────────────────────────

describe('Header sanitization', () => {
  it('stored event headers never contain signature values', async () => {
    const deliveryId = `hdrtest-${Date.now()}`;
    const body = JSON.stringify({ event: 'payment.created', orderId: 'hdr-001' });
    const headers = makeGenericHeaders(body, SECRET, { deliveryId });

    const res = await request.post(`/ingest/${SIM_SOURCE_SLUG}`).set(headers).send(body);
    expect(res.status).toBe(200);

    const doc = await db.collection('events').findOne({ eventId: deliveryId });
    const storedHeaders = doc.headers;
    expect(storedHeaders['x-gateway-signature']).toBeUndefined();
    expect(storedHeaders['x-hub-signature-256']).toBeUndefined();
    // Allow-listed headers should be present
    expect(storedHeaders['x-gateway-delivery-id']).toBe(deliveryId);
  });
});

// ─── X-Request-Id ────────────────────────────────────────────────────────────

describe('X-Request-Id header', () => {
  it('echoes valid X-Request-Id from client', async () => {
    const body = JSON.stringify({ event: 'payment.created' });
    const headers = makeGenericHeaders(body, SECRET);
    const myReqId = 'client-req-12345678';

    const res = await request
      .post(`/ingest/${SIM_SOURCE_SLUG}`)
      .set(headers)
      .set('x-request-id', myReqId)
      .send(body);

    expect(res.headers['x-request-id']).toBe(myReqId);
  });

  it('generates X-Request-Id if not provided', async () => {
    const body = JSON.stringify({ event: 'payment.created' });
    const headers = makeGenericHeaders(body, SECRET);

    const res = await request.post(`/ingest/${SIM_SOURCE_SLUG}`).set(headers).send(body);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-request-id'].length).toBeGreaterThanOrEqual(8);
  });
});

// ─── /health ─────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns correct shape', async () => {
    const res = await request.get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/^(ok|degraded)$/);
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.mongo).toMatch(/^(connected|disconnected)$/);
    expect(res.body.redis).toBe('not_configured');
    expect(typeof res.body.version).toBe('string');
    expect(typeof res.body.timestamp).toBe('string');
  });
});
