/**
 * routes/admin.js — Admin REST API (mounted under /api).
 *
 * Exposes sources, events, schemas, proposals, quarantine, audit log, and manual requeue.
 * Protected by Bearer token authentication.
 */

import { Router } from 'express';
import { ObjectId } from 'mongodb';
import Ajv from 'ajv';
import { AppError } from '../middleware/errorHandler.js';
import { createAdminAuthMiddleware } from '../middleware/adminAuth.js';
import { writeAuditLog, replayEvents, QUEUE_NAMES } from '@hookmend/common';
import logger from '../logger.js';

function parseObjectId(id) {
  if (!id || !ObjectId.isValid(id)) {
    throw new AppError('INVALID_ID', 'Invalid resource identifier', 400);
  }
  return new ObjectId(id);
}

export function createAdminRouter({ db, queue, config = {} }) {
  const router = Router();
  const auth = createAdminAuthMiddleware(config);

  router.use(auth);

  // ── Quarantine Groups (D30) ────────────────────────────────────────────────
  router.get('/quarantine', async (req, res, next) => {
    try {
      const pipeline = [
        { $match: { status: 'quarantined' } },
        {
          $group: {
            _id: '$driftFingerprint',
            sourceId: { $first: '$sourceId' },
            eventType: { $first: '$eventType' },
            count: { $sum: 1 },
            firstSeen: { $min: '$receivedAt' },
            lastSeen: { $max: '$receivedAt' },
            samplePayload: { $first: '$payload' },
            proposalId: { $first: '$proposalId' },
          },
        },
        {
          $project: {
            _id: 0,
            driftFingerprint: '$_id',
            sourceId: 1,
            eventType: 1,
            count: 1,
            firstSeen: 1,
            lastSeen: 1,
            samplePayload: 1,
            proposalId: 1,
          },
        },
        { $sort: { lastSeen: -1 } },
      ];

      const groups = await db.collection('events').aggregate(pipeline).toArray();
      res.json(groups);
    } catch (err) {
      next(err);
    }
  });

  // ── Proposals (D30) ───────────────────────────────────────────────────────
  router.get('/proposals', async (req, res, next) => {
    try {
      const page = Math.max(parseInt(req.query.page || '1', 10), 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 100);

      const filter = {};
      if (req.query.status) {
        filter.status = req.query.status;
      }
      if (req.query.sourceId) {
        const sId = ObjectId.isValid(req.query.sourceId) ? new ObjectId(req.query.sourceId) : req.query.sourceId;
        filter.sourceId = { $in: [sId, req.query.sourceId] };
      }
      if (req.query.eventType) {
        filter.eventType = req.query.eventType;
      }

      const skip = (page - 1) * limit;
      const total = await db.collection('proposals').countDocuments(filter);
      const items = await db
        .collection('proposals')
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      res.json({
        items,
        page,
        limit,
        total,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/proposals/:id', async (req, res, next) => {
    try {
      const _id = parseObjectId(req.params.id);
      const proposal = await db.collection('proposals').findOne({ _id });
      if (!proposal) {
        throw new AppError('NOT_FOUND', 'Proposal not found', 404);
      }
      res.json(proposal);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/proposals/:id', async (req, res, next) => {
    try {
      const _id = parseObjectId(req.params.id);
      const proposal = await db.collection('proposals').findOne({ _id });
      if (!proposal) {
        throw new AppError('NOT_FOUND', 'Proposal not found', 404);
      }

      if (proposal.status !== 'pending_review') {
        throw new AppError(
          'INVALID_STATE',
          `Cannot edit proposal in '${proposal.status}' state (must be 'pending_review')`,
          409
        );
      }

      const { proposedSchema } = req.body;
      if (!proposedSchema || typeof proposedSchema !== 'object' || Array.isArray(proposedSchema)) {
        throw new AppError('INVALID_SCHEMA', 'proposedSchema must be an object', 400);
      }

      // Check Ajv compilation
      const ajv = new Ajv({ allErrors: true, strict: false });
      try {
        ajv.compile(proposedSchema);
      } catch (compileErr) {
        throw new AppError('INVALID_SCHEMA', `Invalid schema: ${compileErr.message}`, 400);
      }

      // Re-run replay validation against quarantined events
      const replayResults = await replayEvents({
        db,
        sourceId: proposal.sourceId,
        eventType: proposal.eventType,
        driftFingerprint: proposal.driftFingerprint,
        schema: proposedSchema,
        max: config.REPLAY_MAX_EVENTS || 1000,
      });

      const now = new Date();
      await db.collection('proposals').updateOne(
        { _id },
        {
          $set: {
            proposedSchema,
            replayResults,
            editedByHuman: true,
            updatedAt: now,
          },
        }
      );

      await writeAuditLog(db, {
        actor: 'admin',
        action: 'proposal.patched',
        entityType: 'proposal',
        entityId: _id,
        detail: {
          editedByHuman: true,
          passed: replayResults.passed,
          failed: replayResults.failed,
        },
        timestamp: now,
      });

      const updated = await db.collection('proposals').findOne({ _id });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  router.post('/proposals/:id/approve', async (req, res, next) => {
    try {
      const _id = parseObjectId(req.params.id);
      const proposal = await db.collection('proposals').findOne({ _id });
      if (!proposal) {
        throw new AppError('NOT_FOUND', 'Proposal not found', 404);
      }

      if (proposal.status !== 'pending_review') {
        throw new AppError(
          'INVALID_STATE',
          `Cannot approve proposal in '${proposal.status}' state (must be 'pending_review')`,
          409
        );
      }

      if (!proposal.proposedSchema) {
        throw new AppError('NEEDS_SCHEMA', 'Proposal has no proposed schema to activate', 409);
      }

      // Pre-check active schema version (stale base check)
      const activeSchema = await db.collection('schemas').findOne({
        sourceId: proposal.sourceId,
        eventType: proposal.eventType,
        active: true,
      });

      if (activeSchema && activeSchema.version !== proposal.baseSchemaVersion) {
        throw new AppError(
          'STALE_BASE',
          `Active schema version (${activeSchema.version}) differs from base schema version (${proposal.baseSchemaVersion})`,
          409
        );
      }

      // Pre-check replay unless allowPartial is true
      const replay = await replayEvents({
        db,
        sourceId: proposal.sourceId,
        eventType: proposal.eventType,
        driftFingerprint: proposal.driftFingerprint,
        schema: proposal.proposedSchema,
        max: config.REPLAY_MAX_EVENTS || 1000,
      });

      if (replay.failed > 0 && !req.body?.allowPartial) {
        throw new AppError(
          'REPLAY_FAILURES',
          `Proposed schema has ${replay.failed} replay failure(s) and allowPartial was not set`,
          409
        );
      }

      const client = db.client || db._client;
      const session = client && typeof client.startSession === 'function' ? client.startSession() : null;

      const now = new Date();
      let newSchemaVersion = 2;
      let requeuedCount = 0;

      const executeApproval = async (sess) => {
        const opts = sess ? { session: sess } : {};

        // In-transaction re-verification
        const currProposal = await db.collection('proposals').findOne({ _id, status: 'pending_review' }, opts);
        if (!currProposal) {
          throw new AppError('INVALID_STATE', 'Proposal was already approved or rejected', 409);
        }

        const currActive = await db.collection('schemas').findOne(
          { sourceId: proposal.sourceId, eventType: proposal.eventType, active: true },
          opts
        );

        if (currActive && currActive.version !== proposal.baseSchemaVersion) {
          throw new AppError('STALE_BASE', 'Active schema version has changed', 409);
        }

        // Deactivate current active schema
        await db.collection('schemas').updateMany(
          { sourceId: proposal.sourceId, eventType: proposal.eventType, active: true },
          { $set: { active: false, updatedAt: now } },
          opts
        );

        newSchemaVersion = (currActive?.version || proposal.baseSchemaVersion || 1) + 1;

        // Insert new active schema
        await db.collection('schemas').insertOne(
          {
            sourceId: proposal.sourceId,
            eventType: proposal.eventType,
            version: newSchemaVersion,
            active: true,
            activatedBy: 'admin',
            activatedAt: now,
            schema: proposal.proposedSchema,
            proposalId: _id,
            createdAt: now,
            updatedAt: now,
          },
          opts
        );

        // Mark proposal approved
        await db.collection('proposals').updateOne(
          { _id },
          {
            $set: {
              status: 'approved',
              approvedBy: 'admin',
              approvedAt: now,
              activatedSchemaVersion: newSchemaVersion,
              updatedAt: now,
            },
          },
          opts
        );

        // Mark quarantined events requeue_pending
        const updateEventsRes = await db.collection('events').updateMany(
          {
            sourceId: proposal.sourceId,
            eventType: proposal.eventType,
            driftFingerprint: proposal.driftFingerprint,
            status: 'quarantined',
          },
          {
            $set: {
              status: 'requeue_pending',
              schemaVersion: newSchemaVersion,
              updatedAt: now,
            },
            $inc: { requeueSeq: 1 },
          },
          opts
        );

        requeuedCount = updateEventsRes.modifiedCount;

        // Write audit log inside transaction
        await writeAuditLog(
          db,
          {
            actor: 'admin',
            action: 'schema.activated',
            entityType: 'schema',
            entityId: `${proposal.sourceId}:${proposal.eventType}:v${newSchemaVersion}`,
            detail: {
              newSchemaVersion,
              proposalId: _id,
            },
            timestamp: now,
          },
          opts
        );

        await writeAuditLog(
          db,
          {
            actor: 'admin',
            action: 'proposal.approved',
            entityType: 'proposal',
            entityId: _id,
            detail: {
              newSchemaVersion,
              requeuedCount,
            },
            timestamp: now,
          },
          opts
        );
      };

      if (session) {
        try {
          await session.withTransaction(async () => {
            await executeApproval(session);
          });
        } finally {
          await session.endSession();
        }
      } else {
        await executeApproval(null);
      }

      // Best-effort enqueue of requeued events
      if (queue) {
        const requeuedEvents = await db
          .collection('events')
          .find({
            sourceId: proposal.sourceId,
            eventType: proposal.eventType,
            driftFingerprint: proposal.driftFingerprint,
            status: 'requeue_pending',
          })
          .toArray();

        for (const evt of requeuedEvents) {
          queue
            .enqueue(
              QUEUE_NAMES.PROCESS_EVENT,
              'process-event',
              {
                eventObjectId: evt._id.toString(),
                eventId: evt.eventId,
                sourceId: evt.sourceId?.toString(),
                eventType: evt.eventType,
              },
              { jobId: `${evt._id}_rq${evt.requeueSeq || 1}` }
            )
            .catch((enqErr) => {
              logger.error({ err: enqErr, eventId: evt.eventId }, 'Requeue best-effort enqueue failed');
            });
        }
      }

      res.json({
        ok: true,
        newSchemaVersion,
        requeuedEvents: requeuedCount,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/proposals/:id/reject', async (req, res, next) => {
    try {
      const _id = parseObjectId(req.params.id);
      const proposal = await db.collection('proposals').findOne({ _id });
      if (!proposal) {
        throw new AppError('NOT_FOUND', 'Proposal not found', 404);
      }

      if (proposal.status !== 'pending_review') {
        throw new AppError(
          'INVALID_STATE',
          `Cannot reject proposal in '${proposal.status}' state (must be 'pending_review')`,
          409
        );
      }

      const now = new Date();
      await db.collection('proposals').updateOne(
        { _id },
        {
          $set: {
            status: 'rejected',
            rejectedBy: 'admin',
            rejectedAt: now,
            rejectionNote: req.body?.note || null,
            updatedAt: now,
          },
        }
      );

      await writeAuditLog(db, {
        actor: 'admin',
        action: 'proposal.rejected',
        entityType: 'proposal',
        entityId: _id,
        detail: {
          note: req.body?.note || null,
        },
        timestamp: now,
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/proposals/reanalyze', async (req, res, next) => {
    try {
      const { sourceId, eventType, driftFingerprint } = req.body;
      if (!sourceId || !eventType || !driftFingerprint) {
        throw new AppError('INVALID_PAYLOAD', 'sourceId, eventType, and driftFingerprint are required', 400);
      }

      const sId = ObjectId.isValid(sourceId) ? new ObjectId(sourceId) : sourceId;

      const existing = await db.collection('proposals').findOne({
        sourceId: { $in: [sId, sourceId] },
        eventType,
        driftFingerprint,
        status: 'pending_review',
      });

      if (existing) {
        throw new AppError('INVALID_STATE', 'A proposal is already pending review for this drift', 409);
      }

      const count = await db.collection('proposals').countDocuments({
        sourceId: { $in: [sId, sourceId] },
        eventType,
        driftFingerprint,
      });

      const jobId = `drift_${driftFingerprint}_a${count}`;

      if (queue) {
        await queue.enqueue(
          QUEUE_NAMES.ANALYZE_DRIFT,
          'analyze-drift',
          {
            driftFingerprint,
            sourceId: sourceId.toString(),
            eventType,
            triggerEventId: 'manual',
          },
          { jobId }
        );
      }

      res.status(202).json({ ok: true, status: 'accepted', jobId });
    } catch (err) {
      next(err);
    }
  });

  // ── Sources ──────────────────────────────────────────────────────────────
  router.get('/sources', async (req, res, next) => {
    try {
      const sources = await db
        .collection('sources')
        .find({})
        .project({ secretEnvVar: 0 })
        .toArray();
      res.json(sources);
    } catch (err) {
      next(err);
    }
  });

  router.get('/sources/:id', async (req, res, next) => {
    try {
      const _id = parseObjectId(req.params.id);
      const source = await db
        .collection('sources')
        .findOne({ _id }, { projection: { secretEnvVar: 0 } });

      if (!source) {
        throw new AppError('NOT_FOUND', 'Source not found', 404);
      }
      res.json(source);
    } catch (err) {
      next(err);
    }
  });

  // ── Events ───────────────────────────────────────────────────────────────
  router.get('/events', async (req, res, next) => {
    try {
      const page = Math.max(parseInt(req.query.page || '1', 10), 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 100);

      const filter = {};
      if (req.query.status) filter.status = req.query.status;
      if (req.query.sourceId) filter.sourceId = parseObjectId(req.query.sourceId);
      if (req.query.eventType) filter.eventType = req.query.eventType;

      const skip = (page - 1) * limit;
      const total = await db.collection('events').countDocuments(filter);
      const items = await db
        .collection('events')
        .find(filter)
        .sort({ receivedAt: -1 })
        .skip(skip)
        .limit(limit)
        .project({ payload: 0, headers: 0 })
        .toArray();

      res.json({
        items,
        page,
        limit,
        total,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/events/:id', async (req, res, next) => {
    try {
      const _id = parseObjectId(req.params.id);
      const event = await db.collection('events').findOne({ _id });
      if (!event) {
        throw new AppError('NOT_FOUND', 'Event not found', 404);
      }
      res.json(event);
    } catch (err) {
      next(err);
    }
  });

  // ── Schemas ──────────────────────────────────────────────────────────────
  router.get('/schemas', async (req, res, next) => {
    try {
      const filter = {};
      if (req.query.sourceId) filter.sourceId = parseObjectId(req.query.sourceId);
      if (req.query.eventType) filter.eventType = req.query.eventType;

      const schemas = await db
        .collection('schemas')
        .find(filter)
        .sort({ version: -1 })
        .toArray();
      res.json(schemas);
    } catch (err) {
      next(err);
    }
  });

  router.get('/schemas/:id', async (req, res, next) => {
    try {
      const _id = parseObjectId(req.params.id);
      const schema = await db.collection('schemas').findOne({ _id });
      if (!schema) {
        throw new AppError('NOT_FOUND', 'Schema not found', 404);
      }
      res.json(schema);
    } catch (err) {
      next(err);
    }
  });

  // ── Requeue Action ────────────────────────────────────────────────────────
  router.post('/events/:id/requeue', async (req, res, next) => {
    try {
      const _id = parseObjectId(req.params.id);
      const event = await db.collection('events').findOne({ _id });

      if (!event) {
        throw new AppError('NOT_FOUND', 'Event not found', 404);
      }

      if (event.status !== 'dead' && event.status !== 'failed') {
        throw new AppError(
          'INVALID_STATE',
          `Cannot requeue event in '${event.status}' state (must be 'dead' or 'failed')`,
          409
        );
      }

      const newSeq = (event.requeueSeq || 0) + 1;
      const now = new Date();

      await db.collection('events').updateOne(
        { _id },
        {
          $set: {
            status: 'requeue_pending',
            requeueSeq: newSeq,
            updatedAt: now,
          },
          $unset: { expireAt: '' },
        }
      );

      await writeAuditLog(db, {
        actor: 'admin',
        action: 'event.requeued',
        entityType: 'event',
        entityId: _id,
        detail: { requeueSeq: newSeq, previousStatus: event.status },
        timestamp: now,
      });

      // Best-effort immediate enqueue (reconciliation acts as backup)
      if (queue) {
        queue
          .enqueue(
            QUEUE_NAMES.PROCESS_EVENT,
            'process-event',
            {
              eventObjectId: _id.toString(),
              eventId: event.eventId,
              sourceId: event.sourceId?.toString(),
              eventType: event.eventType,
            },
            { jobId: `${_id}_rq${newSeq}` }
          )
          .catch((enqErr) => {
            logger.error({ err: enqErr, eventId: event.eventId }, 'Requeue best-effort enqueue failed');
          });
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── Audit Log (D30) ───────────────────────────────────────────────────────
  router.get('/audit', async (req, res, next) => {
    try {
      const filter = {};
      if (req.query.entityType) filter.entityType = req.query.entityType;
      if (req.query.action) filter.action = req.query.action;
      if (req.query.actor) filter.actor = req.query.actor;

      const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 500);

      const items = await db
        .collection('audit_log')
        .find(filter)
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();

      res.json(items);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
