/**
 * middleware/cors.js — CORS allow-list middleware (D40).
 *
 * Applied ONLY to /api routes (never to /ingest).
 * Allow-list from DASHBOARD_ORIGINS (comma-separated, default http://localhost:5173).
 * Reflects origin ONLY if it matches.
 * Methods: GET, POST, PATCH, DELETE, OPTIONS
 * Headers: Authorization, Content-Type
 * OPTIONS → 204 (no body)
 * No credentials header (not needed; auth is Bearer header).
 */

/**
 * @param {{ DASHBOARD_ORIGINS?: string }} config
 * @returns {import('express').RequestHandler}
 */
export function createCorsMiddleware(config = {}) {
  const originsRaw = config.DASHBOARD_ORIGINS || 'http://localhost:5173';
  const allowedOrigins = new Set(
    originsRaw
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  );

  const ALLOWED_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
  const ALLOWED_HEADERS = 'Authorization, Content-Type';

  return function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;

    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    }

    // Pre-flight
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}
