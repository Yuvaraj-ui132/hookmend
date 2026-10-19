/**
 * adapters/github.js — GitHub webhook adapter.
 *
 * Verifies x-hub-signature-256 (HMAC-SHA256 over raw body).
 * GitHub sends no timestamp; tolerance check is skipped.
 *
 * @param {Buffer} rawBody
 * @param {Object} headers - lowercased header map
 * @param {string} secret
 * @returns {Promise<{ok:boolean, eventId:string|null, eventType:string|null, timestamp:number|null, error:string|null}>}
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const SIG_HEADER = 'x-hub-signature-256';
const DELIVERY_HEADER = 'x-github-delivery';
const EVENT_TYPE_HEADER = 'x-github-event';
const SIG_RE = /^sha256=[0-9a-f]{64}$/;

export async function verify(rawBody, headers, secret) {
  const sigHeader = headers[SIG_HEADER];

  if (!sigHeader) {
    return fail('SIGNATURE_MISSING');
  }

  if (!SIG_RE.test(sigHeader)) {
    return fail('SIGNATURE_FORMAT');
  }

  const deliveryId = headers[DELIVERY_HEADER];
  if (!deliveryId) {
    return fail('EVENT_ID_MISSING');
  }

  // Compute expected HMAC over raw body
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(sigHeader.slice(7), 'hex'); // strip "sha256="

  // timingSafeEqual requires same length; length mismatch is a format error but we already checked length
  if (!timingSafeEqual(expected, received)) {
    return fail('SIGNATURE_INVALID');
  }

  return {
    ok: true,
    eventId: deliveryId,
    eventType: headers[EVENT_TYPE_HEADER] || null,
    timestamp: Date.now(),
    error: null,
  };
}

function fail(error) {
  return { ok: false, eventId: null, eventType: null, timestamp: null, error };
}
