/**
 * middleware/errorHandler.js — Central error handler.
 *
 * Error JSON format is FLAT:
 *   { "error": "SNAKE_CASE_CODE", "message": "human readable", "requestId": "..." }
 *
 * Unknown errors → 500 INTERNAL_ERROR with generic message; stack logged server-side.
 */

import logger from '../logger.js';

// Known application errors with their HTTP status codes
const ERROR_MAP = {
  SOURCE_NOT_FOUND: 404,
  SIGNATURE_INVALID: 401,
  SIGNATURE_MISSING: 401,
  SIGNATURE_FORMAT: 401,
  TIMESTAMP_STALE: 401,
  INVALID_TIMESTAMP: 400,
  INVALID_JSON: 400,
  INVALID_PAYLOAD: 400,
  EVENT_ID_MISSING: 400,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

/**
 * Creates an AppError with a known code and message.
 */
export class AppError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_MAP[code] || 500;
  }
}

/**
 * Central Express error handler. Must be registered last.
 */
export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const requestId = req.requestId || 'unknown';

  // Handle express body-parser PayloadTooLargeError
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({
      error: 'PAYLOAD_TOO_LARGE',
      message: 'Request body exceeds maximum allowed size',
      requestId,
    });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: err.code,
      message: err.message,
      requestId,
    });
  }

  // Unknown error — log stack, return generic 500
  logger.error({ err, requestId }, 'Unhandled internal error');
  return res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    requestId,
  });
}
