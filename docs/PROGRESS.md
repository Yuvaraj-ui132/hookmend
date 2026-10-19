# Hookmend Phase 1 — Progress Log

## STEP 1 — Tests First [DONE]
- Created packages/api/test/unit/adapters.test.js (github + generic-hmac, 11 unit cases)
- Created packages/api/test/integration/ingest.test.js (15 integration scenarios covering all spec behaviours)
- Tests will fail until Steps 2-4 implement the source files
- Next: STEP 2 — config.js, logger.js, db/client.js

## STEP 2 — Config, Logger, DB [DONE]
- config.js reads all env vars with defaults; MONGODB_URI required
- logger.js pino with redact for signature/auth headers; never logs bodies or secrets
- db/client.js singleton MongoClient with idempotent index creation for sources and events collections
- expireAt field omitted entirely on insert; TTL index on expireAt with expireAfterSeconds:0
- Next: STEP 3 — adapters (github.js, generic-hmac.js)

## STEP 3 — Adapters [DONE]
- github.js: HMAC-SHA256 over raw body, x-hub-signature-256 validation, timingSafeEqual, no timestamp check
- generic-hmac.js: Signs ${timestamp}.${rawBody}, timestamp tolerance check (past+future), x-gateway-* headers
- All error codes implemented: SIGNATURE_MISSING/FORMAT/INVALID, TIMESTAMP_MISSING/INVALID/STALE, EVENT_ID_MISSING
- Unit tests: all passing
- Next: STEP 4 — middleware, queue stub, routes, server

## STEP 4 — Middleware, Queue Stub, Routes, Server [DONE]
- requestId.js: validates X-Request-Id or generates nanoid()
- rawBody.js: express.raw scoped to ingest route; 413 for oversized
- errorHandler.js: flat JSON error format; unknown errors → 500 INTERNAL_ERROR; no stack leaks
- queue/stub.js: async enqueue() with in-memory array + returns {id}
- routes/health.js: GET /health with mongo ping, redis not_configured
- routes/ingest.js: full pipeline per spec (rate-limit, raw body, source lookup, secret, adapter, JSON parse, event type, insert, dedup, enqueue)
- server.js: createApp factory; main.js: connect, listen, graceful SIGTERM/SIGINT shutdown
- Integration tests: all passing
- Next: STEP 5 — verify all integration test cases pass

## STEP 5 — Integration Tests All Passing [DONE]
- All 15 integration test scenarios passing (verified npm test run)
- Test status: unit 11 pass, integration 15 pass
- Next: STEP 6 — simulator, seed, infra, exit-test

## STEP 6 — Simulator, Seed, Infra, Exit Test [DONE]
- simulator/src/sign.js: signGenericHmac + buildPaymentEvent generator
- simulator/src/sender.js: CLI with --count, --duplicates, --drift flags
- infra/docker-compose.yml: mongo:7 replica set rs0 + redis:7
- infra/seed/seed.js: idempotent upserts for github-main and sim-payments sources
- packages/api/scripts/exit-test.js: full phase1 exit test (25 req → 20 docs, 5 deduplicated)
- Next: STEP 7 — SPEC updates (decision log)

## STEP 7 — SPEC Updates [DONE]
- Added decision log entries: flat error format, 413 for oversized, INVALID_PAYLOAD for missing event type
- Added rate-limit key slug+ip with trust proxy note
- Added /health redis "not_configured" in Phase 1
- Added omit expireAt until terminal status decision
- Added Phase 3 note: analyze-drift jobId must include attempt counter
- All steps complete. Run: npm test → npm run exit-test:phase1

## Phase 1 Exit Test [PASS]
- exit-test.js verified with MongoMemoryServer fallback (matching SPEC §16: "Runs against real or memory database")
- Ran `npm test`: 34/34 tests passing (17 unit, 17 integration)
- Ran `npm run exit-test:phase1`: 25/25 HTTP 200, 5/5 deduplicated:true, 20/20 events in DB with status "received"
- Phase 1 successfully completed. Next: Phase 2 (Queue, Validation, Delivery, Quarantine)

## STEP 1 — Tests First (Phase 2) [DONE]
- Added unit tests for diff, fingerprint, validate in packages/common/test/
- Added unit tests for delivery, processor, reconcile in packages/worker/test/
- Added integration tests for admin REST (auth, pagination, requeue, secrets isolation) in packages/api/test/
- Test status: 34 Phase 1 tests pass, 12 new Phase 2 tests failing (tests-first)
- Next: STEP 2 — create packages/common and migrate shared code

## STEP 2 — Common Package Migration [DONE]
- Created packages/common (@hookmend/common) with constants, logger factory, MongoDB client + idempotent index creation (including schemas and audit_log indexes), and audit-log helper
- Updated packages/api to depend on @hookmend/common and re-export shared modules
- Gate verified: 34/34 Phase 1 unit + integration tests pass, npm run exit-test:phase1 PASS
- Next: STEP 3 — implement drift diff, fingerprint, and Ajv validate in common

## STEP 3 — Drift and Validation [DONE]
- Implemented computeStructuralDiff in packages/common/src/diff.js (value-free, max depth 5, integer accepted for number)
- Implemented computeFingerprint in packages/common/src/fingerprint.js (canonical JSON with normalized key/array sorting)
- Implemented validatePayload in packages/common/src/validate.js (Ajv draft-07, allErrors:true, strict:false, value-free errors capped at 20)
- Test status: 18/18 common tests passing
- Next: STEP 4 — BullMQ producer and API wiring

## STEP 4 — BullMQ Producer and API Wiring [DONE]
- Implemented createBullQueue in packages/common/src/queue/index.js with fail-fast (enableOfflineQueue: false), 2000ms enqueue timeout, ping, and graceful close
- Updated .env.example and packages/api/src/config.js with Phase 2 env vars and production admin token guard
- Updated packages/api/src/routes/health.js to ping Redis via queue.ping() and report connected/disconnected/degraded
- Wired packages/api/src/main.js to real BullMQ queue factory while keeping stub.js for test injection
- Test status: 52 tests passing (34 Phase 1 + 18 common); exit-test:phase1 PASS
- Next: STEP 5 — worker (processor, delivery, reconciliation, analyze-drift stub)
