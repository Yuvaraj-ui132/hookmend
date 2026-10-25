# Hookmend Load Test Results

> **Important**: These numbers were measured on a single laptop with the API server, MongoDB, and Redis all running locally. They are **not** production capacity numbers and should not be treated as such. Infrastructure latency, network hops, and multi-tenant load will differ significantly in production.

Generated: 2026-10-25T13:14:25.432Z
Commit: f1a215d
OS: Windows_NT 10.0.26300
Node: v24.16.0
CPU: Intel(R) Core(TM) i5-8350U CPU @ 1.70GHz (8 cores)
RAM: 16 GB

## Configuration

- API: in-process (same Node.js process as load driver)
- MongoDB: Docker (local)
- Redis: Docker (local)
- Worker: child process (separate Node.js process)
- `INGEST_RATE_LIMIT_MAX=100000` - default per-source limit bypassed for this run; real production should use a much lower value
- Concurrency cap: 20 concurrent in-flight requests
- Stage duration: 30s per stage
- Queue depth sampling interval: 1000ms

## Stage Results (Target vs. Achieved)

| Target RPS | Config Duration (s) | Actual Elapsed (s) | Attempted | Accepted | Errors | Achieved RPS | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 30 | 30 | 299 | 299 | 0 | 10 | 11 | 19 | 597 | 744 |
| 25 | 30 | 30 | 749 | 749 | 0 | 25 | 10 | 26 | 173 | 352 |
| 50 | 30 | 30 | 1499 | 1499 | 0 | 50 | 11 | 147 | 424 | 561 |
| 100 | 30 | 30 | 2999 | 2999 | 0 | 99.9 | 17 | 69 | 189 | 492 |
| baseline (~8.33 target) | 180 | 180 | 1499 | 1499 | 0 | 8.3 | 8 | 13 | 31 | 108 |

## Baseline Measurement

- Target rate: 500 events/min (~8.33 target RPS)
- Configured duration: 180s | Actual elapsed: 180s
- Attempted: 1499 requests
- Accepted (HTTP 200): 1499
- Rejected/error: 0 ({})
- Achieved rate: 499.7 events/min (measured from actual elapsed, not configured duration)
- Achieved RPS: 8.3

## Drain & Pipeline

- Time to drain: 2030ms (2s)
- Queue depth sampling interval: 1000ms
- Max queue depth sampled: 0 (waiting+active+delayed)
- Total attempted across all stages: 7045
- Total accepted across all stages: 7045
- Delivered: 7045
- Dead: 0

> **Accounting**: Attempted = total HTTP requests dispatched; Accepted = HTTP 200 responses (events stored in DB); Delivered = events confirmed delivered downstream by worker. In this test the ingest server performs deduplication, so accepted <= attempted when duplicate delivery-ids are reused. No duplicates are intentionally sent in staged RPS tests; accepted should equal attempted barring errors.

## Assertions (Spec Baseline: 500 events/min for 3 minutes)

- PASS: zero HTTP errors in baseline
- PASS: zero dead events
- PASS: 7045/7045 accepted events delivered

## Reproduce

```
docker compose -f infra/docker-compose.yml up -d
npm run load-test
# or
npm run load-test -- --stages "10,25,50,100" --duration 30
```
