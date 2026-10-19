import { describe, it, expect } from 'vitest';
import { computeFingerprint } from '../src/fingerprint.js';

describe('computeFingerprint', () => {
  const baseInput = {
    sourceId: 'src_01',
    eventType: 'payment.created',
    baseSchemaVersion: 1,
    diff: {
      added: ['/currency'],
      removed: ['/utr'],
      typeChanged: [{ path: '/amount', expected: 'number', actual: 'string' }],
    },
    violations: [{ path: '/amount', keyword: 'type' }],
  };

  it('produces a 64-character hex sha256 hash', () => {
    const hash = computeFingerprint(baseInput);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable regardless of object key order or array order', () => {
    const hash1 = computeFingerprint(baseInput);

    const reorderedInput = {
      baseSchemaVersion: 1,
      eventType: 'payment.created',
      sourceId: 'src_01',
      violations: [{ keyword: 'type', path: '/amount' }],
      diff: {
        typeChanged: [{ actual: 'string', path: '/amount', expected: 'number' }],
        removed: ['/utr'],
        added: ['/currency'],
      },
    };

    const hash2 = computeFingerprint(reorderedInput);
    expect(hash1).toBe(hash2);
  });

  it('produces different hash for different sourceId', () => {
    const hash1 = computeFingerprint(baseInput);
    const hash2 = computeFingerprint({ ...baseInput, sourceId: 'src_02' });
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hash for different eventType', () => {
    const hash1 = computeFingerprint(baseInput);
    const hash2 = computeFingerprint({ ...baseInput, eventType: 'payment.refunded' });
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hash for different baseSchemaVersion', () => {
    const hash1 = computeFingerprint(baseInput);
    const hash2 = computeFingerprint({ ...baseInput, baseSchemaVersion: 2 });
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hash for different diff or violations', () => {
    const hash1 = computeFingerprint(baseInput);
    const hash2 = computeFingerprint({
      ...baseInput,
      diff: { ...baseInput.diff, added: ['/currency', '/extra'] },
    });
    expect(hash1).not.toBe(hash2);
  });

  it('includes violations when structural diff is empty (e.g. enum/minimum violation)', () => {
    const inputWithoutDiff = {
      sourceId: 'src_01',
      eventType: 'payment.created',
      baseSchemaVersion: 1,
      diff: { added: [], removed: [], typeChanged: [] },
      violations: [{ path: '/status', keyword: 'enum' }],
    };
    const hash = computeFingerprint(inputWithoutDiff);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const differentViolation = computeFingerprint({
      ...inputWithoutDiff,
      violations: [{ path: '/amount', keyword: 'minimum' }],
    });
    expect(hash).not.toBe(differentViolation);
  });
});
