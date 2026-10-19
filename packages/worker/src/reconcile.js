/**
 * reconcile.js — Background reconciliation runner.
 *
 * D17:
 * (a) events in 'received' older than RECONCILE_MIN_AGE_MS -> enqueue jobId `${_id}_v0`
 * (b) events in 'requeue_pending' -> enqueue jobId `${_id}_rq${requeueSeq ?? 0}`
 * (c) events in 'processing' older than STALE_JOB_THRESHOLD_MS -> warn
 */

import { EVENT_STATUS, QUEUE_NAMES } from '@hookmend/common';

/**
 * Executes a single reconciliation pass.
 *
 * @param {object} params
 * @param {import('mongodb').Db} params.db
 * @param {object} params.queue
 * @param {Function} [params.now]
 * @param {object} [params.config]
 * @param {object} [params.logger]
 * @returns {Promise<{
 *   recoveredReceived: number,
 *   recoveredRequeuePending: number,
 *   staleProcessingCount: number
 * }>}
 */
export async function reconcileOnce({
  db,
  queue,
  now: nowFn = () => new Date(),
  config = {},
  logger = console,
}) {
  const minAgeMs = config.RECONCILE_MIN_AGE_MS ?? 60000;
  const batchSize = config.RECONCILE_BATCH ?? 500;
  const staleThresholdMs = config.STALE_JOB_THRESHOLD_MS ?? 300000;

  const currentNow = nowFn();
  const receivedThreshold = new Date(currentNow.getTime() - minAgeMs);
  const staleThreshold = new Date(currentNow.getTime() - staleThresholdMs);

  let recoveredReceived = 0;
  let recoveredRequeuePending = 0;
  let staleProcessingCount = 0;

  // (a) Recover unpicked received events
  const receivedEvents = await db
    .collection('events')
    .find({
      status: EVENT_STATUS.RECEIVED,
      receivedAt: { $lte: receivedThreshold },
    })
    .limit(batchSize)
    .toArray();

  for (const ev of receivedEvents) {
    try {
      await queue.enqueue(
        QUEUE_NAMES.PROCESS_EVENT,
        'process-event',
        {
          eventObjectId: ev._id.toString(),
          eventId: ev.eventId,
          sourceId: ev.sourceId?.toString(),
          eventType: ev.eventType,
        },
        { jobId: `${ev._id}_v0` }
      );
      recoveredReceived++;
    } catch (err) {
      logger.error?.({ err, eventId: ev.eventId }, 'Reconciliation failed to enqueue received event');
    }
  }

  // (b) Recover requeue_pending events
  const requeueEvents = await db
    .collection('events')
    .find({
      status: EVENT_STATUS.REQUEUE_PENDING,
    })
    .limit(batchSize)
    .toArray();

  for (const ev of requeueEvents) {
    const seq = ev.requeueSeq ?? 0;
    try {
      await queue.enqueue(
        QUEUE_NAMES.PROCESS_EVENT,
        'process-event',
        {
          eventObjectId: ev._id.toString(),
          eventId: ev.eventId,
          sourceId: ev.sourceId?.toString(),
          eventType: ev.eventType,
        },
        { jobId: `${ev._id}_rq${seq}` }
      );
      recoveredRequeuePending++;
    } catch (err) {
      logger.error?.({ err, eventId: ev.eventId }, 'Reconciliation failed to enqueue requeue_pending event');
    }
  }

  // (c) Check stale processing jobs
  const staleProcessing = await db
    .collection('events')
    .find({
      status: EVENT_STATUS.PROCESSING,
      updatedAt: { $lte: staleThreshold },
    })
    .limit(100)
    .toArray();

  staleProcessingCount = staleProcessing.length;
  if (staleProcessingCount > 0) {
    logger.warn?.(
      { count: staleProcessingCount, staleThreshold },
      'Detected stale processing events that exceeded threshold'
    );
  }

  return {
    recoveredReceived,
    recoveredRequeuePending,
    staleProcessingCount,
  };
}
