/**
 * middleware/secureHeaders.js — Minimal secure response headers.
 *
 * D54(d): Applied to all /api routes with no external dependency.
 * Headers set:
 *   X-Content-Type-Options: nosniff
 *   X-Frame-Options: DENY
 *   Referrer-Policy: no-referrer
 *   Cache-Control: no-store
 *
 * These do not require helmet or any other package.
 */

/**
 * Middleware that sets security headers on every response.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function secureHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
}
