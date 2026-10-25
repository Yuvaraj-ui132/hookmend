#!/usr/bin/env node
/**
 * packages/worker/scripts/exit-test-phase4.js — Phase 4 Exit Test
 *
 * Runs against real docker-compose MongoDB and Redis (no in-memory fallback).
 * Fails clearly with exit code 1 if either is unreachable (D51).
 *
 * Scenarios:
 *  A) D54(a): Body > MAX_BODY_SIZE returns 413 and stores zero documents
 *  B) D54(c): Admin auth returns 401 on missing, malformed, or invalid tokens
 *  C) D54(d): Secure headers (nosniff, DENY, no-referrer, no-store) on all /api routes
 *  D) D54(e): Production token guard rejects short/insecure tokens in production
 *  E) D50: Receiver slow mode delivers accurately with simulated downstream latency
 *  F) D52/C3: Stale processing recovery via reconcileOnce recovers and delivers event
 *  G) D51 & D53: Chaos (chaos.js) and load-test (load-test.js) fail clearly when DB is unreachable
 *  H) D55 & D56: CI workflow least-privilege validity, zero critical npm audit vulns, dashboard dist
 */

import { MongoClient, ObjectId } from 'mongodb';
import { Redis } from 'ioredis';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  connectDb,
  closeDb,
  createIndexes,
  createBullQueue,
  createLogger,
  QUEUE_NAMES,
} from '@hookmend/common';
import { createApp } from '../../api/src/server.js';
import { getConfig } from '../../api/src/config.js';
import { startReceiver } from '../../simulator/src/receiver.js';
import { startWorkerApp } from '../src/main.js';
import { reconcileOnce } from '../src/reconcile.js';
import { signGenericHmac, buildPaymentEvent } from '../../simulator/src/sign.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');

const MONGODB_URI =
  process.env.MONGODB_URI ||
  'mongodb://localhost:27017/hookmend?directConnection=true';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const DB_NAME = 'hookmend_exit_test_phase4';
