/**
 * main.js — Worker entry point and lifecycle manager.
 *
 * D17, D17b: Single-instance reconciliation runner.
 * D20: Graceful shutdown on SIGTERM / SIGINT.
 */

import {
  connectDb,
  closeDb,
  createLogger,
  createBullQueue,
  DEFAULT_CONFIG,
} from '@hookmend/common';
import { createProcessEventWorker } from './process-event/index.js';
import { createAnalyzeDriftWorker } from './analyze-drift/index.js';
import { reconcileOnce } from './reconcile.js';
import { createGeminiClient } from './ai/gemini.js';

export function startReconcileLoop({ db, queue, config = {}, logger = console }) {
  const intervalMs = config.RECONCILE_INTERVAL_MS || 300000;
  let running = true;
  let timer = null;

  async function tick() {
    if (!running) return;
    try {
      await reconcileOnce({ db, queue, config, logger });
    } catch (err) {
      logger.warn?.({ err: err?.message || err }, 'Periodic reconciliation failed; will retry on next interval');
    }
    if (running) {
      timer = setTimeout(tick, intervalMs);
    }
  }

  timer = setTimeout(tick, intervalMs);

  return {
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Starts worker process and background reconciliation.
 */
export async function startWorkerApp(overrides = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    MONGODB_URI: process.env.MONGODB_URI,
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    QUEUE_PREFIX: process.env.QUEUE_PREFIX || DEFAULT_CONFIG.QUEUE_PREFIX,
    WORKER_CONCURRENCY: process.env.WORKER_CONCURRENCY || '5',
    WORKER_LOCK_DURATION_MS: process.env.WORKER_LOCK_DURATION_MS,
    WORKER_STALLED_INTERVAL_MS: process.env.WORKER_STALLED_INTERVAL_MS,
    WORKER_MAX_STALLED_COUNT: process.env.WORKER_MAX_STALLED_COUNT,
    RECONCILE_INTERVAL_MS: process.env.RECONCILE_INTERVAL_MS
      ? parseInt(process.env.RECONCILE_INTERVAL_MS, 10)
      : DEFAULT_CONFIG.RECONCILE_INTERVAL_MS,
    RECONCILE_MIN_AGE_MS: process.env.RECONCILE_MIN_AGE_MS
      ? parseInt(process.env.RECONCILE_MIN_AGE_MS, 10)
      : DEFAULT_CONFIG.RECONCILE_MIN_AGE_MS,
    STALE_JOB_THRESHOLD_MS: process.env.STALE_JOB_THRESHOLD_MS
      ? parseInt(process.env.STALE_JOB_THRESHOLD_MS, 10)
      : DEFAULT_CONFIG.STALE_JOB_THRESHOLD_MS,
    PROCESS_EVENT_BACKOFF_BASE_MS: process.env.PROCESS_EVENT_BACKOFF_BASE_MS,
    PROCESS_EVENT_BACKOFF_MAX_MS: process.env.PROCESS_EVENT_BACKOFF_MAX_MS,
    PROCESS_EVENT_ATTEMPTS: process.env.PROCESS_EVENT_ATTEMPTS,
    ENABLE_AI: process.env.ENABLE_AI === 'true',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    ...overrides.config,
  };

  const logger = overrides.logger || createLogger({ level: config.LOG_LEVEL || 'info' });

  const mongoClient = overrides.db
    ? null
    : await connectDb(config.MONGODB_URI);
  const db = overrides.db || mongoClient.db();

  const queue = overrides.queue || createBullQueue({
    redisUrl: config.REDIS_URL,
    prefix: config.QUEUE_PREFIX,
  });

  const aiClient = overrides.aiClient || (config.ENABLE_AI ? createGeminiClient({ config, logger }) : null);

  const processEventWorker = createProcessEventWorker({ db, queue, config, logger });
  const analyzeDriftWorker = createAnalyzeDriftWorker({ db, queue, aiClient, config, logger });

  logger.info({ prefix: config.QUEUE_PREFIX }, 'Hookmend workers started');

  // Initial reconciliation pass
  try {
    const result = await reconcileOnce({ db, queue, config, logger });
    logger.info({ result }, 'Initial reconciliation pass complete');
  } catch (recErr) {
    logger.warn?.({ err: recErr?.message || recErr }, 'Initial reconciliation pass failed; periodic runner will retry');
  }

  // Periodic reconciliation
  const reconcileRunner = startReconcileLoop({ db, queue, config, logger });

  async function stop() {
    reconcileRunner.stop();
    await processEventWorker.close();
    await analyzeDriftWorker.close();
    if (!overrides.queue) await queue.close();
    if (!overrides.db) await closeDb();
    logger.info('Workers stopped');
  }

  return {
    db,
    queue,
    processEventWorker,
    analyzeDriftWorker,
    stop,
  };
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('main.js')) {
  const logger = createLogger();

  startWorkerApp()
    .then(({ stop }) => {
      async function shutdown(signal) {
        logger.info({ signal }, 'Graceful shutdown initiated');
        await stop();
        process.exit(0);
      }

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((err) => {
      console.error('Fatal worker startup error:', err);
      process.exit(1);
    });
}
