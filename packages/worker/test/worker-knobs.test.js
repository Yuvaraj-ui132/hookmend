/**
 * worker-knobs.test.js — D49: Verify worker option env vars are wired to BullMQ Worker.
 *
 * Tests that WORKER_LOCK_DURATION_MS, WORKER_STALLED_INTERVAL_MS, WORKER_MAX_STALLED_COUNT
 * are read from config and passed to the BullMQ Worker constructor as lockDuration,
 * stalledInterval, and maxStalledCount respectively.
 *
 * Defaults must equal BullMQ's defaults: 30000, 30000, 1.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

describe('D49: Worker knob env var wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('passes lockDuration, stalledInterval, maxStalledCount from config to BullMQ Worker', async () => {
    const constructorCalls = [];

    // Mock bullmq Worker
    vi.doMock('bullmq', () => ({
      Worker: class MockWorker {
        constructor(name, processor, opts) {
          constructorCalls.push({ name, opts });
          this.on = () => this;
          this.close = vi.fn();
        }
      },
    }));

    // Mock ioredis
    vi.doMock('ioredis', () => ({
      Redis: class MockRedis {
        constructor() {
          this.on = () => this;
          this.quit = vi.fn().mockResolvedValue('OK');
          this.status = 'ready';
        }
      },
    }));

    const { createProcessEventWorker } = await import('../src/process-event/index.js');

    const fakeDb = {};
    const fakeQueue = { enqueue: vi.fn() };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    createProcessEventWorker({
      db: fakeDb,
      queue: fakeQueue,
      config: {
        REDIS_URL: 'redis://localhost:6379',
        QUEUE_PREFIX: 'test',
        WORKER_CONCURRENCY: '1',
        WORKER_LOCK_DURATION_MS: '4000',
        WORKER_STALLED_INTERVAL_MS: '2000',
        WORKER_MAX_STALLED_COUNT: '3',
      },
      logger: fakeLogger,
    });

    expect(constructorCalls).toHaveLength(1);
    const opts = constructorCalls[0].opts;
    expect(opts.lockDuration).toBe(4000);
    expect(opts.stalledInterval).toBe(2000);
    expect(opts.maxStalledCount).toBe(3);
  });

  it('uses BullMQ defaults when knob env vars are not set', async () => {
    const constructorCalls = [];

    vi.doMock('bullmq', () => ({
      Worker: class MockWorker {
        constructor(name, processor, opts) {
          constructorCalls.push({ name, opts });
          this.on = () => this;
          this.close = vi.fn();
        }
      },
    }));

    vi.doMock('ioredis', () => ({
      Redis: class MockRedis {
        constructor() {
          this.on = () => this;
          this.quit = vi.fn().mockResolvedValue('OK');
          this.status = 'ready';
        }
      },
    }));

    const { createProcessEventWorker } = await import('../src/process-event/index.js');

    createProcessEventWorker({
      db: {},
      queue: { enqueue: vi.fn() },
      config: {
        REDIS_URL: 'redis://localhost:6379',
        QUEUE_PREFIX: 'test',
        WORKER_CONCURRENCY: '1',
        // No WORKER_LOCK_DURATION_MS, WORKER_STALLED_INTERVAL_MS, WORKER_MAX_STALLED_COUNT
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(constructorCalls).toHaveLength(1);
    const opts = constructorCalls[0].opts;
    // BullMQ defaults
    expect(opts.lockDuration).toBe(30000);
    expect(opts.stalledInterval).toBe(30000);
    expect(opts.maxStalledCount).toBe(1);
  });
});
