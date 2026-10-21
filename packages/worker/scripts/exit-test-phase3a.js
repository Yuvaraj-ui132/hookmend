#!/usr/bin/env node
/**
 * packages/worker/scripts/exit-test-phase3a.js — Phase 3A Exit Test
 *
 * Runs against real docker-compose MongoDB and Redis (fails if either is unreachable).
 * Asserts full Phase 3A loop: drift quarantine -> proposal creation -> admin inspection ->
 * operator patch -> transactional approval -> event requeue & delivery.
 */

import { MongoClient, ObjectId } from 'mongodb';
import { Redis } from 'ioredis';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  connectDb,
  closeDb,
  createIndexes,
  createBullQueue,
  QUEUE_NAMES,
} from '@hookmend/common';
import { createApp } from '../../api/src/server.js';
import { startReceiver } from '../../simulator/src/receiver.js';
import { startWorkerApp } from '../src/main.js';
import { signGenericHmac } from '../../simulator/src/sign.js';

const MONGODB_URI =
  process.env.MONGODB_URI ||
  'mongodb://localhost:27017/hookmend?directConnection=true';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const DB_NAME = 'hookmend_exit_test_phase3a';
const QUEUE_PREFIX = 'hookmend-test-p3a';
const ADMIN_API_TOKEN = 'test-phase3a-admin-token-secret';
const SLUG = 'sim-payments';

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
  console.log('[exit-test-phase3a] Starting Phase 3A Exit Test...');

  // ── 0. Verify Mongo and Redis Reachability ──────────────────────────────────
  console.log(`[exit-test-phase3a] Probing MongoDB: ${MONGODB_URI}`);
  let mongoHost = 'unknown';
  try {
    const mongoProbe = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 2000 });
    await mongoProbe.connect();
    mongoHost = mongoProbe.options?.hosts?.[0] || 'localhost:27017';
    await mongoProbe.close();
    console.log(`[exit-test-phase3a] Connected to MongoDB host: ${mongoHost}`);
  } catch (err) {
    console.error(`[exit-test-phase3a] FATAL: MongoDB unreachable at ${MONGODB_URI}`);
    console.error(err.message);
    process.exit(1);
  }

  console.log(`[exit-test-phase3a] Probing Redis: ${REDIS_URL}`);
  let redisHost = 'unknown';
  try {
    const redisProbe = new Redis(REDIS_URL, { connectTimeout: 2000, maxRetriesPerRequest: 1 });
    const pong = await redisProbe.ping();
    if (pong !== 'PONG') throw new Error('Redis ping did not return PONG');
    redisHost = `${redisProbe.options.host}:${redisProbe.options.port}`;
    console.log(`[exit-test-phase3a] Connected to Redis host: ${redisHost}`);

    // Clear test prefix keys
    const keys = await redisProbe.keys(`${QUEUE_PREFIX}:*`);
    if (keys.length > 0) {
      await redisProbe.del(...keys);
      console.log(`[exit-test-phase3a] Cleared ${keys.length} existing Redis test keys`);
    }
    await redisProbe.quit();
  } catch (err) {
    console.error(`[exit-test-phase3a] FATAL: Redis unreachable at ${REDIS_URL}`);
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
  console.log(`[exit-test-phase3a] Mock Receiver listening on port ${receiver.port}`);

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

  // Schema v1: requires event, orderId, amount (number), utr (string)
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
      required: ['event', 'orderId', 'amount', 'utr'],
      properties: {
        event: { type: 'string' },
        orderId: { type: 'string' },
        amount: { type: 'number' },
        utr: { type: 'string' },
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
    ENABLE_AI: false,
    REPLAY_MAX_EVENTS: 1000,
    MAX_SCHEMA_BYTES: 102400,
  };

  const queue = createBullQueue({
    redisUrl: REDIS_URL,
    prefix: QUEUE_PREFIX,
  });

  const apiApp = createApp({ db, queue, config: testConfig });
  const apiServer = createServer(apiApp);
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const apiPort = apiServer.address().port;
  console.log(`[exit-test-phase3a] API server listening on port ${apiPort}`);

  const workerApp = await startWorkerApp({
    db,
    queue,
    config: {
      ...testConfig,
      RECONCILE_INTERVAL_MS: 300000,
      ENABLE_AI: false,
    },
  });
  console.log('[exit-test-phase3a] Worker app started');

  const results = [];
  const authHeaders = {
    Authorization: `Bearer ${ADMIN_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  let proposalId = null;
  let driftFingerprint = null;

  try {
    // ═════════════════════════════════════════════════════════════════════════
    // Scenario A: Drift Ingest -> Quarantine -> Proposal Created
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[exit-test-phase3a] Running Scenario A: Ingest 3 drifted events...');

    // Drifted payload: amount is string, currency added, utr missing
    const driftedEvents = [
      { event: 'payment.created', orderId: 'ord_d1', amount: '150.00', currency: 'INR' },
      { event: 'payment.created', orderId: 'ord_d2', amount: '250.00', currency: 'INR' },
      { event: 'payment.created', orderId: 'ord_d3', amount: '350.00', currency: 'INR' },
    ];

    for (let i = 0; i < driftedEvents.length; i++) {
      const payload = driftedEvents[i];
      const payloadString = JSON.stringify(payload);
      const timestamp = String(Date.now());
      const deliveryId = `deliv_${randomUUID().slice(0, 8)}_${i}`;
      const signature = signGenericHmac(secret, timestamp, payloadString);

      const res = await fetch(`http://127.0.0.1:${apiPort}/ingest/${SLUG}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-gateway-signature': signature,
          'x-gateway-timestamp': timestamp,
          'x-gateway-delivery-id': deliveryId,
        },
        body: payloadString,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Ingest failed with status ${res.status}: ${errText}`);
      }
    }

    // Wait for events to be quarantined
    console.log('[exit-test-phase3a] Waiting for 3 events to be quarantined...');
    await waitForCondition(async () => {
      const count = await db.collection('events').countDocuments({
        sourceId,
        eventType: 'payment.created',
        status: 'quarantined',
      });
      return count === 3;
    });

    const sampleEvent = await db.collection('events').findOne({ status: 'quarantined' });
    driftFingerprint = sampleEvent.driftFingerprint;

    // Wait for analyze-drift worker to produce proposal
    console.log('[exit-test-phase3a] Waiting for proposal to be generated by worker...');
    const proposalDoc = await waitForCondition(async () => {
      return db.collection('proposals').findOne({
        sourceId,
        eventType: 'payment.created',
        status: 'pending_review',
      });
    }, 25000);

    proposalId = proposalDoc._id.toString();

    // Verify all 3 quarantined events have proposalId linked
    const linkedCount = await db.collection('events').countDocuments({
      status: 'quarantined',
      proposalId: proposalDoc._id,
    });

    const passA = proposalDoc !== null && linkedCount === 3;
    results.push({
      scenario: 'Scenario A: Ingest 3 drifted events -> quarantined with fingerprint -> proposal created and linked',
      pass: passA,
      detail: `proposalId: ${proposalId}, driftFingerprint: ${driftFingerprint?.slice(0, 12)}..., linkedEvents: ${linkedCount}/3`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario B: Admin REST Inspection & Quarantine Grouping
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[exit-test-phase3a] Running Scenario B: Admin REST inspection...');

    // GET /api/quarantine
    const qRes = await fetch(`http://127.0.0.1:${apiPort}/api/quarantine`, {
      headers: authHeaders,
    });
    const quarantineGroups = await qRes.json();
    const group = quarantineGroups.find((g) => g.driftFingerprint === driftFingerprint);

    // GET /api/proposals
    const pListRes = await fetch(`http://127.0.0.1:${apiPort}/api/proposals?status=pending_review`, {
      headers: authHeaders,
    });
    const pListData = await pListRes.json();

    // GET /api/proposals/:id
    const pGetRes = await fetch(`http://127.0.0.1:${apiPort}/api/proposals/${proposalId}`, {
      headers: authHeaders,
    });
    const pGetData = await pGetRes.json();

    const passB =
      qRes.status === 200 &&
      group?.count === 3 &&
      pListData.items?.length >= 1 &&
      pGetData._id === proposalId &&
      pGetData.proposedSchema !== undefined;

    results.push({
      scenario: 'Scenario B: Admin REST inspection (/api/quarantine, /api/proposals, /api/proposals/:id)',
      pass: passB,
      detail: `quarantine group count: ${group?.count}, proposal status: ${pGetData?.status}`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario C: Operator Patches Proposal Schema
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[exit-test-phase3a] Running Scenario C: Operator PATCH proposal...');

    const humanAdjustedSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['event', 'orderId', 'amount'],
      properties: {
        event: { type: 'string' },
        orderId: { type: 'string' },
        amount: { type: ['number', 'string'] },
        utr: { type: 'string' },
        currency: { type: 'string' },
      },
      additionalProperties: false,
    };

    const patchRes = await fetch(`http://127.0.0.1:${apiPort}/api/proposals/${proposalId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ proposedSchema: humanAdjustedSchema }),
    });

    const patchData = await patchRes.json();
    const passC =
      patchRes.status === 200 &&
      patchData.editedByHuman === true &&
      patchData.replayResults?.passed === 3;

    results.push({
      scenario: 'Scenario C: Operator PATCH proposal schema -> validated, replayed, editedByHuman set true',
      pass: passC,
      detail: `editedByHuman: ${patchData.editedByHuman}, replay passed: ${patchData.replayResults?.passed}/3`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario D: Transactional Approval & Requeue & Delivery
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[exit-test-phase3a] Running Scenario D: Approve proposal & verify redelivery...');

    const approveRes = await fetch(`http://127.0.0.1:${apiPort}/api/proposals/${proposalId}/approve`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    });

    const approveData = await approveRes.json();

    // Verify DB states:
    // 1. Schema v2 is active, v1 is inactive
    const activeSchemaV2 = await db.collection('schemas').findOne({ sourceId, version: 2, active: true });
    const inactiveSchemaV1 = await db.collection('schemas').findOne({ sourceId, version: 1 });

    // 2. Proposal is approved
    const approvedProposal = await db.collection('proposals').findOne({ _id: new ObjectId(proposalId) });

    // 3. Quarantined events transition through requeue_pending -> delivered
    console.log('[exit-test-phase3a] Waiting for requeued events to be delivered to downstream...');
    await waitForCondition(async () => {
      const deliveredCount = await db.collection('events').countDocuments({
        sourceId,
        status: 'delivered',
        schemaVersion: 2,
      });
      return deliveredCount === 3;
    }, 25000);

    // 4. Downstream mock receiver should have received the 3 events
    const receiverStats = receiver.getStats();

    const passD =
      approveRes.status === 200 &&
      activeSchemaV2 !== null &&
      inactiveSchemaV1?.active === false &&
      approvedProposal?.status === 'approved' &&
      receiverStats.totalRequests >= 3;

    results.push({
      scenario: 'Scenario D: Transactional approval -> schema v2 activated -> 3 events redelivered to downstream',
      pass: passD,
      detail: `newSchemaVersion: ${approveData.newSchemaVersion}, receiver requests: ${receiverStats.totalRequests}`,
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Scenario E: Audit Trail Integrity
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[exit-test-phase3a] Running Scenario E: Audit trail verification...');

    const auditRes = await fetch(`http://127.0.0.1:${apiPort}/api/audit`, {
      headers: authHeaders,
    });
    const auditLogs = await auditRes.json();
    const actions = auditLogs.map((a) => a.action);

    const hasProposalCreated = actions.includes('proposal.created');
    const hasProposalPatched = actions.includes('proposal.patched');
    const hasSchemaActivated = actions.includes('schema.activated');
    const hasProposalApproved = actions.includes('proposal.approved');

    const passE =
      auditRes.status === 200 &&
      hasProposalCreated &&
      hasProposalPatched &&
      hasSchemaActivated &&
      hasProposalApproved;

    results.push({
      scenario: 'Scenario E: Audit log integrity (proposal.created, proposal.patched, schema.activated, proposal.approved)',
      pass: passE,
      detail: `found actions: ${actions.filter(a => a.startsWith('proposal.') || a.startsWith('schema.')).join(', ')}`,
    });
  } finally {
    // ── Teardown ────────────────────────────────────────────────────────────
    console.log('\n[exit-test-phase3a] Cleaning up test resources...');
    await workerApp.stop();
    await queue.close();
    apiServer.close();
    await receiver.close();
    await closeDb();
  }

  // ── Results Summary ───────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('            HOOKMEND PHASE 3A EXIT TEST RESULTS                ');
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
    console.log('[exit-test-phase3a] ALL SCENARIOS PASSED.');
    process.exit(0);
  } else {
    console.error('[exit-test-phase3a] ONE OR MORE SCENARIOS FAILED.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[exit-test-phase3a] Fatal unhandled error:', err);
  process.exit(1);
});
