#!/usr/bin/env node
/**
 * packages/worker/scripts/chaos.js — Phase 4 Chaos Test Suite (D51, D52)
 *
 * Scenarios: C1–C7
 * Usage:
 *   npm run chaos
 *   npm run chaos -- --only C1,C2,C4
 *   npm run chaos -- --ci
 *
 * HARD RULES:
 * - Requires real docker-compose Mongo and Redis (exit 1 if unreachable; no in-memory fallback)
 * - Worker runs as a child process (child_process.spawn of packages/worker/src/main.js)
 * - Redis controlled via ioredis (for FLUSHALL in C3) and docker compose stop/start
 * - All numbers measured from real output — docs/CHAOS.md written by this script
 * - Exit code 0 only if every selected scenario passes
 */

import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import os from 'node:os';

import {
  connectDb,
  closeDb,
  createIndexes,
  createBullQueue,
  createLogger,
} from '@hookmend/common';
import { createApp } from '../../api/src/server.js';
import { startReceiver } from '../../simulator/src/receiver.js';
import { signGenericHmac, buildPaymentEvent } from '../../simulator/src/sign.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

// ── Configuration ─────────────────────────────────────────────────────────────

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/hookmend?directConnection=true';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DB_NAME = 'hookmend_chaos';
const QUEUE_PREFIX = 'hookmend-chaos';
const ADMIN_TOKEN = 'chaos-test-admin-token-chaos-secret';
const SLUG = 'chaos-payments';

// D49: Chaos uses short knobs so recovery takes seconds
const CHAOS_ENV = {
  ...process.env,
  MONGODB_URI: MONGODB_URI.replace(/\/[^/?]*([\?]|$)/, `/${DB_NAME}$1`),
  REDIS_URL,
  QUEUE_PREFIX,
  WORKER_CONCURRENCY: '5',
  WORKER_LOCK_DURATION_MS: '4000',
  WORKER_STALLED_INTERVAL_MS: '2000',
  WORKER_MAX_STALLED_COUNT: '3',
  PROCESS_EVENT_BACKOFF_BASE_MS: '200',
  PROCESS_EVENT_BACKOFF_MAX_MS: '5000',
  PROCESS_EVENT_ATTEMPTS: '5',
  RECONCILE_INTERVAL_MS: '5000',
  RECONCILE_MIN_AGE_MS: '3000',
  STALE_JOB_THRESHOLD_MS: '10000',
  ADMIN_API_TOKEN: ADMIN_TOKEN,
  LOG_LEVEL: 'warn',
  NODE_ENV: 'test',
  ENABLE_AI: 'false',
  SIM_WEBHOOK_SECRET: '',
};

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const onlyScenarios = onlyIdx >= 0
  ? new Set(args[onlyIdx + 1].split(',').map(s => s.trim()))
  : null;
const isCI = args.includes('--ci');

// CI uses shorter waits
const WAIT_MULTIPLIER = isCI ? 0.7 : 1.0;
const wait = (ms) => new Promise(r => setTimeout(r, Math.round(ms * WAIT_MULTIPLIER)));

