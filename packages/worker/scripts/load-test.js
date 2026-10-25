#!/usr/bin/env node
/**
 * packages/worker/scripts/load-test.js — Phase 4 Load Test (D53)
 *
 * Usage:
 *   npm run load-test
 *   npm run load-test -- --rps 50 --duration 30
 *   npm run load-test -- --stages "10,25,50,100" --duration 30
 *
 * HARD RULES:
 * - Requires real docker-compose Mongo and Redis (exit 1 if unreachable)
 * - Worker runs as child process; API and receiver in-process
 * - All numbers measured from real output — docs/PERF.md written by this script
 * - INGEST_RATE_LIMIT_MAX set very high for this run (otherwise per-source limit throttles test)
 * - Do NOT assert latency thresholds (machines differ); report only
 * - Assert: zero HTTP errors and zero lost events (received == delivered, none dead)
 */

import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import os from 'node:os';

import {
  connectDb,
  closeDb,
  createIndexes,
  createBullQueue,
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
const DB_NAME = 'hookmend_load_test';
const QUEUE_PREFIX = 'hookmend-load';
const ADMIN_TOKEN = 'load-test-admin-token-load-secret-x';
const SLUG = 'load-payments';

// CLI args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : defaultVal;
}

const stagesArg = getArg('--stages', '10,25,50,100');
const stages = stagesArg.split(',').map(Number);
const stageDuration = parseInt(getArg('--duration', '30'), 10); // seconds per stage
const concurrency = parseInt(getArg('--concurrency', '20'), 10);
const specRps = parseInt(getArg('--rps', '0'), 10); // 0 = use stages

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let apiApp, apiServer, apiBase, receiver, db, mongoClient, queue;
let sourceSecret, workerChild;

