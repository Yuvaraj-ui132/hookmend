/**
 * packages/api/test/integration/sources.test.js
 * Integration tests for POST/PATCH/DELETE /api/sources and POST /api/schemas (D39).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { createIndexes } from '@hookmend/common';

const ADMIN_TOKEN = 'test-sources-token';
const AUTH = { Authorization: `Bearer ${ADMIN_TOKEN}` };

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
  db = mongoClient.db('test_sources');
  await createIndexes(db);

  const config = {
    NODE_ENV: 'test',
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    MONGODB_URI: uri,
    REDIS_URL: 'redis://localhost:6379',
    QUEUE_PREFIX: 'hookmend-test-sources',
    MAX_SCHEMA_BYTES: 102400,
    REPLAY_MAX_EVENTS: 1000,
    SSE_HEARTBEAT_MS: 25000,
    MAX_SSE_CLIENTS: 20,
    ENABLE_SIMULATOR_API: false,
    SIMULATOR_SOURCES: 'sim-payments',
    DASHBOARD_ORIGINS: 'http://localhost:5173',
    ALLOW_PRIVATE_DOWNSTREAM: false,
  };

  app = createApp({ db, queue, config });
}, 30000);

afterAll(async () => {
  await mongoClient.close();
  await replSet.stop();
}, 15000);

beforeEach(async () => {
  await db.collection('sources').deleteMany({});
  await db.collection('schemas').deleteMany({});
  await db.collection('audit_log').deleteMany({});
});

describe('POST /api/sources', () => {
  it('creates a source with valid fields', async () => {
    const res = await request(app)
      .post('/api/sources')
      .set(AUTH)
      .send({
        slug: 'my-webhook',
        name: 'My Webhook',
        adapter: 'generic-hmac',
        secretEnvVar: 'MY_SECRET',
        downstreamUrl: 'https://api.example.com/receive',
      });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('my-webhook');
    expect(res.body).not.toHaveProperty('secretEnvVar');
    expect(res.body.active).toBe(true);
  });

  it('returns 409 SLUG_EXISTS for duplicate slug', async () => {
    const body = {
      slug: 'dup-slug',
      name: 'Dup',
      adapter: 'generic-hmac',
      secretEnvVar: 'DUP_SECRET',
      downstreamUrl: 'https://api.example.com/recv',
    };
    await request(app).post('/api/sources').set(AUTH).send(body);
    const res = await request(app).post('/api/sources').set(AUTH).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('SLUG_EXISTS');
  });

  it('rejects invalid slug (uppercase)', async () => {
    const res = await request(app)
      .post('/api/sources')
      .set(AUTH)
      .send({
        slug: 'My-Webhook',
        name: 'n',
        adapter: 'generic-hmac',
        secretEnvVar: 'MY_SECRET',
        downstreamUrl: 'https://api.example.com/recv',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAYLOAD');
  });

  it('rejects invalid slug starting with hyphen', async () => {
    const res = await request(app)
      .post('/api/sources')
      .set(AUTH)
      .send({
        slug: '-bad',
        name: 'n',
        adapter: 'generic-hmac',
        secretEnvVar: 'MY_SECRET',
        downstreamUrl: 'https://api.example.com/recv',
      });
    expect(res.status).toBe(400);
  });

  it('rejects unknown adapter', async () => {
    const res = await request(app)
      .post('/api/sources')
      .set(AUTH)
      .send({
        slug: 'valid-slug',
        name: 'n',
        adapter: 'stripe',
        secretEnvVar: 'MY_SECRET',
        downstreamUrl: 'https://api.example.com/recv',
      });
    expect(res.status).toBe(400);
  });

  it('rejects invalid secretEnvVar (lowercase)', async () => {
    const res = await request(app)
      .post('/api/sources')
      .set(AUTH)
      .send({
        slug: 'valid-slug',
        name: 'n',
        adapter: 'generic-hmac',
        secretEnvVar: 'my_secret',
        downstreamUrl: 'https://api.example.com/recv',
      });
    expect(res.status).toBe(400);
  });

  it('rejects 169.254.x.x downstreamUrl always', async () => {
    const res = await request(app)
      .post('/api/sources')
      .set(AUTH)
      .send({
        slug: 'link-local',
        name: 'n',
        adapter: 'generic-hmac',
        secretEnvVar: 'MY_SECRET',
        downstreamUrl: 'http://169.254.169.254/metadata',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_URL');
  });

  it('rejects metadata.google.internal always', async () => {
    const res = await request(app)
      .post('/api/sources')
      .set(AUTH)
      .send({
        slug: 'gcp-meta',
        name: 'n',
        adapter: 'generic-hmac',
        secretEnvVar: 'MY_SECRET',
        downstreamUrl: 'http://metadata.google.internal/computeMetadata/',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_URL');
  });

  it('creates audit log entry source.created', async () => {
    await request(app)
      .post('/api/sources')
      .set(AUTH)
      .send({
        slug: 'audit-test',
        name: 'Audit Test',
        adapter: 'generic-hmac',
        secretEnvVar: 'AUDIT_SECRET',
        downstreamUrl: 'https://api.example.com/recv',
      });
    const audit = await db.collection('audit_log').findOne({ action: 'source.created' });
    expect(audit).not.toBeNull();
    expect(audit.actor).toBe('human:admin');
  });
});

describe('PATCH /api/sources/:id', () => {
  it('updates name and downstreamUrl', async () => {
    const create = await request(app)
      .post('/api/sources')
      .set(AUTH)
      .send({
        slug: 'patch-me',
        name: 'Original',
        adapter: 'generic-hmac',
        secretEnvVar: 'PATCH_SECRET',
        downstreamUrl: 'https://api.example.com/orig',
      });
    const id = create.body._id || create.body.id;

    // Get the actual _id from DB
    const src = await db.collection('sources').findOne({ slug: 'patch-me' });
    const sid = src._id.toString();

    const res = await request(app)
      .patch(`/api/sources/${sid}`)
      .set(AUTH)
      .send({ name: 'Updated Name', downstreamUrl: 'https://api.example.com/new' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
  });

  it('soft-deletes via active=false', async () => {
    await request(app)
      .post('/api/sources')
      .set(AUTH)
      .send({
        slug: 'deactivate-me',
        name: 'Active',
        adapter: 'generic-hmac',
        secretEnvVar: 'ACT_SECRET',
        downstreamUrl: 'https://api.example.com/recv',
      });
    const src = await db.collection('sources').findOne({ slug: 'deactivate-me' });
    const sid = src._id.toString();

    const res = await request(app)
      .patch(`/api/sources/${sid}`)
      .set(AUTH)
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });
});

describe('DELETE /api/sources/:id', () => {
  it('soft-deletes the source (sets active=false)', async () => {
    await request(app)
      .post('/api/sources')
      .set(AUTH)
      .send({
        slug: 'del-me',
        name: 'Delete Me',
        adapter: 'generic-hmac',
        secretEnvVar: 'DEL_SECRET',
        downstreamUrl: 'https://api.example.com/recv',
      });
    const src = await db.collection('sources').findOne({ slug: 'del-me' });
    const sid = src._id.toString();

    const res = await request(app).delete(`/api/sources/${sid}`).set(AUTH);
    expect(res.status).toBe(200);
    const updated = await db.collection('sources').findOne({ slug: 'del-me' });
    expect(updated.active).toBe(false);
  });
});

describe('POST /api/schemas', () => {
  const VALID_SCHEMA = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['event'],
    properties: { event: { type: 'string' } },
  };

  async function createSource() {
    await request(app)
      .post('/api/sources')
      .set(AUTH)
      .send({
        slug: 'schema-src',
        name: 'Schema Source',
        adapter: 'generic-hmac',
        secretEnvVar: 'SCHEMA_SECRET',
        downstreamUrl: 'https://api.example.com/recv',
      });
    const src = await db.collection('sources').findOne({ slug: 'schema-src' });
    return src._id.toString();
  }

  it('creates a schema (version 1, active true) for a new source+eventType pair', async () => {
    const sourceId = await createSource();
    const res = await request(app)
      .post('/api/schemas')
      .set(AUTH)
      .send({ sourceId, eventType: 'payment.created', schema: VALID_SCHEMA });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(1);
    expect(res.body.active).toBe(true);
    expect(res.body.activatedBy).toBe('human:admin');
  });

  it('returns 409 SCHEMA_EXISTS if schema already exists for same pair', async () => {
    const sourceId = await createSource();
    await request(app)
      .post('/api/schemas')
      .set(AUTH)
      .send({ sourceId, eventType: 'payment.created', schema: VALID_SCHEMA });

    const res = await request(app)
      .post('/api/schemas')
      .set(AUTH)
      .send({ sourceId, eventType: 'payment.created', schema: VALID_SCHEMA });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('SCHEMA_EXISTS');
  });

  it('returns 400 INVALID_SCHEMA for non-object schema', async () => {
    const sourceId = await createSource();
    const res = await request(app)
      .post('/api/schemas')
      .set(AUTH)
      .send({ sourceId, eventType: 'payment.created', schema: 'not-an-object' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SCHEMA');
  });

  it('returns 400 INVALID_SCHEMA for schema that fails Ajv compile', async () => {
    const sourceId = await createSource();
    const res = await request(app)
      .post('/api/schemas')
      .set(AUTH)
      .send({
        sourceId,
        eventType: 'payment.created',
        schema: { type: 'object', properties: { x: { type: 'invalid-type-xyz' } } },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SCHEMA');
  });
});

describe('GET /api/events/:id/raw-hash', () => {
  it('returns the rawBodyHash for an event', async () => {
    const res = await db.collection('events').insertOne({
      eventId: 'evt-hash-1',
      status: 'received',
      rawBodyHash: 'sha256:abc123',
      receivedAt: new Date(),
      payload: { x: 1 },
    });
    const id = res.insertedId.toString();

    const r = await request(app).get(`/api/events/${id}/raw-hash`).set(AUTH);
    expect(r.status).toBe(200);
    expect(r.body.rawBodyHash).toBe('sha256:abc123');
  });

  it('returns 404 for unknown event id', async () => {
    const r = await request(app)
      .get('/api/events/000000000000000000000001/raw-hash')
      .set(AUTH);
    expect(r.status).toBe(404);
  });
});
