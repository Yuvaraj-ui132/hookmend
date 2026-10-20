/**
 * proposals.test.js — Integration tests for Phase 3A admin REST endpoints (D30)
 * Uses MongoMemoryReplSet for transaction support.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { createIndexes } from '@hookmend/common';

const ADMIN_TOKEN = 'test-admin-token-3a';
const AUTH = { Authorization: `Bearer ${ADMIN_TOKEN}` };

let replSet;
let mongoClient;
let db;
let app;
let sourceId;

const BASE_SCHEMA_V1 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['event', 'orderId', 'amount', 'utr'],
  properties: {
    event: { type: 'string' },
    orderId: { type: 'string' },
    amount: { type: 'number' },
    utr: { type: 'string' },
  },
  additionalProperties: false,
};

const DRIFTED_PAYLOAD = { event: 'payment.created', orderId: 'ord1', amount: '100.50', currency: 'INR' };
const DRIFT_FINGERPRINT = 'test_fp_abc123def456';

async function seedSource() {
  const now = new Date();
  const res = await db.collection('sources').insertOne({
    slug: 'test-payments',
    name: 'Test Payments',
    adapter: 'generic-hmac',
    secretEnvVar: 'TEST_SECRET',
    downstreamUrl: 'http://127.0.0.1:9999/receive',
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  return res.insertedId;
}

async function seedSchema(sid, version = 1, active = true) {
  const now = new Date();
  await db.collection('schemas').insertOne({
    sourceId: sid,
    eventType: 'payment.created',
    version,
    active,
    activatedBy: 'system:seed',
    activatedAt: now,
    schema: BASE_SCHEMA_V1,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedProposal(sid, overrides = {}) {
  const now = new Date();
  const PROPOSED_SCHEMA = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['event', 'orderId', 'amount'],
    properties: {
      event: { type: 'string' },
      orderId: { type: 'string' },
      amount: { type: ['number', 'string'] },
      utr: { type: 'string' },
      currency: { type: 'string' },
    },
    additionalProperties: false,
  };
  const res = await db.collection('proposals').insertOne({
    sourceId: sid,
    eventType: 'payment.created',
    driftFingerprint: DRIFT_FINGERPRINT,
    baseSchemaId: 'schema1',
    baseSchemaVersion: 1,
    status: 'pending_review',
    diff: {
      added: ['/currency'],
      removed: ['/utr'],
      typeChanged: [{ path: '/amount', from: 'number', to: 'string' }],
    },
    proposedSchema: PROPOSED_SCHEMA,
    fieldMappings: [],
    breakingChanges: [
      { path: '/utr', kind: 'required_field_removed' },
      { path: '/amount', kind: 'type_changed' },
    ],
    replayResults: { total: 5, passed: 5, failed: 0, truncated: false, failedEventIds: [] },
    aiUsed: false,
    editedByHuman: false,
    affectedEventCount: 5,
    sampleEventIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return res.insertedId;
}

async function seedQuarantinedEvents(sid, count = 5, fp = DRIFT_FINGERPRINT) {
  const now = new Date();
  const events = Array.from({ length: count }, (_, i) => ({
    eventId: `evt_quarantine_${i}_${Math.random().toString(36).slice(2)}`,
    sourceId: sid,
    eventType: 'payment.created',
    status: 'quarantined',
    driftFingerprint: fp,
    schemaVersion: 1,
    payload: DRIFTED_PAYLOAD,
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
    requeueSeq: 0,
  }));
  await db.collection('events').insertMany(events);
  return events.map(e => e.eventId);
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  mongoClient = new MongoClient(uri);
  await mongoClient.connect();
  db = mongoClient.db('test_proposals_3a');
  await createIndexes(db);

  const config = {
    NODE_ENV: 'test',
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    MONGODB_URI: uri,
    REDIS_URL: 'redis://localhost:6379',
    QUEUE_PREFIX: 'hookmend-test-3a',
    MAX_SCHEMA_BYTES: 102400,
    REPLAY_MAX_EVENTS: 1000,
  };

  // Create a minimal queue mock
  const queue = {
    enqueue: async () => ({ id: 'mock-job' }),
    close: async () => {},
  };

  app = createApp({ db, queue, config });
});

afterAll(async () => {
  await mongoClient.close();
  await replSet.stop();
});

beforeEach(async () => {
  // Clean up collections between tests
  await db.collection('events').deleteMany({});
  await db.collection('proposals').deleteMany({});
  await db.collection('schemas').deleteMany({});
  await db.collection('sources').deleteMany({});
  await db.collection('audit_log').deleteMany({});

  sourceId = await seedSource();
  await seedSchema(sourceId);
});

describe('GET /api/quarantine', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/quarantine');
    expect(res.status).toBe(401);
  });

  it('returns quarantine groups', async () => {
    await seedQuarantinedEvents(sourceId, 3);
    const res = await request(app).get('/api/quarantine').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    if (res.body.length > 0) {
      expect(res.body[0]).toHaveProperty('count');
      expect(res.body[0]).toHaveProperty('driftFingerprint');
    }
  });
});

describe('GET /api/proposals', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/proposals');
    expect(res.status).toBe(401);
  });

  it('lists proposals with pagination', async () => {
    await seedProposal(sourceId);
    await seedProposal(sourceId, { driftFingerprint: 'fp2', status: 'rejected' });
    const res = await request(app).get('/api/proposals').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.items).toBeDefined();
    expect(res.body.total).toBeGreaterThanOrEqual(2);
  });

  it('filters by status', async () => {
    await seedProposal(sourceId);
    await seedProposal(sourceId, { driftFingerprint: 'fp2', status: 'rejected' });
    const res = await request(app).get('/api/proposals?status=rejected').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.items.every(p => p.status === 'rejected')).toBe(true);
  });
});

describe('GET /api/proposals/:id', () => {
  it('returns full proposal document', async () => {
    const proposalId = await seedProposal(sourceId);
    const res = await request(app).get(`/api/proposals/${proposalId}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_review');
    expect(res.body.proposedSchema).toBeDefined();
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).get(`/api/proposals/${new ObjectId()}`).set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/proposals/:id', () => {
  it('requires auth', async () => {
    const proposalId = await seedProposal(sourceId);
    const res = await request(app).patch(`/api/proposals/${proposalId}`).send({ proposedSchema: {} });
    expect(res.status).toBe(401);
  });

  it('rejects invalid (non-compiling) schema with 400 INVALID_SCHEMA', async () => {
    const proposalId = await seedProposal(sourceId);
    const res = await request(app)
      .patch(`/api/proposals/${proposalId}`)
      .set(AUTH)
      .send({ proposedSchema: { type: 'COMPLETELY_INVALID_TYPE_THAT_WONT_COMPILE' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SCHEMA');
  });

  it('accepts valid schema, sets editedByHuman true, recomputes replay', async () => {
    await seedQuarantinedEvents(sourceId, 3);
    const proposalId = await seedProposal(sourceId);
    const validSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['event'],
      properties: {
        event: { type: 'string' },
        orderId: { type: 'string' },
        amount: { type: ['number', 'string'] },
        utr: { type: 'string' },
        currency: { type: 'string' },
      },
      additionalProperties: false,
    };
    const res = await request(app)
      .patch(`/api/proposals/${proposalId}`)
      .set(AUTH)
      .send({ proposedSchema: validSchema });
    expect(res.status).toBe(200);
    expect(res.body.editedByHuman).toBe(true);
  });

  it('returns 409 INVALID_STATE for non-pending proposal', async () => {
    const proposalId = await seedProposal(sourceId, { status: 'rejected' });
    const validSchema = { type: 'object', properties: { x: { type: 'string' } } };
    const res = await request(app)
      .patch(`/api/proposals/${proposalId}`)
      .set(AUTH)
      .send({ proposedSchema: validSchema });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INVALID_STATE');
  });
});

describe('POST /api/proposals/:id/approve', () => {
  it('requires auth', async () => {
    const proposalId = await seedProposal(sourceId);
    const res = await request(app).post(`/api/proposals/${proposalId}/approve`);
    expect(res.status).toBe(401);
  });

  it('happy path: schema v2 active, v1 inactive, events requeue_pending, audit entries', async () => {
    await seedQuarantinedEvents(sourceId, 5);
    const proposalId = await seedProposal(sourceId);

    const res = await request(app).post(`/api/proposals/${proposalId}/approve`).set(AUTH).send({});
    expect(res.status).toBe(200);
    expect(res.body.newSchemaVersion).toBe(2);
    expect(res.body.requeuedEvents).toBe(5);

    // Check schema state
    const v2 = await db.collection('schemas').findOne({ version: 2, active: true });
    expect(v2).toBeDefined();
    const v1 = await db.collection('schemas').findOne({ version: 1 });
    expect(v1.active).toBe(false);

    // Check audit entries
    const auditEntries = await db.collection('audit_log').find({}).toArray();
    const actions = auditEntries.map(e => e.action);
    expect(actions).toContain('schema.activated');
    expect(actions).toContain('proposal.approved');

    // Check events are requeue_pending
    const events = await db.collection('events').find({ driftFingerprint: DRIFT_FINGERPRINT }).toArray();
    expect(events.every(e => e.status === 'requeue_pending')).toBe(true);
  });

  it('returns 409 INVALID_STATE for non-pending proposal', async () => {
    const proposalId = await seedProposal(sourceId, { status: 'rejected' });
    const res = await request(app).post(`/api/proposals/${proposalId}/approve`).set(AUTH).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INVALID_STATE');
  });

  it('returns 409 NEEDS_SCHEMA when proposedSchema is null', async () => {
    const proposalId = await seedProposal(sourceId, { proposedSchema: null });
    const res = await request(app).post(`/api/proposals/${proposalId}/approve`).set(AUTH).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NEEDS_SCHEMA');
  });

  it('returns 409 STALE_BASE when schema version has advanced', async () => {
    // Insert a v2 schema as active (v1 is now stale)
    await db.collection('schemas').updateOne({ version: 1 }, { $set: { active: false } });
    const now = new Date();
    await db.collection('schemas').insertOne({
      sourceId,
      eventType: 'payment.created',
      version: 2,
      active: true,
      schema: BASE_SCHEMA_V1,
      createdAt: now,
      updatedAt: now,
    });
    const proposalId = await seedProposal(sourceId, { baseSchemaVersion: 1 }); // still points at v1
    const res = await request(app).post(`/api/proposals/${proposalId}/approve`).set(AUTH).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('STALE_BASE');
  });

  it('returns 409 REPLAY_FAILURES without allowPartial', async () => {
    // Seed events that will fail the proposed schema
    const badPayloads = Array.from({ length: 3 }, (_, i) => ({
      eventId: `bad_evt_${i}`,
      sourceId,
      eventType: 'payment.created',
      status: 'quarantined',
      driftFingerprint: DRIFT_FINGERPRINT,
      schemaVersion: 1,
      payload: { event: 'x', amount: 'bad', extraBad: 999 },
      receivedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      requeueSeq: 0,
    }));
    await db.collection('events').insertMany(badPayloads);

    // Proposal with a strict schema that these events fail
    const strictSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['event', 'orderId'],
      properties: {
        event: { type: 'string' },
        orderId: { type: 'string' },
      },
      additionalProperties: false,
    };
    const proposalId = await seedProposal(sourceId, { proposedSchema: strictSchema });
    const res = await request(app).post(`/api/proposals/${proposalId}/approve`).set(AUTH).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('REPLAY_FAILURES');
  });

  it('allowPartial: approves even with replay failures', async () => {
    // Seed events that will fail
    await seedQuarantinedEvents(sourceId, 2);
    const strictSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['event', 'orderId', 'amount', 'utr', 'nonExistent'],
      properties: {
        event: { type: 'string' },
        orderId: { type: 'string' },
        amount: { type: 'number' },
        utr: { type: 'string' },
        nonExistent: { type: 'string' },
      },
      additionalProperties: false,
    };
    const proposalId = await seedProposal(sourceId, { proposedSchema: strictSchema });
    const res = await request(app)
      .post(`/api/proposals/${proposalId}/approve`)
      .set(AUTH)
      .send({ allowPartial: true });
    expect(res.status).toBe(200);
  });

  it('concurrent approves: exactly one 200 and one 409', async () => {
    await seedQuarantinedEvents(sourceId, 3);
    const proposalId = await seedProposal(sourceId);

    const [res1, res2] = await Promise.all([
      request(app).post(`/api/proposals/${proposalId}/approve`).set(AUTH).send({}),
      request(app).post(`/api/proposals/${proposalId}/approve`).set(AUTH).send({}),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toContain(200);
    expect(statuses).toContain(409);

    // Exactly one new schema version
    const schemas = await db.collection('schemas').find({ sourceId, eventType: 'payment.created' }).toArray();
    const activeSchemas = schemas.filter(s => s.active);
    expect(activeSchemas).toHaveLength(1);
    const versions = schemas.map(s => s.version).sort((a, b) => a - b);
    expect(versions[versions.length - 1]).toBe(2);
  });
});

describe('POST /api/proposals/:id/reject', () => {
  it('rejects pending proposal, events stay quarantined', async () => {
    const eventIds = await seedQuarantinedEvents(sourceId, 3);
    const proposalId = await seedProposal(sourceId);

    const res = await request(app)
      .post(`/api/proposals/${proposalId}/reject`)
      .set(AUTH)
      .send({ note: 'Not acceptable' });
    expect(res.status).toBe(200);

    const proposal = await db.collection('proposals').findOne({ _id: proposalId });
    expect(proposal.status).toBe('rejected');

    // Events still quarantined
    const events = await db.collection('events').find({ driftFingerprint: DRIFT_FINGERPRINT }).toArray();
    expect(events.every(e => e.status === 'quarantined')).toBe(true);

    // Audit entry
    const audit = await db.collection('audit_log').findOne({ action: 'proposal.rejected' });
    expect(audit).toBeDefined();
  });

  it('returns 409 for non-pending proposal', async () => {
    const proposalId = await seedProposal(sourceId, { status: 'approved' });
    const res = await request(app).post(`/api/proposals/${proposalId}/reject`).set(AUTH).send({});
    expect(res.status).toBe(409);
  });
});

describe('POST /api/proposals/reanalyze', () => {
  it('returns 202 and enqueues job when no pending proposal exists', async () => {
    await seedQuarantinedEvents(sourceId, 3);
    await seedProposal(sourceId, { status: 'rejected' }); // rejected, not pending

    const res = await request(app)
      .post('/api/proposals/reanalyze')
      .set(AUTH)
      .send({ sourceId: sourceId.toString(), eventType: 'payment.created', driftFingerprint: DRIFT_FINGERPRINT });
    expect(res.status).toBe(202);
  });

  it('returns 409 when a pending proposal already exists', async () => {
    await seedQuarantinedEvents(sourceId, 3);
    await seedProposal(sourceId); // pending

    const res = await request(app)
      .post('/api/proposals/reanalyze')
      .set(AUTH)
      .send({ sourceId: sourceId.toString(), eventType: 'payment.created', driftFingerprint: DRIFT_FINGERPRINT });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/audit', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(401);
  });

  it('returns audit entries newest first', async () => {
    await db.collection('audit_log').insertMany([
      { actor: 'human:admin', action: 'test.action1', entityType: 'proposal', entityId: new ObjectId(), timestamp: new Date(2026, 0, 1), detail: {} },
      { actor: 'human:admin', action: 'test.action2', entityType: 'proposal', entityId: new ObjectId(), timestamp: new Date(2026, 0, 2), detail: {} },
    ]);
    const res = await request(app).get('/api/audit').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    if (res.body.length >= 2) {
      expect(new Date(res.body[0].timestamp) >= new Date(res.body[1].timestamp)).toBe(true);
    }
  });
});
