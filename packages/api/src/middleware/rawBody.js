/**
 * middleware/rawBody.js
 *
 * express.raw applied ONLY on the ingest route.
 * Oversized bodies → 413 PAYLOAD_TOO_LARGE.
 * No global express.json() anywhere.
 */

import express from 'express';

/**
 * @param {number} maxBodySize - bytes
 * @returns {import('express').RequestHandler[]}
 */
export function rawBodyMiddleware(maxBodySize) {
  return [
    express.raw({ type: '*/*', limit: maxBodySize }),
  ];
}
