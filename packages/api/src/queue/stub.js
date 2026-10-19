/**
 * queue/stub.js — In-memory queue stub for Phase 1.
 *
 * Exports the exact signature the Phase 2 BullMQ version will have.
 * Maintains an in-memory array for test inspection.
 *
 * Usage in tests: import { createQueue } from './queue/stub.js'
 *   const queue = createQueue();
 *   queue.jobs  → array of enqueued jobs
 *
 * Deviation from BullMQ: in-memory only; no persistence; no Redis.
 * Recorded in SPEC.md decision log.
 */

import logger from '../logger.js';

/**
 * Creates a new queue stub instance.
 * Each test run should create a fresh instance (or clear queue.jobs).
 */
export function createQueue() {
  /** @type {Array<{queueName:string, jobName:string, data:object, opts:object}>} */
  const jobs = [];

  /**
   * @param {string} queueName
   * @param {string} jobName
   * @param {object} data
   * @param {object} [opts={}]
   * @returns {Promise<{id: string}>}
   */
  async function enqueue(queueName, jobName, data, opts = {}) {
    const id = opts.jobId || `stub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    logger.debug({ queueName, jobName, jobId: id }, 'queue stub: enqueue');
    jobs.push({ queueName, jobName, data, opts });
    return { id };
  }

  return { enqueue, jobs };
}

// Default singleton for production use (main.js can use this)
export const defaultQueue = createQueue();