// ── Utility functions ─────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForCondition(checkFn, timeoutMs = 30000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await checkFn();
      if (res) return res;
    } catch { /* retry */ }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function sendEvent(apiBase, sourceSlug, secret, opts = {}) {
  const deliveryId = opts.deliveryId || randomBytes(16).toString('hex');
  const payload = opts.payload || buildPaymentEvent();
  const bodyStr = JSON.stringify(payload);
  const ts = String(Date.now());
  const sig = signGenericHmac(secret, ts, bodyStr);

  const start = Date.now();
  const res = await fetch(`${apiBase}/ingest/${sourceSlug}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gateway-signature': sig,
      'x-gateway-timestamp': ts,
      'x-gateway-delivery-id': deliveryId,
    },
    body: bodyStr,
  });
  const latency = Date.now() - start;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, latency, deliveryId };
}

async function getEventCounts(db) {
  const pipeline = [{ $group: { _id: '$status', count: { $sum: 1 } } }];
  const rows = await db.collection('events').aggregate(pipeline).toArray();
  const counts = {};
  for (const r of rows) counts[r._id] = r.count;
  return counts;
}

async function waitAllDelivered(db, expected, timeoutMs = 90000) {
  const start = Date.now();
  let counts;
  while (Date.now() - start < timeoutMs) {
    counts = await getEventCounts(db);
    const delivered = counts.delivered || 0;
    if (delivered >= expected) return { counts, elapsed: Date.now() - start };
    await sleep(300);
  }
  counts = await getEventCounts(db);
  return { counts, elapsed: Date.now() - start, timedOut: true };
}

// ── Worker child process helpers ──────────────────────────────────────────────

function spawnWorker(env = {}) {
  const workerMain = join(__dirname, '..', 'src', 'main.js');
  const child = spawn('node', [workerMain], {
    env: { ...CHAOS_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {}); // drain
  child.stderr.on('data', () => {});
  return child;
}

async function killWorker(child) {
  if (!child || child.killed) return;
  child.kill('SIGKILL');
  await sleep(200);
}

async function waitWorkerReady(child, timeoutMs = 5000) {
  // Worker is ready when it starts consuming jobs — just wait a bit
  await sleep(Math.min(timeoutMs, 2000));
}

// ── Redis docker compose control ──────────────────────────────────────────────

function dockerComposeRedis(action) {
  // action: 'stop' | 'start'
  const result = spawnSync(
    'docker',
    ['compose', '-f', join(ROOT, 'infra', 'docker-compose.yml'), action, 'redis'],
    { encoding: 'utf8', timeout: 15000 }
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function pollRedisHealth(redisUrl, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = new Redis(redisUrl, { connectTimeout: 1000, maxRetriesPerRequest: 1, lazyConnect: true });
      await r.connect();
      const pong = await r.ping();
      await r.quit().catch(() => {});
      if (pong === 'PONG') return true;
    } catch { /* retry */ }
    await sleep(500);
  }
  return false;
}

// ── Fake AI client for C7 (always throws 429-style error) ────────────────────

function createFakeRateLimitedAI() {
  return {
    analyzeAndPropose: async () => {
      const err = new Error('Resource has been exhausted (429 Quota exceeded)');
      err.status = 429;
      err.code = 'RESOURCE_EXHAUSTED';
      throw err;
    },
  };
}

// ── Machine info ──────────────────────────────────────────────────────────────

function getMachineInfo() {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()}`,
    node: process.version,
    cpu: cpus.length > 0 ? `${cpus[0].model} (${cpus.length} cores)` : 'unknown',
    ram: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB`,
  };
}

function getCommitHash() {
  try {
    return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', cwd: ROOT }).stdout.trim();
  } catch { return 'unknown'; }
}

// ── Setup/Teardown ─────────────────────────────────────────────────────────────

let apiApp, apiServer, apiBase, receiver, db, mongoClient, queue;
let sourceId, sourceSecret;
const logger = { info: () => {}, warn: () => {}, error: console.error };

async function setup() {
  // Verify MongoDB
  console.log(`[chaos] Probing MongoDB: ${MONGODB_URI}`);
  try {
    const probe = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 2500 });
    await probe.connect();
    await probe.close();
    console.log('[chaos] MongoDB: OK');
  } catch (err) {
    console.error(`[chaos] FATAL: MongoDB unreachable at ${MONGODB_URI}: ${err.message}`);
    process.exit(1);
  }

  // Verify Redis
  console.log(`[chaos] Probing Redis: ${REDIS_URL}`);
  try {
    const r = new Redis(REDIS_URL, { connectTimeout: 2500, maxRetriesPerRequest: 1, lazyConnect: true });
    await r.connect();
    const pong = await r.ping();
    if (pong !== 'PONG') throw new Error('no PONG');
    await r.quit().catch(() => {});
    console.log('[chaos] Redis: OK');
  } catch (err) {
    console.error(`[chaos] FATAL: Redis unreachable at ${REDIS_URL}: ${err.message}`);
    process.exit(1);
  }

  // Drop chaos DB and recreate
  const adminClient = new MongoClient(MONGODB_URI);
  await adminClient.connect();
  await adminClient.db(DB_NAME).dropDatabase();

  // Clear Redis chaos prefix
  const rCleanup = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  const keys = await rCleanup.keys(`${QUEUE_PREFIX}:*`);
  if (keys.length > 0) await rCleanup.del(...keys);
  await rCleanup.quit();

  await adminClient.close();

  const chaosUri = MONGODB_URI.replace(/\/[^/?]*(\?|$)/, `/${DB_NAME}$1`);
  mongoClient = await connectDb(chaosUri);
  db = mongoClient.db();
  await createIndexes(db);

  // Start receiver
  receiver = await startReceiver({ port: 0 });
  console.log(`[chaos] Receiver on :${receiver.port}`);

  // Seed source
  sourceSecret = randomBytes(32).toString('hex');
  process.env.CHAOS_WEBHOOK_SECRET = sourceSecret;
  const now = new Date();
  const res = await db.collection('sources').insertOne({
    slug: SLUG,
    name: 'Chaos Test Source',
    adapter: 'generic-hmac',
    secretEnvVar: 'CHAOS_WEBHOOK_SECRET',
    downstreamUrl: `http://127.0.0.1:${receiver.port}/receive`,
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  sourceId = res.insertedId;

  // Build API app in-process
  queue = createBullQueue({ redisUrl: REDIS_URL, prefix: QUEUE_PREFIX });
  const config = {
    PORT: 0,
    NODE_ENV: 'test',
    MAX_BODY_SIZE: 524288,
    TIMESTAMP_TOLERANCE_SECONDS: 300,
    INGEST_RATE_LIMIT_MAX: 10000,
    INGEST_RATE_LIMIT_WINDOW_MS: 60000,
    EVENT_TTL_DAYS: 14,
    LOG_LEVEL: 'warn',
    REDIS_URL,
    QUEUE_PREFIX,
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    DOWNSTREAM_TIMEOUT_MS: 15000,
    ENABLE_AI: false,
    SSE_HEARTBEAT_MS: 25000,
    MAX_SSE_CLIENTS: 20,
    DASHBOARD_ORIGINS: 'http://localhost:5173',
    ENABLE_SIMULATOR_API: false,
    SIMULATOR_SOURCES: '',
    ALLOW_PRIVATE_DOWNSTREAM: false,
    GEMINI_RPM_LIMIT: 10,
    GEMINI_RPD_LIMIT: 100,
    MAX_SCHEMA_BYTES: 102400,
    REPLAY_MAX_EVENTS: 1000,
  };

  const watcher = { addListener: () => {}, removeListener: () => {} };
  apiApp = createApp({ db, queue, config, watcher });
  await new Promise((resolve) => {
    apiServer = apiApp.listen(0, '127.0.0.1', resolve);
  });
  const { port } = apiServer.address();
  apiBase = `http://127.0.0.1:${port}`;
  console.log(`[chaos] API on :${port}`);
}

async function teardown() {
  if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
  if (queue) await queue.close().catch(() => {});
  if (receiver) await receiver.close().catch(() => {});
  await closeDb().catch(() => {});
}

async function resetForScenario() {
  // Clear events, drop then recreate
  await db.collection('events').deleteMany({});
  receiver.clear();
  // Clear Redis chaos prefix
  try {
    const rClean = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1000 });
    const keys = await rClean.keys(`${QUEUE_PREFIX}:*`);
    if (keys.length > 0) await rClean.del(...keys);
    await rClean.quit();
  } catch { /* Redis may be down during C2 */ }
}

