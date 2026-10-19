/**
 * simulator/src/sign.js
 *
 * Signing helpers and synthetic event generator for the Webhook Simulator.
 * SYNTHETIC data only — no real payment values.
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
 * Builds a synthetic payment.created event.
 * With drift=true: amount becomes a string, utr removed, currency added.
 * @param {{ drift?: boolean }} options
 * @returns {object}
 */
export function buildPaymentEvent({ drift = false } = {}) {
  const orderId = `ord-${randomUUID().slice(0, 8)}`;
  const utr = `UTR${Math.floor(Math.random() * 1e12).toString().padStart(12, '0')}`;
  const paymentId = `pay_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  if (drift) {
    // Drifted: amount is string, utr removed, currency added
    return {
      event: 'payment.created',
      orderId,
      amount: '1000', // type changed: number → string
      amountPaise: 100000,
      currency: 'INR', // added field
      paymentId,
      // utr: removed
    };
  }

  return {
    event: 'payment.created',
    orderId,
    amount: 1000,
    amountPaise: 100000,
    utr,
    paymentId,
  };
}
