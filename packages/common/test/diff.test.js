import { describe, it, expect } from 'vitest';
import { computeStructuralDiff } from '../src/diff.js';

describe('computeStructuralDiff', () => {
  const schema = {
    type: 'object',
    required: ['event', 'orderId', 'amount', 'amountPaise', 'utr', 'paymentId'],
    properties: {
      event: { type: 'string' },
      orderId: { type: 'string' },
      amount: { type: 'number' },
      amountPaise: { type: 'number' },
      utr: { type: 'string' },
      paymentId: { type: 'string' },
      metadata: {
        type: 'object',
        properties: {
          note: { type: 'string' },
        },
      },
    },
    additionalProperties: false,
  };

  it('returns empty diff for matching payload', () => {
    const payload = {
      event: 'payment.created',
      orderId: 'ord-123',
      amount: 1000,
      amountPaise: 100000,
      utr: 'UTR123456789012',
      paymentId: 'pay_123',
    };

    const diff = computeStructuralDiff(schema, payload);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.typeChanged).toEqual([]);
  });

  it('detects added keys not declared in schema.properties', () => {
    const payload = {
      event: 'payment.created',
      orderId: 'ord-123',
      amount: 1000,
      amountPaise: 100000,
      utr: 'UTR123456789012',
      paymentId: 'pay_123',
      currency: 'INR',
    };

    const diff = computeStructuralDiff(schema, payload);
    expect(diff.added).toContain('/currency');
  });

  it('detects removed keys that are required by schema', () => {
    const payload = {
      event: 'payment.created',
      orderId: 'ord-123',
      amount: 1000,
      amountPaise: 100000,
      // utr missing
      paymentId: 'pay_123',
    };

    const diff = computeStructuralDiff(schema, payload);
    expect(diff.removed).toContain('/utr');
  });

  it('detects typeChanged when declared type differs from payload JSON type', () => {
    const payload = {
      event: 'payment.created',
      orderId: 'ord-123',
      amount: '1000', // string instead of number
      amountPaise: 100000,
      utr: 'UTR123456789012',
      paymentId: 'pay_123',
    };

    const diff = computeStructuralDiff(schema, payload);
    expect(diff.typeChanged).toEqual([
      { path: '/amount', expected: 'number', actual: 'string' },
    ]);
  });

  it('accepts integer for number type without flagging typeChanged', () => {
    const payload = {
      event: 'payment.created',
      orderId: 'ord-123',
      amount: 42,
      amountPaise: 4200,
      utr: 'UTR123456789012',
      paymentId: 'pay_123',
    };

    const diff = computeStructuralDiff(schema, payload);
    expect(diff.typeChanged).toEqual([]);
  });

  it('descends into nested objects up to max depth 5', () => {
    const payload = {
      event: 'payment.created',
      orderId: 'ord-123',
      amount: 1000,
      amountPaise: 100000,
      utr: 'UTR123456789012',
      paymentId: 'pay_123',
      metadata: {
        note: 123, // expected string, got number
        extra: 'hello', // added
      },
    };

    const diff = computeStructuralDiff(schema, payload);
    expect(diff.added).toContain('/metadata/extra');
    expect(diff.typeChanged).toContainEqual({
      path: '/metadata/note',
      expected: 'string',
      actual: 'number',
    });
  });

  it('never leaks payload values into diff output', () => {
    const payload = {
      event: 'payment.created',
      orderId: 'ord-SECRET-123',
      amount: 'SECRET_AMOUNT',
      amountPaise: 100000,
      utr: 'SECRET_UTR',
      paymentId: 'SECRET_PAYMENT_ID',
      secretField: 'TOP_SECRET_VALUE',
    };

    const diff = computeStructuralDiff(schema, payload);
    const serialized = JSON.stringify(diff);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('TOP_SECRET_VALUE');
  });
});
