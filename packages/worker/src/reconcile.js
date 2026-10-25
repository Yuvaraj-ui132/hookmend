/**
 * reconcile.js — Background reconciliation runner.
 *
 * D17:
 * (a) events in 'received' older than RECONCILE_MIN_AGE_MS -> enqueue jobId `${_id}_v0`
 * (b) events in 'requeue_pending' -> enqueue jobId `${_id}_rq${requeueSeq ?? 0}`
 * (c) events in 'processing' or 'failed' older than STALE_JOB_THRESHOLD_MS
 *     -> move to requeue_pending with incremented requeueSeq and enqueue (D52/C3 fix)
 *
 * D52: stale processing/failed events whose statusChangedAt (or updatedAt as fallback)
 * is older than STALE_JOB_THRESHOLD_MS are conditionally moved to requeue_pending
 * by incrementing requeueSeq and enqueueing with jobId `${id}_rq${seq}`.
 * This enables at-least-once delivery recovery after Redis data loss.
 * Downstream must deduplicate on x-hookmend-event-id.
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
 *   staleProcessingCount: number,
 *   recoveredStaleProcessing: number
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
  let recoveredStaleProcessing = 0;

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
      logger.warn?.({ err: err?.message || err, eventId: ev.eventId }, 'Reconciliation failed to enqueue received event');
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
      logger.warn?.({ err: err?.message || err, eventId: ev.eventId }, 'Reconciliation failed to enqueue requeue_pending event');
    }
  }

  // (c) D52/C3: Recover stale processing and failed events
  // Use statusChangedAt if available, fallback to updatedAt, then receivedAt.
  // Only re-enqueue events where the last status change is older than STALE_JOB_THRESHOLD_MS.
  // This avoids hitting a legitimate in-flight job that is actively being worked on.
  const staleEvents = await db
    .collection('events')
    .find({
      status: { $in: [EVENT_STATUS.PROCESSING, EVENT_STATUS.FAILED] },
      $or: [
        { statusChangedAt: { $lte: staleThreshold } },
        { statusChangedAt: { $exists: false }, updatedAt: { $lte: staleThreshold } },
        { statusChangedAt: { $exists: false }, updatedAt: { $exists: false }, receivedAt: { $lte: staleThreshold } },
      ],
    })
    .limit(batchSize)
    .toArray();

  staleProcessingCount = staleEvents.length;

  if (staleProcessingCount > 0) {
    logger.warn?.(
      { count: staleProcessingCount, staleThreshold },
      'Detected stale processing/failed events; re-enqueueing via requeue_pending (at-least-once delivery)'
    );
  }

  for (const ev of staleEvents) {
    const oldSeq = ev.requeueSeq ?? 0;
    const newSeq = oldSeq + 1;
    const now = nowFn();

    try {
      // Conditionally move to requeue_pending using the old status and old timestamp
      // to avoid double-hitting an event that was already updated by another reconciliation pass
      const effectiveChangedAt = ev.statusChangedAt ?? ev.updatedAt ?? ev.receivedAt;
      const updateResult = await db.collection('events').updateOne(
        {
          _id: ev._id,
          status: ev.status,                          // still in the same status
          $or: [
            { statusChangedAt: effectiveChangedAt },
            { statusChangedAt: { $exists: false }, updatedAt: effectiveChangedAt },
            {
              statusChangedAt: { $exists: false },
              updatedAt: { $exists: false },
              receivedAt: effectiveChangedAt,
            },
          ],
        },
        {
          $set: {
            status: EVENT_STATUS.REQUEUE_PENDING,
            requeueSeq: newSeq,
            statusChangedAt: now,
            updatedAt: now,
          },
        }
      );

      if (updateResult.modifiedCount === 0) {
        // Race condition: another reconciliation pass already handled this event
        logger.info?.({ eventId: ev.eventId }, 'Stale event already updated by concurrent reconciliation; skipping');
        continue;
      }

      await queue.enqueue(
        QUEUE_NAMES.PROCESS_EVENT,
        'process-event',
        {
          eventObjectId: ev._id.toString(),
          eventId: ev.eventId,
          sourceId: ev.sourceId?.toString(),
          eventType: ev.eventType,
        },
        { jobId: `${ev._id}_rq${newSeq}` }
      );
      recoveredStaleProcessing++;
    } catch (err) {
      logger.warn?.({ err: err?.message || err, eventId: ev.eventId }, 'Reconciliation failed to re-enqueue stale processing/failed event');
    }
  }

  return {
    recoveredReceived,
    recoveredRequeuePending,
    staleProcessingCount,
    recoveredStaleProcessing,
  };
}
