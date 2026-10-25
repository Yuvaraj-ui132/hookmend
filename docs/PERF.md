# Hookmend Load Test Results

> **Important**: These numbers were measured on a single laptop with the API server, MongoDB, and Redis all running locally. They are **not** production capacity numbers and should not be treated as such. Infrastructure latency, network hops, and multi-tenant load will differ significantly in production.

Generated: 2026-10-25T12:44:25.942Z  
Commit: db6ba8e  
OS: Windows_NT 10.0.26300  
Node: v24.16.0  
CPU: Intel(R) Core(TM) i5-8350U CPU @ 1.70GHz (8 cores)  
RAM: 16 GB

## Configuration

- API: in-process (same Node.js process as load driver)
- MongoDB: Docker (local)
- Redis: Docker (local)
- Worker: child process (separate Node.js process)
- `INGEST_RATE_LIMIT_MAX=100000` — default per-source limit bypassed for this run; real production should use a much lower value
- Concurrency cap: 20 concurrent in-flight requests
- Stage duration: 30s per stage
- Queue depth sampling interval: 1000ms

## Stage Results (Target vs. Achieved)

| Target RPS | Duration (s) | Sent | Accepted | Errors | Achieved RPS | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) |
|---|---|---|---|---|---|---|---|---|---|
| 10 | 30 | 300 | 150 | {} | 10 | 9 | 12 | 35 | 46 |
| 25 | 30 | 750 | 375 | {} | 25 | 9 | 11 | 11 | 16 |
| 50 | 30 | 1500 | 750 | {} | 50 | 8 | 11 | 12 | 18 |
| 100 | 30 | 3000 | 1500 | {} | 100 | 10 | 13 | 18 | 47 |
| baseline (8.3 target, 500/min) | 180 | 1500 | 750 | {} | 8.3 (achieved 500 events/min) | 8 | 10 | 11 | 13 |

## Baseline Measurement

- Target rate: 500 events/min (~8.33 target RPS)
- Duration: 180s (target: 1500 events)
- Total sent: 1500
- Total accepted: 750
- Achieved rate: 500 events/min
- Achieved RPS: 8.3
- HTTP errors: {}

## Drain & Pipeline

- Time to drain: 2015ms (2s)
- Queue depth sampling interval: 1000ms
- Max queue depth sampled: 0 (waiting+active+delayed)
- Total accepted across all stages: 3525
- Delivered: 3525
- Dead: 0

## Assertions (Spec Baseline: 500 events/min for 3 minutes)

- PASS: zero HTTP errors in baseline
- PASS: zero dead events
- PASS: 3525/3525 accepted events delivered

## Reproduce

```
docker compose -f infra/docker-compose.yml up -d
npm run load-test
# or
npm run load-test -- --stages "10,25,50,100" --duration 30
```
