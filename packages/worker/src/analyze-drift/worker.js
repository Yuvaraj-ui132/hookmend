/**
 * analyze-drift/worker.js — Plain function drift analyzer (D26, D27).
 */

import {
  writeAuditLog,
  computeStructuralDiff,
  buildBaselineSchema,
  buildBreakingChanges,
  replayEvents,
  redactSchema,
  validateAiOutput,
} from '@hookmend/common';

/**
 * Analyzes schema drift for quarantined events, generates proposal, and performs replay.
 *
 * @param {{
 *   job: object,
 *   db: object,
 *   deps: {
 *     queue?: object,
 *     aiClient?: object,
 *     redis?: object,
 *     now?: () => Date,
 *     logger?: object,
 *     config?: object
 *   }
 * }} params
 * @returns {Promise<object>}
 */
export async function analyzeDrift({ job, db, deps }) {
  const {
    queue,
    aiClient,
    redis,
    now: nowFn = () => new Date(),
    logger = console,
    config = {},
  } = deps;

  const { driftFingerprint, sourceId, eventType } = job.data;
  const now = nowFn();

  // 1. Fetch quarantined events matching this drift fingerprint
  const eventsColl = db.collection('events');
  const events = await eventsColl
    .find({
      sourceId,
      eventType,
      driftFingerprint,
      status: 'quarantined',
    })
    .sort({ receivedAt: 1 })
    .limit(100)
    .toArray();

  if (!events || events.length === 0) {
    logger.info?.({ driftFingerprint }, 'No quarantined events found for drift analysis');
    return { status: 'no_events' };
  }

  // 2. Idempotency: Check if a proposal is already pending review
  const proposalsColl = db.collection('proposals');
  const existingProposal = await proposalsColl.findOne({
    sourceId,
    eventType,
    driftFingerprint,
    status: 'pending_review',
  });

  if (existingProposal) {
    logger.info?.({ driftFingerprint, proposalId: existingProposal._id }, 'Proposal already pending review; skipping');
    return { status: 'proposal_already_exists', proposalId: existingProposal._id };
  }

  // 3. Stale base check: Check active schema version
  const activeSchema = await db.collection('schemas').findOne({
    sourceId,
    eventType,
    active: true,
  });

  const eventSchemaVersion = events[0]?.schemaVersion;
  if (activeSchema && eventSchemaVersion !== undefined && activeSchema.version > eventSchemaVersion) {
    // Active schema has progressed since quarantine -> mark requeue_pending
    logger.info?.(
      { activeVersion: activeSchema.version, eventVersion: eventSchemaVersion },
      'Active schema is newer than quarantined event schemaVersion; marking requeue_pending'
    );

    await eventsColl.updateMany(
      { sourceId, eventType, driftFingerprint, status: 'quarantined' },
      { $set: { status: 'requeue_pending', updatedAt: now } }
    );

    await writeAuditLog(db, {
      actor: 'worker:analyze-drift',
      action: 'events.requeue_pending',
      entityType: 'events',
      entityId: driftFingerprint,
      detail: {
        reason: 'stale_base_schema',
        activeVersion: activeSchema.version,
        eventVersion: eventSchemaVersion,
      },
      timestamp: now,
    });

    return { status: 'stale_base_requeued' };
  }

  // 4. Compute structural diff across sample quarantined events
  const samplePayloads = events.map((e) => e.payload);
  const mergedAdded = new Set();
  const mergedRemoved = new Set();
  const typeChangedMap = new Map();

  for (const evt of events) {
    const diff = computeStructuralDiff(activeSchema?.schema, evt.payload);
    diff.added?.forEach((p) => mergedAdded.add(p));
    diff.removed?.forEach((p) => mergedRemoved.add(p));
    diff.typeChanged?.forEach((tc) => {
      typeChangedMap.set(tc.path, tc);
    });
  }

  const mergedDiff = {
    added: Array.from(mergedAdded),
    removed: Array.from(mergedRemoved),
    typeChanged: Array.from(typeChangedMap.values()),
  };

  const { schema: baselineSchema } = buildBaselineSchema(activeSchema?.schema, mergedDiff);
  const breakingChanges = buildBreakingChanges(activeSchema?.schema, mergedDiff);

  // 5. Replay baseline schema against quarantined events
  const baselineReplay = await replayEvents({
    db,
    sourceId,
    eventType,
    driftFingerprint,
    schema: baselineSchema || activeSchema?.schema,
    max: config.REPLAY_MAX_EVENTS || 1000,
  });

  // 6. Optional AI refinement
  let proposedSchema = baselineSchema || activeSchema?.schema;
  let replayResult = baselineReplay;
  let aiUsed = false;
  let aiFailureReason = null;
  let rationale = null;
  let fieldMappings = null;
  let confidence = undefined;

  const enableAi = Boolean(config.ENABLE_AI);

  if (enableAi && aiClient) {
    let quotaExceeded = false;

    if (redis) {
      try {
        const today = now.toISOString().slice(0, 10);
        const quotaKey = `gemini:rpd:${today}`;
        const currentCount = await redis.incr(quotaKey);
        if (currentCount === 1) {
          await redis.expire(quotaKey, 86400);
        }

        const rpdLimit = config.GEMINI_RPD_LIMIT || 100;
        if (currentCount > rpdLimit) {
          quotaExceeded = true;
          aiFailureReason = 'AI_QUOTA_EXCEEDED_DAILY';
          aiUsed = false;
        }
      } catch (redisErr) {
        logger.warn?.({ redisErr }, 'Failed checking AI Redis quota');
      }
    }

    if (!quotaExceeded) {
      const maxAttempts = job.opts?.attempts || config.ANALYZE_DRIFT_ATTEMPTS || 3;
      const isLastAttempt = (job.attemptsMade ?? 0) >= (maxAttempts - 1);

      try {
        const redactedSchema = redactSchema(activeSchema?.schema);

        const aiOutput = await aiClient.generate({
          system: 'Generate an updated JSON Schema draft-07 resolving the observed schema drift.',
          user: {
            baseSchema: redactedSchema,
            diff: mergedDiff,
            breakingChanges,
          },
        });

        const containment = validateAiOutput(aiOutput, samplePayloads, config.MAX_SCHEMA_BYTES || 102400);
        if (!containment.ok) {
          aiFailureReason = containment.reason || 'CONTAINMENT_FAILED';
          aiUsed = false;
        } else {
          const aiSchema = JSON.parse(aiOutput.proposedSchemaJson);
          const aiReplay = await replayEvents({
            db,
            sourceId,
            eventType,
            driftFingerprint,
            schema: aiSchema,
            max: config.REPLAY_MAX_EVENTS || 1000,
          });

          if (aiReplay.passed >= baselineReplay.passed) {
            aiUsed = true;
            proposedSchema = aiSchema;
            replayResult = aiReplay;
            rationale = aiOutput.rationale;
            fieldMappings = aiOutput.fieldMappings;
            confidence = aiOutput.confidence;
          } else {
            aiUsed = false;
            aiFailureReason = 'AI_REPLAY_WORSE_THAN_BASELINE';
          }
        }
      } catch (err) {
        if (err.status === 429 || err.message?.includes('429') || err.message?.includes('Rate limited')) {
          if (!isLastAttempt) {
            throw err;
          }
          aiFailureReason = 'AI_RATE_LIMITED';
          aiUsed = false;
        } else {
          aiFailureReason = err.message || 'AI_ERROR';
          aiUsed = false;
        }
      }
    }
  }

  // 7. Insert proposal into proposals collection
  const proposalDoc = {
    sourceId,
    eventType,
    driftFingerprint,
    baseSchemaId: activeSchema?._id,
    baseSchemaVersion: activeSchema?.version,
    proposedSchema,
    baselineSchema,
    breakingChanges,
    status: 'pending_review',
    aiUsed,
    ...(aiFailureReason ? { aiFailureReason } : {}),
    ...(rationale ? { rationale } : {}),
    ...(fieldMappings ? { fieldMappings } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    replay: replayResult,
    sampleEventCount: events.length,
    triggerEventId: job.data.triggerEventId,
    createdAt: now,
    updatedAt: now,
  };

  const insertRes = await proposalsColl.insertOne(proposalDoc);
  const proposalId = insertRes.insertedId || proposalDoc._id;

  // 8. Link proposalId to all quarantined events for this drift
  await eventsColl.updateMany(
    { sourceId, eventType, driftFingerprint, status: 'quarantined' },
    { $set: { proposalId, updatedAt: now } }
  );

  // 9. Write audit log
  await writeAuditLog(db, {
    actor: 'worker:analyze-drift',
    action: 'proposal.created',
    entityType: 'proposal',
    entityId: proposalId,
    detail: {
      sourceId,
      eventType,
      driftFingerprint,
      aiUsed,
      passedCount: replayResult.passed,
      failedCount: replayResult.failed,
    },
    timestamp: now,
  });

  return { status: 'proposal_created', proposalId };
}