const QUEUE_PREFIX = 'hookmend-test-p4';
const ADMIN_API_TOKEN = 'test-phase4-admin-token-super-secret-xyz';
const SLUG = 'sim-payments-p4';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(checkFn, timeoutMs = 20000, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await checkFn();
    if (res) return res;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function main() {
  console.log('[exit-test-phase4] Starting Phase 4 Exit Test (Hardening & Resilience)...');

  // ── 0. Verify MongoDB & Redis reachability (D51: no in-memory fallback) ──────
  console.log(`[exit-test-phase4] Probing MongoDB: ${MONGODB_URI}`);
  let mongoHost = 'unknown';
  try {
    const mongoProbe = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 2500 });
    await mongoProbe.connect();
    mongoHost = mongoProbe.options?.hosts?.[0] || 'localhost:27017';
    await mongoProbe.close();
    console.log(`[exit-test-phase4] Connected to MongoDB host: ${mongoHost}`);
  } catch (err) {
    console.error(`[exit-test-phase4] FATAL: MongoDB unreachable at ${MONGODB_URI}`);
    console.error(err.message);
    process.exit(1);
  }

  console.log(`[exit-test-phase4] Probing Redis: ${REDIS_URL}`);
  let redisHost = 'unknown';
  try {
    const redisProbe = new Redis(REDIS_URL, { connectTimeout: 2500, maxRetriesPerRequest: 1 });
    const pong = await redisProbe.ping();
    if (pong !== 'PONG') throw new Error('Redis ping did not return PONG');
    redisHost = `${redisProbe.options.host}:${redisProbe.options.port}`;
    console.log(`[exit-test-phase4] Connected to Redis host: ${redisHost}`);

    // Clear test prefix keys
    const keys = await redisProbe.keys(`${QUEUE_PREFIX}:*`);
    if (keys.length > 0) {
      await redisProbe.del(...keys);
      console.log(`[exit-test-phase4] Cleared ${keys.length} existing Redis test keys`);
    }
    await redisProbe.quit();
  } catch (err) {
    console.error(`[exit-test-phase4] FATAL: Redis unreachable at ${REDIS_URL}`);
    console.error(err.message);
    process.exit(1);
  }

  // ── 1. Drop and recreate test database ─────────────────────────────────────
  const adminClient = new MongoClient(MONGODB_URI);
  await adminClient.connect();
  await adminClient.db(DB_NAME).dropDatabase();
  await adminClient.close();

  const mongoClient = await connectDb(MONGODB_URI);
  const db = mongoClient.db(DB_NAME);
  await createIndexes(db);

  // ── 2. Start Downstream Receiver ───────────────────────────────────────────
  const receiver = await startReceiver({ port: 0 });
  const receiverPort = receiver.port;
  const downstreamUrl = `http://127.0.0.1:${receiverPort}/receive`;
  console.log(`[exit-test-phase4] Receiver running on port ${receiverPort}`);

  // ── 3. Seed Source and Schema ──────────────────────────────────────────────
  const secretValue = 'test_webhook_secret_p4_' + randomBytes(8).toString('hex');
  const secretEnvVar = 'EXIT_TEST_P4_SECRET';
  process.env[secretEnvVar] = secretValue;

  const sourceInsert = await db.collection('sources').insertOne({
    slug: SLUG,
    name: 'Sim Payments Phase 4',
    adapter: 'generic-hmac',
    secretEnvVar,
    downstreamUrl,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const sourceId = sourceInsert.insertedId;

  await db.collection('schemas').insertOne({
    sourceId,
    eventType: 'payment.created',
    version: 1,
    active: true,
    schema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['orderId', 'amount', 'currency'],
      properties: {
        orderId: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
      },
    },
    createdAt: new Date(),
  });

  // ── 4. Start BullMQ Queue, API server, and Worker ─────────────────────────
  const queue = createBullQueue({
    redisUrl: REDIS_URL,
    prefix: QUEUE_PREFIX,
  });

  const config = {
    PORT: 0,
    NODE_ENV: 'test',
    MONGODB_URI,
    REDIS_URL,
    QUEUE_PREFIX,
    ADMIN_API_TOKEN,
    MAX_BODY_SIZE: 512, // Strict small limit for 413 test
    DOWNSTREAM_TIMEOUT_MS: 5000,
    ENABLE_AI: false,
    LOG_LEVEL: 'silent',
    ALLOW_PRIVATE_DOWNSTREAM: true,
  };

  const app = createApp({ db, queue, config });
  const apiServer = createServer(app);
  await new Promise((resolve) => apiServer.listen(0, resolve));
  const apiPort = apiServer.address().port;
  const apiBase = `http://127.0.0.1:${apiPort}`;
  console.log(`[exit-test-phase4] API Server running on port ${apiPort}`);

  const workerApp = await startWorkerApp({
    db,
    queue,
    config: {
      ...config,
      STALE_JOB_THRESHOLD_MS: 3000,
      WORKER_LOCK_DURATION_MS: '4000',
      WORKER_STALLED_INTERVAL_MS: '2000',
      WORKER_MAX_STALLED_COUNT: '3',
    },
  });
  console.log('[exit-test-phase4] Worker started with Phase 4 configurable knobs');

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // Scenario A: D54(a) Body > MAX_BODY_SIZE returns 413 and stores zero docs
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[exit-test-phase4] ── Scenario A: D54(a) Oversized body 413');
    const largePayload = JSON.stringify({
      orderId: 'ord_large_payload_test',
      amount: 100,
      currency: 'USD',
      padding: 'x'.repeat(1024), // 1KB > 512 bytes MAX_BODY_SIZE
    });
    const largeTimestamp = Math.floor(Date.now() / 1000);
    const largeSignature = signGenericHmac(largePayload, secretValue, largeTimestamp);

    const resA = await fetch(`${apiBase}/ingest/${SLUG}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': largeSignature,
        'x-timestamp': String(largeTimestamp),
      },
      body: largePayload,
    });

    if (resA.status !== 413) {
      throw new Error(`Scenario A failed: expected status 413, got ${resA.status}`);
    }
    const countA = await db.collection('events').countDocuments({ 'payload.orderId': 'ord_large_payload_test' });
    if (countA !== 0) {
      throw new Error(`Scenario A failed: oversized payload was stored in database (count=${countA})`);
    }
    console.log('[exit-test-phase4] Scenario A PASS: 413 Payload Too Large and zero documents stored');

    // ──────────────────────────────────────────────────────────────────────────
    // Scenario B: D54(c) Admin auth returns 401 on missing, malformed, or invalid tokens
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[exit-test-phase4] ── Scenario B: D54(c) Admin Auth 401 Enforcement');
    const resB1 = await fetch(`${apiBase}/api/events`);
    if (resB1.status !== 401) {
      throw new Error(`Scenario B failed: missing token expected 401, got ${resB1.status}`);
    }
    const resB2 = await fetch(`${apiBase}/api/events`, {
      headers: { Authorization: 'Bearer wrong-token-value' },
    });
    if (resB2.status !== 401) {
      throw new Error(`Scenario B failed: wrong token expected 401, got ${resB2.status}`);
    }
    const resB3 = await fetch(`${apiBase}/api/events`, {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    if (resB3.status !== 401) {
      throw new Error(`Scenario B failed: malformed scheme expected 401, got ${resB3.status}`);
    }
    console.log('[exit-test-phase4] Scenario B PASS: Missing, wrong, and malformed tokens all return 401');

    // ──────────────────────────────────────────────────────────────────────────
    // Scenario C: D54(d) Secure headers on all /api routes
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[exit-test-phase4] ── Scenario C: D54(d) Secure Headers Middleware');
    const resC = await fetch(`${apiBase}/api/stats`, {
      headers: { Authorization: `Bearer ${ADMIN_API_TOKEN}` },
    });
    if (resC.status !== 200) {
      throw new Error(`Scenario C failed: expected 200 from /api/stats, got ${resC.status}`);
    }
    const hOptions = resC.headers.get('x-content-type-options');
    const hFrame = resC.headers.get('x-frame-options');
    const hReferrer = resC.headers.get('referrer-policy');
    const hCache = resC.headers.get('cache-control');

    if (hOptions !== 'nosniff') throw new Error(`Scenario C: invalid x-content-type-options: ${hOptions}`);
    if (hFrame !== 'DENY') throw new Error(`Scenario C: invalid x-frame-options: ${hFrame}`);
    if (hReferrer !== 'no-referrer') throw new Error(`Scenario C: invalid referrer-policy: ${hReferrer}`);
    if (hCache !== 'no-store') throw new Error(`Scenario C: invalid cache-control: ${hCache}`);
    console.log('[exit-test-phase4] Scenario C PASS: Secure headers nosniff, DENY, no-referrer, no-store verified');

    // ──────────────────────────────────────────────────────────────────────────
    // Scenario D: D54(e) Production token guard
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[exit-test-phase4] ── Scenario D: D54(e) Production Token Startup Guard');
    const origEnv = process.env.NODE_ENV;
    const origToken = process.env.ADMIN_API_TOKEN;
    try {
      process.env.NODE_ENV = 'production';
      process.env.ADMIN_API_TOKEN = 'short-token-123';
      let threw = false;
      try {
        getConfig();
      } catch (err) {
        threw = true;
        if (!err.message.includes('at least 24 characters in production')) {
          throw new Error(`Scenario D: unexpected error message: ${err.message}`);
        }
      }
      if (!threw) {
        throw new Error('Scenario D failed: getConfig did not throw on short token in production');
      }
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.ADMIN_API_TOKEN = origToken;
    }
    console.log('[exit-test-phase4] Scenario D PASS: Short token rejected in production mode');

    // ──────────────────────────────────────────────────────────────────────────
    // Scenario E: D50 Receiver slow mode
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[exit-test-phase4] ── Scenario E: D50 Receiver Slow Mode Delivery');
    receiver.clear();
    receiver.setMode('slow', 600); // 600ms delay

    const eventPayloadE = JSON.stringify({
      orderId: 'ord_slow_test_p4',
      amount: 45.5,
      currency: 'INR',
    });
    const tsE = Math.floor(Date.now() / 1000);
    const sigE = signGenericHmac(eventPayloadE, secretValue, tsE);

    const startE = Date.now();
    const resE = await fetch(`${apiBase}/ingest/${SLUG}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': sigE,
        'x-timestamp': String(tsE),
      },
      body: eventPayloadE,
    });
    if (resE.status !== 200) {
      throw new Error(`Scenario E ingest failed: status ${resE.status}`);
    }

    // Wait for event to be delivered
    await waitForCondition(async () => {
      const doc = await db.collection('events').findOne({ 'payload.orderId': 'ord_slow_test_p4' });
      return doc && doc.status === 'delivered';
    }, 15000);

    const durationE = Date.now() - startE;
    if (durationE < 500) {
      throw new Error(`Scenario E failed: delivery completed too quickly (${durationE}ms < 500ms)`);
    }
    receiver.setMode('ok');
    console.log(`[exit-test-phase4] Scenario E PASS: Event delivered through slow downstream in ${durationE}ms`);

    // ──────────────────────────────────────────────────────────────────────────
    // Scenario F: D52/C3 Stale processing recovery
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[exit-test-phase4] ── Scenario F: D52/C3 Stale Processing Reconcile Recovery');
    receiver.clear();
    const staleEventId = 'evt_stale_p4_' + randomBytes(4).toString('hex');
    const staleDoc = {
      eventId: staleEventId,
      sourceId,
      sourceSlug: SLUG,
      eventType: 'payment.created',
      schemaVersion: 1,
      status: 'processing',
      receivedAt: new Date(Date.now() - 400000),
      statusChangedAt: new Date(Date.now() - 400000), // > 3000ms threshold
      updatedAt: new Date(Date.now() - 400000),
      payload: { orderId: 'ord_stale_recovery_test', amount: 99.0, currency: 'USD' },
      headers: { 'content-type': 'application/json' },
      downstreamUrl,
      requeueSeq: 0,
    };
    await db.collection('events').insertOne(staleDoc);

    const recResult = await reconcileOnce({
      db,
      queue,
      config: {
        STALE_JOB_THRESHOLD_MS: 3000,
        RECONCILE_MIN_AGE_MS: 60000,
      },
    });

    if (recResult.recoveredStaleProcessing < 1) {
      throw new Error(`Scenario F failed: reconcileOnce recovered ${recResult.recoveredStaleProcessing} stale events (expected >= 1)`);
    }

    // Wait for the worker to process the re-enqueued event to delivered
    await waitForCondition(async () => {
      const doc = await db.collection('events').findOne({ eventId: staleEventId });
      return doc && doc.status === 'delivered' && doc.requeueSeq === 1;
    }, 15000);

    console.log('[exit-test-phase4] Scenario F PASS: Stale processing event recovered, requeued with seq=1, and delivered');

    // ──────────────────────────────────────────────────────────────────────────
    // Scenario G: D51 & D53 Chaos and Load Runner Scripts Integrity
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[exit-test-phase4] ── Scenario G: D51 & D53 Chaos & Load Test Scripts');
    const chaosPath = resolve(ROOT, 'packages', 'worker', 'scripts', 'chaos.js');
    const loadPath = resolve(ROOT, 'packages', 'worker', 'scripts', 'load-test.js');

    if (!existsSync(chaosPath)) throw new Error('Scenario G: chaos.js missing');
    if (!existsSync(loadPath)) throw new Error('Scenario G: load-test.js missing');

    // Execute with unreachable host to verify clean exit 1 per D51
    const probeChaos = spawnSync('node', [chaosPath], {
      cwd: ROOT,
      env: { ...process.env, MONGODB_URI: 'mongodb://127.0.0.1:27999/unreachable' },
      encoding: 'utf8',
      timeout: 10000,
    });
    if (probeChaos.status !== 1) {
      throw new Error(`Scenario G: chaos.js expected exit code 1 on unreachable DB, got ${probeChaos.status}`);
    }

    const probeLoad = spawnSync('node', [loadPath], {
      cwd: ROOT,
      env: { ...process.env, MONGODB_URI: 'mongodb://127.0.0.1:27999/unreachable' },
      encoding: 'utf8',
      timeout: 10000,
    });
    if (probeLoad.status !== 1) {
      throw new Error(`Scenario G: load-test.js expected exit code 1 on unreachable DB, got ${probeLoad.status}`);
    }
    console.log('[exit-test-phase4] Scenario G PASS: Chaos and Load test runners exist and fail cleanly on unreachable infra');

    // ──────────────────────────────────────────────────────────────────────────
    // Scenario H: D55 & D56 CI Workflow, Audit Status, Dashboard Artifact
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[exit-test-phase4] ── Scenario H: D55 & D56 CI Workflow, Audit & Dashboard Build');
    const ciPath = resolve(ROOT, '.github', 'workflows', 'ci.yml');
    if (!existsSync(ciPath)) throw new Error('Scenario H: ci.yml missing');
    const ciContent = readFileSync(ciPath, 'utf8');
    if (!ciContent.includes('permissions:\n  contents: read')) {
      throw new Error('Scenario H: ci.yml missing least-privilege contents: read permissions');
    }
    if (!ciContent.includes('actions/checkout@v4') || !ciContent.includes('actions/setup-node@v4')) {
      throw new Error('Scenario H: ci.yml missing pinned v4 action versions');
    }

    const distPath = resolve(ROOT, 'packages', 'dashboard', 'dist', 'index.html');
    if (!existsSync(distPath)) {
      throw new Error('Scenario H: packages/dashboard/dist/index.html missing');
    }

    const auditRes = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=critical'], {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
    });
    if (auditRes.status !== 0) {
      throw new Error(`Scenario H: npm audit failed with critical vulnerabilities: ${auditRes.stdout}`);
    }
    console.log('[exit-test-phase4] Scenario H PASS: CI workflow verified, dashboard bundle intact, zero critical audit vulnerabilities');

    console.log('\n[exit-test-phase4] ═════════════════════════════════════════════');
    console.log('[exit-test-phase4] ALL PHASE 4 SCENARIOS (A–H) PASSED');
    console.log('[exit-test-phase4] ═════════════════════════════════════════════\n');
  } finally {
    // Teardown
    console.log('[exit-test-phase4] Cleaning up servers and connections...');
    if (workerApp && workerApp.stop) await workerApp.stop();
    await new Promise((r) => apiServer.close(r));
    await receiver.close();
    await queue.close();
    await closeDb(mongoClient);
  }
}

main().catch((err) => {
  console.error('[exit-test-phase4] Unhandled error during exit test:', err);
  process.exit(1);
});