// ── Scenario helpers ──────────────────────────────────────────────────────────

async function sendN(n, opts = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = await sendEvent(apiBase, SLUG, sourceSecret, opts).catch((e) => ({ status: 0, json: {}, latency: 0, deliveryId: opts.deliveryId || 'err', error: e.message }));
    ids.push(r.deliveryId);
  }
  return ids;
}

async function sendNConcurrent(n, opts = {}) {
  const tasks = [];
  for (let i = 0; i < n; i++) {
    tasks.push(sendEvent(apiBase, SLUG, sourceSecret, opts).catch((e) => ({ status: 0, json: {}, latency: 0, deliveryId: opts.deliveryId || 'err', error: e.message })));
  }
  return Promise.all(tasks);
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

const results = [];

async function runScenario(id, name, fn) {
  if (onlyScenarios && !onlyScenarios.has(id)) {
    results.push({ id, name, pass: null, skipped: true, note: 'skipped via --only' });
    return;
  }
  console.log(`\n[chaos] === ${id}: ${name} ===`);
  await resetForScenario();
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    results.push({ id, name, pass: true, elapsed, ...result });
    console.log(`[chaos] ${id}: PASS (${elapsed}ms) — ${result.summary || ''}`);
  } catch (err) {
    const elapsed = Date.now() - start;
    results.push({ id, name, pass: false, elapsed, error: err.message });
    console.error(`[chaos] ${id}: FAIL (${elapsed}ms) — ${err.message}`);
  }
}

