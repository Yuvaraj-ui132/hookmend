/**
 * packages/api/test/integration/dashboardContract.test.js
 * Cross-package contract test guarding API response shapes against dashboard client expectations.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { createServer } from 'node:http';
import { createApp } from '../../src/server.js';
import { createIndexes } from '@hookmend/common';
import * as client from '../../../../packages/dashboard/src/api/client.js';

const ADMIN_TOKEN = 'test-contract-token';

let replSet;
let mongoClient;
let db;
let server;
let baseUrl;
let sourceId;
let proposalId;

const mockQueue = {
  enqueue: async () => ({ id: 'mock-job' }),
  close: async () => {},
  getQueue: () => ({
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
  db = mongoClient.db('test_dashboard_contract');
  await createIndexes(db);

  const config = {
    NODE_ENV: 'test',
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    MONGODB_URI: uri,
    REDIS_URL: 'redis://localhost:6379',
    QUEUE_PREFIX: 'hookmend-test-contract',
    MAX_SCHEMA_BYTES: 102400,
    REPLAY_MAX_EVENTS: 1000,
    SSE_HEARTBEAT_MS: 25000,
    MAX_SSE_CLIENTS: 20,
    ENABLE_SIMULATOR_API: true,
    SIMULATOR_SOURCES: 'sim-payments',
    DASHBOARD_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
  };

  // Seed source
  const srcRes = await db.collection('sources').insertOne({
    slug: 'sim-payments',
    name: 'Payment Simulator',
    adapter: 'generic-hmac',
    secretEnvVar: 'SIM_WEBHOOK_SECRET',
    downstreamUrl: 'http://localhost:4001/receive',
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  sourceId = srcRes.insertedId;

  // Seed schema
  await db.collection('schemas').insertOne({
    sourceId,
    eventType: 'payment.created',
    version: 1,
    active: true,
    schema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { id: { type: 'string' } },
    },
    activatedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Seed events in several statuses (received, delivered, quarantined, dead)
  const now = new Date();
  await db.collection('events').insertMany([
    {
      sourceId,
      sourceSlug: 'sim-payments',
      eventId: 'evt-1',
      eventType: 'payment.created',
      status: 'received',
      receivedAt: now,
      updatedAt: now,
    },
    {
      sourceId,
      sourceSlug: 'sim-payments',
      eventId: 'evt-2',
      eventType: 'payment.created',
      status: 'delivered',
      receivedAt: now,
      updatedAt: now,
    },
    {
      sourceId,
      sourceSlug: 'sim-payments',
      eventId: 'evt-3',
      eventType: 'payment.created',
      status: 'quarantined',
      driftFingerprint: 'drift-fp-1',
      payload: { id: '123', extra: true },
      receivedAt: now,
      updatedAt: now,
    },
    {
      sourceId,
      sourceSlug: 'sim-payments',
      eventId: 'evt-4',
      eventType: 'payment.created',
      status: 'dead',
      receivedAt: now,
      updatedAt: now,
      deliveryAttempts: 5,
    },
  ]);

  // Seed proposal
  const propRes = await db.collection('proposals').insertOne({
    sourceId,
    eventType: 'payment.created',
    driftFingerprint: 'drift-fp-1',
    status: 'pending_review',
    baseSchemaVersion: 1,
    proposedSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, extra: { type: 'boolean' } },
    },
    diff: [{ path: '/extra', type: 'added' }],
    affectedEventCount: 1,
    aiUsed: false,
    createdAt: now,
    updatedAt: now,
  });
  proposalId = propRes.insertedId.toString();

  const app = createApp({ db, queue: mockQueue, config });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  if (typeof client.setApiBase === 'function') {
    client.setApiBase(baseUrl);
  }
}, 30000);

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoClient) await mongoClient.close();
  if (replSet) await replSet.stop();
});

describe('Dashboard/API Cross-Package Contract Tests', () => {
  it('GET /api/events via client returns a normalised array of event objects', async () => {
    const events = await client.getEvents(ADMIN_TOKEN);
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(4);
    const first = events[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('status');
    expect(first).toHaveProperty('eventType');
  });

  it('GET /api/quarantine via client returns a normalised array of quarantine groups', async () => {
    const groups = await client.getQuarantine(ADMIN_TOKEN);
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const grp = groups[0];
    expect(grp).toHaveProperty('driftFingerprint');
    expect(grp).toHaveProperty('count');
    expect(typeof grp.count).toBe('number');
  });

  it('GET /api/proposals via client returns a normalised array of proposals', async () => {
    const proposals = await client.getProposals(ADMIN_TOKEN);
    expect(Array.isArray(proposals)).toBe(true);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const p = proposals[0];
    expect(p).toHaveProperty('status', 'pending_review');
    expect(p).toHaveProperty('driftFingerprint');
  });

  it('GET /api/proposals/:id via client returns proposal details with expected fields', async () => {
    const p = await client.getProposal(proposalId, ADMIN_TOKEN);
    expect(p).toBeDefined();
    expect(typeof p).toBe('object');
    expect(p._id || p.id).toBe(proposalId);
    expect(p).toHaveProperty('proposedSchema');
    expect(p).toHaveProperty('diff');
    expect(p).toHaveProperty('status', 'pending_review');
    expect(p).toHaveProperty('baseSchemaVersion');
  });

  it('GET /api/schemas via client returns a normalised array of schemas', async () => {
    const schemas = await client.getSchemas(ADMIN_TOKEN);
    expect(Array.isArray(schemas)).toBe(true);
    expect(schemas.length).toBeGreaterThanOrEqual(1);
    expect(schemas[0]).toHaveProperty('version');
    expect(schemas[0]).toHaveProperty('schema');
  });

  it('GET /api/sources via client returns a normalised array of sources with active flag', async () => {
    const sources = await client.getSources(ADMIN_TOKEN);
    expect(Array.isArray(sources)).toBe(true);
    expect(sources.length).toBeGreaterThanOrEqual(1);
    const src = sources[0];
    expect(src).toHaveProperty('slug', 'sim-payments');
    expect(typeof src.active).toBe('boolean');
  });

  it('GET /api/stats via client returns normalised metrics where counts are numbers', async () => {
    const stats = await client.getStats(ADMIN_TOKEN);
    expect(stats).toBeDefined();
    expect(typeof stats).toBe('object');
    expect(typeof stats.pendingProposals).toBe('number');
    expect(typeof stats.sseClients).toBe('number');
    expect(stats.eventCounts).toBeDefined();
    expect(typeof stats.eventCounts.delivered).toBe('number');
    expect(typeof stats.eventCounts.quarantined).toBe('number');
    expect(typeof stats.eventCounts.dead).toBe('number');
    expect(typeof stats.eventCounts.received).toBe('number');
  });

  it('asList helper extracts arrays from { items: [] } and raw arrays, and throws on invalid shapes', () => {
    expect(client.asList([1, 2, 3], 'items', '/api/test')).toEqual([1, 2, 3]);
    expect(client.asList({ items: ['a', 'b'] }, 'items', '/api/test')).toEqual(['a', 'b']);
    expect(client.asList(null, 'items', '/api/test')).toEqual([]);
    expect(client.asList(undefined, 'items', '/api/test')).toEqual([]);
    expect(() => client.asList({ notItems: [] }, 'items', '/api/test')).toThrow(/Unexpected response shape/);
    expect(() => client.asList('not-an-object', 'items', '/api/test')).toThrow(/Unexpected response shape/);
  });
});
