/**
 * redact.test.js — Unit tests for schema redaction allow-list (D28)
 */

import { describe, it, expect } from 'vitest';
import { redactSchema } from '../src/redact.js';

describe('redactSchema', () => {
  it('keeps allowed keys: type, properties, required, items, additionalProperties, anyOf, oneOf, allOf, format', () => {
    const schema = {
      type: 'object',
      properties: {
        amount: { type: 'number', default: 0, description: 'The amount', minimum: 0 },
      },
      required: ['amount'],
      additionalProperties: false,
      title: 'My Schema',
      description: 'Should be removed',
      default: {},
      examples: [{}],
    };
    const result = redactSchema(schema);
    expect(result.type).toBe('object');
    expect(result.required).toEqual(['amount']);
    expect(result.additionalProperties).toBe(false);
    expect(result.title).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.default).toBeUndefined();
    expect(result.examples).toBeUndefined();
  });

  it('removes enum, const, default, description, pattern from nested property', () => {
    const schema = {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'inactive'],
          const: 'active',
          default: 'active',
          description: 'Remove me',
          pattern: '^[a-z]+$',
          title: 'Status',
        },
      },
    };
    const result = redactSchema(schema);
    const statusProp = result.properties.status;
    expect(statusProp.type).toBe('string');
    expect(statusProp.enum).toBeUndefined();
    expect(statusProp.const).toBeUndefined();
    expect(statusProp.default).toBeUndefined();
    expect(statusProp.description).toBeUndefined();
    expect(statusProp.pattern).toBeUndefined();
    expect(statusProp.title).toBeUndefined();
  });

  it('recursively redacts nested properties', () => {
    const schema = {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          description: 'Nested',
          properties: {
            ref: { type: 'string', default: 'foo', description: 'Remove' },
          },
        },
      },
    };
    const result = redactSchema(schema);
    expect(result.properties.meta.description).toBeUndefined();
    expect(result.properties.meta.properties.ref.description).toBeUndefined();
    expect(result.properties.meta.properties.ref.default).toBeUndefined();
    expect(result.properties.meta.properties.ref.type).toBe('string');
  });

  it('redacts items schemas (array type)', () => {
    const schema = {
      type: 'array',
      items: {
        type: 'string',
        description: 'Remove me',
        enum: ['a', 'b'],
      },
    };
    const result = redactSchema(schema);
    expect(result.items.type).toBe('string');
    expect(result.items.description).toBeUndefined();
    expect(result.items.enum).toBeUndefined();
  });

  it('handles anyOf, oneOf, allOf arrays', () => {
    const schema = {
      anyOf: [
        { type: 'string', description: 'Remove' },
        { type: 'number', default: 0 },
      ],
    };
    const result = redactSchema(schema);
    expect(result.anyOf[0].type).toBe('string');
    expect(result.anyOf[0].description).toBeUndefined();
    expect(result.anyOf[1].default).toBeUndefined();
  });

  it('no payload value appears in the redacted schema', () => {
    const schema = {
      type: 'object',
      properties: {
        secretField: {
          type: 'string',
          // If somehow a value snuck in via default/example, it should be removed
          default: 'actual_secret_value_12345',
          examples: ['secret_value_67890'],
        },
      },
    };
    const result = redactSchema(schema);
    const str = JSON.stringify(result);
    expect(str).not.toContain('actual_secret_value_12345');
    expect(str).not.toContain('secret_value_67890');
  });
});