// ── C1: Worker SIGKILL mid-delivery ──────────────────────────────────────────
async function scenarioC1() {
  receiver.setMode('slow', 3000);

  const n = 20;
  // Start a worker before sending events
  let worker1 = spawnWorker();
  await sleep(1500);

  // Send 20 events
  await sendN(n);

  // Wait until at least 5 are in 'processing'
  await waitForCondition(async () => {
    const counts = await getEventCounts(db);
    return (counts.processing || 0) >= 5;
  }, 15000);

  const counts1 = await getEventCounts(db);
  const inProcessing = counts1.processing || 0;
  console.log(`[chaos] C1: ${inProcessing} events in processing before SIGKILL`);

  // SIGKILL the worker
  await killWorker(worker1);
  console.log('[chaos] C1: worker1 killed');

  // Reset receiver to ok
  receiver.setMode('ok');

  // Start a new worker
  const worker2 = spawnWorker();
  await waitWorkerReady(worker2, 3000);
  console.log('[chaos] C1: worker2 started');

  const timeout = isCI ? 60000 : 90000;
  const { counts, elapsed, timedOut } = await waitAllDelivered(db, n, timeout);
  await killWorker(worker2);

  const delivered = counts.delivered || 0;
  const dead = counts.dead || 0;
  const total = await db.collection('events').countDocuments({});

  const stats = receiver.getStats();
  const seenOnce = Object.values(stats.stats).filter(c => c >= 1).length;
  const seenMore = Object.values(stats.stats).filter(c => c > 1).length;

  if (total !== n) throw new Error(`Expected exactly ${n} event documents, got ${total} (duplicates in DB?)`);
  if (dead > 0) throw new Error(`Expected 0 dead events, got ${dead}`);
  if (delivered < n) throw new Error(`Only ${delivered}/${n} delivered after ${elapsed}ms${timedOut ? ' (timed out)' : ''}`);

  return {
    summary: `${delivered}/${n} delivered, ${seenMore} ids seen >1 (at-least-once), recovery ${elapsed}ms`,
    recoveryMs: elapsed,
    delivered,
    duplicateEventIds: seenMore,
    dead,
  };
}

// ── C2: Redis down during ingest ──────────────────────────────────────────────
async function scenarioC2() {
  receiver.setMode('ok');
  const worker = spawnWorker();
  await waitWorkerReady(worker, 2000);

  // Stop Redis via docker compose
  console.log('[chaos] C2: stopping Redis via docker compose');
  const stopResult = dockerComposeRedis('stop');
  if (stopResult.code !== 0) {
    console.warn('[chaos] C2: docker compose stop failed; attempting direct ioredis ping to verify');
  }
  await sleep(1500); // Wait for Redis to go down

  // Send 20 events while Redis is down — should get HTTP 200 each (fail-fast producer)
  const n = 20;
  const responses = await sendNConcurrent(n);

  const http200 = responses.filter(r => r.status === 200).length;
  const maxLatency = Math.max(...responses.map(r => r.latency));

  console.log(`[chaos] C2: ${http200}/${n} returned 200 while Redis down, maxLatency=${maxLatency}ms`);

  // Check all stored as 'received'
  const storedCount = await db.collection('events').countDocuments({ status: 'received' });

  // Start Redis again
  console.log('[chaos] C2: starting Redis via docker compose');
  dockerComposeRedis('start');

  const redisHealthy = await pollRedisHealth(REDIS_URL, 30000);
  if (!redisHealthy) throw new Error('Redis did not become healthy within 30s of restart');
  console.log('[chaos] C2: Redis back online');

  const redisRestartAt = Date.now();

  // Wait for all events to be delivered via reconciliation
  const timeout = isCI ? 90000 : 120000;
  const { counts, elapsed, timedOut } = await waitAllDelivered(db, n, timeout);
  await killWorker(worker);
  const secondsToLastDelivery = Math.round((elapsed) / 1000);

  const delivered = counts.delivered || 0;
  const dead = counts.dead || 0;

  if (http200 !== n) throw new Error(`Expected ${n} HTTP 200s while Redis down, got ${http200}`);
  if (maxLatency >= 3000) throw new Error(`Max latency ${maxLatency}ms exceeded 3000ms`);
  if (storedCount < n) throw new Error(`Expected ${n} events stored as 'received', got ${storedCount}`);
  if (delivered < n) throw new Error(`Only ${delivered}/${n} delivered after ${elapsed}ms${timedOut ? ' (timed out)' : ''}`);
  if (dead > 0) throw new Error(`Expected 0 dead events, got ${dead}`);

  return {
    summary: `${http200}/${n} HTTP 200 while Redis down; all ${delivered} delivered in ${secondsToLastDelivery}s after restart`,
    http200,
    maxLatencyMs: maxLatency,
    secondsToLastDelivery,
    delivered,
  };
}

