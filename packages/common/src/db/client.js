/**
 * db/client.js — MongoClient manager with idempotent index creation.
 */

import { MongoClient } from 'mongodb';

/** @type {Map<string, MongoClient>} */
const clients = new Map();

/**
 * Connect (or return existing) MongoClient and create indexes idempotently.
 * @param {string} [uri] - MongoDB connection URI (optional; uses process.env.MONGODB_URI)
 * @returns {Promise<MongoClient>}
 */
export async function connectDb(uri) {
  const connectionUri = uri || process.env.MONGODB_URI;
  if (!connectionUri) throw new Error('MONGODB_URI is required');

  if (clients.has(connectionUri)) return clients.get(connectionUri);

  const mongoClient = new MongoClient(connectionUri);
  await mongoClient.connect();
  clients.set(connectionUri, mongoClient);

  const db = mongoClient.db();
  await createIndexes(db);

  return mongoClient;
}

export async function createIndexes(db) {
  // ── sources ──────────────────────────────────────────────────────────────
  const sources = db.collection('sources');
  await sources.createIndex({ slug: 1 }, { unique: true, background: true });
  await sources.createIndex({ active: 1 }, { background: true });

  // ── events ───────────────────────────────────────────────────────────────
  const events = db.collection('events');
  await events.createIndex({ sourceId: 1, eventId: 1 }, { unique: true, background: true });
  await events.createIndex({ status: 1, receivedAt: -1 }, { background: true });
  await events.createIndex({ driftFingerprint: 1 }, { background: true });
  await events.createIndex({ sourceId: 1, eventType: 1, status: 1 }, { background: true });
  await events.createIndex({ proposalId: 1 }, { background: true });
  // TTL index — fires only when expireAt is set
  await events.createIndex(
    { expireAt: 1 },
    { expireAfterSeconds: 0, sparse: true, background: true }
  );

  // ── schemas (D16) ────────────────────────────────────────────────────────
  const schemas = db.collection('schemas');
  await schemas.createIndex(
    { sourceId: 1, eventType: 1, version: 1 },
    { unique: true, background: true }
  );
  await schemas.createIndex(
    { sourceId: 1, eventType: 1 },
    { unique: true, partialFilterExpression: { active: true }, background: true }
  );

  // ── audit_log (D15, D16) ──────────────────────────────────────────────────
  const auditLog = db.collection('audit_log');
  await auditLog.createIndex(
    { entityType: 1, entityId: 1, timestamp: -1 },
    { background: true }
  );
  await auditLog.createIndex(
    { actor: 1, timestamp: -1 },
    { background: true }
  );
  await auditLog.createIndex(
    { timestamp: -1 },
    { expireAfterSeconds: 7776000, background: true } // 90 days TTL
  );

  // ── proposals (D24) ───────────────────────────────────────────────────────
  const proposals = db.collection('proposals');
  await proposals.createIndex(
    { sourceId: 1, eventType: 1, driftFingerprint: 1 },
    { unique: true, partialFilterExpression: { status: 'pending_review' }, background: true }
  );
  await proposals.createIndex(
    { status: 1, createdAt: -1 },
    { background: true }
  );
  await proposals.createIndex(
    { sourceId: 1, eventType: 1, status: 1 },
    { background: true }
  );
}

/**
 * Close all clients.
 */
export async function closeDb() {
  for (const [uri, mongoClient] of clients.entries()) {
    await mongoClient.close();
    clients.delete(uri);
  }
}
