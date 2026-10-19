/**
 * logger.js — Pino structured logger factory with sensitive header redaction.
 * Never logs: payload bodies, secrets, or raw signature values.
 * Always logs: rawBodyHash (sha256 hex) for integrity audit.
 */

import pino from 'pino';

export function createLogger(options = {}) {
  const level = options.level || process.env.LOG_LEVEL || 'info';

  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-gateway-signature"]',
        'req.headers["x-hub-signature-256"]',
        'headers.authorization',
        'headers["x-gateway-signature"]',
        'headers["x-hub-signature-256"]',
      ],
      censor: '[REDACTED]',
    },
    ...options,
  });
}

const defaultLogger = createLogger();
export default defaultLogger;
