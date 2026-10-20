/**
 * constants.js — Shared constants across gateway, worker, and admin services.
 */

export const EVENT_STATUS = {
  RECEIVED: 'received',
  PROCESSING: 'processing',
  DELIVERED: 'delivered',
  QUARANTINED: 'quarantined',
  FAILED: 'failed',
  DEAD: 'dead',
  REQUEUE_PENDING: 'requeue_pending',
};

export const PROPOSAL_STATUS = {
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

export const QUEUE_NAMES = {
  PROCESS_EVENT: 'process-event',
  ANALYZE_DRIFT: 'analyze-drift',
};

export const DEFAULT_CONFIG = {
  QUEUE_PREFIX: 'hookmend',
  PROCESS_EVENT_ATTEMPTS: 5,
  PROCESS_EVENT_BACKOFF_BASE_MS: 1000,
  PROCESS_EVENT_BACKOFF_MAX_MS: 30000,
  ANALYZE_DRIFT_ATTEMPTS: 3,
  ANALYZE_DRIFT_BACKOFF_MS: 5000,
  DOWNSTREAM_TIMEOUT_MS: 10000,
  RECONCILE_INTERVAL_MS: 300000,
  RECONCILE_MIN_AGE_MS: 60000,
  RECONCILE_BATCH: 500,
  STALE_JOB_THRESHOLD_MS: 300000,
  EVENT_TTL_DAYS: 14,
  AUDIT_TTL_SECONDS: 7776000, // 90 days
  ENABLE_AI: false,
  GEMINI_RPM_LIMIT: 10,
  GEMINI_RPD_LIMIT: 100,
  REPLAY_MAX_EVENTS: 1000,
  MAX_SCHEMA_BYTES: 102400,
};

export const DEFAULT_JOB_OPTIONS = {
  PROCESS_EVENT: {
    attempts: DEFAULT_CONFIG.PROCESS_EVENT_ATTEMPTS,
    backoff: { type: 'custom' },
    removeOnComplete: { count: 1000, age: 86400 },
    removeOnFail: { count: 5000, age: 604800 },
  },
  ANALYZE_DRIFT: {
    attempts: DEFAULT_CONFIG.ANALYZE_DRIFT_ATTEMPTS,
    backoff: { type: 'exponential', delay: DEFAULT_CONFIG.ANALYZE_DRIFT_BACKOFF_MS },
    removeOnComplete: { count: 1000, age: 86400 },
    removeOnFail: { count: 5000, age: 604800 },
  },
};
