# Hookmend Chaos Test Results

Generated: 2026-10-25T13:39:28.770Z
Commit: a4dd5a6
OS: Windows_NT 10.0.26300
Node: v24.16.0
CPU: Intel(R) Core(TM) i5-8350U CPU @ 1.70GHz (8 cores)
RAM: 16 GB
Queue prefix: `hookmend-chaos`
Worker knobs (chaos): lockDuration=4000ms, stalledInterval=2000ms, maxStalledCount=3
STALE_JOB_THRESHOLD_MS (chaos): 10000ms

## Results

| Scenario | Injected Fault | Assertion | Result | Recovery (s) |
|---|---|---|---|---|
| C1 | Worker SIGKILL mid-delivery (receiver slow 3s) | All 20 delivered, exactly 20 docs, 0 dead, receiver saw each id >= 1 | PASS - 20/20 delivered, 5 ids seen >1 (at-least-once), recovery 3421ms | 3 |
| C2 | Redis stopped during ingest | All 20 HTTP 200 < 3000ms, 20 stored received, all delivered after Redis restart | PASS - 20/20 HTTP 200 while Redis down; all 20 delivered in 5s post-restart (12s total) | 5 |
| C3 | Redis FLUSHALL while events in flight | All 30 delivered, 0 dead, 0 stuck in any non-terminal state | PASS - 30/30 delivered after Redis FLUSHALL; 0 duplicate deliveries (at-least-once); 3118ms total | 3 |
| C4 | 100 concurrent requests with same delivery id | 1 doc, 1 not-dedup, 99 dedup, receiver saw exactly 1 request | PASS - 1 unique doc, 1 not-dedup, 99 dedup, receiver saw 1 request | 2 |
| C5 | Downstream 503 for ~3s (shorter than retry window) | All 20 delivered, 0 dead | PASS - 20/20 delivered, 0 dead, attempt distribution: {"3":20} | 1 |
| C6 | Downstream 503 until all events dead, then requeue | All go dead; requeue via admin API; all delivered | PASS - 20 events went dead; requeued 20; all 20 delivered after recovery | 10 |
| C7 | Fake AI client always throws 429-style error | Proposal with aiUsed=false, aiFailureReason=AI_RATE_LIMITED; no crash; baseline schema exists | PASS - Proposal created with aiUsed=false, aiFailureReason=AI_RATE_LIMITED; baseline replay covered 1 events | 16 |

## Notes

- C1: At-least-once delivery is expected for in-flight events at kill time. Downstream must deduplicate on `x-hookmend-event-id`.
- C3: Redis FLUSHALL removes all BullMQ job data. The D52/C3 fix in reconcile.js detects events stuck in `processing` or `failed` with statusChangedAt older than STALE_JOB_THRESHOLD_MS and moves them to `requeue_pending`, then re-enqueues them. This causes at-least-once delivery.
- C7: No real Gemini API call is made in any test. The fake AI client always throws a 429-style error. The baseline proposal is generated from the existing active schema.

## Reproduce

```
docker compose -f infra/docker-compose.yml up -d
npm run chaos
# or
npm run chaos -- --only C1,C2,C4 --ci
```
