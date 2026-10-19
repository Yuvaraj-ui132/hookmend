/**
 * queue/index.js — BullMQ queue factory and connection manager.
 *
 * D9: Queues: "process-event" and "analyze-drift". Configurable prefix (QUEUE_PREFIX).
 * D10: Producer fail-fast (enableOfflineQueue: false) + 2000ms enqueue timeout.
 */

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { DEFAULT_CONFIG, DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '../constants.js';

export function createBullQueue(options = {}) {
  const redisUrl = options.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
  const prefix = options.prefix || process.env.QUEUE_PREFIX || DEFAULT_CONFIG.QUEUE_PREFIX;

  const redisConnection = new Redis(redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });

  redisConnection.on('error', () => {
    // Error logged or caught by ping / enqueue
  });

  const queues = new Map();

  function getQueue(queueName) {
    if (queues.has(queueName)) return queues.get(queueName);
    const q = new Queue(queueName, {
      connection: redisConnection,
      prefix,
    });
    queues.set(queueName, q);
    return q;
  }

  // Initialize standard queues
  getQueue(QUEUE_NAMES.PROCESS_EVENT);
  getQueue(QUEUE_NAMES.ANALYZE_DRIFT);

  async function enqueue(queueName, jobName, data, opts = {}) {
    const queue = getQueue(queueName);
    const configuredAttempts =
      options.processEventAttempts ||
      options.attempts ||
      (options.config && options.config.PROCESS_EVENT_ATTEMPTS);

    const defaultOpts =
      queueName === QUEUE_NAMES.ANALYZE_DRIFT
        ? DEFAULT_JOB_OPTIONS.ANALYZE_DRIFT
        : {
            ...DEFAULT_JOB_OPTIONS.PROCESS_EVENT,
            ...(configuredAttempts ? { attempts: parseInt(configuredAttempts, 10) } : {}),
            ...(options.defaultJobOptions || {}),
          };

    const enqueuePromise = queue.add(jobName, data, {
      ...defaultOpts,
      ...opts,
    });

    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Queue enqueue timed out')), 2000);
    });

    try {
      return await Promise.race([enqueuePromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function ping(timeoutMs = 1500) {
    try {
      let timer;
      const pingPromise = redisConnection.ping();
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis ping timeout')), timeoutMs);
      });
      const res = await Promise.race([pingPromise, timeoutPromise]);
      clearTimeout(timer);
      return res === 'PONG';
    } catch {
      return false;
    }
  }

  async function close() {
    for (const q of queues.values()) {
      await q.close();
    }
    await redisConnection.quit().catch(() => {});
  }

  return {
    enqueue,
    ping,
    close,
    getQueue,
    redisConnection,
  };
}
