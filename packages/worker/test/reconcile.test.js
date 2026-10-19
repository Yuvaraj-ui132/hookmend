import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { reconcileOnce } from '../src/reconcile.js';

describe('reconcileOnce', () => {
  let mongod;
  let client;
  let db;

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
    await db.collection('events').deleteMany({});
  });

  it('re-enqueues events stuck in received older than RECONCILE_MIN_AGE_MS', async () => {
    const oldReceivedAt = new Date(Date.now() - 120000); // 2 minutes ago
    const freshReceivedAt = new Date(Date.now() - 10000); // 10 seconds ago

    const oldEvent = await db.collection('events').insertOne({
      eventId: 'evt_old_rec',
      status: 'received',
      receivedAt: oldReceivedAt,
      updatedAt: oldReceivedAt,
    });

    const freshEvent = await db.collection('events').insertOne({
      eventId: 'evt_fresh_rec',
      status: 'received',
      receivedAt: freshReceivedAt,
      updatedAt: freshReceivedAt,
    });

    const fakeQueue = { enqueue: vi.fn().mockResolvedValue({ id: 'reconciled_1' }) };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await reconcileOnce({
      db,
      queue: fakeQueue,
      now: () => new Date(),
      config: {
        RECONCILE_MIN_AGE_MS: 60000,
        RECONCILE_BATCH: 100,
        STALE_JOB_THRESHOLD_MS: 300000,
      },
      logger: fakeLogger,
    });

    expect(result.recoveredReceived).toBe(1);
    expect(fakeQueue.enqueue).toHaveBeenCalledWith(
      'process-event',
      'process-event',
      expect.objectContaining({ eventObjectId: oldEvent.insertedId.toString() }),
      expect.objectContaining({ jobId: `${oldEvent.insertedId}_v0` })
    );
  });

  it('re-enqueues events in requeue_pending status with jobId ${id}_rq${requeueSeq}', async () => {
    const event = await db.collection('events').insertOne({
      eventId: 'evt_requeued',
      status: 'requeue_pending',
      requeueSeq: 2,
      receivedAt: new Date(Date.now() - 60000),
      updatedAt: new Date(),
    });

    const fakeQueue = { enqueue: vi.fn().mockResolvedValue({ id: 'reconciled_rq_1' }) };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await reconcileOnce({
      db,
      queue: fakeQueue,
      now: () => new Date(),
      config: {
        RECONCILE_MIN_AGE_MS: 60000,
        RECONCILE_BATCH: 100,
        STALE_JOB_THRESHOLD_MS: 300000,
      },
      logger: fakeLogger,
    });

    expect(result.recoveredRequeuePending).toBe(1);
    expect(fakeQueue.enqueue).toHaveBeenCalledWith(
      'process-event',
      'process-event',
      expect.objectContaining({ eventObjectId: event.insertedId.toString() }),
      expect.objectContaining({ jobId: `${event.insertedId}_rq2` })
    );
  });

  it('logs warning for events stuck in processing beyond STALE_JOB_THRESHOLD_MS', async () => {
    const oldProcessingAt = new Date(Date.now() - 600000); // 10 minutes ago
    await db.collection('events').insertOne({
      eventId: 'evt_stuck_proc',
      status: 'processing',
      receivedAt: oldProcessingAt,
      updatedAt: oldProcessingAt,
    });

    const fakeQueue = { enqueue: vi.fn() };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await reconcileOnce({
      db,
      queue: fakeQueue,
      now: () => new Date(),
      config: {
        RECONCILE_MIN_AGE_MS: 60000,
        RECONCILE_BATCH: 100,
        STALE_JOB_THRESHOLD_MS: 300000,
      },
      logger: fakeLogger,
    });

    expect(result.staleProcessingCount).toBe(1);
    expect(fakeLogger.warn).toHaveBeenCalled();
  });
});
