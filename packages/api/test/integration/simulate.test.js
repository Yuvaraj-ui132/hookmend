/**
 * packages/api/test/integration/simulate.test.js
 * Integration tests for POST /api/simulate (D41).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { createServer } from 'node:http';
import { createApp } from '../../src/server.js';
import { createIndexes } from '@hookmend/common';

const ADMIN_TOKEN = 'test-simulate-token';
const AUTH = { Authorization: `Bearer ${ADMIN_TOKEN}` };

let replSet;
let mongoClient;
let db;
let server;
let app;
let port;

const queue = {
  enqueue: async () => ({ id: 'mock-job' }),
  close: async () => {},
  getQueue: () => ({ getJobCounts: async () => ({}) }),
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  mongoClient = new MongoClient(uri);
  await mongoClient.connect();
  db = mongoClient.db('test_simulate');
  await createIndexes(db);

  // Seed sim-payments source with secret env var
  process.env.SIM_PAYMENTS_SECRET = 'test-sim-secret';
  await db.collection('sources').insertOne({
    slug: 'sim-payments',
    name: 'Sim Payments',
    adapter: 'generic-hmac',
    secretEnvVar: 'SIM_PAYMENTS_SECRET',
    downstreamUrl: 'http://127.0.0.1:19999/receive', // not used in test
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const config = {
    NODE_ENV: 'test',
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    MONGODB_URI: uri,
    REDIS_URL: 'redis://localhost:6379',
    QUEUE_PREFIX: 'hookmend-test-simulate',
    MAX_SCHEMA_BYTES: 102400,
    REPLAY_MAX_EVENTS: 1000,
    SSE_HEARTBEAT_MS: 25000,
    MAX_SSE_CLIENTS: 20,
    ENABLE_SIMULATOR_API: true,
    SIMULATOR_SOURCES: 'sim-payments',
    DASHBOARD_ORIGINS: 'http://localhost:5173',
    ALLOW_PRIVATE_DOWNSTREAM: false,
    PORT: 0,
    TIMESTAMP_TOLERANCE_SECONDS: 300,
    INGEST_RATE_LIMIT_MAX: 1000,
    INGEST_RATE_LIMIT_WINDOW_MS: 60000,
    MAX_BODY_SIZE: 524288,
  };

  app = createApp({ db, queue, config });

  await new Promise((resolve) => {
    server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      // Inject the port into config so simulate endpoint knows its own URL
      config.PORT = port;
      resolve();
    });
  });

  // Re-create app with resolved port
  app = createApp({ db, queue, config });
  server.removeAllListeners('request');
  server.on('request', app);
}, 60000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoClient.close();
  await replSet.stop();
}, 30000);

beforeEach(async () => {
  await db.collection('events').deleteMany({});
});

describe('POST /api/simulate', () => {
  it('returns 404 when ENABLE_SIMULATOR_API is false', async () => {
    // Create a second app with simulator disabled
    const config2 = {
      NODE_ENV: 'test',
      ADMIN_API_TOKEN: ADMIN_TOKEN,
      MONGODB_URI: replSet.getUri(),
      REDIS_URL: 'redis://localhost:6379',
      QUEUE_PREFIX: 'hookmend-test-sim2',
      MAX_SCHEMA_BYTES: 102400,
      REPLAY_MAX_EVENTS: 1000,
      SSE_HEARTBEAT_MS: 25000,
      MAX_SSE_CLIENTS: 20,
      ENABLE_SIMULATOR_API: false,
      SIMULATOR_SOURCES: 'sim-payments',
      DASHBOARD_ORIGINS: 'http://localhost:5173',
      ALLOW_PRIVATE_DOWNSTREAM: false,
      PORT: port,
      TIMESTAMP_TOLERANCE_SECONDS: 300,
      INGEST_RATE_LIMIT_MAX: 1000,
      INGEST_RATE_LIMIT_WINDOW_MS: 60000,
      MAX_BODY_SIZE: 524288,
    };
    const app2 = createApp({ db, queue, config: config2 });

    // Direct supertest call
    const { default: request } = await import('supertest');
    const res = await request(app2)
      .post('/api/simulate')
      .set(AUTH)
      .send({ count: 1, drift: 'none' });
    expect(res.status).toBe(404);
  });

  it('returns 400 if count > 50', async () => {
    const { default: request } = await import('supertest');
    const res = await request(app)
      .post('/api/simulate')
      .set(AUTH)
      .send({ count: 51, drift: 'none', sourceSlug: 'sim-payments' });
    expect(res.status).toBe(400);
  });

  it('returns 403 if sourceSlug not in SIMULATOR_SOURCES allow-list', async () => {
    const { default: request } = await import('supertest');
    const res = await request(app)
      .post('/api/simulate')
      .set(AUTH)
      .send({ count: 1, drift: 'none', sourceSlug: 'not-allowed' });
    expect(res.status).toBe(403);
  });

  it('sends signed events to own ingest and returns result summary', async () => {
    const { default: request } = await import('supertest');
    const res = await request(app)
      .post('/api/simulate')
      .set(AUTH)
      .send({ count: 2, drift: 'none', sourceSlug: 'sim-payments', duplicates: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sent');
    expect(res.body).toHaveProperty('accepted');
    expect(res.body).toHaveProperty('deduplicated');
    expect(res.body).toHaveProperty('statuses');
    expect(res.body.sent).toBe(2);
    // Events should appear in DB
    const count = await db.collection('events').countDocuments({});
    expect(count).toBeGreaterThan(0);
  }, 15000);
});
