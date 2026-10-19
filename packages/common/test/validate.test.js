import { describe, it, expect } from 'vitest';
import { validatePayload } from '../src/validate.js';

describe('validatePayload', () => {
  const schemaDoc = {
    _id: 'schema_123',
    version: 1,
    schema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['event', 'amount'],
      properties: {
        event: { type: 'string' },
        amount: { type: 'number', minimum: 1 },
      },
      additionalProperties: false,
    },
  };

  it('returns valid: true and empty errors for conforming payload', () => {
    const payload = { event: 'payment.created', amount: 100 };
    const result = validatePayload(schemaDoc, payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('returns valid: false and standardized error list for non-conforming payload', () => {
    const payload = { event: 'payment.created', amount: 'not-a-number' };
    const result = validatePayload(schemaDoc, payload);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toHaveProperty('path');
    expect(result.errors[0]).toHaveProperty('keyword');
  });

  it('never leaks payload values or raw schema definitions in errors', () => {
    const payload = {
      event: 'SECRET_EVENT_TYPE',
      amount: 'SECRET_PAYLOAD_VALUE_9999',
    };
    const result = validatePayload(schemaDoc, payload);
    const serialized = JSON.stringify(result.errors);
    expect(serialized).not.toContain('SECRET_PAYLOAD_VALUE');
    expect(serialized).not.toContain('SECRET_EVENT_TYPE');
  });

  it('caps validation errors to max 20 items', () => {
    const schemaWithManyFields = {
      _id: 'schema_many',
      version: 1,
      schema: {
        type: 'object',
        required: Array.from({ length: 30 }, (_, i) => `field_${i}`),
      },
    };
    const result = validatePayload(schemaWithManyFields, {});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeLessThanOrEqual(20);
  });
});
