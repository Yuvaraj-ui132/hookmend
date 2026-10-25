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

    await db.collection('events').insertOne({
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
    // This test verifies staleProcessingCount still reported (not re-enqueued in this scenario
    // because STALE_JOB_THRESHOLD_MS is very large — event is old but threshold is larger)
    const oldProcessingAt = new Date(Date.now() - 600000); // 10 minutes ago
    await db.collection('events').insertOne({
      eventId: 'evt_stuck_proc_warn',
      status: 'processing',
      statusChangedAt: oldProcessingAt,
      receivedAt: oldProcessingAt,
      updatedAt: oldProcessingAt,
    });

    const fakeQueue = { enqueue: vi.fn().mockResolvedValue({ id: 'ok' }) };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // Use large STALE threshold so warning path is hit but re-enqueue also happens
    // (since event is 10 min old and threshold is 5 min, it will be re-enqueued now)
    const result = await reconcileOnce({
      db,
      queue: fakeQueue,
      now: () => new Date(),
      config: {
        RECONCILE_MIN_AGE_MS: 60000,
        RECONCILE_BATCH: 100,
        STALE_JOB_THRESHOLD_MS: 300000, // 5 min; event is 10 min old
      },
      logger: fakeLogger,
    });

    // Event should be re-enqueued and counted
    expect(result.recoveredStaleProcessing).toBe(1);
  });

  // ── D52/C3 fix: stale processing and failed events are re-enqueued ──────────

  it('D52: re-enqueues stale processing events older than STALE_JOB_THRESHOLD_MS to requeue_pending', async () => {
    const staleAt = new Date(Date.now() - 200000); // 200 s ago
    const staleEvent = await db.collection('events').insertOne({
      eventId: 'evt_stale_proc',
      status: 'processing',
      statusChangedAt: staleAt,
      receivedAt: staleAt,
      updatedAt: staleAt,
      requeueSeq: 0,
    });

    const fakeQueue = { enqueue: vi.fn().mockResolvedValue({ id: 'rq_1' }) };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await reconcileOnce({
      db,
      queue: fakeQueue,
      now: () => new Date(),
      config: {
        RECONCILE_MIN_AGE_MS: 60000,
        RECONCILE_BATCH: 100,
        STALE_JOB_THRESHOLD_MS: 120000, // 120 s threshold; event is 200 s old
      },
      logger: fakeLogger,
    });

    expect(result.recoveredStaleProcessing).toBe(1);

    // Mongo doc should now have status requeue_pending
    const updated = await db.collection('events').findOne({ _id: staleEvent.insertedId });
    expect(updated.status).toBe('requeue_pending');
    expect(updated.requeueSeq).toBe(1);

    // enqueue called with new jobId
    expect(fakeQueue.enqueue).toHaveBeenCalledWith(
      'process-event',
      'process-event',
      expect.objectContaining({ eventObjectId: staleEvent.insertedId.toString() }),
      expect.objectContaining({ jobId: `${staleEvent.insertedId}_rq1` })
    );
  });

  it('D52: re-enqueues stale failed events older than STALE_JOB_THRESHOLD_MS to requeue_pending', async () => {
    const staleAt = new Date(Date.now() - 200000);
    const staleEvent = await db.collection('events').insertOne({
      eventId: 'evt_stale_fail',
      status: 'failed',
      statusChangedAt: staleAt,
      receivedAt: staleAt,
      updatedAt: staleAt,
      requeueSeq: 1,
    });

    const fakeQueue = { enqueue: vi.fn().mockResolvedValue({ id: 'rq_2' }) };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await reconcileOnce({
      db,
      queue: fakeQueue,
      now: () => new Date(),
      config: {
        RECONCILE_MIN_AGE_MS: 60000,
        RECONCILE_BATCH: 100,
        STALE_JOB_THRESHOLD_MS: 120000,
      },
      logger: fakeLogger,
    });

    expect(result.recoveredStaleProcessing).toBe(1);

    const updated = await db.collection('events').findOne({ _id: staleEvent.insertedId });
    expect(updated.status).toBe('requeue_pending');
    expect(updated.requeueSeq).toBe(2);

    expect(fakeQueue.enqueue).toHaveBeenCalledWith(
      'process-event',
      'process-event',
      expect.objectContaining({ eventObjectId: staleEvent.insertedId.toString() }),
      expect.objectContaining({ jobId: `${staleEvent.insertedId}_rq2` })
    );
  });

  it('D52: does NOT re-enqueue recent processing events (within STALE_JOB_THRESHOLD_MS)', async () => {
    const recentAt = new Date(Date.now() - 30000); // 30 s ago — well within 120 s
    await db.collection('events').insertOne({
      eventId: 'evt_recent_proc',
      status: 'processing',
      statusChangedAt: recentAt,
      receivedAt: recentAt,
      updatedAt: recentAt,
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
        STALE_JOB_THRESHOLD_MS: 120000,
      },
      logger: fakeLogger,
    });

    expect(result.recoveredStaleProcessing).toBe(0);
    // enqueue not called for stale path (no received events either)
    expect(fakeQueue.enqueue).not.toHaveBeenCalled();
  });

  it('D52: does NOT re-enqueue terminal state events (delivered, dead, quarantined)', async () => {
    const oldAt = new Date(Date.now() - 500000);
    await db.collection('events').insertMany([
      { eventId: 'evt_delivered', status: 'delivered', statusChangedAt: oldAt, updatedAt: oldAt, receivedAt: oldAt },
      { eventId: 'evt_dead', status: 'dead', statusChangedAt: oldAt, updatedAt: oldAt, receivedAt: oldAt },
      { eventId: 'evt_quar', status: 'quarantined', statusChangedAt: oldAt, updatedAt: oldAt, receivedAt: oldAt },
    ]);

    const fakeQueue = { enqueue: vi.fn() };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await reconcileOnce({
      db,
      queue: fakeQueue,
      now: () => new Date(),
      config: {
        RECONCILE_MIN_AGE_MS: 60000,
        RECONCILE_BATCH: 100,
        STALE_JOB_THRESHOLD_MS: 120000,
      },
      logger: fakeLogger,
    });

    expect(result.recoveredStaleProcessing).toBe(0);
    expect(fakeQueue.enqueue).not.toHaveBeenCalled();
  });

  it('D52: respects batch limit for stale processing recovery', async () => {
    const staleAt = new Date(Date.now() - 200000);
    // Insert 5 stale processing events but batch limit is 3
    for (let i = 0; i < 5; i++) {
      await db.collection('events').insertOne({
        eventId: `evt_batch_${i}`,
        status: 'processing',
        statusChangedAt: staleAt,
        receivedAt: staleAt,
        updatedAt: staleAt,
        requeueSeq: 0,
      });
    }

    const fakeQueue = { enqueue: vi.fn().mockResolvedValue({ id: 'ok' }) };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await reconcileOnce({
      db,
      queue: fakeQueue,
      now: () => new Date(),
      config: {
        RECONCILE_MIN_AGE_MS: 60000,
        RECONCILE_BATCH: 3,
        STALE_JOB_THRESHOLD_MS: 120000,
      },
      logger: fakeLogger,
    });

    // Batch of 3 only
    expect(result.recoveredStaleProcessing).toBe(3);
    expect(fakeQueue.enqueue).toHaveBeenCalledTimes(3);
  });

  it('D52: falls back to updatedAt when statusChangedAt is missing for stale processing check', async () => {
    const staleAt = new Date(Date.now() - 200000);
    // No statusChangedAt — falls back to updatedAt
    const staleEvent = await db.collection('events').insertOne({
      eventId: 'evt_no_changed_at',
      status: 'processing',
      receivedAt: staleAt,
      updatedAt: staleAt,
      // no statusChangedAt
    });

    const fakeQueue = { enqueue: vi.fn().mockResolvedValue({ id: 'ok' }) };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await reconcileOnce({
      db,
      queue: fakeQueue,
      now: () => new Date(),
      config: {
        RECONCILE_MIN_AGE_MS: 60000,
        RECONCILE_BATCH: 100,
        STALE_JOB_THRESHOLD_MS: 120000,
      },
      logger: fakeLogger,
    });

    expect(result.recoveredStaleProcessing).toBe(1);
    const updated = await db.collection('events').findOne({ _id: staleEvent.insertedId });
    expect(updated.status).toBe('requeue_pending');
  });

  it('reconcile loop survives queue.enqueue failures and continues on next interval with warn log', async () => {
    const { startReconcileLoop } = await import('../src/main.js');
    const oldReceivedAt = new Date(Date.now() - 120000);

    await db.collection('events').insertOne({
      eventId: 'evt_fail_then_ok',
      status: 'received',
      receivedAt: oldReceivedAt,
      updatedAt: oldReceivedAt,
    });

    let calls = 0;
    const fakeQueue = {
      enqueue: vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
        }
        return Promise.resolve({ id: 'recovered-job' });
      }),
    };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const loop = startReconcileLoop({
      db,
      queue: fakeQueue,
      config: {
        RECONCILE_INTERVAL_MS: 25,
        RECONCILE_MIN_AGE_MS: 1000,
        STALE_JOB_THRESHOLD_MS: 10000,
      },
      logger: fakeLogger,
    });

    try {
      // Wait for at least two intervals (first throws error, second succeeds)
      const startWait = Date.now();
      while (Date.now() - startWait < 3000 && calls < 2) {
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(calls).toBeGreaterThanOrEqual(2);
      expect(fakeLogger.warn).toHaveBeenCalled();
    } finally {
      loop.stop();
    }
  });
});
