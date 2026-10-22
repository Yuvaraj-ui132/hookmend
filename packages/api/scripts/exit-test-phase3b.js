#!/usr/bin/env node
/**
 * packages/api/scripts/exit-test-phase3b.js — Phase 3B Exit Test
 *
 * Runs against real docker-compose MongoDB replica set and Redis (no in-memory fallback).
 * Scenarios:
 *  A) GET /api/sse without a token -> 401
 *  B) 3 valid events -> SSE delivers event.received and event.delivered for all 3 within 10 s
 *  C) 5 drifted events via POST /api/simulate drift "all" -> SSE delivers 5 event.quarantined and 1 proposal.created
 *  D) approve the proposal -> SSE delivers proposal.approved and event.delivered for the 5 events
 *  E) a heartbeat comment is observed; no SSE message contains "payload", "headers" or any synthetic orderId, paymentId or utr used in the run
 *  F) force a watcher restart -> a resync event arrives and later events still flow
 *  G) POST /api/simulate with the simulator flag off returns 404
 *  H) the dashboard production build succeeds (dist/index.html exists) and the dashboard tests pass
 */

import { MongoClient, ObjectId } from 'mongodb';
import { Redis } from 'ioredis';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  connectDb,
  closeDb,
  createIndexes,
  createBullQueue,
  createSseWatcher,
} from '@hookmend/common';
import { createApp } from '../src/server.js';
import { startReceiver } from '../../simulator/src/receiver.js';
import { startWorkerApp } from '../../worker/src/main.js';

const MONGODB_URI =
  process.env.MONGODB_URI ||
  'mongodb://localhost:27017/hookmend?directConnection=true';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const DB_NAME = 'hookmend_exit_test_phase3b';
