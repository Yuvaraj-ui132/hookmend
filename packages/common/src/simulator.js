/**
 * packages/common/src/simulator.js
 * D41: Synthetic event generator moved from packages/simulator/src/sign.js.
 *
 * SYNTHETIC data only — no real payment values.
 * drift presets: 'none' | 'amount_string' | 'remove_utr' | 'add_currency' |
 *                'remove_orderId' | 'all'
 * 'all' = amount_string + remove_utr + add_currency (same as Phase 1 drift).
 */

import { createHmac, randomUUID } from 'node:crypto';

/**
 * Signs `${timestamp}.${rawBodyString}` using HMAC-SHA256.
 * @param {string} secret
 * @param {string|number} timestamp - ms epoch
 * @param {string} rawBodyString - JSON string of the body
 * @returns {string} "sha256=<hex>"
 */
export function signGenericHmac(secret, timestamp, rawBodyString) {
  const signingInput = `${timestamp}.${rawBodyString}`;
  const hex = createHmac('sha256', secret).update(signingInput).digest('hex');
  return `sha256=${hex}`;
}

/**
 * Builds a synthetic payment.created event with optional drift preset.
 * @param {{ drift?: 'none'|'amount_string'|'remove_utr'|'add_currency'|'remove_orderId'|'all' }} options
 * @returns {object}
 */
export function buildPaymentEvent({ drift = 'none' } = {}) {
  const orderId = `ord-${randomUUID().slice(0, 8)}`;
  const utr = `UTR${Math.floor(Math.random() * 1e12).toString().padStart(12, '0')}`;
  const paymentId = `pay_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  // Start with base valid payload
  const payload = {
    event: 'payment.created',
    orderId,
    amount: 1000,
    amountPaise: 100000,
    utr,
    paymentId,
  };

  // Apply drift presets
  if (drift === 'amount_string') {
    payload.amount = String(payload.amount);
  } else if (drift === 'remove_utr') {
    delete payload.utr;
  } else if (drift === 'add_currency') {
    payload.currency = 'INR';
  } else if (drift === 'remove_orderId') {
    delete payload.orderId;
  } else if (drift === 'all') {
    // amount string + remove utr + add currency
    payload.amount = String(payload.amount);
    delete payload.utr;
    payload.currency = 'INR';
  }
  // drift === 'none' → no changes

  return payload;
}
