/**
 * process-event/index.js — BullMQ Worker registration for process-event queue.
 *
 * D10: Worker connections use maxRetriesPerRequest: null.
 * D13: worker.on('failed') safety net to ensure event is marked dead if attempts exhausted.
 */

import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { ObjectId } from 'mongodb';
import {
  DEFAULT_CONFIG,
  EVENT_STATUS,
  QUEUE_NAMES,
  writeAuditLog,
} from '@hookmend/common';
import { processEvent } from '../processor.js';
import { computeBackoff } from '../delivery.js';

export function createProcessEventWorker({ db, queue, config, logger }) {
  const redisUrl = config.REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379';
  const prefix = config.QUEUE_PREFIX || process.env.QUEUE_PREFIX || DEFAULT_CONFIG.QUEUE_PREFIX;
  const concurrency = parseInt(config.WORKER_CONCURRENCY || '5', 10);

  // D49: Configurable BullMQ Worker knobs; defaults equal BullMQ's own defaults.
  // lockDuration: 30000 ms (how long a job lock is held before stall check can reclaim it)
  // stalledInterval: 30000 ms (how often BullMQ checks for stalled jobs)
  // maxStalledCount: 1 (max times a job can stall before being moved to failed)
  const lockDuration = parseInt(
    config.WORKER_LOCK_DURATION_MS || process.env.WORKER_LOCK_DURATION_MS || '30000',
    10
  );
  const stalledInterval = parseInt(
    config.WORKER_STALLED_INTERVAL_MS || process.env.WORKER_STALLED_INTERVAL_MS || '30000',
    10
  );
  const maxStalledCount = parseInt(
    config.WORKER_MAX_STALLED_COUNT || process.env.WORKER_MAX_STALLED_COUNT || '1',
    10
  );

  const redisConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null, // Required by BullMQ worker
    connectTimeout: 5000,
  });

  redisConnection.on('error', (err) => {
    logger.warn?.({ err: err?.message || err }, 'process-event Redis connection warning');
  });

  const worker = new Worker(
    QUEUE_NAMES.PROCESS_EVENT,
    async (job) => {
      return processEvent({
        job,
        db,
        deps: {
          queue,
          fetch: globalThis.fetch,
          logger,
          config,
        },
      });
    },
    {
      connection: redisConnection,
      prefix,
      concurrency,
      lockDuration,
      stalledInterval,
      maxStalledCount,
      settings: {
        backoffStrategy(attemptsMade) {
          const baseMs = parseInt(config?.PROCESS_EVENT_BACKOFF_BASE_MS || '1000', 10);
          const maxMs = parseInt(config?.PROCESS_EVENT_BACKOFF_MAX_MS || '30000', 10);
          return computeBackoff(attemptsMade, baseMs, maxMs);
        },
      },
    }
  );

  worker.on('error', (err) => {
    logger.warn?.({ err: err?.message || err }, 'process-event BullMQ worker warning');
  });

  // D13: Safety net on worker failure
  worker.on('failed', async (job, err) => {
    logger.error?.({ jobId: job?.id, err: err?.message }, 'Job failed in process-event worker');

    if (!job || !job.data?.eventObjectId) return;

    const attempts = job.opts?.attempts || config.PROCESS_EVENT_ATTEMPTS || 5;
    if (job.attemptsMade >= attempts) {
      try {
        const eventObjectId = new ObjectId(job.data.eventObjectId);
        const ttlDays = config.EVENT_TTL_DAYS || 14;
        const now = new Date();
        const expireAt = new Date(now.getTime() + ttlDays * 86400000);

        const res = await db.collection('events').updateOne(
          {
            _id: eventObjectId,
            status: { $nin: [EVENT_STATUS.DELIVERED, EVENT_STATUS.DEAD] },
          },
          {
            $set: {
              status: EVENT_STATUS.DEAD,
              expireAt,
              lastError: {
                code: 'WORKER_FAILED_EXHAUSTED',
                message: (err?.message || 'Exhausted worker retries').slice(0, 200),
                at: now,
              },
              updatedAt: now,
            },
          }
        );

        if (res.modifiedCount > 0) {
          await writeAuditLog(db, {
            actor: 'worker:process-event',
            action: 'event.dead',
            entityType: 'event',
            entityId: eventObjectId,
            detail: {
              reason: 'worker_failed_exhausted',
              message: (err?.message || '').slice(0, 200),
            },
            timestamp: now,
          });
        }
      } catch (safetyErr) {
        logger.error?.({ safetyErr }, 'Failed in failed-event safety net');
      }
    }
  });

  return {
    worker,
    redisConnection,
    async close() {
      await worker.close();
      await redisConnection.quit().catch(() => {});
    },
  };
}
