/**
 * audit.js — Helper for append-only audit trail.
 */

/**
 * Writes an entry to the audit_log collection.
 * Strictly avoids storing payload values.
 *
 * @param {import('mongodb').Db} db
 * @param {object} params
 * @param {string} params.actor - e.g. "worker:process-event" | "system:reconcile" | "admin"
 * @param {string} params.action - e.g. "event.delivered" | "event.quarantined" | "event.dead" | "event.requeued"
 * @param {string} params.entityType - "event" | "proposal" | "schema"
 * @param {import('mongodb').ObjectId|string} params.entityId
 * @param {object} [params.detail] - Structured metadata (no payload values)
 * @param {Date} [params.timestamp]
 */
export async function writeAuditLog(db, {
  actor,
  action,
  entityType,
  entityId,
  detail = {},
  timestamp = new Date(),
}, options = {}) {
  return db.collection('audit_log').insertOne({
    timestamp,
    actor,
    action,
    entityType,
    entityId,
    detail,
  }, options);
}
