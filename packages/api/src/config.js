/**
 * config.js — single source of truth for all environment variables.
 * MONGODB_URI is required at runtime (not at import time, to allow test setup).
 * Per-source secrets are read at request time from process.env[source.secretEnvVar].
 */

function getConfig() {
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is required');
  }

  const NODE_ENV = process.env.NODE_ENV || 'development';
  const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || 'change-me';

  if (NODE_ENV === 'production' && (!ADMIN_API_TOKEN || ADMIN_API_TOKEN === 'change-me')) {
    throw new Error('ADMIN_API_TOKEN must be set to a secure value in production');
  }

  return {
    PORT: parseInt(process.env.PORT || '3000', 10),
    NODE_ENV,
    MONGODB_URI,
    MAX_BODY_SIZE: parseInt(process.env.MAX_BODY_SIZE || '524288', 10),
    TIMESTAMP_TOLERANCE_SECONDS: parseInt(process.env.TIMESTAMP_TOLERANCE_SECONDS || '300', 10),
    INGEST_RATE_LIMIT_MAX: parseInt(process.env.INGEST_RATE_LIMIT_MAX || '100', 10),
    INGEST_RATE_LIMIT_WINDOW_MS: parseInt(process.env.INGEST_RATE_LIMIT_WINDOW_MS || '60000', 10),
    EVENT_TTL_DAYS: parseInt(process.env.EVENT_TTL_DAYS || '14', 10),
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    VERSION: '0.2.0',
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    QUEUE_PREFIX: process.env.QUEUE_PREFIX || 'hookmend',
    ADMIN_API_TOKEN,
    DOWNSTREAM_TIMEOUT_MS: parseInt(process.env.DOWNSTREAM_TIMEOUT_MS || '10000', 10),
    ENABLE_AI: process.env.ENABLE_AI === 'true',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    GEMINI_RPM_LIMIT: parseInt(process.env.GEMINI_RPM_LIMIT || '10', 10),
    GEMINI_RPD_LIMIT: parseInt(process.env.GEMINI_RPD_LIMIT || '100', 10),
    MAX_SCHEMA_BYTES: parseInt(process.env.MAX_SCHEMA_BYTES || '102400', 10),
    REPLAY_MAX_EVENTS: parseInt(process.env.REPLAY_MAX_EVENTS || '1000', 10),
  };
}

// Export a live config object that reads from process.env at call time.
// Tests can set MONGODB_URI before calling connectDb / createApp.
export { getConfig };
export default getConfig;