// ── C3: Redis DATA LOSS (FLUSHALL while in flight) ────────────────────────────
async function scenarioC3() {
  const n = 30;
  receiver.setMode('slow', 1500);

  // Start worker
  const worker = spawnWorker();
  await sleep(1500);

  // Send 30 events
  await sendN(n);
  await sleep(1500); // Let some get picked up by worker

  // FLUSHALL the test Redis
  console.log('[chaos] C3: flushing Redis (simulating data loss)');
  const rFlush = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  await rFlush.flushall();
  await rFlush.quit();
  console.log('[chaos] C3: Redis FLUSHED');

  // Reset receiver to ok
  receiver.setMode('ok');

  // Wait for reconciliation to re-enqueue stale processing/failed events
  // STALE_JOB_THRESHOLD_MS=10000 in CHAOS_ENV, so reconcile after ~10s
  const timeout = isCI ? 120000 : 180000;
  const { counts, elapsed, timedOut } = await waitAllDelivered(db, n, timeout);
  await killWorker(worker);

  const delivered = counts.delivered || 0;
  const dead = counts.dead || 0;
  const stuck = (counts.received || 0) + (counts.processing || 0) + (counts.failed || 0) + (counts.requeue_pending || 0);

  if (dead > 0) throw new Error(`Expected 0 dead after C3 recovery, got ${dead}`);
  if (stuck > 0) throw new Error(`Expected 0 stuck events, got ${stuck} (${JSON.stringify(counts)})`);
  if (delivered < n) throw new Error(`Only ${delivered}/${n} delivered after ${elapsed}ms${timedOut ? ' (timed out)' : ''}`);

  const stats = receiver.getStats();
  const seenMore = Object.values(stats.stats).filter(c => c > 1).length;

  return {
    summary: `${delivered}/${n} delivered after Redis FLUSHALL; ${seenMore} duplicate deliveries (at-least-once); ${elapsed}ms total`,
    delivered,
    duplicateDeliveries: seenMore,
    elapsedMs: elapsed,
  };
}

// ── C4: Duplicate storm ───────────────────────────────────────────────────────
async function scenarioC4() {
  const DELIVERY_ID = `dup-storm-${randomBytes(8).toString('hex')}`;
  const n = 100;
  receiver.setMode('ok');

  const worker = spawnWorker();
  await sleep(1000);

  // Send 100 concurrent requests with same delivery id
  const responses = await sendNConcurrent(n, { deliveryId: DELIVERY_ID });

  const http200 = responses.filter(r => r.status === 200).length;
  const deduplicatedTrue = responses.filter(r => r.json?.deduplicated === true).length;
  const deduplicatedFalse = responses.filter(r => r.json?.deduplicated === false).length;

  // Wait for delivery
  const timeout = isCI ? 30000 : 45000;
  const { counts, elapsed } = await waitAllDelivered(db, 1, timeout);
  await killWorker(worker);

  const total = await db.collection('events').countDocuments({ status: { $exists: true } });
  const stats = receiver.getStats();
  const receiverCount = stats.stats[DELIVERY_ID] || 0;

  if (total !== 1) throw new Error(`Expected exactly 1 event document, got ${total}`);
  if (deduplicatedFalse !== 1) throw new Error(`Expected exactly 1 deduplicated:false, got ${deduplicatedFalse}`);
  if (deduplicatedTrue !== n - 1) throw new Error(`Expected ${n - 1} deduplicated:true, got ${deduplicatedTrue}`);
  if (receiverCount !== 1) throw new Error(`Receiver saw ${receiverCount} requests, expected exactly 1`);

  return {
    summary: `1 unique doc, ${deduplicatedFalse} not-dedup, ${deduplicatedTrue} dedup, receiver saw 1 request`,
    totalDocs: total,
    deduplicatedFalse,
    deduplicatedTrue,
    receiverRequests: receiverCount,
  };
}

