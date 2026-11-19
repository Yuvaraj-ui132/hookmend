# Contributing to Hookmend

Thank you for your interest in contributing to Hookmend.

## Development Setup

### Prerequisites
- Node.js >= 20
- npm >= 10
- Docker and Docker Compose (for local MongoDB replica set and Redis)

### Setup Steps
1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/Yuvaraj-ui132/hookmend.git
   cd hookmend
   npm install
   ```
2. Set up environment configuration:
   ```bash
   cp .env.example .env
   ```
3. Start backing services via Docker Compose:
   ```bash
   docker compose -f infra/docker-compose.yml up -d
   ```
4. Seed the database with initial sources and schemas:
   ```bash
   npm run seed
   ```

## Running Tests

All changes must pass unit, integration, and exit test suites:
- Run unit and integration tests:
  ```bash
  npm test
  ```
- Run exit test phases:
  ```bash
  npm run exit-test:phase1
  npm run exit-test:phase2
  npm run exit-test:phase3a
  npm run exit-test:phase3b
  npm run exit-test:phase4
  ```
- Run chaos scenarios (requires Docker):
  ```bash
  npm run chaos -- --ci --only C1,C2,C4
  ```

## Branch and Commit Style

- Branch names should follow conventional prefixes: `feature/name`, `fix/name`, `docs/name`, or `chore/name`.
- Commit messages follow Conventional Commits format: `<type>(<scope>): <short description>`.
  Examples:
  - `feat(api): add stripe provider adapter`
  - `fix(worker): handle timeout during reconciliation`
  - `docs: update quickstart guide`

## Adding a Provider Adapter

Provider adapters reside in `packages/api/src/adapters/` and are registered in `packages/api/src/adapters/index.js`.

### Adapter Contract

Every adapter must export an asynchronous `verify` function matching the contract from `docs/SPEC.md` §9:

```javascript
/**
 * @param {Buffer} rawBody - Raw unparsed request body buffer
 * @param {Record<string, string>} headers - Lowercased HTTP headers
 * @param {string} secret - Shared secret value from environment
 * @returns {Promise<{
 *   ok: boolean,
 *   eventId: string|null,
 *   eventType: string|null,
 *   timestamp: number|null,
 *   error: string|null
 * }>}
 */
export async function verify(rawBody, headers, secret) {
  // 1. Extract required headers (signature, timestamp, delivery id)
  // 2. Validate format (e.g. hex length, structure)
  // 3. Verify timestamp tolerance window (reject stale or future timestamps)
  // 4. Compute HMAC over rawBody (or canonical string) using crypto.createHmac
  // 5. Compare signatures using crypto.timingSafeEqual
  // 6. Return standardized result
}
```

### Standardized Error Codes

When verification fails, `ok` must be `false` with one of the following error codes:
- `SIGNATURE_MISSING`: Signature header not found.
- `SIGNATURE_FORMAT`: Signature does not match expected format (e.g. invalid length or non-hex).
- `SIGNATURE_INVALID`: Signature mismatch.
- `TIMESTAMP_MISSING`: Timestamp header missing.
- `TIMESTAMP_INVALID`: Timestamp format is malformed or non-numeric.
- `TIMESTAMP_STALE`: Timestamp falls outside the acceptable tolerance window.
- `EVENT_ID_MISSING`: Unique delivery or event identifier header missing.

Never expose secrets or environment variable names in error return values or logs.
