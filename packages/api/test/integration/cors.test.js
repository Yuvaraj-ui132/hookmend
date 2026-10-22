/**
 * packages/api/test/integration/cors.test.js
 * Integration tests for CORS middleware (D40).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { createIndexes } from '@hookmend/common';

const ADMIN_TOKEN = 'test-cors-token';
const AUTH = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const ALLOWED_ORIGIN = 'http://localhost:5173';
const OTHER_ORIGIN = 'http://evil.example.com';

let replSet;
let mongoClient;
let db;
let app;

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
  db = mongoClient.db('test_cors');
  await createIndexes(db);

  const config = {
    NODE_ENV: 'test',
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    MONGODB_URI: uri,
    REDIS_URL: 'redis://localhost:6379',
    QUEUE_PREFIX: 'hookmend-test-cors',
    MAX_SCHEMA_BYTES: 102400,
    REPLAY_MAX_EVENTS: 1000,
    SSE_HEARTBEAT_MS: 25000,
    MAX_SSE_CLIENTS: 20,
    ENABLE_SIMULATOR_API: false,
    SIMULATOR_SOURCES: 'sim-payments',
    DASHBOARD_ORIGINS: ALLOWED_ORIGIN,
    ALLOW_PRIVATE_DOWNSTREAM: false,
  };

  app = createApp({ db, queue, config });
}, 30000);

afterAll(async () => {
  await mongoClient.close();
  await replSet.stop();
}, 15000);

describe('CORS middleware', () => {
  it('reflects allowed origin on /api/stats', async () => {
    const res = await request(app)
      .get('/api/stats')
      .set(AUTH)
      .set('Origin', ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('does not set allow-origin header for disallowed origin', async () => {
    const res = await request(app)
      .get('/api/stats')
      .set(AUTH)
      .set('Origin', OTHER_ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('responds 204 to OPTIONS preflight on /api route', async () => {
    const res = await request(app)
      .options('/api/stats')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'Authorization');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('OPTIONS from disallowed origin does NOT reflect allow-origin', async () => {
    const res = await request(app)
      .options('/api/stats')
      .set('Origin', OTHER_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('/ingest routes have NO CORS headers', async () => {
    // Seed a source
    await db.collection('sources').insertOne({
      slug: 'cors-test-src',
      name: 'CORS Test',
      adapter: 'generic-hmac',
      secretEnvVar: 'CORS_SECRET',
      downstreamUrl: 'https://api.example.com/recv',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/ingest/cors-test-src')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('CORS allows Authorization and Content-Type headers', async () => {
    const res = await request(app)
      .options('/api/stats')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'Authorization, Content-Type');
    expect(res.status).toBe(204);
    const allowHeaders = res.headers['access-control-allow-headers'] || '';
    expect(allowHeaders.toLowerCase()).toContain('authorization');
    expect(allowHeaders.toLowerCase()).toContain('content-type');
  });
});
