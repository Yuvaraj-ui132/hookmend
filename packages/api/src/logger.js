/**
 * logger.js — Pino structured logger with sensitive header redaction.
 * Never logs: payload bodies, secrets, or raw signature values.
 * Always logs: rawBodyHash (sha256 hex) for integrity audit.
 */

import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
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
});

export default logger;
