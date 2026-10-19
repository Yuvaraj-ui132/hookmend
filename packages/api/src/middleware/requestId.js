/**
 * middleware/requestId.js
 *
 * Uses X-Request-Id from client if it is 8–64 chars of [A-Za-z0-9_-],
 * otherwise generates a nanoid(). Sets req.requestId and response header.
 */

import { nanoid } from 'nanoid';

const VALID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function requestIdMiddleware(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const requestId = (incoming && VALID_RE.test(incoming)) ? incoming : nanoid();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}
