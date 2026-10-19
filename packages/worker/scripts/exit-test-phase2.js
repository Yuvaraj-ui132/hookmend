#!/usr/bin/env node
/**
 * packages/worker/scripts/exit-test-phase2.js — Phase 2 Exit Test
 *
 * Runs against real docker-compose MongoDB and Redis (fails if either is unreachable).
 * Asserts Scenarios A through G.
 */

import { MongoClient, ObjectId } from 'mongodb';
import { Redis } from 'ioredis';
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  connectDb,
  closeDb,
  createIndexes,
  createBullQueue,
  createLogger,
  QUEUE_NAMES,
} from '@hookmend/common';
import { createApp } from '../../api/src/server.js';
import { startReceiver } from '../../simulator/src/receiver.js';
import { startWorkerApp } from '../src/main.js';
import { reconcileOnce } from '../src/reconcile.js';
import { signGenericHmac, buildPaymentEvent } from '../../simulator/src/sign.js';

const MONGODB_URI =
  process.env.MONGODB_URI ||
  'mongodb://localhost:27017/hookmend?directConnection=true';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const DB_NAME = 'hookmend_exit_test_phase2';
const QUEUE_PREFIX = 'hookmend-test';
const ADMIN_API_TOKEN = 'test-phase2-admin-token-secret';
const SLUG = 'sim-payments';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(checkFn, timeoutMs = 15000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await checkFn();
    if (res) return res;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function main() {
  console.log('[exit-test-phase2] Starting Phase 2 Exit Test...');

  // ── 0. Verify Mongo and Redis Reachability (No in-memory fallback) ────────
  console.log(`[exit-test-phase2] Probing MongoDB: ${MONGODB_URI}`);
  let mongoHost = 'unknown';
  try {
    const mongoProbe = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 2000 });
    await mongoProbe.connect();
    mongoHost = mongoProbe.options?.hosts?.[0] || 'localhost:27017';
    await mongoProbe.close();
    console.log(`[exit-test-phase2] Connected to MongoDB host: ${mongoHost}`);
  } catch (err) {
    console.error(`[exit-test-phase2] FATAL: MongoDB unreachable at ${MONGODB_URI}`);
    console.error(err.message);
    process.exit(1);
  }

  console.log(`[exit-test-phase2] Probing Redis: ${REDIS_URL}`);
  let redisHost = 'unknown';
  try {
    const redisProbe = new Redis(REDIS_URL, { connectTimeout: 2000, maxRetriesPerRequest: 1 });
    const pong = await redisProbe.ping();
    if (pong !== 'PONG') throw new Error('Redis ping did not return PONG');
    redisHost = `${redisProbe.options.host}:${redisProbe.options.port}`;
    console.log(`[exit-test-phase2] Connected to Redis host: ${redisHost}`);

    // Clear test prefix keys
    const keys = await redisProbe.keys(`${QUEUE_PREFIX}:*`);
    if (keys.length > 0) {
      await redisProbe.del(...keys);
      console.log(`[exit-test-phase2] Cleared ${keys.length} existing Redis test keys`);
    }
    await redisProbe.quit();
  } catch (err) {
    console.error(`[exit-test-phase2] FATAL: Redis unreachable at ${REDIS_URL}`);
    console.error(err.message);
    process.exit(1);
  }

  // ── 1. Drop and recreate test database ─────────────────────────────────────
  const adminClient = new MongoClient(MONGODB_URI);
  await adminClient.connect();
  await adminClient.db(DB_NAME).dropDatabase();
  await adminClient.close();

  const uri = MONGODB_URI.replace(/\/[^/?]*(\?|$)/, `/${DB_NAME}$1`);
  const mongoClient = await connectDb(uri);
  const db = mongoClient.db();
  await createIndexes(db);

  // ── 2. Start Receiver ─────────────────────────────────────────────────────
  let receiver = await startReceiver({ port: 0 });
  console.log(`[exit-test-phase2] Mock Receiver listening on port ${receiver.port}`);

  // ── 3. Seed Source and Schema ─────────────────────────────────────────────
  if (!process.env.SIM_WEBHOOK_SECRET) {
    process.env.SIM_WEBHOOK_SECRET = randomBytes(32).toString('hex');
  }
  const secret = process.env.SIM_WEBHOOK_SECRET;

  const now = new Date();
  const sourceRes = await db.collection('sources').insertOne({
    slug: SLUG,
    name: 'Payment Simulator',
    adapter: 'generic-hmac',
    secretEnvVar: 'SIM_WEBHOOK_SECRET',
    downstreamUrl: `http://127.0.0.1:${receiver.port}/receive`,
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  const sourceId = sourceRes.insertedId;

  await db.collection('schemas').insertOne({
    sourceId,
    eventType: 'payment.created',
    version: 1,
    active: true,
    activatedBy: 'system:seed',
    activatedAt: now,
    schema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['event', 'orderId', 'amount', 'amountPaise', 'utr', 'paymentId'],
      properties: {
        event: { type: 'string' },
        orderId: { type: 'string' },
        amount: { type: 'number' },
        amountPaise: { type: 'number' },
        utr: { type: 'string' },
        paymentId: { type: 'string' },
      },
      additionalProperties: false,
    },
    createdAt: now,
    updatedAt: now,
  });

  // ── 4. Start Queue, API, and Worker ───────────────────────────────────────
  const testConfig = {
    PORT: 0,
    NODE_ENV: 'test',
    MONGODB_URI: uri,
    REDIS_URL,
    QUEUE_PREFIX,
    MAX_BODY_SIZE: 524288,
    TIMESTAMP_TOLERANCE_SECONDS: 300,
    INGEST_RATE_LIMIT_MAX: 10000,
    INGEST_RATE_LIMIT_WINDOW_MS: 60000,
    EVENT_TTL_DAYS: 14,
    LOG_LEVEL: 'silent',
    ADMIN_API_TOKEN,
    PROCESS_EVENT_ATTEMPTS: 3,
    PROCESS_EVENT_BACKOFF_BASE_MS: 500,
    PROCESS_EVENT_BACKOFF_MAX_MS: 500,
    DOWNSTREAM_TIMEOUT_MS: 2000,
    RECONCILE_INTERVAL_MS: 60000,
    RECONCILE_MIN_AGE_MS: 60000,
  };

  const queue = createBullQueue({
    redisUrl: REDIS_URL,
    prefix: QUEUE_PREFIX,
    processEventAttempts: 3,
  });

  const apiApp = createApp({ db, queue, config: testConfig });
  const apiServer = createServer(apiApp);
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const apiPort = apiServer.address().port;
  const apiBase = `http://127.0.0.1:${apiPort}`;
  console.log(`[exit-test-phase2] API server listening on port ${apiPort}`);

  const silentLogger = createLogger({ level: 'silent' });
  const workerApp = await startWorkerApp({
    db,
    queue,
    config: testConfig,
    logger: silentLogger,
  });

  // Helper to send events to API
  async function postIngest(body, deliveryId) {
    const rawBody = JSON.stringify(body);
    const ts = String(Date.now());
    const sig = signGenericHmac(secret, ts, rawBody);

    const res = await fetch(`${apiBase}/ingest/${SLUG}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-signature': sig,
        'x-gateway-timestamp': ts,
        'x-gateway-delivery-id': deliveryId,
      },
      body: rawBody,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  }

  const results = [];

  try {
    // ═════════════════════════════════════════════════════════════════════════
    // Scenario A: 10 valid events -> all delivered, receiver saw 10 requests, each has expireAt
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[Scenario A] Sending 10 valid events...');
    receiver.clear();
    const eventIdsA = [];

    for (let i = 0; i < 10; i++) {
      const delId = `evt_a_${i}_${randomUUID().slice(0, 6)}`;
      eventIdsA.push(delId);
      const body = buildPaymentEvent({ drift: false });
      const res = await postIngest(body, delId);
      if (res.status !== 200) throw new Error(`Scenario A ingest failed: ${res.status}`);
    }

    // Wait until all 10 are delivered
    await waitForCondition(async () => {
      const count = await db.collection('events').countDocuments({
        eventId: { $in: eventIdsA },
        status: 'delivered',
      });
      return count === 10;
    }, 15000);

    const docsA = await db.collection('events').find({ eventId: { $in: eventIdsA } }).toArray();
    const allHaveExpireAtA = docsA.every((d) => d.expireAt instanceof Date);
    const statsA = receiver.getStats();

    const passA = docsA.length === 10 && statsA.totalRequests === 10 && allHaveExpireAtA;
    results.push({
      scenario: 'Scenario A: 10 valid events delivered + expireAt set + receiver saw 10',
      pass: passA,
      detail: `docs delivered: ${docsA.length}/10, receiver requests: ${statsA.totalRequests}/10, expireAt: ${allHaveExpireAtA}`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario B: 5 drifted events -> all quarantined with SAME driftFingerprint, no expireAt, 1 analyze-drift job
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[Scenario B] Sending 5 drifted events...');
    receiver.clear();
    const eventIdsB = [];

    for (let i = 0; i < 5; i++) {
      const delId = `evt_b_${i}_${randomUUID().slice(0, 6)}`;
      eventIdsB.push(delId);
      const body = buildPaymentEvent({ drift: true });
      const res = await postIngest(body, delId);
      if (res.status !== 200) throw new Error(`Scenario B ingest failed: ${res.status}`);
    }

    await waitForCondition(async () => {
      const count = await db.collection('events').countDocuments({
        eventId: { $in: eventIdsB },
        status: 'quarantined',
      });
      return count === 5;
    }, 15000);

    const docsB = await db.collection('events').find({ eventId: { $in: eventIdsB } }).toArray();
    const fingerprintsB = new Set(docsB.map((d) => d.driftFingerprint));
    const anyDeliveredB = receiver.getStats().totalRequests > 0;
    const anyExpireAtB = docsB.some((d) => d.expireAt != null);

    // Verify analyze-drift job exists
    const driftFingerprint = docsB[0].driftFingerprint;
    const driftQueue = queue.getQueue(QUEUE_NAMES.ANALYZE_DRIFT);
    const driftJob = await driftQueue.getJob(`drift_${driftFingerprint}_a0`);

    const passB =
      docsB.length === 5 &&
      fingerprintsB.size === 1 &&
      !anyDeliveredB &&
      !anyExpireAtB &&
      driftJob != null;

    results.push({
      scenario: 'Scenario B: 5 drifted events quarantined with same fingerprint + no delivery + analyze-drift job',
      pass: passB,
      detail: `quarantined: ${docsB.length}/5, unique fingerprints: ${fingerprintsB.size}, delivered: ${receiver.getStats().totalRequests}, job: ${driftJob?.id}`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario C: fail503 mode, 10 events -> dead after 3 attempts, receiver saw 30, 10 event.dead audits
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[Scenario C] Testing retryable 503 failure (10 events)...');
    receiver.clear();
    receiver.setMode('fail503');
    const eventIdsC = [];

    for (let i = 0; i < 10; i++) {
      const delId = `evt_c_${i}_${randomUUID().slice(0, 6)}`;
      eventIdsC.push(delId);
      const body = buildPaymentEvent({ drift: false });
      await postIngest(body, delId);
    }

    await waitForCondition(async () => {
      const count = await db.collection('events').countDocuments({
        eventId: { $in: eventIdsC },
        status: 'dead',
      });
      return count === 10;
    }, 20000);

    const docsC = await db.collection('events').find({ eventId: { $in: eventIdsC } }).toArray();
    const allAttempts3C = docsC.every((d) => d.deliveryAttempts === 3);
    const statsC = receiver.getStats();

    const deadAuditsC = await db.collection('audit_log').countDocuments({
      action: 'event.dead',
      entityId: { $in: docsC.map((d) => d._id) },
    });

    const passC = docsC.length === 10 && allAttempts3C && statsC.totalRequests === 30 && deadAuditsC === 10;
    results.push({
      scenario: 'Scenario C: 10 events fail503 -> dead after 3 attempts, receiver saw 30, 10 dead audits',
      pass: passC,
      detail: `dead: ${docsC.length}/10, attempts=3: ${allAttempts3C}, receiver reqs: ${statsC.totalRequests}/30, audits: ${deadAuditsC}/10`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario D: fail400 mode, 1 event -> dead after exactly 1 attempt
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[Scenario D] Testing non-retryable 400 failure (1 event)...');
    receiver.clear();
    receiver.setMode('fail400');
    const delIdD = `evt_d_${randomUUID().slice(0, 6)}`;
    const bodyD = buildPaymentEvent({ drift: false });
    await postIngest(bodyD, delIdD);

    await waitForCondition(async () => {
      const doc = await db.collection('events').findOne({ eventId: delIdD });
      return doc?.status === 'dead';
    }, 10000);

    const docD = await db.collection('events').findOne({ eventId: delIdD });
    const statsD = receiver.getStats();

    const passD = docD?.status === 'dead' && docD?.deliveryAttempts === 1 && statsD.totalRequests === 1;
    results.push({
      scenario: 'Scenario D: 1 event fail400 -> dead after exactly 1 attempt',
      pass: passD,
      detail: `status: ${docD?.status}, attempts: ${docD?.deliveryAttempts}/1, receiver reqs: ${statsD.totalRequests}/1`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario E: Same event sent twice concurrently -> delivered once, receiver saw 1
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[Scenario E] Testing concurrent duplicate submission...');
    receiver.clear();
    receiver.setMode('ok');
    const delIdE = `evt_e_${randomUUID().slice(0, 6)}`;
    const bodyE = buildPaymentEvent({ drift: false });

    // Send twice concurrently
    const [resE1, resE2] = await Promise.all([
      postIngest(bodyE, delIdE),
      postIngest(bodyE, delIdE),
    ]);

    await waitForCondition(async () => {
      const doc = await db.collection('events').findOne({ eventId: delIdE });
      return doc?.status === 'delivered';
    }, 10000);

    const countE = await db.collection('events').countDocuments({ eventId: delIdE });
    const statsE = receiver.getStats();
    const oneDeduplicatedE =
      (resE1.body.deduplicated === true && resE2.body.deduplicated === false) ||
      (resE1.body.deduplicated === false && resE2.body.deduplicated === true);

    const passE = countE === 1 && statsE.totalRequests === 1 && oneDeduplicatedE;
    results.push({
      scenario: 'Scenario E: Concurrent duplicate -> 1 document, 1 delivery, 1 deduplicated response',
      pass: passE,
      detail: `docs in DB: ${countE}/1, receiver requests: ${statsE.totalRequests}/1, deduplicated flagged: ${oneDeduplicatedE}`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario F: Unenqueued event older than 60s -> reconcileOnce delivers it
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[Scenario F] Testing reconciliation of unpicked received event...');
    receiver.clear();
    receiver.setMode('ok');
    const delIdF = `evt_f_${randomUUID().slice(0, 6)}`;
    const bodyF = buildPaymentEvent({ drift: false });

    const insertF = await db.collection('events').insertOne({
      sourceId,
      sourceSlug: SLUG,
      eventId: delIdF,
      eventType: 'payment.created',
      status: 'received',
      rawBodyHash: 'hash_f',
      payload: bodyF,
      headers: {},
      deliveryAttempts: 0,
      receivedAt: new Date(Date.now() - 300000), // 5 minutes ago
      updatedAt: new Date(Date.now() - 300000),
    });

    // Run reconciliation pass
    const reconResult = await reconcileOnce({
      db,
      queue,
      config: { RECONCILE_MIN_AGE_MS: 60000, RECONCILE_BATCH: 100 },
      logger: silentLogger,
    });

    await waitForCondition(async () => {
      const doc = await db.collection('events').findOne({ _id: insertF.insertedId });
      return doc?.status === 'delivered';
    }, 10000);

    const statsF = receiver.getStats();
    const passF = reconResult.recoveredReceived >= 1 && statsF.totalRequests === 1;
    results.push({
      scenario: 'Scenario F: Reconcile unpicked received event -> recovered and delivered',
      pass: passF,
      detail: `recovered: ${reconResult.recoveredReceived}, receiver requests: ${statsF.totalRequests}/1`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario G: POST /api/events/:id/requeue on dead event -> delivered
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[Scenario G] Testing Admin REST requeue of dead event...');
    receiver.clear();
    receiver.setMode('ok');

    // Use dead event from Scenario D
    const requeueRes = await fetch(`${apiBase}/api/events/${docD._id}/requeue`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_API_TOKEN}`,
      },
    });
    const requeueJson = await requeueRes.json();

    await waitForCondition(async () => {
      const doc = await db.collection('events').findOne({ _id: docD._id });
      return doc?.status === 'delivered';
    }, 10000);

    const updatedD = await db.collection('events').findOne({ _id: docD._id });
    const statsG = receiver.getStats();

    const passG = requeueRes.status === 200 && requeueJson.ok === true && updatedD?.status === 'delivered' && statsG.totalRequests === 1;
    results.push({
      scenario: 'Scenario G: Admin REST requeue dead event -> requeue_pending -> delivered',
      pass: passG,
      detail: `api status: ${requeueRes.status}, event status: ${updatedD?.status}, receiver requests: ${statsG.totalRequests}/1`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario H: Start receiver stopped -> retried -> delivered with attempts >= 2
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[Scenario H] Testing delivery retry on network error with receiver temporarily stopped...');
    const receiverPort = receiver.port;
    await receiver.close();

    const delIdH = `evt_h_${randomUUID().slice(0, 6)}`;
    const bodyH = buildPaymentEvent({ drift: false });
    await postIngest(bodyH, delIdH);

    // Wait about 1 second before starting the receiver
    await new Promise((r) => setTimeout(r, 1000));
    receiver = await startReceiver({ port: receiverPort });
    receiver.setMode('ok');

    await waitForCondition(async () => {
      const doc = await db.collection('events').findOne({ eventId: delIdH });
      return doc?.status === 'delivered';
    }, 15000);

    const docH = await db.collection('events').findOne({ eventId: delIdH });
    const statsH = receiver.getStats();

    const passH = docH?.status === 'delivered' && (docH?.deliveryAttempts ?? 0) >= 2;
    results.push({
      scenario: 'Scenario H: Receiver stopped initially -> retried on network error -> delivered with deliveryAttempts >= 2',
      pass: passH,
      detail: `status: ${docH?.status}, deliveryAttempts: ${docH?.deliveryAttempts}, receiver reqs: ${statsH.totalRequests}`,
    });
  } finally {
    // ── Teardown ────────────────────────────────────────────────────────────
    console.log('\n[exit-test-phase2] Cleaning up test resources...');
    await workerApp.stop();
    await queue.close();
    apiServer.close();
    await receiver.close();
    await closeDb();
  }

  // ── Results Summary ───────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('             HOOKMEND PHASE 2 EXIT TEST RESULTS                ');
  console.log('═══════════════════════════════════════════════════════════════');

  let allPass = true;
  for (const r of results) {
    const mark = r.pass ? '✓ PASS' : '✗ FAIL';
    console.log(`[${mark}] ${r.scenario}`);
    console.log(`         (${r.detail})`);
    if (!r.pass) allPass = false;
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (allPass) {
    console.log('[exit-test-phase2] ALL SCENARIOS PASSED.');
    process.exit(0);
  } else {
    console.error('[exit-test-phase2] ONE OR MORE SCENARIOS FAILED.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[exit-test-phase2] Fatal unhandled error:', err);
  process.exit(1);
});
