import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { processEvent } from '../src/processor.js';

describe('processEvent', () => {
  let mongod;
  let client;
  let db;

  const sourceId = new ObjectId();
  const source = {
    _id: sourceId,
    slug: 'sim-payments',
    name: 'Payment Simulator',
    adapter: 'generic-hmac',
    secretEnvVar: 'SIM_WEBHOOK_SECRET',
    downstreamUrl: 'http://downstream.test/webhook',
    active: true,
  };

  const schemaDoc = {
    _id: new ObjectId(),
    sourceId,
    eventType: 'payment.created',
    version: 1,
    active: true,
    schema: {
      type: 'object',
      required: ['event', 'amount', 'orderId'],
      properties: {
        event: { type: 'string' },
        amount: { type: 'number' },
        orderId: { type: 'string' },
      },
      additionalProperties: false,
    },
  };

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db();
  });

  afterAll(async () => {
    await client?.close();
    await mongod?.stop();
  });

  beforeEach(async () => {
    await db.collection('sources').deleteMany({});
    await db.collection('events').deleteMany({});
    await db.collection('schemas').deleteMany({});
    await db.collection('audit_log').deleteMany({});

    await db.collection('sources').insertOne(source);
    await db.collection('schemas').insertOne(schemaDoc);
  });

  it('marks event delivered when schema valid and downstream returns 200', async () => {
    const eventId = 'evt_valid_1';
    const insertRes = await db.collection('events').insertOne({
      sourceId,
      sourceSlug: 'sim-payments',
      eventId,
      eventType: 'payment.created',
      status: 'received',
      rawBodyHash: 'hash1',
      payload: { event: 'payment.created', amount: 100, orderId: 'ord-1' },
      headers: {},
      deliveryAttempts: 0,
      receivedAt: new Date(),
      updatedAt: new Date(),
    });

    const fakeFetch = vi.fn().mockResolvedValue({ status: 200 });
    const fakeQueue = { enqueue: vi.fn().mockResolvedValue({ id: 'job_1' }) };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const job = {
      id: `${eventId}_v0`,
      data: { eventObjectId: insertRes.insertedId.toString(), eventId },
      opts: { attempts: 3 },
      attemptsMade: 0,
    };

    await processEvent({
      job,
      db,
      deps: {
        fetch: fakeFetch,
        queue: fakeQueue,
        logger: fakeLogger,
        config: { EVENT_TTL_DAYS: 14, DOWNSTREAM_TIMEOUT_MS: 5000 },
      },
    });

    const updated = await db.collection('events').findOne({ _id: insertRes.insertedId });
    expect(updated.status).toBe('delivered');
    expect(updated.validated).toBe(true);
    expect(updated.schemaVersion).toBe(1);
    expect(updated.downstreamStatus).toBe(200);
    expect(updated.expireAt).toBeInstanceOf(Date);

    const audit = await db.collection('audit_log').findOne({ entityId: insertRes.insertedId });
    expect(audit).not.toBeNull();
    expect(audit.action).toBe('event.delivered');
  });

  it('quarantines event when payload violates schema, computes driftFingerprint and enqueues analyze-drift', async () => {
    const eventId = 'evt_drift_1';
    const insertRes = await db.collection('events').insertOne({
      sourceId,
      sourceSlug: 'sim-payments',
      eventId,
      eventType: 'payment.created',
      status: 'received',
      rawBodyHash: 'hash2',
      payload: { event: 'payment.created', amount: '100', orderId: 'ord-1', currency: 'INR' }, // amount is string, currency added
      headers: {},
      deliveryAttempts: 0,
      receivedAt: new Date(),
      updatedAt: new Date(),
    });

    const fakeFetch = vi.fn();
    const fakeQueue = { enqueue: vi.fn().mockResolvedValue({ id: 'job_drift_1' }) };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const job = {
      id: `${eventId}_v0`,
      data: { eventObjectId: insertRes.insertedId.toString(), eventId },
      opts: { attempts: 3 },
      attemptsMade: 0,
    };

    await processEvent({
      job,
      db,
      deps: {
        fetch: fakeFetch,
        queue: fakeQueue,
        logger: fakeLogger,
        config: { EVENT_TTL_DAYS: 14, DOWNSTREAM_TIMEOUT_MS: 5000 },
      },
    });

    expect(fakeFetch).not.toHaveBeenCalled();

    const updated = await db.collection('events').findOne({ _id: insertRes.insertedId });
    expect(updated.status).toBe('quarantined');
    expect(updated.driftFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(updated.quarantinedAt).toBeInstanceOf(Date);
    expect(updated.expireAt).toBeUndefined(); // Never expires while quarantined
    expect(updated.validationErrors.length).toBeGreaterThan(0);

    // Enqueued analyze-drift
    expect(fakeQueue.enqueue).toHaveBeenCalledWith(
      'analyze-drift',
      'analyze-drift',
      expect.objectContaining({
        driftFingerprint: updated.driftFingerprint,
        sourceId: sourceId.toString(),
        eventType: 'payment.created',
      }),
      expect.any(Object)
    );

    const audit = await db.collection('audit_log').findOne({ entityId: insertRes.insertedId });
    expect(audit.action).toBe('event.quarantined');
  });

  it('sets status failed and throws on retryable downstream failure when attempts remain', async () => {
    const eventId = 'evt_fail_503';
    const insertRes = await db.collection('events').insertOne({
      sourceId,
      sourceSlug: 'sim-payments',
      eventId,
      eventType: 'payment.created',
      status: 'received',
      rawBodyHash: 'hash3',
      payload: { event: 'payment.created', amount: 100, orderId: 'ord-1' },
      headers: {},
      deliveryAttempts: 0,
      receivedAt: new Date(),
      updatedAt: new Date(),
    });

    const fakeFetch = vi.fn().mockResolvedValue({ status: 503 });
    const fakeQueue = { enqueue: vi.fn() };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const job = {
      id: `${eventId}_v0`,
      data: { eventObjectId: insertRes.insertedId.toString(), eventId },
      opts: { attempts: 3 },
      attemptsMade: 0, // first attempt
    };

    await expect(
      processEvent({
        job,
        db,
        deps: {
          fetch: fakeFetch,
          queue: fakeQueue,
          logger: fakeLogger,
          config: { EVENT_TTL_DAYS: 14, DOWNSTREAM_TIMEOUT_MS: 5000 },
        },
      })
    ).rejects.toThrow();

    const updated = await db.collection('events').findOne({ _id: insertRes.insertedId });
    expect(updated.status).toBe('failed');
    expect(updated.deliveryAttempts).toBe(1);
    expect(updated.downstreamStatus).toBe(503);
    expect(updated.lastError).toBeDefined();
    expect(updated.expireAt).toBeUndefined();
  });

  it('marks event dead and sets expireAt on last attempt or non-retryable 4xx', async () => {
    const eventId = 'evt_fail_400';
    const insertRes = await db.collection('events').insertOne({
      sourceId,
      sourceSlug: 'sim-payments',
      eventId,
      eventType: 'payment.created',
      status: 'received',
      rawBodyHash: 'hash4',
      payload: { event: 'payment.created', amount: 100, orderId: 'ord-1' },
      headers: {},
      deliveryAttempts: 0,
      receivedAt: new Date(),
      updatedAt: new Date(),
    });

    const fakeFetch = vi.fn().mockResolvedValue({ status: 400 }); // non-retryable
    const fakeQueue = { enqueue: vi.fn() };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const job = {
      id: `${eventId}_v0`,
      data: { eventObjectId: insertRes.insertedId.toString(), eventId },
      opts: { attempts: 3 },
      attemptsMade: 0,
    };

    await expect(
      processEvent({
        job,
        db,
        deps: {
          fetch: fakeFetch,
          queue: fakeQueue,
          logger: fakeLogger,
          config: { EVENT_TTL_DAYS: 14, DOWNSTREAM_TIMEOUT_MS: 5000 },
        },
      })
    ).rejects.toThrow(); // throws UnrecoverableError

    const updated = await db.collection('events').findOne({ _id: insertRes.insertedId });
    expect(updated.status).toBe('dead');
    expect(updated.downstreamStatus).toBe(400);
    expect(updated.expireAt).toBeInstanceOf(Date);

    const audit = await db.collection('audit_log').findOne({ entityId: insertRes.insertedId });
    expect(audit.action).toBe('event.dead');
  });

  it('skips event if already in delivered, dead, or quarantined state', async () => {
    const eventId = 'evt_already_delivered';
    const insertRes = await db.collection('events').insertOne({
      sourceId,
      sourceSlug: 'sim-payments',
      eventId,
      eventType: 'payment.created',
      status: 'delivered',
      rawBodyHash: 'hash5',
      payload: { event: 'payment.created', amount: 100, orderId: 'ord-1' },
      headers: {},
      deliveryAttempts: 1,
      receivedAt: new Date(),
      updatedAt: new Date(),
    });

    const fakeFetch = vi.fn();
    const fakeQueue = { enqueue: vi.fn() };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const job = {
      id: `${eventId}_v0`,
      data: { eventObjectId: insertRes.insertedId.toString(), eventId },
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await processEvent({
      job,
      db,
      deps: {
        fetch: fakeFetch,
        queue: fakeQueue,
        logger: fakeLogger,
        config: { EVENT_TTL_DAYS: 14, DOWNSTREAM_TIMEOUT_MS: 5000 },
      },
    });

    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('delivers without validation and sets validated:false when no active schema exists', async () => {
    const eventId = 'evt_no_schema';
    const insertRes = await db.collection('events').insertOne({
      sourceId,
      sourceSlug: 'sim-payments',
      eventId,
      eventType: 'unknown.event',
      status: 'received',
      rawBodyHash: 'hash6',
      payload: { any: 'data' },
      headers: {},
      deliveryAttempts: 0,
      receivedAt: new Date(),
      updatedAt: new Date(),
    });

    const fakeFetch = vi.fn().mockResolvedValue({ status: 200 });
    const fakeQueue = { enqueue: vi.fn() };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const job = {
      id: `${eventId}_v0`,
      data: { eventObjectId: insertRes.insertedId.toString(), eventId },
      opts: { attempts: 3 },
      attemptsMade: 0,
    };

    await processEvent({
      job,
      db,
      deps: {
        fetch: fakeFetch,
        queue: fakeQueue,
        logger: fakeLogger,
        config: { EVENT_TTL_DAYS: 14, DOWNSTREAM_TIMEOUT_MS: 5000 },
      },
    });

    const updated = await db.collection('events').findOne({ _id: insertRes.insertedId });
    expect(updated.status).toBe('delivered');
    expect(updated.validated).toBe(false);
    expect(updated.schemaVersion).toBeNull();
    expect(fakeLogger.warn).toHaveBeenCalled();
  });

  it('sets status failed and throws for retry when fetch throws on non-last attempt', async () => {
    const eventId = 'evt_fetch_err_retry';
    const insertRes = await db.collection('events').insertOne({
      sourceId,
      sourceSlug: 'sim-payments',
      eventId,
      eventType: 'payment.created',
      status: 'received',
      rawBodyHash: 'hash_err_1',
      payload: { event: 'payment.created', amount: 100, orderId: 'ord-1' },
      headers: {},
      deliveryAttempts: 0,
      receivedAt: new Date(),
      updatedAt: new Date(),
    });

    const netErr = new TypeError('fetch failed');
    netErr.cause = { code: 'ECONNREFUSED' };
    const fakeFetch = vi.fn().mockRejectedValue(netErr);
    const fakeQueue = { enqueue: vi.fn() };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const job = {
      id: `${eventId}_v0`,
      data: { eventObjectId: insertRes.insertedId.toString(), eventId },
      opts: { attempts: 3 },
      attemptsMade: 0, // 1st attempt out of 3
    };

    await expect(
      processEvent({
        job,
        db,
        deps: {
          fetch: fakeFetch,
          queue: fakeQueue,
          logger: fakeLogger,
          config: { EVENT_TTL_DAYS: 14, DOWNSTREAM_TIMEOUT_MS: 5000 },
        },
      })
    ).rejects.toThrow();

    const updated = await db.collection('events').findOne({ _id: insertRes.insertedId });
    expect(updated.status).toBe('failed');
    expect(updated.deliveryAttempts).toBe(1);
    expect(updated.lastError.code).toBe('ECONNREFUSED');
    expect(updated.expireAt).toBeUndefined();
  });

  it('sets status dead and sets expireAt when fetch throws on last attempt', async () => {
    const eventId = 'evt_fetch_err_dead';
    const insertRes = await db.collection('events').insertOne({
      sourceId,
      sourceSlug: 'sim-payments',
      eventId,
      eventType: 'payment.created',
      status: 'failed',
      rawBodyHash: 'hash_err_2',
      payload: { event: 'payment.created', amount: 100, orderId: 'ord-1' },
      headers: {},
      deliveryAttempts: 2,
      receivedAt: new Date(),
      updatedAt: new Date(),
    });

    const netErr = new TypeError('fetch failed');
    netErr.cause = { code: 'ETIMEDOUT' };
    const fakeFetch = vi.fn().mockRejectedValue(netErr);
    const fakeQueue = { enqueue: vi.fn() };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const job = {
      id: `${eventId}_v0`,
      data: { eventObjectId: insertRes.insertedId.toString(), eventId },
      opts: { attempts: 3 },
      attemptsMade: 2, // 3rd attempt out of 3
    };

    await expect(
      processEvent({
        job,
        db,
        deps: {
          fetch: fakeFetch,
          queue: fakeQueue,
          logger: fakeLogger,
          config: { EVENT_TTL_DAYS: 14, DOWNSTREAM_TIMEOUT_MS: 5000 },
        },
      })
    ).rejects.toThrow();

    const updated = await db.collection('events').findOne({ _id: insertRes.insertedId });
    expect(updated.status).toBe('dead');
    expect(updated.deliveryAttempts).toBe(3);
    expect(updated.lastError.code).toBe('ETIMEDOUT');
    expect(updated.expireAt).toBeInstanceOf(Date);

    const audit = await db.collection('audit_log').findOne({
      entityId: insertRes.insertedId,
      action: 'event.dead',
    });
    expect(audit).not.toBeNull();
    expect(audit.detail.reason).toBe('attempts_exhausted');
  });
});
