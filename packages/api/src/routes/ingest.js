/**
 * routes/ingest.js — POST /ingest/:sourceSlug
 *
 * Pipeline (per spec §7 + instructions):
 *  1  Rate limit (slug:ip key, trust proxy)
 *  2  Raw body (scoped, 413 on oversize)
 *  3  Find source by slug with active:true → 404 SOURCE_NOT_FOUND
 *  4  Secret from process.env[source.secretEnvVar] → 500 INTERNAL_ERROR (no var name leaked)
 *  5  adapter.verify → map errors to HTTP codes
 *  6  Parse JSON from raw buffer (after verify) → 400 INVALID_JSON
 *  7  eventType from adapter or body.event → 400 INVALID_PAYLOAD
 *  8  insertOne event (no expireAt field) → catch E11000 for dedup
 *  9  queue.enqueue (if throws: log + still return 200)
 * 10  return 200 { ok, eventId, deduplicated }
 */

import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { rawBodyMiddleware } from '../middleware/rawBody.js';
import { AppError } from '../middleware/errorHandler.js';
import * as githubAdapter from '../adapters/github.js';
import * as genericHmacAdapter from '../adapters/generic-hmac.js';
import logger from '../logger.js';

// Header allow-list for storage — signature headers are NEVER stored
const ALLOWED_HEADERS = new Set([
  'x-request-id',
  'x-github-delivery',
  'x-github-event',
  'x-gateway-delivery-id',
  'x-gateway-timestamp',
  'content-type',
]);

const ADAPTERS = {
  github: githubAdapter,
  'generic-hmac': genericHmacAdapter,
};

// Map adapter error codes to HTTP responses
function mapAdapterError(error) {
  switch (error) {
    case 'SIGNATURE_MISSING':
    case 'SIGNATURE_FORMAT':
    case 'SIGNATURE_INVALID':
      return new AppError('SIGNATURE_INVALID', 'Invalid or missing webhook signature', 401);
    case 'TIMESTAMP_MISSING':
    case 'TIMESTAMP_INVALID':
      return new AppError('INVALID_TIMESTAMP', 'Missing or non-numeric timestamp', 400);
    case 'TIMESTAMP_STALE':
      return new AppError('TIMESTAMP_STALE', 'Timestamp is outside the allowed tolerance window', 401);
    case 'EVENT_ID_MISSING':
      return new AppError('EVENT_ID_MISSING', 'Missing delivery ID header', 400);
    default:
      return new AppError('INTERNAL_ERROR', 'Adapter verification failed', 500);
  }
}

/**
 * @param {{ db: import('mongodb').Db, queue: object, config: object }} deps
 */
export function createIngestRouter({ db, queue, config }) {
  const router = Router();

  // Per-source rate limiter factory (slug:ip key, trust proxy set on app)
  const limiter = rateLimit({
    windowMs: config.INGEST_RATE_LIMIT_WINDOW_MS,
    max: config.INGEST_RATE_LIMIT_MAX,
    keyGenerator: (req) => `${req.params.sourceSlug}:${req.ip}`,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many requests',
        requestId: req.requestId,
      });
    },
  });

  const rawBody = rawBodyMiddleware(config.MAX_BODY_SIZE);

  router.post(
    '/ingest/:sourceSlug',
    limiter,
    ...rawBody,
    async (req, res, next) => {
      const { sourceSlug } = req.params;
      const requestId = req.requestId;

      try {
        // ── 3. Find source ──────────────────────────────────────────────────
        const source = await db.collection('sources').findOne({
          slug: sourceSlug,
          active: true,
        });

        if (!source) {
          throw new AppError('SOURCE_NOT_FOUND', `Source '${sourceSlug}' not found or inactive`, 404);
        }

        // ── 4. Lookup secret ────────────────────────────────────────────────
        const secret = process.env[source.secretEnvVar];
        if (!secret) {
          // Log only sourceSlug, never the env var name or value
          logger.error({ sourceSlug, requestId }, 'Secret env var not configured for source');
          throw new AppError('INTERNAL_ERROR', 'An unexpected error occurred', 500);
        }

        // ── 5. Verify signature ─────────────────────────────────────────────
        const adapter = ADAPTERS[source.adapter];
        if (!adapter) {
          logger.error({ sourceSlug, adapter: source.adapter, requestId }, 'Unknown adapter');
          throw new AppError('INTERNAL_ERROR', 'An unexpected error occurred', 500);
        }

        const rawBody = req.body; // Buffer from express.raw
        if (!Buffer.isBuffer(rawBody)) {
          throw new AppError('INVALID_JSON', 'Empty or non-buffer request body', 400);
        }

        const verification = await adapter.verify(rawBody, req.headers, secret);

        if (!verification.ok) {
          throw mapAdapterError(verification.error);
        }

        // ── 6. Parse JSON (only after verify) ──────────────────────────────
        let payload;
        try {
          payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
          throw new AppError('INVALID_JSON', 'Request body is not valid JSON', 400);
        }

        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new AppError('INVALID_JSON', 'Request body must be a JSON object', 400);
        }

        // ── 7. eventType ────────────────────────────────────────────────────
        let eventType = verification.eventType;
        if (!eventType) {
          // generic-hmac: read from body.event
          eventType = typeof payload.event === 'string' ? payload.event : null;
        }
        if (!eventType) {
          throw new AppError('INVALID_PAYLOAD', 'Missing event type', 400);
        }

        // ── 8. Compute rawBodyHash and build header allow-list ──────────────
        const rawBodyHash = createHash('sha256').update(rawBody).digest('hex');

        const safeHeaders = {};
        for (const [key, val] of Object.entries(req.headers)) {
          if (ALLOWED_HEADERS.has(key)) {
            safeHeaders[key] = val;
          }
        }

        // ── 8. Insert event (no expireAt field) ─────────────────────────────
        const now = new Date();
        const eventDoc = {
          sourceId: source._id,
          sourceSlug,
          eventId: verification.eventId,
          eventType,
          status: 'received',
          rawBodyHash,
          payload,
          headers: safeHeaders,
          deliveryAttempts: 0,
          receivedAt: now,
        };

        let insertedId;
        let deduplicated = false;

        try {
          const result = await db.collection('events').insertOne(eventDoc);
          insertedId = result.insertedId;
        } catch (err) {
          // ── 9. E11000 duplicate key ──────────────────────────────────────
          if (err.code === 11000) {
            deduplicated = true;
            // Find the existing doc's _id for the eventId field
            const existing = await db.collection('events').findOne(
              { sourceId: source._id, eventId: verification.eventId },
              { projection: { _id: 1 } }
            );
            insertedId = existing?._id;
          } else {
            throw err;
          }
        }

        // ── 10. Enqueue (if not deduplicated) ───────────────────────────────
        if (!deduplicated) {
          try {
            await queue.enqueue(
              'process-event',
              'process-event',
              {
                eventObjectId: insertedId.toString(),
                eventId: verification.eventId,
                sourceId: source._id.toString(),
                sourceSlug,
                eventType,
                requestId,
              },
              { jobId: `${verification.eventId}_v0` }
            );
          } catch (enqErr) {
            // Log but still return 200; Phase 2 reconciliation will recover
            logger.error({ err: enqErr, requestId, sourceSlug }, 'Failed to enqueue job; event is stored');
          }
        }

        // ── 11. Return 200 ──────────────────────────────────────────────────
        return res.status(200).json({
          ok: true,
          eventId: verification.eventId,
          deduplicated,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
