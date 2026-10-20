/**
 * containment.test.js — Unit tests for Gemini AI output containment (D29)
 */

import { describe, it, expect } from 'vitest';
import { validateAiOutput } from '../src/containment.js';

const VALID_AI_OUTPUT = {
  proposedSchemaJson: JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['event', 'amount'],
    properties: {
      event: { type: 'string' },
      amount: { type: ['number', 'string'] },
      currency: { type: 'string' },
    },
    additionalProperties: false,
  }),
  fieldMappings: [{ from: '/amount', to: '/amount', note: 'type widened' }],
  confidence: 0.85,
  rationale: 'Amount field changed from number to string in observed payload; currency added.',
};

describe('validateAiOutput', () => {
  it('accepts valid output', () => {
    const result = validateAiOutput(VALID_AI_OUTPUT, [], 102400);
    expect(result.ok).toBe(true);
  });

  it('rejects non-JSON proposedSchemaJson', () => {
    const bad = { ...VALID_AI_OUTPUT, proposedSchemaJson: 'not json {{}' };
    const result = validateAiOutput(bad, [], 102400);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('rejects unknown top-level keys', () => {
    const bad = { ...VALID_AI_OUTPUT, extraKey: 'surprise' };
    const result = validateAiOutput(bad, [], 102400);
    expect(result.ok).toBe(false);
  });

  it('rejects schema that does not compile with Ajv', () => {
    const bad = {
      ...VALID_AI_OUTPUT,
      proposedSchemaJson: JSON.stringify({ type: 'INVALID_TYPE_NAME_XYZ' }),
    };
    const result = validateAiOutput(bad, [], 102400);
    expect(result.ok).toBe(false);
  });

  it('rejects $ref values starting with http', () => {
    const bad = {
      ...VALID_AI_OUTPUT,
      proposedSchemaJson: JSON.stringify({
        type: 'object',
        properties: { x: { $ref: 'https://example.com/schema.json' } },
      }),
    };
    const result = validateAiOutput(bad, [], 102400);
    expect(result.ok).toBe(false);
  });

  it('rejects oversized proposedSchemaJson', () => {
    const bigSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 5000 }, (_, i) => [`field_${i}`, { type: 'string' }])
      ),
    };
    const big = { ...VALID_AI_OUTPUT, proposedSchemaJson: JSON.stringify(bigSchema) };
    const result = validateAiOutput(big, [], 100); // max 100 bytes
    expect(result.ok).toBe(false);
  });

  it('rejects confidence out of range (>1)', () => {
    const bad = { ...VALID_AI_OUTPUT, confidence: 1.5 };
    const result = validateAiOutput(bad, [], 102400);
    expect(result.ok).toBe(false);
  });

  it('rejects confidence out of range (<0)', () => {
    const bad = { ...VALID_AI_OUTPUT, confidence: -0.1 };
    const result = validateAiOutput(bad, [], 102400);
    expect(result.ok).toBe(false);
  });

  it('rejects rationale > 1000 chars', () => {
    const bad = { ...VALID_AI_OUTPUT, rationale: 'x'.repeat(1001) };
    const result = validateAiOutput(bad, [], 102400);
    expect(result.ok).toBe(false);
  });

  it('rejects rationale leaking a payload value (string >= 4 chars)', () => {
    const sampleEventPayloads = [{ orderId: 'ORD-LEAK-9999', amount: 100 }];
    const bad = { ...VALID_AI_OUTPUT, rationale: 'The order ORD-LEAK-9999 was processed with drift.' };
    const result = validateAiOutput(bad, sampleEventPayloads, 102400);
    expect(result.ok).toBe(false);
  });

  it('rejects fieldMappings note leaking a payload value', () => {
    const sampleEventPayloads = [{ paymentId: 'PAY-SECRET-77' }];
    const bad = {
      ...VALID_AI_OUTPUT,
      fieldMappings: [{ from: '/paymentId', to: '/paymentId', note: 'field PAY-SECRET-77 was renamed' }],
    };
    const result = validateAiOutput(bad, sampleEventPayloads, 102400);
    expect(result.ok).toBe(false);
  });

  it('accepts $schema draft-07 in proposedSchemaJson', () => {
    const good = {
      ...VALID_AI_OUTPUT,
      proposedSchemaJson: JSON.stringify({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
      }),
    };
    const result = validateAiOutput(good, [], 102400);
    expect(result.ok).toBe(true);
  });

  it('rejects non-draft-07 $schema', () => {
    const bad = {
      ...VALID_AI_OUTPUT,
      proposedSchemaJson: JSON.stringify({
        $schema: 'http://json-schema.org/draft-06/schema#',
        type: 'object',
      }),
    };
    const result = validateAiOutput(bad, [], 102400);
    expect(result.ok).toBe(false);
  });
});
