/**
 * routes/admin.js — Admin REST API (mounted under /api).
 *
 * Exposes sources, events, schemas, and manual event requeue.
 * Protected by Bearer token authentication.
 */

import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { AppError } from '../middleware/errorHandler.js';
import { createAdminAuthMiddleware } from '../middleware/adminAuth.js';
import { writeAuditLog, QUEUE_NAMES } from '@hookmend/common';
import logger from '../logger.js';

function parseObjectId(id) {
  if (!id || !ObjectId.isValid(id)) {
    throw new AppError('INVALID_ID', 'Invalid resource identifier', 400);
  }
  return new ObjectId(id);
}

export function createAdminRouter({ db, queue, config }) {
  const router = Router();
  const auth = createAdminAuthMiddleware(config);

  router.use(auth);

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

  return router;
}