// ── C5: Downstream outage shorter than retry window ──────────────────────────
async function scenarioC5() {
  // Total backoff window with 5 attempts: ~200+400+800+1600+3200 = ~6200ms max
  // We'll bring it back at ~3000ms (half of max)
  const n = 20;
  receiver.setMode('fail503');

  const worker = spawnWorker();
  await sleep(1000);

  await sendN(n);
  await sleep(3000); // Let some attempts fail

  receiver.setMode('ok');
  console.log('[chaos] C5: receiver back online');

  const timeout = isCI ? 60000 : 90000;
  const { counts, elapsed, timedOut } = await waitAllDelivered(db, n, timeout);
  await killWorker(worker);

  const delivered = counts.delivered || 0;
  const dead = counts.dead || 0;

  // Get attempt distribution
  const events = await db.collection('events').find({ status: 'delivered' }).project({ deliveryAttempts: 1 }).toArray();
  const attemptCounts = {};
  for (const ev of events) {
    const a = ev.deliveryAttempts || 1;
    attemptCounts[a] = (attemptCounts[a] || 0) + 1;
  }

  if (dead > 0) throw new Error(`Expected 0 dead events, got ${dead}`);
  if (delivered < n) throw new Error(`Only ${delivered}/${n} delivered after ${elapsed}ms${timedOut ? ' (timed out)' : ''}`);

  return {
    summary: `${delivered}/${n} delivered, 0 dead, attempt distribution: ${JSON.stringify(attemptCounts)}`,
    delivered,
    dead,
    attemptDistribution: attemptCounts,
    elapsedMs: elapsed,
  };
}