const QUEUE_PREFIX = 'hookmend-test-3b';
const ADMIN_API_TOKEN = 'test-phase3b-admin-token-secret-xyz';
const SLUG = 'sim-payments-3b';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  console.log('[exit-test-phase3b] Starting Phase 3B Exit Test...');

  // ── 0. Verify MongoDB & Redis reachability (No in-memory fallback) ──────────
  console.log(`[exit-test-phase3b] Probing MongoDB: ${MONGODB_URI}`);
  let mongoHost = 'unknown';
  try {
    const mongoProbe = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 2500 });
    await mongoProbe.connect();
    mongoHost = mongoProbe.options?.hosts?.[0] || 'localhost:27017';
    await mongoProbe.close();
    console.log(`[exit-test-phase3b] Connected to MongoDB host: ${mongoHost}`);
  } catch (err) {
    console.error(`[exit-test-phase3b] FATAL: MongoDB unreachable at ${MONGODB_URI}`);
    console.error(err.message);
    process.exit(1);
  }

  console.log(`[exit-test-phase3b] Probing Redis: ${REDIS_URL}`);
  let redisHost = 'unknown';
  try {
    const redisProbe = new Redis(REDIS_URL, { connectTimeout: 2500, maxRetriesPerRequest: 1 });
    const pong = await redisProbe.ping();
    if (pong !== 'PONG') throw new Error('Redis ping did not return PONG');
    redisHost = `${redisProbe.options.host}:${redisProbe.options.port}`;
    console.log(`[exit-test-phase3b] Connected to Redis host: ${redisHost}`);

    // Clear test prefix keys
    const keys = await redisProbe.keys(`${QUEUE_PREFIX}:*`);
    if (keys.length > 0) {
      await redisProbe.del(...keys);
      console.log(`[exit-test-phase3b] Cleared ${keys.length} existing Redis test keys`);
    }
    await redisProbe.quit();
  } catch (err) {
    console.error(`[exit-test-phase3b] FATAL: Redis unreachable at ${REDIS_URL}`);
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
  console.log(`[exit-test-phase3b] Receiver running on port ${receiverPort}`);

  // ── 3. Seed Source and v1 Schema ───────────────────────────────────────────
  const secretValue = 'test_webhook_secret_3b_' + randomBytes(8).toString('hex');
  const secretEnvVar = 'EXIT_TEST_3B_SECRET';
  process.env[secretEnvVar] = secretValue;

  const sourceInsert = await db.collection('sources').insertOne({
    slug: SLUG,
    name: 'Sim Payments 3B',
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
      required: ['event', 'orderId', 'amount', 'amountPaise', 'utr', 'paymentId'],
      properties: {
        event: { type: 'string' },
        orderId: { type: 'string' },
        amount: { type: 'number' },
        amountPaise: { type: 'integer' },
        utr: { type: 'string' },
        paymentId: { type: 'string' },
      },
      additionalProperties: false,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log(`[exit-test-phase3b] Seeded source ${SLUG} and v1 payment.created schema`);

  // ── 4. Initialize Queue and Workers ────────────────────────────────────────
  const queue = createBullQueue({
    redisUrl: REDIS_URL,
    prefix: QUEUE_PREFIX,
  });

  const testConfig = {
    PORT: 0,
    NODE_ENV: 'test',
    MONGODB_URI,
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
    DOWNSTREAM_TIMEOUT_MS: 3000,
    ENABLE_AI: false,
    ENABLE_SIMULATOR_API: true,
    SIMULATOR_SOURCES: `${SLUG},sim-payments`,
    DASHBOARD_ORIGINS: 'http://localhost:5173',
    MAX_SSE_CLIENTS: 10,
    SSE_HEARTBEAT_MS: 500, // as requested: 500ms
    SSE_WATCHER_MIN_BACKOFF_MS: 50, // test backoff override
    SSE_WATCHER_MAX_BACKOFF_MS: 200,
    REPLAY_MAX_EVENTS: 1000,
    MAX_SCHEMA_BYTES: 102400,
  };

  const workerApp = await startWorkerApp({
    db,
    queue,
    config: {
      ...testConfig,
      RECONCILE_INTERVAL_MS: 300000,
      ENABLE_AI: false,
    },
  });
  console.log('[exit-test-phase3b] Worker app started');

  // ── 5. Initialize SSE Watcher and API Server ───────────────────────────────
  const watcher = createSseWatcher({ db, config: testConfig });
  await watcher.start();

  const app = createApp({
    db,
    queue,
    config: testConfig,
    watcher,
  });

  const server = createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const apiPort = server.address().port;
  testConfig.PORT = apiPort;
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  console.log(`[exit-test-phase3b] API server running at ${baseUrl}`);

  const authHeaders = {
    Authorization: `Bearer ${ADMIN_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  const results = [];
  let sseAbort = null;
  const sseEvents = [];
  const rawChunks = [];

  try {
    // ═════════════════════════════════════════════════════════════════════════
    // Scenario A: GET /api/sse without a token -> 401
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[exit-test-phase3b] Running Scenario A: GET /api/sse without token...');
    const noAuthRes = await fetch(`${baseUrl}/api/sse`);
    const passA = noAuthRes.status === 401;
    results.push({
      scenario: 'Scenario A: GET /api/sse without token -> 401',
      pass: passA,
      detail: `got HTTP ${noAuthRes.status}`,
    });

    // Connect SSE client for subsequent scenarios
    sseAbort = new AbortController();
    const sseRes = await fetch(`${baseUrl}/api/sse`, {
      headers: { Authorization: `Bearer ${ADMIN_API_TOKEN}` },
      signal: sseAbort.signal,
    });
    if (!sseRes.ok) throw new Error(`SSE connect failed: ${sseRes.status}`);

    // Start background SSE reader
    (async () => {
      try {
        const reader = sseRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkStr = decoder.decode(value, { stream: true });
          rawChunks.push(chunkStr);
          buffer += chunkStr;
          const parts = buffer.split('\n\n');
          buffer = parts.pop();
          for (const part of parts) {
            let evName = '';
            let evData = '';
            for (const line of part.split('\n')) {
              const trimmed = line.trim();
              if (trimmed.startsWith('event:')) evName = trimmed.slice(6).trim();
              else if (trimmed.startsWith('data:')) evData += trimmed.slice(5).trim();
            }
            if (evName || evData) {
              let parsedData = evData;
              try { parsedData = JSON.parse(evData); } catch {}
              sseEvents.push({ event: evName, data: parsedData, raw: part });
            }
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') console.error('SSE reader closed:', err.message);
      }
    })();

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario B: 3 valid events -> SSE delivers event.received and event.delivered within 10s
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[exit-test-phase3b] Running Scenario B: 3 valid events -> event.received & event.delivered...');
    const simBRes = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        sourceSlug: SLUG,
        count: 3,
        drift: 'none',
      }),
    });
    if (!simBRes.ok) throw new Error(`POST /api/simulate (B) failed: ${simBRes.status}`);

    await waitForCondition(() => {
      const rec = sseEvents.filter((e) => e.event === 'event.received');
      const del = sseEvents.filter((e) => e.event === 'event.delivered');
      return rec.length >= 3 && del.length >= 3;
    }, 10000, 150);

    const recB = sseEvents.filter((e) => e.event === 'event.received').length;
    const delB = sseEvents.filter((e) => e.event === 'event.delivered').length;
    const passB = recB >= 3 && delB >= 3;
    results.push({
      scenario: 'Scenario B: 3 valid events -> SSE delivers event.received and event.delivered within 10s',
      pass: passB,
      detail: `event.received: ${recB}/3, event.delivered: ${delB}/3`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario C: 5 drifted events via POST /api/simulate drift "all" -> 5 event.quarantined & 1 proposal.created
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[exit-test-phase3b] Running Scenario C: 5 drifted events -> 5 event.quarantined & 1 proposal.created...');
    const simCRes = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        sourceSlug: SLUG,
        count: 5,
        drift: 'all',
      }),
    });
    if (!simCRes.ok) throw new Error(`POST /api/simulate (C) failed: ${simCRes.status}`);

    await waitForCondition(() => {
      const quar = sseEvents.filter((e) => e.event === 'event.quarantined');
      const prop = sseEvents.filter((e) => e.event === 'proposal.created');
      return quar.length >= 5 && prop.length >= 1;
    }, 15000, 150);

    const quarC = sseEvents.filter((e) => e.event === 'event.quarantined').length;
    const propC = sseEvents.filter((e) => e.event === 'proposal.created').length;
    const passC = quarC >= 5 && propC >= 1;
    results.push({
      scenario: 'Scenario C: 5 drifted events via POST /api/simulate drift "all" -> 5 event.quarantined and 1 proposal.created',
      pass: passC,
      detail: `event.quarantined: ${quarC}/5, proposal.created: ${propC}/1`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario D: Approve proposal -> SSE delivers proposal.approved and event.delivered for 5 events
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[exit-test-phase3b] Running Scenario D: Approve proposal -> proposal.approved & event.delivered...');
    const proposalDoc = await waitForCondition(async () => {
      return await db.collection('proposals').findOne({ status: 'pending_review' });
    }, 5000, 100);

    const approveRes = await fetch(`${baseUrl}/api/proposals/${proposalDoc._id}/approve`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ currentSchemaVersion: 1 }),
    });
    if (!approveRes.ok) {
      const errText = await approveRes.text();
      throw new Error(`Approve proposal failed: ${approveRes.status} ${errText}`);
    }

    // Wait for proposal.approved and 5 new event.delivered (total delivered >= 8)
    await waitForCondition(() => {
      const appEvt = sseEvents.filter((e) => e.event === 'proposal.approved');
      const delEvt = sseEvents.filter((e) => e.event === 'event.delivered');
      return appEvt.length >= 1 && delEvt.length >= 8;
    }, 15000, 150);

    const appD = sseEvents.filter((e) => e.event === 'proposal.approved').length;
    const delD = sseEvents.filter((e) => e.event === 'event.delivered').length;
    const passD = appD >= 1 && delD >= 8;
    results.push({
      scenario: 'Scenario D: approve proposal -> SSE delivers proposal.approved and event.delivered for 5 events',
      pass: passD,
      detail: `proposal.approved: ${appD}/1, total delivered: ${delD}/8`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario E: Heartbeat comment observed; no SSE contains payload, headers or synthetic IDs
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[exit-test-phase3b] Running Scenario E: Heartbeat observed & zero payload leak...');
    const hasHeartbeat = rawChunks.some((chunk) => chunk.includes(': heartbeat'));

    let leaksFound = 0;
    for (const evt of sseEvents) {
      const serialized = JSON.stringify(evt.data || '');
      if (
        serialized.includes('"payload"') ||
        serialized.includes('"headers"') ||
        serialized.includes('"ord-') ||
        serialized.includes('"pay_') ||
        serialized.includes('"UTR')
      ) {
        leaksFound++;
      }
    }

    const passE = hasHeartbeat && leaksFound === 0;
    results.push({
      scenario: 'Scenario E: heartbeat comment observed and zero payload, headers, orderId, paymentId, utr leaks',
      pass: passE,
      detail: `heartbeat observed: ${hasHeartbeat}, leaks found: ${leaksFound}`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario F: Force watcher restart -> resync event arrives and later events still flow
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[exit-test-phase3b] Running Scenario F: Force watcher restart -> resync event...');
    const preCount = sseEvents.length;
    watcher.forceRestart();

    await waitForCondition(() => {
      return sseEvents.some((e) => e.event === 'resync');
    }, 5000, 50);

    const resyncEvts = sseEvents.filter((e) => e.event === 'resync').length;

    // Send 1 more event after restart to confirm events still flow
    await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        sourceSlug: SLUG,
        count: 1,
        drift: 'none',
      }),
    });

    await waitForCondition(() => {
      const rec = sseEvents.filter((e) => e.event === 'event.received');
      return rec.length >= 9; // 3 from B + 5 from C + 1 new = 9
    }, 8000, 100);

    const laterReceived = sseEvents.filter((e) => e.event === 'event.received').length;
    const passF = resyncEvts >= 1 && laterReceived >= 9;
    results.push({
      scenario: 'Scenario F: force watcher restart -> resync event arrives and later events flow',
      pass: passF,
      detail: `resync count: ${resyncEvts}, later event.received total: ${laterReceived}/9`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario G: POST /api/simulate with simulator flag off returns 404
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[exit-test-phase3b] Running Scenario G: POST /api/simulate with flag off -> 404...');
    const disabledApp = createApp({
      db,
      queue,
      config: { ...testConfig, ENABLE_SIMULATOR_API: false },
    });
    const disabledServer = createServer(disabledApp);
    await new Promise((res) => disabledServer.listen(0, '127.0.0.1', res));
    const disabledPort = disabledServer.address().port;

    const disabledRes = await fetch(`http://127.0.0.1:${disabledPort}/api/simulate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ sourceSlug: SLUG }),
    });
    const passG = disabledRes.status === 404;
    disabledServer.close();

    results.push({
      scenario: 'Scenario G: POST /api/simulate with simulator flag off returns 404',
      pass: passG,
      detail: `got HTTP ${disabledRes.status}`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario H: Dashboard production build succeeds and dashboard tests pass
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[exit-test-phase3b] Running Scenario H: Dashboard build and tests...');
    execSync('npx vite build packages/dashboard', { stdio: 'pipe' });
    const distHtmlExists = existsSync(resolve('packages/dashboard/dist/index.html'));

    let testsPass = false;
    try {
      execSync('npx vitest run packages/dashboard/test', { stdio: 'pipe' });
      testsPass = true;
    } catch {}

    const passH = distHtmlExists && testsPass;
    results.push({
      scenario: 'Scenario H: dashboard production build succeeds and dashboard tests pass',
      pass: passH,
      detail: `dist/index.html exists: ${distHtmlExists}, tests passed: ${testsPass}`,
    });

  } finally {
    // ── Teardown ─────────────────────────────────────────────────────────────
    console.log('\n[exit-test-phase3b] Cleaning up test resources...');
    if (sseAbort) {
      try { sseAbort.abort(); } catch {}
    }
    if (watcher) {
      try { await watcher.stop(); } catch {}
    }
    if (workerApp) {
      try { await workerApp.stop(); } catch {}
    }
    if (server) {
      await new Promise((res) => server.close(res));
    }
    if (receiver) {
      try { await receiver.close(); } catch {}
    }
    if (queue) {
      try { await queue.close(); } catch {}
    }
    try { await closeDb(); } catch {}
    delete process.env[secretEnvVar];
    await sleep(200);
  }

  // ── Results Summary ─────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('            HOOKMEND PHASE 3B EXIT TEST RESULTS                ');
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
    console.log('[exit-test-phase3b] ALL SCENARIOS PASSED.');
    process.exitCode = 0;
  } else {
    console.error('[exit-test-phase3b] ONE OR MORE SCENARIOS FAILED.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n❌ PHASE 3B EXIT TEST FAILED:');
  console.error(err);
  process.exitCode = 1;
});
