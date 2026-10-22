/**
 * packages/api/test/integration/stats.test.js
 * Integration tests for GET /api/stats (D38).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { createIndexes } from '@hookmend/common';

const ADMIN_TOKEN = 'test-stats-token';
const AUTH = { Authorization: `Bearer ${ADMIN_TOKEN}` };

let replSet;
let mongoClient;
let db;
// app is re-created per test to avoid cache sharing
let app;
let config;

const mockQueue = {
  enqueue: async () => ({ id: 'mock-job' }),
  close: async () => {},
  getQueue: (name) => ({
    getJobCounts: async (...types) => {
      const result = {};
      for (const t of types) result[t] = 0;
      return result;
    },
  }),
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  mongoClient = new MongoClient(uri);
  await mongoClient.connect();
  db = mongoClient.db('test_stats');
  await createIndexes(db);

  config = {
    NODE_ENV: 'test',
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    MONGODB_URI: uri,
    REDIS_URL: 'redis://localhost:6379',
    QUEUE_PREFIX: 'hookmend-test-stats',
    MAX_SCHEMA_BYTES: 102400,
    REPLAY_MAX_EVENTS: 1000,
    SSE_HEARTBEAT_MS: 25000,
    MAX_SSE_CLIENTS: 20,
    ENABLE_SIMULATOR_API: false,
    SIMULATOR_SOURCES: 'sim-payments',
    DASHBOARD_ORIGINS: 'http://localhost:5173',
  };
}, 30000);

afterAll(async () => {
  await mongoClient.close();
  await replSet.stop();
}, 15000);

beforeEach(async () => {
  await db.collection('events').deleteMany({});
  await db.collection('proposals').deleteMany({});
  // Re-create app each test to get a fresh stats cache
  app = createApp({ db, queue: mockQueue, config });
});

describe('GET /api/stats', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(401);
  });

  it('returns expected shape with zero counts', async () => {
    const res = await request(app).get('/api/stats').set(AUTH);
    expect(res.status).toBe(200);
    const body = res.body;

    // byStatus counts
    expect(body).toHaveProperty('byStatus');
    expect(body.byStatus).toHaveProperty('received');
    expect(body.byStatus).toHaveProperty('processing');
    expect(body.byStatus).toHaveProperty('delivered');
    expect(body.byStatus).toHaveProperty('quarantined');
    expect(body.byStatus).toHaveProperty('failed');
    expect(body.byStatus).toHaveProperty('dead');
    expect(body.byStatus).toHaveProperty('requeue_pending');

    // last24h array of 24 entries
    expect(body).toHaveProperty('last24h');
    expect(Array.isArray(body.last24h)).toBe(true);
    expect(body.last24h.length).toBe(24);
    // Each entry has hour and received
    for (const entry of body.last24h) {
      expect(entry).toHaveProperty('hour');
      expect(entry).toHaveProperty('received');
      expect(typeof entry.received).toBe('number');
    }

    // queues object
    expect(body).toHaveProperty('queues');
    expect(body.queues).toHaveProperty('processEvent');
    expect(body.queues['processEvent']).toHaveProperty('waiting');
    expect(body.queues['processEvent']).toHaveProperty('active');
    expect(body.queues['processEvent']).toHaveProperty('delayed');
    expect(body.queues['processEvent']).toHaveProperty('failed');
    expect(body.queues).toHaveProperty('analyzeDrift');

    // pendingProposals
    expect(body).toHaveProperty('pendingProposals');
    expect(typeof body.pendingProposals).toBe('number');

    // sseClients
    expect(body).toHaveProperty('sseClients');
    expect(typeof body.sseClients).toBe('number');
  });

  it('counts events by status correctly', async () => {
    const now = new Date();
    const events = [
      { eventId: 'e1', status: 'delivered', receivedAt: now },
      { eventId: 'e2', status: 'delivered', receivedAt: now },
      { eventId: 'e3', status: 'quarantined', receivedAt: now },
      { eventId: 'e4', status: 'received', receivedAt: now },
    ];
    await db.collection('events').insertMany(events);

    const res = await request(app).get('/api/stats').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.byStatus.delivered).toBe(2);
    expect(res.body.byStatus.quarantined).toBe(1);
    expect(res.body.byStatus.received).toBe(1);
  });

  it('counts pendingProposals correctly', async () => {
    await db.collection('proposals').insertMany([
      { status: 'pending_review', sourceId: 'src1', eventType: 'et1', driftFingerprint: 'fp1' },
      { status: 'pending_review', sourceId: 'src1', eventType: 'et1', driftFingerprint: 'fp2' },
      { status: 'approved', sourceId: 'src1', eventType: 'et1', driftFingerprint: 'fp3' },
    ]);

    const res = await request(app).get('/api/stats').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.pendingProposals).toBe(2);
  });

  it('last24h has 24 zero-filled entries when no events', async () => {
    const res = await request(app).get('/api/stats').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.last24h.length).toBe(24);
    const total = res.body.last24h.reduce((s, e) => s + e.received, 0);
    expect(total).toBe(0);
  });
});
