/**
 * packages/common/src/sse.js
 * D34: changeToSseEvent — maps MongoDB change stream documents to SSE events.
 *
 * SECURITY: payload, headers, and rawBodyHash are NEVER included in output.
 * Only allow-listed fields are emitted.
 */

// Allow-list of fields emitted for event changes
const EVENT_ALLOW_LIST = [
  'id',
  'sourceSlug',
  'eventType',
  'status',
  'driftFingerprint',
  'deliveryAttempts',
  'lastErrorCode',
  'receivedAt',
  'schemaVersion',
];

// Allow-list of fields emitted for proposal changes
const PROPOSAL_ALLOW_LIST = [
  'id',
  'status',
  'driftFingerprint',
  'sourceId',
  'eventType',
  'aiUsed',
  'affectedEventCount',
  'replayPassed',
  'replayTotal',
  'newSchemaVersion',
];

/**
 * Maps _id to string and extracts only allow-listed fields from a document.
 * @param {object} doc
 * @param {string[]} allowList
 * @returns {object}
 */
function project(doc, allowList) {
  const out = {};
  for (const key of allowList) {
    if (key === 'id') {
      const raw = doc._id;
      out.id = raw != null ? raw.toString() : undefined;
    } else if (key === 'sourceId' && doc[key] != null) {
      out[key] = doc[key].toString();
    } else if (doc[key] !== undefined) {
      out[key] = doc[key];
    }
  }
  return out;
}

/**
 * Maps a MongoDB change stream document to an SSE { event, data } object.
 * Returns null if the change is not mapped to any SSE event.
 *
 * @param {object} change - MongoDB ChangeStreamDocument
 * @returns {{ event: string, data: object } | null}
 */
export function changeToSseEvent(change) {
  const coll = change?.ns?.coll;
  const op = change?.operationType;
  const doc = change?.fullDocument;

  if (!doc || !coll || !op) return null;

  // ── Events collection ──────────────────────────────────────────────────────
  if (coll === 'events') {
    if (op === 'insert') {
      return { event: 'event.received', data: project(doc, EVENT_ALLOW_LIST) };
    }

    if (op === 'update') {
      const updatedFields = change.updateDescription?.updatedFields || {};
      const newStatus = updatedFields.status;
      if (!newStatus) return null;

      const STATUS_EVENT_MAP = {
        delivered: 'event.delivered',
        quarantined: 'event.quarantined',
        failed: 'event.failed',
        dead: 'event.dead',
        requeue_pending: 'event.requeue_pending',
        processing: 'event.processing',
      };

      const sseEvent = STATUS_EVENT_MAP[newStatus];
      if (!sseEvent) return null;

      return { event: sseEvent, data: project(doc, EVENT_ALLOW_LIST) };
    }

    return null;
  }

  // ── Proposals collection ───────────────────────────────────────────────────
  if (coll === 'proposals') {
    if (op === 'insert') {
      return { event: 'proposal.created', data: project(doc, PROPOSAL_ALLOW_LIST) };
    }

    if (op === 'update') {
      const updatedFields = change.updateDescription?.updatedFields || {};
      const newStatus = updatedFields.status;
      const editedByHuman = updatedFields.editedByHuman;

      if (editedByHuman) {
        return { event: 'proposal.edited', data: project(doc, PROPOSAL_ALLOW_LIST) };
      }

      if (newStatus === 'approved') {
        return { event: 'proposal.approved', data: project(doc, PROPOSAL_ALLOW_LIST) };
      }

      if (newStatus === 'rejected') {
        return { event: 'proposal.rejected', data: project(doc, PROPOSAL_ALLOW_LIST) };
      }

      return null;
    }

    return null;
  }

  return null;
}
