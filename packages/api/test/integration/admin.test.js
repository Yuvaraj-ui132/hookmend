import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import supertest from 'supertest';
import { createApp } from '../../src/server.js';
import { createQueue } from '../../src/queue/stub.js';

describe('Admin REST API', () => {
  let mongod;
  let mongoClient;
  let db;
  let app;
  let request;
  let queue;

  const ADMIN_TOKEN = 'test-admin-secret-token-123';
  const config = {
    PORT: 0,
    NODE_ENV: 'test',
    MAX_BODY_SIZE: 524288,
    TIMESTAMP_TOLERANCE_SECONDS: 300,
    INGEST_RATE_LIMIT_MAX: 1000,
    INGEST_RATE_LIMIT_WINDOW_MS: 60000,
    EVENT_TTL_DAYS: 14,
    LOG_LEVEL: 'silent',
    ADMIN_API_TOKEN: ADMIN_TOKEN,
  };

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    mongoClient = new MongoClient(mongod.getUri());
    await mongoClient.connect();
    db = mongoClient.db();
    queue = createQueue();

    app = createApp({ db, queue, config });
    request = supertest(app);
  });

  afterAll(async () => {
    await mongoClient?.close();
    await mongod?.stop();
  });

  beforeEach(async () => {
    await db.collection('sources').deleteMany({});
    await db.collection('events').deleteMany({});
    await db.collection('schemas').deleteMany({});
    await db.collection('audit_log').deleteMany({});
  });

  describe('Authentication', () => {
    it('rejects requests with missing Authorization header with 401 UNAUTHORIZED', async () => {
      const res = await request.get('/api/sources');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('rejects requests with invalid Bearer token with 401 UNAUTHORIZED', async () => {
      const res = await request
        .get('/api/sources')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('accepts requests with valid Bearer token', async () => {
      const res = await request
        .get('/api/sources')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/sources & /api/sources/:id', () => {
    it('lists sources and omits secretEnvVar', async () => {
      const now = new Date();
      await db.collection('sources').insertOne({
        slug: 'sim-payments',
        name: 'Simulator',
        adapter: 'generic-hmac',
        secretEnvVar: 'SIM_WEBHOOK_SECRET',
        downstreamUrl: 'http://test/hook',
        active: true,
        createdAt: now,
        updatedAt: now,
      });

      const res = await request
        .get('/api/sources')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].slug).toBe('sim-payments');
      expect(res.body[0].secretEnvVar).toBeUndefined();
    });

    it('gets single source and omits secretEnvVar', async () => {
      const resInsert = await db.collection('sources').insertOne({
        slug: 'github-main',
        name: 'GitHub',
        adapter: 'github',
        secretEnvVar: 'GITHUB_WEBHOOK_SECRET',
        downstreamUrl: 'http://test/hook',
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await request
        .get(`/api/sources/${resInsert.insertedId}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.slug).toBe('github-main');
      expect(res.body.secretEnvVar).toBeUndefined();
    });
  });

  describe('GET /api/events & /api/events/:id', () => {
    it('paginates events and omits payload and headers in list view', async () => {
      for (let i = 0; i < 5; i++) {
        await db.collection('events').insertOne({
          eventId: `evt_${i}`,
          eventType: 'payment.created',
          status: 'received',
          payload: { secret: 'do-not-show-in-list' },
          headers: { 'user-agent': 'test' },
          receivedAt: new Date(Date.now() + i * 1000),
        });
      }

      const res = await request
        .get('/api/events?limit=2&page=1')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(res.body).toHaveProperty('total', 5);
      expect(res.body).toHaveProperty('page', 1);
      expect(res.body).toHaveProperty('limit', 2);
      expect(res.body.items.length).toBe(2);

      // payload and headers omitted
      expect(res.body.items[0].payload).toBeUndefined();
      expect(res.body.items[0].headers).toBeUndefined();
    });

    it('returns full event document including payload on GET /api/events/:id', async () => {
      const insert = await db.collection('events').insertOne({
        eventId: 'evt_full',
        eventType: 'payment.created',
        status: 'delivered',
        payload: { amount: 500 },
        receivedAt: new Date(),
      });

      const res = await request
        .get(`/api/events/${insert.insertedId}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.eventId).toBe('evt_full');
      expect(res.body.payload).toEqual({ amount: 500 });
    });
  });

  describe('GET /api/schemas & /api/schemas/:id', () => {
    it('lists schemas filterable by sourceId and eventType', async () => {
      const srcId = new ObjectId();
      await db.collection('schemas').insertOne({
        sourceId: srcId,
        eventType: 'payment.created',
        version: 1,
        active: true,
        schema: { type: 'object' },
      });

      const res = await request
        .get(`/api/schemas?sourceId=${srcId}&eventType=payment.created`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].version).toBe(1);
    });
  });

  describe('POST /api/events/:id/requeue', () => {
    it('returns 400 INVALID_ID for malformed ObjectId', async () => {
      const res = await request
        .post('/api/events/invalid-id/requeue')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_ID');
    });

    it('returns 404 NOT_FOUND for non-existent event', async () => {
      const randomId = new ObjectId();
      const res = await request
        .post(`/api/events/${randomId}/requeue`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });

    it('returns 409 INVALID_STATE when event is not failed or dead', async () => {
      const insert = await db.collection('events').insertOne({
        eventId: 'evt_rec',
        status: 'received',
      });

      const res = await request
        .post(`/api/events/${insert.insertedId}/requeue`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('INVALID_STATE');
    });

    it('requeues a dead or failed event: transitions to requeue_pending, unsets expireAt, audits, enqueues', async () => {
      const insert = await db.collection('events').insertOne({
        eventId: 'evt_dead_1',
        status: 'dead',
        expireAt: new Date(Date.now() + 86400000),
      });

      const res = await request
        .post(`/api/events/${insert.insertedId}/requeue`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const updated = await db.collection('events').findOne({ _id: insert.insertedId });
      expect(updated.status).toBe('requeue_pending');
      expect(updated.requeueSeq).toBe(1);
      expect(updated.expireAt).toBeUndefined();

      const audit = await db.collection('audit_log').findOne({ entityId: insert.insertedId });
      expect(audit).not.toBeNull();
      expect(audit.action).toBe('event.requeued');
    });
  });
});
