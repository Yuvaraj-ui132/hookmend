#!/usr/bin/env node
/**
 * packages/api/scripts/exit-test.js — Phase 1 Exit Test
 *
 * Requires docker compose Mongo running (MONGODB_URI env var).
 *
 * Process:
 *  1. Drop + recreate "hookmend_exit_test" database
 *  2. Seed sim-payments source
 *  3. Set SIM_WEBHOOK_SECRET to a random value if unset
 *  4. Start createApp on ephemeral port with queue stub
 *  5. Send 20 valid events + 5 duplicates of first 5
 *  6. Assert: 25 HTTP 200, 5 deduplicated:true, 20 docs in events (all received)
 *  7. Print PASS/FAIL + exit 0 or 1
 */

import { MongoClient } from 'mongodb';
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';
import { createQueue } from '../src/queue/stub.js';
import { connectDb, closeDb } from '../src/db/client.js';
import { signGenericHmac, buildPaymentEvent } from '../../simulator/src/sign.js';

const DB_NAME = 'hookmend_exit_test';
const SLUG = 'sim-payments';

async function getMongoUri() {
  if (process.env.MONGODB_URI) {
    return { uri: process.env.MONGODB_URI, mongod: null };
  }

  // Try connecting to local Docker MongoDB first
  const defaultLocalUri = 'mongodb://localhost:27017/hookmend?directConnection=true';
  try {
    const probe = new MongoClient(defaultLocalUri, { serverSelectionTimeoutMS: 1500 });
    await probe.connect();
    await probe.close();
    console.log('[exit-test] Using local MongoDB at localhost:27017');
    return { uri: defaultLocalUri, mongod: null };
  } catch {
    console.log('[exit-test] Local MongoDB unreachable; spinning up MongoMemoryServer...');
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri() + 'hookmend';
    return { uri, mongod };
  }
}

async function main() {
  console.log('[exit-test] Starting Phase 1 exit test...');

  const { uri: baseMongoUri, mongod } = await getMongoUri();

  // ── 1. Drop + recreate db ────────────────────────────────────────────────
  const adminClient = new MongoClient(baseMongoUri);
  await adminClient.connect();
  await adminClient.db(DB_NAME).dropDatabase();
  await adminClient.close();

  // ── 2. Connect with indexes ──────────────────────────────────────────────
  const uri = baseMongoUri.replace(/\/[^/?]*(\?|$)/, `/${DB_NAME}$1`);
  const mongoClient = await connectDb(uri);
  const db = mongoClient.db();

  // ── 3. Seed source ───────────────────────────────────────────────────────
  if (!process.env.SIM_WEBHOOK_SECRET) {
    process.env.SIM_WEBHOOK_SECRET = randomBytes(32).toString('hex');
  }
  const secret = process.env.SIM_WEBHOOK_SECRET;

  const now = new Date();
  await db.collection('sources').insertOne({
    slug: SLUG,
    name: 'Payment Simulator',
    adapter: 'generic-hmac',
    secretEnvVar: 'SIM_WEBHOOK_SECRET',
    downstreamUrl: 'http://localhost:4001/receive',
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  // ── 4. Start app on ephemeral port ───────────────────────────────────────
  const queue = createQueue();
  const config = {
    PORT: 0,
    NODE_ENV: 'test',
    MONGODB_URI: uri,
    MAX_BODY_SIZE: 524288,
    TIMESTAMP_TOLERANCE_SECONDS: 300,
    INGEST_RATE_LIMIT_MAX: 10000,
    INGEST_RATE_LIMIT_WINDOW_MS: 60000,
    EVENT_TTL_DAYS: 14,
    LOG_LEVEL: 'silent',
    VERSION: '0.2.0',
  };

  const app = createApp({ db, queue, config });
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  console.log(`[exit-test] Server listening on port ${port}`);

  // ── 5. Send 20 valid events + 5 duplicates ───────────────────────────────
  const events = Array.from({ length: 20 }, () => ({
    deliveryId: randomUUID(),
    body: buildPaymentEvent(),
  }));

  const responses = [];

  // Send 20 unique
  for (const ev of events) {
    const rawBody = JSON.stringify(ev.body);
    const ts = String(Date.now());
    const sig = signGenericHmac(secret, ts, rawBody);

    const res = await fetch(`${base}/ingest/${SLUG}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-signature': sig,
        'x-gateway-timestamp': ts,
        'x-gateway-delivery-id': ev.deliveryId,
      },
      body: rawBody,
    });
    const json = await res.json();
    responses.push({ status: res.status, body: json });
  }

  // Send 5 duplicates of first 5
  for (let i = 0; i < 5; i++) {
    const ev = events[i];
    const rawBody = JSON.stringify(ev.body);
    const ts = String(Date.now());
    const sig = signGenericHmac(secret, ts, rawBody);

    const res = await fetch(`${base}/ingest/${SLUG}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-signature': sig,
        'x-gateway-timestamp': ts,
        'x-gateway-delivery-id': ev.deliveryId,
      },
      body: rawBody,
    });
    const json = await res.json();
    responses.push({ status: res.status, body: json });
  }

  // ── 6. Assert ─────────────────────────────────────────────────────────────
  const total200 = responses.filter(r => r.status === 200).length;
  const totalDeduplicated = responses.filter(r => r.status === 200 && r.body.deduplicated === true).length;
  const eventCount = await db.collection('events').countDocuments();
  const receivedCount = await db.collection('events').countDocuments({ status: 'received' });

  // ── 7. Report ─────────────────────────────────────────────────────────────
  const checks = [
    { name: '25 HTTP 200 responses', pass: total200 === 25, got: total200, want: 25 },
    { name: '5 deduplicated:true responses', pass: totalDeduplicated === 5, got: totalDeduplicated, want: 5 },
    { name: '20 documents in events', pass: eventCount === 20, got: eventCount, want: 20 },
    { name: 'all docs have status received', pass: receivedCount === 20, got: receivedCount, want: 20 },
  ];

  let allPass = true;
  for (const c of checks) {
    const mark = c.pass ? '✓' : '✗';
    console.log(`  ${mark} ${c.name} — got: ${c.got}, want: ${c.want}`);
    if (!c.pass) allPass = false;
  }

  // Cleanup
  server.close();
  await closeDb();
  if (mongod) {
    await mongod.stop();
  }

  if (allPass) {
    console.log('\n[exit-test] PASS');
    process.exit(0);
  } else {
    console.log('\n[exit-test] FAIL');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[exit-test] Fatal error:', err);
  process.exit(1);
});