async function setup() {
  console.log('[load-test] Probing MongoDB...');
  try {
    const probe = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 2500 });
    await probe.connect();
    await probe.close();
    console.log('[load-test] MongoDB: OK');
  } catch (err) {
    console.error(`[load-test] FATAL: MongoDB unreachable at ${MONGODB_URI}: ${err.message}`);
    process.exit(1);
  }

  console.log('[load-test] Probing Redis...');
  try {
    const r = new Redis(REDIS_URL, { connectTimeout: 2500, maxRetriesPerRequest: 1, lazyConnect: true });
    await r.connect();
    const pong = await r.ping();
    if (pong !== 'PONG') throw new Error('no PONG');
    await r.quit().catch(() => {});
    console.log('[load-test] Redis: OK');
  } catch (err) {
    console.error(`[load-test] FATAL: Redis unreachable at ${REDIS_URL}: ${err.message}`);
    process.exit(1);
  }

  // Drop and recreate DB
  const adminClient = new MongoClient(MONGODB_URI);
  await adminClient.connect();
  await adminClient.db(DB_NAME).dropDatabase();

  // Clear Redis prefix
  const rClean = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  const keys = await rClean.keys(`${QUEUE_PREFIX}:*`);
  if (keys.length > 0) await rClean.del(...keys);
  await rClean.quit();

  await adminClient.close();

  const loadUri = MONGODB_URI.replace(/\/[^/?]*(\?|$)/, `/${DB_NAME}$1`);
  mongoClient = await connectDb(loadUri);
  db = mongoClient.db();
  await createIndexes(db);

  // Start receiver
  receiver = await startReceiver({ port: 0 });
  console.log(`[load-test] Receiver on :${receiver.port}`);

  // Seed source
  sourceSecret = randomBytes(32).toString('hex');
  process.env.LOAD_WEBHOOK_SECRET = sourceSecret;
  const now = new Date();
  await db.collection('sources').insertOne({
    slug: SLUG,
    name: 'Load Test Source',
    adapter: 'generic-hmac',
    secretEnvVar: 'LOAD_WEBHOOK_SECRET',
    downstreamUrl: `http://127.0.0.1:${receiver.port}/receive`,
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  // Build API in-process
  // INGEST_RATE_LIMIT_MAX set very high (10000/min) — default would throttle test
  queue = createBullQueue({ redisUrl: REDIS_URL, prefix: QUEUE_PREFIX });
  const config = {
    PORT: 0,
    NODE_ENV: 'test',
    MAX_BODY_SIZE: 524288,
    TIMESTAMP_TOLERANCE_SECONDS: 300,
    INGEST_RATE_LIMIT_MAX: 100000, // Very high — load test needs this
    INGEST_RATE_LIMIT_WINDOW_MS: 60000,
    EVENT_TTL_DAYS: 14,
    LOG_LEVEL: 'error',
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
  console.log('[load-test] NOTE: INGEST_RATE_LIMIT_MAX=100000 for this run (bypasses per-source default limit)');

  const watcher = { addListener: () => {}, removeListener: () => {} };
  apiApp = createApp({ db, queue, config, watcher });
  await new Promise((resolve) => {
    apiServer = apiApp.listen(0, '127.0.0.1', resolve);
  });
  const { port } = apiServer.address();
  apiBase = `http://127.0.0.1:${port}`;
  console.log(`[load-test] API on :${port}`);

  // Start worker
  const workerMain = join(__dirname, '..', 'src', 'main.js');
  workerChild = spawn('node', [workerMain], {
    env: {
      ...process.env,
      MONGODB_URI: loadUri,
      REDIS_URL,
      QUEUE_PREFIX,
      WORKER_CONCURRENCY: '10',
      LOG_LEVEL: 'error',
      NODE_ENV: 'test',
      ADMIN_API_TOKEN: ADMIN_TOKEN,
      ENABLE_AI: 'false',
      LOAD_WEBHOOK_SECRET: sourceSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  workerChild.stdout.on('data', () => {});
  workerChild.stderr.on('data', () => {});
  await sleep(2000); // Let worker connect
  console.log('[load-test] Worker started');
}

async function teardown() {
  if (workerChild && !workerChild.killed) {
    workerChild.kill('SIGTERM');
    await sleep(1000);
    if (!workerChild.killed) workerChild.kill('SIGKILL');
  }
  if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
  if (queue) await queue.close().catch(() => {});
  if (receiver) await receiver.close().catch(() => {});
  await closeDb().catch(() => {});
}

// ── Load runner ───────────────────────────────────────────────────────────────

async function runStage(targetRps, durationSec) {
  const latencies = [];
  // attempted: incremented once per request in the scheduler (before dispatch)
  // sent: incremented once per completed request inside sendOne (after response/error)
  // accepted: HTTP 200 responses
  // errsByStatus: non-200 and network errors
  let attempted = 0;  // requests dispatched by scheduler
  let sent = 0;       // requests that completed (response or error)
  let accepted = 0;
  const errsByStatus = {};

  const startTime = Date.now();
  const endTime = startTime + durationSec * 1000;

  // Queue of in-flight promises
  const inflight = new Set();

  async function sendOne() {
    const payload = buildPaymentEvent();
    const bodyStr = JSON.stringify(payload);
    const deliveryId = randomBytes(16).toString('hex');
    const ts = String(Date.now());
    const sig = signGenericHmac(sourceSecret, ts, bodyStr);

    const start = Date.now();
    try {
      const res = await fetch(`${apiBase}/ingest/${SLUG}`, {
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
      latencies.push(latency);
      sent++;
      if (res.status === 200) {
        accepted++;
      } else {
        errsByStatus[res.status] = (errsByStatus[res.status] || 0) + 1;
      }
    } catch (_err) {
      sent++;
      errsByStatus['network'] = (errsByStatus['network'] || 0) + 1;
    }
  }

  // Catch-up scheduler: every 5 ms compute due = floor(elapsedSeconds * rps) - attempted
  // 'attempted' is incremented here (one per dispatch); 'sent' is incremented in sendOne (one per completion).
  // This ensures each request is counted exactly once in each counter.
  while (Date.now() < endTime) {
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    let due = Math.floor(elapsedSeconds * targetRps) - attempted;
    while (due > 0 && inflight.size < concurrency) {
      attempted++;
      due--;
      const p = sendOne().finally(() => inflight.delete(p));
      inflight.add(p);
    }
    await sleep(5);
  }

  // Drain remaining in-flight requests
  await Promise.all([...inflight]);

  // Use actual wall-clock elapsed (includes drain time) for honest RPS calculation
  const actualElapsedSec = (Date.now() - startTime) / 1000;
  const achievedRps = actualElapsedSec > 0 ? sent / actualElapsedSec : 0;
  return {
    targetRps,
    durationSec,
    actualElapsedSec: Math.round(actualElapsedSec * 10) / 10,
    attempted,
    sent,          // completed requests (should equal attempted after drain)
    accepted,
    errors: sent - accepted,
    errsByStatus,
    achievedRps: Math.round(achievedRps * 10) / 10,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.length ? Math.max(...latencies) : 0,
  };
}

async function sampleQueueDepth(queueObj, intervalMs, durationMs) {
  const depths = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    try {
      const q = queueObj.getQueue('process-event');
      const counts = await q.getJobCounts('waiting', 'active', 'delayed');
      depths.push((counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0));
    } catch { depths.push(0); }
    await sleep(intervalMs);
  }
  return depths;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[load-test] Hookmend Load Test — Phase 4');

  try {
    await setup();
  } catch (err) {
    console.error('[load-test] Setup failed:', err.message);
    process.exit(1);
  }

  const stageResults = [];
  let totalAttempted = 0;
  let totalAccepted = 0;

  // Determine stages to run
  const runStages = specRps > 0 ? [specRps] : stages;

  try {
    for (const rps of runStages) {
      console.log(`\n[load-test] Stage: Target ${rps} RPS for ${stageDuration}s`);
      const stageResult = await runStage(rps, stageDuration);
      stageResults.push(stageResult);
      totalAttempted += stageResult.attempted;
      totalAccepted += stageResult.accepted;
      console.log(`[load-test]   target=${stageResult.targetRps}rps attempted=${stageResult.attempted} accepted=${stageResult.accepted} errors=${stageResult.errors} achieved=${stageResult.achievedRps}rps (actual ${stageResult.actualElapsedSec}s) p50=${stageResult.p50}ms p95=${stageResult.p95}ms p99=${stageResult.p99}ms max=${stageResult.max}ms`);
      await sleep(1000); // brief pause between stages
    }

    // Run spec baseline: 500 events per minute for 3 minutes
    // = 500 / 60 = ~8.33 rps for 180 seconds = 1500 events target
    const baselineTargetRps = 500 / 60;
    console.log('\n[load-test] Running spec baseline: ~8.33 target RPS for 180s (500 events/min × 3 min = 1500 target events)');
    const baselineResult = await runStage(baselineTargetRps, 180);
    totalAttempted += baselineResult.attempted;
    totalAccepted += baselineResult.accepted;
    // Use actual elapsed wall-clock time for events/min calculation, NOT configured durationSec
    const baselineAchievedEventsPerMin = Math.round((baselineResult.sent / (baselineResult.actualElapsedSec / 60)) * 10) / 10;
    console.log(`[load-test]   baseline: target=${Math.round(baselineTargetRps * 10) / 10}rps attempted=${baselineResult.attempted} accepted=${baselineResult.accepted} errors=${baselineResult.errors} achieved=${baselineResult.achievedRps}rps (actual ${baselineResult.actualElapsedSec}s = ${baselineAchievedEventsPerMin} events/min) errors=${JSON.stringify(baselineResult.errsByStatus)}`);

    // Wait for pipeline to drain
    console.log('\n[load-test] Waiting for pipeline to drain...');
    const drainStart = Date.now();

    // Sample queue depth during drain every 1000ms
    const queueSamplingIntervalMs = 1000;
    const depthSampler = sampleQueueDepth(queue, queueSamplingIntervalMs, 120000);

    await new Promise((resolve) => {
      const check = async () => {
        const counts = await db.collection('events').aggregate([
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]).toArray();
        const countMap = {};
        for (const c of counts) countMap[c._id] = c.count;
        const total = Object.values(countMap).reduce((a, b) => a + b, 0);
        const delivered = countMap.delivered || 0;
        const dead = countMap.dead || 0;
        const inFlight = total - delivered - dead - (countMap.quarantined || 0);
        if (inFlight <= 0 || Date.now() - drainStart > 120000) {
          resolve();
        } else {
          setTimeout(check, 1000);
        }
      };
      setTimeout(check, 2000);
    });

    const drainMs = Date.now() - drainStart;
    const depths = await depthSampler;
    const maxQueueDepth = depths.length > 0 ? Math.max(...depths) : 0;

    console.log(`[load-test] Pipeline drained in ${drainMs}ms, maxQueueDepth=${maxQueueDepth} (sampled every ${queueSamplingIntervalMs}ms)`);

    // Final counts
    const finalCounts = await db.collection('events').aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).toArray();
    const countMap = {};
    for (const c of finalCounts) countMap[c._id] = c.count;
    const delivered = countMap.delivered || 0;
    const dead = countMap.dead || 0;

    // SPEC assertions:
    // 1. Zero HTTP errors (baseline only)
    const baselineErrors = Object.values(baselineResult.errsByStatus).reduce((a, b) => a + b, 0);
    let assertPass = true;
    const assertions = [];

    if (baselineErrors > 0) {
      assertions.push(`FAIL: baseline had ${baselineErrors} HTTP errors`);
      assertPass = false;
    } else {
      assertions.push('PASS: zero HTTP errors in baseline');
    }

    // 2. Zero lost events (total accepted should equal delivered + dead; dead should be 0)
    if (dead > 0) {
      assertions.push(`FAIL: ${dead} dead events (lost)`);
      assertPass = false;
    } else {
      assertions.push('PASS: zero dead events');
    }

    // All accepted events must be delivered — no silent 5% tolerance after drain timeout
    if (delivered < totalAccepted) {
      assertions.push(`FAIL: only ${delivered}/${totalAccepted} accepted events delivered after drain timeout`);
      assertPass = false;
    } else {
      assertions.push(`PASS: ${delivered}/${totalAccepted} accepted events delivered`);
    }

    console.log('\n[load-test] Assertions:');
    for (const a of assertions) console.log(`  ${a}`);

    // Write docs/PERF.md
    const machine = getMachineInfo();
    const commit = getCommitHash();
    const date = new Date().toISOString();

    const stageTable = [
      '| Target RPS | Config Duration (s) | Actual Elapsed (s) | Attempted | Accepted | Errors | Achieved RPS | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
      ...stageResults.map(r => `| ${r.targetRps} | ${r.durationSec} | ${r.actualElapsedSec} | ${r.attempted} | ${r.accepted} | ${r.errors} | ${r.achievedRps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} |`),
      `| baseline (~8.33 target) | ${baselineResult.durationSec} | ${baselineResult.actualElapsedSec} | ${baselineResult.attempted} | ${baselineResult.accepted} | ${baselineResult.errors} | ${baselineResult.achievedRps} | ${baselineResult.p50} | ${baselineResult.p95} | ${baselineResult.p99} | ${baselineResult.max} |`,
    ];

    const perfContent = `# Hookmend Load Test Results

> **Important**: These numbers were measured on a single laptop with the API server, MongoDB, and Redis all running locally. They are **not** production capacity numbers and should not be treated as such. Infrastructure latency, network hops, and multi-tenant load will differ significantly in production.

Generated: ${date}  
Commit: ${commit}  
OS: ${machine.os}  
Node: ${machine.node}  
CPU: ${machine.cpu}  
RAM: ${machine.ram}

## Configuration

- API: in-process (same Node.js process as load driver)
- MongoDB: Docker (local)
- Redis: Docker (local)
- Worker: child process (separate Node.js process)
- \`INGEST_RATE_LIMIT_MAX=100000\` — default per-source limit bypassed for this run; real production should use a much lower value
- Concurrency cap: ${concurrency} concurrent in-flight requests
- Stage duration: ${stageDuration}s per stage
- Queue depth sampling interval: ${queueSamplingIntervalMs}ms

## Stage Results (Target vs. Achieved)

${stageTable.join('\n')}

## Baseline Measurement

- Target rate: 500 events/min (~8.33 target RPS)
- Configured duration: ${baselineResult.durationSec}s | Actual elapsed: ${baselineResult.actualElapsedSec}s
- Attempted: ${baselineResult.attempted} requests
- Accepted (HTTP 200): ${baselineResult.accepted}
- Rejected/error: ${baselineResult.errors} (${JSON.stringify(baselineResult.errsByStatus)})
- Achieved rate: ${baselineAchievedEventsPerMin} events/min (measured from actual elapsed, not configured duration)
- Achieved RPS: ${baselineResult.achievedRps}

## Drain & Pipeline

- Time to drain: ${drainMs}ms (${Math.round(drainMs / 1000)}s)
- Queue depth sampling interval: ${queueSamplingIntervalMs}ms
- Max queue depth sampled: ${maxQueueDepth} (waiting+active+delayed)
- Total attempted across all stages: ${totalAttempted}
- Total accepted across all stages: ${totalAccepted}
- Delivered: ${delivered}
- Dead: ${dead}

> **Accounting**: Attempted = total HTTP requests dispatched; Accepted = HTTP 200 responses (events stored in DB); Delivered = events confirmed delivered downstream by worker. In this test the ingest server performs deduplication, so accepted ≤ attempted when duplicate delivery-ids are reused. No duplicates are intentionally sent in staged RPS tests; accepted should equal attempted barring errors.

## Assertions (Spec Baseline: 500 events/min for 3 minutes)

${assertions.map(a => `- ${a}`).join('\n')}

## Reproduce

\`\`\`
docker compose -f infra/docker-compose.yml up -d
npm run load-test
# or
npm run load-test -- --stages "10,25,50,100" --duration 30
\`\`\`
`;

    const docsDir = join(ROOT, 'docs');
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, 'PERF.md'), perfContent, 'utf8');
    console.log('[load-test] Wrote docs/PERF.md');

    if (!assertPass) {
      console.error('[load-test] ASSERTIONS FAILED');
      process.exitCode = 1;
    } else {
      console.log('[load-test] ALL ASSERTIONS PASS');
    }
  } finally {
    // Teardown always runs — process.exitCode (not process.exit) is used so this finally block executes
    await teardown();
  }
}

main().catch((err) => {
  console.error('[load-test] Unhandled error:', err);
  process.exit(1);
});
