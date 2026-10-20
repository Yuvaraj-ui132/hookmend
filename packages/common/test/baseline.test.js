/**
 * baseline.test.js — Unit tests for buildBaselineSchema and buildBreakingChanges (D21, D22)
 */

import { describe, it, expect } from 'vitest';
import { buildBaselineSchema, buildBreakingChanges } from '../src/baseline.js';
import Ajv from 'ajv';

const BASE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['event', 'orderId', 'amount', 'utr'],
  properties: {
    event: { type: 'string' },
    orderId: { type: 'string' },
    amount: { type: 'number' },
    utr: { type: 'string' },
  },
  additionalProperties: false,
};

describe('buildBaselineSchema', () => {
  it('added field: adds property without adding to required', () => {
    const diff = { added: ['/currency'], removed: [], typeChanged: [] };
    const { schema, applied, skipped } = buildBaselineSchema(BASE_SCHEMA, diff);
    expect(schema.properties.currency).toBeDefined();
    expect(schema.required).not.toContain('currency');
    expect(applied).toContain('/currency');
    expect(skipped).toHaveLength(0);
  });

  it('removed field: removes from required but keeps property declaration', () => {
    const diff = { added: [], removed: ['/utr'], typeChanged: [] };
    const { schema, applied, skipped } = buildBaselineSchema(BASE_SCHEMA, diff);
    expect(schema.required).not.toContain('utr');
    expect(schema.properties.utr).toBeDefined();
    expect(applied).toContain('/utr');
    expect(skipped).toHaveLength(0);
  });

  it('typeChanged field: makes type a sorted union', () => {
    const diff = { added: [], removed: [], typeChanged: [{ path: '/amount', from: 'number', to: 'string' }] };
    const { schema, applied, skipped } = buildBaselineSchema(BASE_SCHEMA, diff);
    const amountType = schema.properties.amount.type;
    expect(Array.isArray(amountType)).toBe(true);
    expect(amountType).toContain('number');
    expect(amountType).toContain('string');
    expect(applied).toContain('/amount');
    expect(skipped).toHaveLength(0);
  });

  it('typeChanged: if already union, merges uniquely and sorts', () => {
    const baseWithUnion = {
      ...BASE_SCHEMA,
      properties: {
        ...BASE_SCHEMA.properties,
        amount: { type: ['number', 'string'] },
      },
    };
    const diff = { added: [], removed: [], typeChanged: [{ path: '/amount', from: 'number', to: 'integer' }] };
    const { schema } = buildBaselineSchema(baseWithUnion, diff);
    const amountType = schema.properties.amount.type;
    const sorted = [...amountType].sort();
    expect(amountType).toEqual(sorted);
    // no duplicates
    const unique = [...new Set(amountType)];
    expect(amountType).toHaveLength(unique.length);
  });

  it('nested path: walks into nested object schema properties', () => {
    const nestedBase = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['meta'],
      properties: {
        meta: {
          type: 'object',
          required: ['ref'],
          properties: {
            ref: { type: 'string' },
          },
        },
      },
    };
    const diff = { added: ['/meta/newField'], removed: [], typeChanged: [] };
    const { schema, applied, skipped } = buildBaselineSchema(nestedBase, diff);
    expect(schema.properties.meta.properties.newField).toBeDefined();
    expect(applied).toContain('/meta/newField');
    expect(skipped).toHaveLength(0);
  });

  it('unresolved path: adds to skipped', () => {
    const diff = { added: ['/nonExistentParent/child'], removed: [], typeChanged: [] };
    const { schema, applied, skipped } = buildBaselineSchema(BASE_SCHEMA, diff);
    expect(skipped).toContain('/nonExistentParent/child');
    expect(applied).not.toContain('/nonExistentParent/child');
  });

  it('empty diff (no structural changes): returns null proposedSchema', () => {
    const diff = { added: [], removed: [], typeChanged: [] };
    const { schema } = buildBaselineSchema(BASE_SCHEMA, diff);
    expect(schema).toBeNull();
  });

  it('preserves $schema key', () => {
    const diff = { added: ['/currency'], removed: [], typeChanged: [] };
    const { schema } = buildBaselineSchema(BASE_SCHEMA, diff);
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
  });

  it('does not mutate the original schema', () => {
    const original = JSON.parse(JSON.stringify(BASE_SCHEMA));
    const diff = { added: ['/currency'], removed: [], typeChanged: [] };
    buildBaselineSchema(BASE_SCHEMA, diff);
    expect(BASE_SCHEMA).toEqual(original);
  });

  it('original-shape payload still validates against the result (backward compat)', () => {
    // drift: amount -> string, utr removed, currency added
    const diff = {
      added: ['/currency'],
      removed: ['/utr'],
      typeChanged: [{ path: '/amount', from: 'number', to: 'string' }],
    };
    const { schema } = buildBaselineSchema(BASE_SCHEMA, diff);
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    // Original shape: amount is number, utr present, no currency
    const originalPayload = { event: 'payment.created', orderId: 'ord1', amount: 100.5, utr: 'UTR123' };
    const valid = validate(originalPayload);
    expect(valid).toBe(true);
  });
});

describe('buildBreakingChanges', () => {
  it('required field removed => required_field_removed', () => {
    const diff = { added: [], removed: ['/utr'], typeChanged: [] };
    const changes = buildBreakingChanges(BASE_SCHEMA, diff);
    expect(changes).toContainEqual({ path: '/utr', kind: 'required_field_removed' });
  });

  it('non-required field removed => not breaking', () => {
    const baseWithOptional = {
      ...BASE_SCHEMA,
      properties: { ...BASE_SCHEMA.properties, notes: { type: 'string' } },
    };
    const diff = { added: [], removed: ['/notes'], typeChanged: [] };
    const changes = buildBreakingChanges(baseWithOptional, diff);
    expect(changes).toHaveLength(0);
  });

  it('typeChanged => type_changed', () => {
    const diff = { added: [], removed: [], typeChanged: [{ path: '/amount', from: 'number', to: 'string' }] };
    const changes = buildBreakingChanges(BASE_SCHEMA, diff);
    expect(changes).toContainEqual({ path: '/amount', kind: 'type_changed' });
  });

  it('added field => not breaking', () => {
    const diff = { added: ['/currency'], removed: [], typeChanged: [] };
    const changes = buildBreakingChanges(BASE_SCHEMA, diff);
    expect(changes).toHaveLength(0);
  });

  it('combined: required removed + type changed', () => {
    const diff = {
      added: ['/currency'],
      removed: ['/utr'],
      typeChanged: [{ path: '/amount', from: 'number', to: 'string' }],
    };
    const changes = buildBreakingChanges(BASE_SCHEMA, diff);
    expect(changes).toContainEqual({ path: '/utr', kind: 'required_field_removed' });
    expect(changes).toContainEqual({ path: '/amount', kind: 'type_changed' });
    const currencyChange = changes.find(c => c.path === '/currency');
    expect(currencyChange).toBeUndefined();
  });
});
