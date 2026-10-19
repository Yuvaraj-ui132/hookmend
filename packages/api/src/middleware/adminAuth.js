/**
 * middleware/adminAuth.js — Bearer token authentication for Admin REST API.
 *
 * Compares sha256(token) with crypto.timingSafeEqual.
 * Never logs the token.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from './errorHandler.js';

export function createAdminAuthMiddleware(config) {
  const expectedToken = config.ADMIN_API_TOKEN;

  return function adminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError('UNAUTHORIZED', 'Missing or invalid authorization header', 401));
    }

    const token = authHeader.slice(7).trim();
    if (!token || !expectedToken) {
      return next(new AppError('UNAUTHORIZED', 'Invalid credentials', 401));
    }

    const tokenHash = createHash('sha256').update(token).digest();
    const expectedHash = createHash('sha256').update(expectedToken).digest();

    if (!timingSafeEqual(tokenHash, expectedHash)) {
      return next(new AppError('UNAUTHORIZED', 'Invalid credentials', 401));
    }

    next();
  };
}
