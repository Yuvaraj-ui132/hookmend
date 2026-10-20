/**
 * analyze-drift/index.js — BullMQ Worker for analyze-drift queue (D26, D27).
 */

import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DEFAULT_CONFIG, QUEUE_NAMES } from '@hookmend/common';
import { analyzeDrift } from './worker.js';

export { analyzeDrift };

export function createAnalyzeDriftWorker({ db, queue, aiClient, config = {}, logger = console }) {
  const redisUrl = config.REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379';
  const prefix = config.QUEUE_PREFIX || process.env.QUEUE_PREFIX || DEFAULT_CONFIG.QUEUE_PREFIX;

  const redisConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
  });

  const rpmLimit = Number(config.GEMINI_RPM_LIMIT || DEFAULT_CONFIG.GEMINI_RPM_LIMIT || 10);

  const worker = new Worker(
    QUEUE_NAMES.ANALYZE_DRIFT,
    async (job) => {
      logger.info?.(
        {
          jobId: job.id,
          driftFingerprint: job.data?.driftFingerprint,
          sourceId: job.data?.sourceId,
          eventType: job.data?.eventType,
        },
        'Drift analysis job started'
      );

      return analyzeDrift({
        job,
        db,
        deps: {
          queue,
          aiClient,
          redis: redisConnection,
          now: () => new Date(),
          logger,
          config,
        },
      });
    },
    {
      connection: redisConnection,
      prefix,
      concurrency: 1,
      limiter: {
        max: rpmLimit,
        duration: 60000,
      },
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
