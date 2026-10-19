/**
 * db/client.js — Singleton MongoClient with idempotent index creation.
 *
 * Index notes:
 * - sources: unique {slug:1}; {active:1}
 * - events: unique {sourceId:1,eventId:1}; {status:1,receivedAt:-1}; {driftFingerprint:1};
 *           {sourceId:1,eventType:1,status:1}; {proposalId:1}; TTL {expireAt:1} expireAfterSeconds:0
 * - expireAt is OMITTED from event docs until status becomes delivered or dead (Phase 2)
 */

import { MongoClient } from 'mongodb';

/** @type {Map<string, MongoClient>} */
const clients = new Map();

/**
 * Connect (or return existing) MongoClient and create indexes idempotently.
 * @param {string} uri - MongoDB connection URI (optional; uses process.env.MONGODB_URI)
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

async function createIndexes(db) {
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
  // TTL index — MongoDB will delete docs where expireAt <= now. expireAt is omitted
  // entirely until a terminal status is set; this index fires only when expireAt is present.
  await events.createIndex(
    { expireAt: 1 },
    { expireAfterSeconds: 0, sparse: true, background: true }
  );
}

/**
 * Close all clients. Useful for graceful shutdown.
 */
export async function closeDb() {
  for (const [uri, mongoClient] of clients.entries()) {
    await mongoClient.close();
    clients.delete(uri);
  }
}
