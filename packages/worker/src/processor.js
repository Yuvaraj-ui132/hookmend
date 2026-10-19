/**
 * processor.js — Plain function event processor.
 *
 * D11: processEvent({job, db, deps}) independent of BullMQ.
 * D3, D4, D5, D12, D13, D14, D15 implemented strictly.
 */

import { ObjectId } from 'mongodb';
import { UnrecoverableError } from 'bullmq';
import {
  writeAuditLog,
  computeStructuralDiff,
  computeFingerprint,
  validatePayload,
  EVENT_STATUS,
  QUEUE_NAMES,
} from '@hookmend/common';
import { classifyDeliveryResponse, deliverEvent } from './delivery.js';

export async function processEvent({ job, db, deps }) {
  const {
    fetch: fetchImpl = globalThis.fetch,
    queue,
    now: nowFn = () => new Date(),
    logger = console,
    config = {},
  } = deps;

  const eventObjectId = new ObjectId(job.data.eventObjectId);

  // 1. Fetch event
  const event = await db.collection('events').findOne({ _id: eventObjectId });
  if (!event) {
    logger.warn?.({ eventObjectId }, 'Event not found; skipping');
    return;
  }

  // D4: Skip if already in delivered, dead, or quarantined state
  if (
    event.status === EVENT_STATUS.DELIVERED ||
    event.status === EVENT_STATUS.DEAD ||
    event.status === EVENT_STATUS.QUARANTINED
  ) {
    logger.info?.({ eventId: event.eventId, status: event.status }, 'Event already in terminal/quarantined state; skipping');
    return;
  }

  const now = nowFn();

  // Mark status processing conditionally
  await db.collection('events').updateOne(
    {
      _id: eventObjectId,
      status: {
        $in: [
          EVENT_STATUS.RECEIVED,
          EVENT_STATUS.FAILED,
          EVENT_STATUS.PROCESSING,
          EVENT_STATUS.REQUEUE_PENDING,
        ],
      },
    },
    { $set: { status: EVENT_STATUS.PROCESSING, updatedAt: now } }
  );

  // 2. Fetch source
  const source = await db.collection('sources').findOne({ _id: event.sourceId });
  if (!source) {
    logger.error?.({ sourceId: event.sourceId }, 'Source not found for event');
    throw new UnrecoverableError('Source not found for event');
  }

  // 3. Schema lookup & validation (D5, D6, D7, D8, D14)
  const activeSchema = await db.collection('schemas').findOne({
    sourceId: event.sourceId,
    eventType: event.eventType,
    active: true,
  });

  let validated = false;
  let schemaVersion = null;

  if (activeSchema) {
    validated = true;
    schemaVersion = activeSchema.version;

    const validationResult = validatePayload(activeSchema, event.payload);
    if (!validationResult.valid) {
      // Schema drift detected -> Quarantine
      const diff = computeStructuralDiff(activeSchema.schema, event.payload);
      const driftFingerprint = computeFingerprint({
        sourceId: event.sourceId.toString(),
        eventType: event.eventType,
        baseSchemaVersion: activeSchema.version,
        diff,
        violations: validationResult.errors,
      });

      const quarantinedAt = nowFn();
      await db.collection('events').updateOne(
        { _id: eventObjectId, status: EVENT_STATUS.PROCESSING },
        {
          $set: {
            status: EVENT_STATUS.QUARANTINED,
            driftFingerprint,
            quarantinedAt,
            schemaVersion,
            validationErrors: validationResult.errors.slice(0, 20),
            validated: true,
            updatedAt: quarantinedAt,
          },
        }
      );

      await writeAuditLog(db, {
        actor: 'worker:process-event',
        action: 'event.quarantined',
        entityType: 'event',
        entityId: eventObjectId,
        detail: {
          driftFingerprint,
          schemaVersion,
          errorCount: validationResult.errors.length,
        },
        timestamp: quarantinedAt,
      });

      // Enqueue analyze-drift job (D9, D14)
      if (queue) {
        await queue.enqueue(
          QUEUE_NAMES.ANALYZE_DRIFT,
          'analyze-drift',
          {
            driftFingerprint,
            sourceId: event.sourceId.toString(),
            eventType: event.eventType,
            triggerEventId: event.eventId,
            requestId: job.data.requestId,
          },
          { jobId: `drift_${driftFingerprint}_a0` }
        );
      }

      return;
    }
  } else {
    // D5: No active schema -> warn, validated: false, schemaVersion: null
    logger.warn?.(
      { sourceId: event.sourceId, eventType: event.eventType },
      'No active schema found for event; proceeding without validation'
    );
  }

  // 4. Delivery (D12, D13)
  const currentAttempt = (job.attemptsMade ?? 0) + 1;
  const maxAttempts = job.opts?.attempts || config.PROCESS_EVENT_ATTEMPTS || 5;

  let deliveryStatus = 0;
  let deliveryErr = null;

  try {
    const res = await deliverEvent({
      event,
      source,
      attempt: currentAttempt,
      fetch: fetchImpl,
      timeoutMs: config.DOWNSTREAM_TIMEOUT_MS || 10000,
    });
    deliveryStatus = res.status;
  } catch (err) {
    deliveryErr = err;
  }

  const { delivered, retryable } = classifyDeliveryResponse(deliveryStatus);

  if (delivered) {
    // Delivered 2xx
    const deliveredAt = nowFn();
    const ttlDays = config.EVENT_TTL_DAYS || 14;
    const expireAt = new Date(deliveredAt.getTime() + ttlDays * 86400000);

    await db.collection('events').updateOne(
      { _id: eventObjectId, status: EVENT_STATUS.PROCESSING },
      {
        $set: {
          status: EVENT_STATUS.DELIVERED,
          processedAt: deliveredAt,
          downstreamStatus: deliveryStatus,
          expireAt,
          validated,
          schemaVersion,
          updatedAt: deliveredAt,
        },
      }
    );

    await writeAuditLog(db, {
      actor: 'worker:process-event',
      action: 'event.delivered',
      entityType: 'event',
      entityId: eventObjectId,
      detail: {
        downstreamStatus: deliveryStatus,
        attempts: currentAttempt,
      },
      timestamp: deliveredAt,
    });

    return;
  }

  // Not delivered
  const isLastAttempt = currentAttempt >= maxAttempts;
  const errorMsg = (deliveryErr ? deliveryErr.message : `HTTP ${deliveryStatus}`).slice(0, 200);

  if (retryable && !isLastAttempt) {
    // Retryable failure, attempts remain -> Mark failed, throw for BullMQ backoff retry
    const failedAt = nowFn();
    await db.collection('events').updateOne(
      { _id: eventObjectId, status: EVENT_STATUS.PROCESSING },
      {
        $set: {
          status: EVENT_STATUS.FAILED,
          downstreamStatus: deliveryStatus,
          lastError: {
            code: 'DOWNSTREAM_ERROR',
            message: errorMsg,
            at: failedAt,
          },
          updatedAt: failedAt,
        },
        $inc: { deliveryAttempts: 1 },
      }
    );

    throw deliveryErr || new Error(`Downstream returned retryable HTTP ${deliveryStatus}`);
  }

  // Either non-retryable OR last attempt exhausted -> Mark dead
  const deadAt = nowFn();
  const ttlDays = config.EVENT_TTL_DAYS || 14;
  const expireAt = new Date(deadAt.getTime() + ttlDays * 86400000);

  await db.collection('events').updateOne(
    { _id: eventObjectId, status: EVENT_STATUS.PROCESSING },
    {
      $set: {
        status: EVENT_STATUS.DEAD,
        downstreamStatus: deliveryStatus,
        expireAt,
        lastError: {
          code: isLastAttempt ? 'DOWNSTREAM_EXHAUSTED' : 'NON_RETRYABLE_ERROR',
          message: errorMsg,
          at: deadAt,
        },
        updatedAt: deadAt,
      },
      $inc: { deliveryAttempts: 1 },
    }
  );

  await writeAuditLog(db, {
    actor: 'worker:process-event',
    action: 'event.dead',
    entityType: 'event',
    entityId: eventObjectId,
    detail: {
      downstreamStatus: deliveryStatus,
      attempts: currentAttempt,
      reason: isLastAttempt ? 'attempts_exhausted' : 'non_retryable_client_error',
    },
    timestamp: deadAt,
  });

  throw new UnrecoverableError(
    isLastAttempt
      ? `Downstream attempts exhausted: ${errorMsg}`
      : `Non-retryable downstream client error: ${errorMsg}`
  );
}
