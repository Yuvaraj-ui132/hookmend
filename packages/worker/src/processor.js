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

  const rawId =
    job.data.eventObjectId || (ObjectId.isValid(job.data.eventId) ? job.data.eventId : null);

  // 1. Fetch event
  const event = rawId
    ? await db.collection('events').findOne({ _id: new ObjectId(rawId) })
    : await db.collection('events').findOne({ eventId: job.data.eventId });

  if (!event) {
    logger.warn?.({ eventObjectId: rawId, eventId: job.data.eventId }, 'Event not found; skipping');
    return;
  }

  const eventObjectId = event._id;

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
    { $set: { status: EVENT_STATUS.PROCESSING, statusChangedAt: now, updatedAt: now } }
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

      // Check if a pending_review proposal exists for this drift (D25)
      const proposalsColl = db.collection('proposals');
      const pendingProposal = await proposalsColl.findOne({
        sourceId: event.sourceId,
        eventType: event.eventType,
        driftFingerprint,
        status: 'pending_review',
      });

      const quarantineSet = {
        status: EVENT_STATUS.QUARANTINED,
        driftFingerprint,
        quarantinedAt,
        schemaVersion,
        validationErrors: validationResult.errors.slice(0, 20),
        validated: true,
        statusChangedAt: quarantinedAt,
        updatedAt: quarantinedAt,
      };

      if (pendingProposal) {
        quarantineSet.proposalId = pendingProposal._id;
      }

      await db.collection('events').updateOne(
        { _id: eventObjectId, status: EVENT_STATUS.PROCESSING },
        { $set: quarantineSet }
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
          ...(pendingProposal ? { proposalId: pendingProposal._id } : {}),
        },
        timestamp: quarantinedAt,
      });

      // Enqueue analyze-drift job only if no proposal is pending review (D25)
      if (!pendingProposal && queue) {
        let proposalCount = 0;
        try {
          proposalCount = await proposalsColl.countDocuments({
            sourceId: event.sourceId,
            eventType: event.eventType,
            driftFingerprint,
          });
        } catch {
          proposalCount = 0;
        }

        const jobId = `drift_${driftFingerprint}_a${proposalCount}`;
        await queue.enqueue(
          QUEUE_NAMES.ANALYZE_DRIFT,
          'analyze-drift',
          {
            driftFingerprint,
            sourceId: event.sourceId.toString(),
            eventType: event.eventType,
            triggerEventId: event.eventId,
            requestId: job.data?.requestId,
          },
          { jobId }
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

  const { delivered, retryable } = classifyDeliveryResponse(deliveryStatus, {
    networkError: Boolean(deliveryErr),
  });

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
          statusChangedAt: deliveredAt,
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
  const rawMsg = deliveryErr ? deliveryErr.message : `HTTP ${deliveryStatus}`;
  const errorMsg = rawMsg.replace(/https?:\/\/[^\s]+/gi, '[redacted]').slice(0, 200);

  const errorCode = deliveryErr
    ? (deliveryErr.cause?.code || deliveryErr.code || deliveryErr.cause?.name || deliveryErr.name || 'NETWORK_ERROR')
    : (isLastAttempt ? 'DOWNSTREAM_EXHAUSTED' : (retryable ? 'DOWNSTREAM_ERROR' : 'NON_RETRYABLE_ERROR'));

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
            code: errorCode,
            message: errorMsg,
            at: failedAt,
          },
          statusChangedAt: failedAt,
          updatedAt: failedAt,
        },
        $inc: { deliveryAttempts: 1 },
      }
    );

    logger.warn?.(
      { eventId: event.eventId, downstreamStatus: deliveryStatus, err: errorCode },
      deliveryErr ? 'Downstream delivery network failure; will retry' : 'Downstream delivery retryable failure; will retry'
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
          code: errorCode,
          message: errorMsg,
          at: deadAt,
        },
        statusChangedAt: deadAt,
        updatedAt: deadAt,
      },
      $inc: { deliveryAttempts: 1 },
    }
  );

  const failureReason = isLastAttempt
    ? 'attempts_exhausted'
    : (deliveryErr ? 'network_error' : 'non_retryable_client_error');

  await writeAuditLog(db, {
    actor: 'worker:process-event',
    action: 'event.dead',
    entityType: 'event',
    entityId: eventObjectId,
    detail: {
      downstreamStatus: deliveryStatus,
      attempts: currentAttempt,
      reason: failureReason,
      code: errorCode,
    },
    timestamp: deadAt,
  });

  const failureMessage = isLastAttempt
    ? `Downstream attempts exhausted: ${errorMsg}`
    : (deliveryErr
        ? `Downstream network error: ${errorMsg}`
        : `Non-retryable downstream client error: ${errorMsg}`);

  logger.error?.(
    { eventId: event.eventId, downstreamStatus: deliveryStatus, code: errorCode },
    failureMessage
  );

  throw new UnrecoverableError(failureMessage);
}
