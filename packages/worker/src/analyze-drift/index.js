/**
 * analyze-drift/index.js — Stub BullMQ Worker for analyze-drift queue.
 *
 * D14: STUB worker that logs at info level and completes.
 */

import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DEFAULT_CONFIG, QUEUE_NAMES } from '@hookmend/common';

export function createAnalyzeDriftWorker({ config, logger }) {
  const redisUrl = config.REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379';
  const prefix = config.QUEUE_PREFIX || process.env.QUEUE_PREFIX || DEFAULT_CONFIG.QUEUE_PREFIX;

  const redisConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
  });

  const worker = new Worker(
    QUEUE_NAMES.ANALYZE_DRIFT,
    async (job) => {
      logger.info?.(
        {
          jobId: job.id,
          driftFingerprint: job.data.driftFingerprint,
          sourceId: job.data.sourceId,
          eventType: job.data.eventType,
        },
        '[analyze-drift STUB] Drift analysis job received (AI layer deferred to Phase 3)'
      );
      return { status: 'acknowledged' };
    },
    {
      connection: redisConnection,
      prefix,
      concurrency: 1,
    }
  );

  return {
    worker,
    redisConnection,
    async close() {
      await worker.close();
      await redisConnection.quit().catch(() => {});
    },
  };
}
