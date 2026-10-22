/**
 * packages/common/test/simulatorPresets.test.js
 * Unit tests for buildPaymentEvent drift presets (D41).
 */

import { describe, it, expect } from 'vitest';
import { buildPaymentEvent } from '../src/simulator.js';

describe('buildPaymentEvent drift presets', () => {
  it('drift=none produces valid payment with number amount and utr', () => {
    const p = buildPaymentEvent({ drift: 'none' });
    expect(typeof p.amount).toBe('number');
    expect(p.utr).toBeDefined();
    expect(p.currency).toBeUndefined();
    expect(p.event).toBe('payment.created');
  });

  it('drift=amount_string makes amount a string', () => {
    const p = buildPaymentEvent({ drift: 'amount_string' });
    expect(typeof p.amount).toBe('string');
    expect(p.utr).toBeDefined();
    expect(p.currency).toBeUndefined();
  });

  it('drift=remove_utr removes utr field', () => {
    const p = buildPaymentEvent({ drift: 'remove_utr' });
    expect(p.utr).toBeUndefined();
    expect(typeof p.amount).toBe('number');
  });

  it('drift=add_currency adds currency:INR', () => {
    const p = buildPaymentEvent({ drift: 'add_currency' });
    expect(p.currency).toBe('INR');
    expect(typeof p.amount).toBe('number');
    expect(p.utr).toBeDefined();
  });

  it('drift=remove_orderId removes orderId field', () => {
    const p = buildPaymentEvent({ drift: 'remove_orderId' });
    expect(p.orderId).toBeUndefined();
  });

  it('drift=all applies amount_string + remove_utr + add_currency', () => {
    const p = buildPaymentEvent({ drift: 'all' });
    expect(typeof p.amount).toBe('string');
    expect(p.utr).toBeUndefined();
    expect(p.currency).toBe('INR');
  });

  it('each call produces unique orderId, paymentId', () => {
    const a = buildPaymentEvent({ drift: 'none' });
    const b = buildPaymentEvent({ drift: 'none' });
    expect(a.orderId).not.toBe(b.orderId);
    expect(a.paymentId).not.toBe(b.paymentId);
  });
});