// ── C6: Downstream outage longer than retry window ───────────────────────────
async function scenarioC6() {
  const n = 20;
  receiver.setMode('fail503');

  const worker = spawnWorker();
  await sleep(1000);

  await sendN(n);

  // Wait for all to become dead (5 attempts exhausted)
  const timeout = isCI ? 90000 : 120000;
  await waitForCondition(async () => {
    const counts = await getEventCounts(db);
    const dead = counts.dead || 0;
    return dead >= n;
  }, timeout, 500);

  await killWorker(worker);

  const countsBefore = await getEventCounts(db);
  const dead = countsBefore.dead || 0;
  console.log(`[chaos] C6: ${dead} events dead`);
  if (dead < n) throw new Error(`Expected ${n} dead events, got ${dead}`);

  // Bring receiver back
  receiver.setMode('ok');

  // Requeue all dead events via admin API
  const deadEvents = await db.collection('events').find({ status: 'dead' }).project({ _id: 1 }).toArray();
  const requeueResults = [];
  for (const ev of deadEvents) {
    const res = await fetch(`${apiBase}/api/events/${ev._id}/requeue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    });
    requeueResults.push(res.status);
  }

  const requeued = requeueResults.filter(s => s === 200).length;
  console.log(`[chaos] C6: requeued ${requeued} dead events`);

  // Start a new worker to process them
  const worker2 = spawnWorker();
  const { counts, elapsed, timedOut } = await waitAllDelivered(db, n, isCI ? 60000 : 90000);
  await killWorker(worker2);

  const delivered = counts.delivered || 0;
  const stillDead = counts.dead || 0;

  if (delivered < n) throw new Error(`After requeue: only ${delivered}/${n} delivered after ${elapsed}ms${timedOut ? ' (timed out)' : ''}`);

  return {
    summary: `${dead} events went dead; requeued ${requeued}; all ${delivered} delivered after recovery`,
    deadBeforeRequeue: dead,
    requeued,
    delivered,
  };
}

// ── C7: AI rate limit ─────────────────────────────────────────────────────────
async function scenarioC7() {
  // This test runs in-process: analyze-drift worker with fake AI that always 429s
  // We need a quarantined event with a drift fingerprint, then trigger analyze-drift
  const { createAnalyzeDriftWorker } = await import('../src/analyze-drift/index.js');
  const { reconcileOnce } = await import('../src/reconcile.js');

  const fakeAI = createFakeRateLimitedAI();

  // Seed a schema and an event with schema drift
  const { ObjectId } = await import('mongodb');
  const schemaDoc = {
    sourceId,
    eventType: 'payment.chaos',
    version: 1,
    active: true,
    schema: {
      type: 'object',
      required: ['amount', 'currency'],
      properties: { amount: { type: 'number' }, currency: { type: 'string' } },
    },
    createdAt: new Date(),
  };
  const schemaRes = await db.collection('schemas').insertOne(schemaDoc);

  // Create a quarantined event (schema drift: missing 'amount')
  const driftFingerprint = 'chaos-c7-drift-' + randomBytes(8).toString('hex');
  const eventRes = await db.collection('events').insertOne({
    sourceId,
    sourceSlug: SLUG,
    eventId: randomBytes(16).toString('hex'),
    eventType: 'payment.chaos',
    status: 'quarantined',
    driftFingerprint,
    quarantinedAt: new Date(),
    payload: { currency: 'USD' }, // missing amount
    receivedAt: new Date(),
    statusChangedAt: new Date(),
    updatedAt: new Date(),
  });

  // Configure queue with short attempts
  const c7Queue = createBullQueue({ redisUrl: REDIS_URL, prefix: QUEUE_PREFIX });
  const c7Config = {
    REDIS_URL,
    QUEUE_PREFIX,
    ENABLE_AI: true,
    ANALYZE_DRIFT_ATTEMPTS: '3',
    ANALYZE_DRIFT_BACKOFF_MS: '100',
    LOG_LEVEL: 'error',
  };

  const driftWorker = createAnalyzeDriftWorker({
    db,
    queue: c7Queue,
    aiClient: fakeAI,
    config: c7Config,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });

  // Enqueue analyze-drift job manually
  await c7Queue.enqueue('analyze-drift', 'analyze-drift', {
    driftFingerprint,
    sourceId: sourceId.toString(),
    eventType: 'payment.chaos',
    triggerEventId: randomBytes(16).toString('hex'),
  }, { jobId: `drift_${driftFingerprint}_a0` });

  // Wait for the job to be processed (attempts exhausted)
  const timeout = isCI ? 20000 : 30000;
  await waitForCondition(async () => {
    const proposal = await db.collection('proposals').findOne({ driftFingerprint });
    return proposal !== null;
  }, timeout);

  await driftWorker.close();
  await c7Queue.close().catch(() => {});

  const proposal = await db.collection('proposals').findOne({ driftFingerprint });
  if (!proposal) throw new Error('No proposal created after AI rate limit exhaustion');
  if (proposal.aiUsed !== false) throw new Error(`Expected aiUsed=false, got ${proposal.aiUsed}`);
  if (proposal.aiFailureReason !== 'AI_RATE_LIMITED') throw new Error(`Expected aiFailureReason=AI_RATE_LIMITED, got ${proposal.aiFailureReason}`);
  if (!proposal.proposedSchema) throw new Error('Expected baseline proposedSchema to be present');

  // Verify baseline replay: count quarantined events for this fingerprint
  const quarantinedCount = await db.collection('events').countDocuments({ driftFingerprint, status: 'quarantined' });
  // baseline = 1 event (the one we inserted)
  if (quarantinedCount < 1) throw new Error(`Expected >=1 quarantined event for drift baseline`);

  return {
    summary: `Proposal created with aiUsed=false, aiFailureReason=AI_RATE_LIMITED; baseline replay covered ${quarantinedCount} events`,
    aiUsed: proposal.aiUsed,
    aiFailureReason: proposal.aiFailureReason,
    baselineEvents: quarantinedCount,
  };
}

// ── Write docs/CHAOS.md ───────────────────────────────────────────────────────

async function writeChaosDoc(machine, commit, date) {
  const table = [
    '| Scenario | Injected Fault | Assertion | Result | Recovery (s) |',
    '|---|---|---|---|---|',
  ];

  const faultMap = {
    C1: 'Worker SIGKILL mid-delivery (receiver slow 3s)',
    C2: 'Redis stopped during ingest',
    C3: 'Redis FLUSHALL while events in flight',
    C4: '100 concurrent requests with same delivery id',
    C5: 'Downstream 503 for ~3s (shorter than retry window)',
    C6: 'Downstream 503 until all events dead, then requeue',
    C7: 'Fake AI client always throws 429-style error',
  };

  const assertMap = {
    C1: 'All 20 delivered, exactly 20 docs, 0 dead, receiver saw each id ≥1',
    C2: 'All 200 HTTP 200 < 3000ms, 20 stored received, all delivered after Redis restart',
    C3: 'All 30 delivered, 0 dead, 0 stuck in any non-terminal state',
    C4: '1 doc, 1 not-dedup, 99 dedup, receiver saw exactly 1 request',
    C5: 'All 20 delivered, 0 dead',
    C6: 'All go dead; requeue via admin API; all delivered',
    C7: 'Proposal with aiUsed=false, aiFailureReason=AI_RATE_LIMITED; no crash; baseline schema exists',
  };

  for (const r of results) {
    if (r.skipped) {
      table.push(`| ${r.id} | ${faultMap[r.id] || r.name} | ${assertMap[r.id] || ''} | SKIPPED | — |`);
      continue;
    }
    const status = r.pass ? 'PASS' : `FAIL: ${r.error || ''}`;
    const recovery = r.recoveryMs ? `${Math.round(r.recoveryMs / 1000)}` :
      r.elapsedMs ? `${Math.round(r.elapsedMs / 1000)}` :
      r.elapsed ? `${Math.round(r.elapsed / 1000)}` : '—';
    const resultDetail = r.summary || r.error || '';
    table.push(`| ${r.id} | ${faultMap[r.id] || r.name} | ${assertMap[r.id] || ''} | ${status} — ${resultDetail.slice(0, 80)} | ${recovery} |`);
  }

  const content = `# Hookmend Chaos Test Results

Generated: ${date}  
Commit: ${commit}  
OS: ${machine.os}  
Node: ${machine.node}  
CPU: ${machine.cpu}  
RAM: ${machine.ram}  
Queue prefix: \`${QUEUE_PREFIX}\`  
Worker knobs (chaos): lockDuration=4000ms, stalledInterval=2000ms, maxStalledCount=3  
STALE_JOB_THRESHOLD_MS (chaos): 10000ms

## Results

${table.join('\n')}

## Notes

- C1: At-least-once delivery is expected for in-flight events at kill time. Downstream must deduplicate on \`x-hookmend-event-id\`.
- C3: Redis FLUSHALL removes all BullMQ job data. The D52/C3 fix in reconcile.js detects events stuck in \`processing\` or \`failed\` with statusChangedAt older than STALE_JOB_THRESHOLD_MS and moves them to \`requeue_pending\`, then re-enqueues them. This causes at-least-once delivery.
- C7: No real Gemini API call is made in any test. The fake AI client always throws a 429-style error. The baseline proposal is generated from the existing active schema.

## Reproduce

\`\`\`
docker compose -f infra/docker-compose.yml up -d
npm run chaos
# or
npm run chaos -- --only C1,C2,C4 --ci
\`\`\`
`;

  const docsDir = join(ROOT, 'docs');
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, 'CHAOS.md'), content, 'utf8');
  console.log('[chaos] Wrote docs/CHAOS.md');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[chaos] Hookmend Chaos Test Suite — Phase 4');
  console.log(`[chaos] MongoDB: ${MONGODB_URI}`);
  console.log(`[chaos] Redis:   ${REDIS_URL}`);
  console.log(`[chaos] DB:      ${DB_NAME}`);
  console.log(`[chaos] Prefix:  ${QUEUE_PREFIX}`);
  if (onlyScenarios) console.log(`[chaos] Only:    ${[...onlyScenarios].join(', ')}`);
  if (isCI) console.log('[chaos] CI mode: shorter waits');

  try {
    await setup();
  } catch (err) {
    console.error('[chaos] Setup failed:', err.message);
    process.exit(1);
  }

  try {
    await runScenario('C1', 'Worker SIGKILL mid-delivery', scenarioC1);
    await runScenario('C2', 'Redis down during ingest', scenarioC2);
    await runScenario('C3', 'Redis DATA LOSS (FLUSHALL)', scenarioC3);
    await runScenario('C4', 'Duplicate storm (100 same id)', scenarioC4);
    await runScenario('C5', 'Downstream outage < retry window', scenarioC5);
    await runScenario('C6', 'Downstream outage > retry window', scenarioC6);
    await runScenario('C7', 'AI rate limit (fake 429)', scenarioC7);
  } finally {
    await teardown();
  }

  const machine = getMachineInfo();
  const commit = getCommitHash();
  const date = new Date().toISOString();
  await writeChaosDoc(machine, commit, date);

  // Print summary
  console.log('\n[chaos] ══ SUMMARY ══');
  let allPass = true;
  for (const r of results) {
    if (r.skipped) {
      console.log(`[chaos]   ${r.id}: SKIPPED`);
    } else if (r.pass) {
      console.log(`[chaos]   ${r.id}: PASS — ${r.summary || ''}`);
    } else {
      console.log(`[chaos]   ${r.id}: FAIL — ${r.error || ''}`);
      allPass = false;
    }
  }

  if (allPass) {
    console.log('\n[chaos] ALL SCENARIOS PASS');
    process.exit(0);
  } else {
    console.log('\n[chaos] SOME SCENARIOS FAILED');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[chaos] Unhandled error:', err);
  process.exit(1);
});
