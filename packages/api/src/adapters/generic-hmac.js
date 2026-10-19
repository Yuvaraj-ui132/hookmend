/**
 * adapters/generic-hmac.js — Generic HMAC webhook adapter.
 *
 * Signs `${timestamp}.${rawBody}` for replay resistance.
 * Enforces timestamp tolerance window (past AND future).
 *
 * @param {Buffer} rawBody
 * @param {Object} headers - lowercased header map
 * @param {string} secret
 * @returns {Promise<{ok:boolean, eventId:string|null, eventType:string|null, timestamp:number|null, error:string|null}>}
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const SIG_HEADER = 'x-gateway-signature';
const TS_HEADER = 'x-gateway-timestamp';
const DELIVERY_HEADER = 'x-gateway-delivery-id';
const SIG_RE = /^sha256=[0-9a-f]{64}$/;

const TOLERANCE_MS = parseInt(process.env.TIMESTAMP_TOLERANCE_SECONDS || '300', 10) * 1000;

export async function verify(rawBody, headers, secret) {
  const sigHeader = headers[SIG_HEADER];

  if (!sigHeader) {
    return fail('SIGNATURE_MISSING');
  }

  if (!SIG_RE.test(sigHeader)) {
    return fail('SIGNATURE_FORMAT');
  }

  const tsHeader = headers[TS_HEADER];
  if (tsHeader === undefined || tsHeader === null || tsHeader === '') {
    return fail('TIMESTAMP_MISSING');
  }

  const tsNum = Number(tsHeader);
  if (!Number.isInteger(tsNum) || !Number.isFinite(tsNum)) {
    return fail('TIMESTAMP_INVALID');
  }

  // Tolerance: reject stale AND future timestamps
  const toleranceMs = parseInt(process.env.TIMESTAMP_TOLERANCE_SECONDS || '300', 10) * 1000;
  if (Math.abs(Date.now() - tsNum) > toleranceMs) {
    return fail('TIMESTAMP_STALE');
  }

  const deliveryId = headers[DELIVERY_HEADER];
  if (!deliveryId) {
    return fail('EVENT_ID_MISSING');
  }

  // Compute expected HMAC over "${timestamp}.${rawBody}"
  const signingInput = `${tsHeader}.${rawBody.toString()}`;
  const expected = createHmac('sha256', secret).update(signingInput).digest();
  const received = Buffer.from(sigHeader.slice(7), 'hex'); // strip "sha256="

  if (!timingSafeEqual(expected, received)) {
    return fail('SIGNATURE_INVALID');
  }

  return {
    ok: true,
    eventId: deliveryId,
    eventType: null, // read from body.event after parse in route
    timestamp: tsNum,
    error: null,
  };
}

function fail(error) {
  return { ok: false, eventId: null, eventType: null, timestamp: null, error };
}
