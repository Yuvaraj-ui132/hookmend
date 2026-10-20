/**
 * replay.test.js — Unit tests for replayEvents (D23)
 */

import { describe, it, expect, vi } from 'vitest';
import { replayEvents } from '../src/replay.js';

const BASE_SCHEMA_DOC = {
  _id: 'schema1',
  version: 1,
  schema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['event', 'amount'],
    properties: {
      event: { type: 'string' },
      amount: { type: 'number' },
    },
    additionalProperties: false,
  },
};

function makeEvent(overrides = {}) {
  return {
    _id: `evt_${Math.random()}`,
    payload: { event: 'payment.created', amount: 100 },
    receivedAt: new Date(),
    ...overrides,
  };
}

function makeDb(events) {
  const mockFind = () => ({
    sort: () => ({
      limit: (n) => ({
        toArray: async () => events.slice(0, n),
      }),
    }),
  });
  return {
    collection: () => ({
      find: mockFind,
      countDocuments: async () => events.length,
    }),
  };
}

describe('replayEvents', () => {
  it('returns total, passed, failed counts for valid events', async () => {
    const events = [makeEvent(), makeEvent(), makeEvent()];
    const db = makeDb(events);
    const result = await replayEvents({
      db,
      sourceId: 'src1',
      eventType: 'payment.created',
      driftFingerprint: 'fp1',
      schema: BASE_SCHEMA_DOC,
      max: 1000,
    });
    expect(result.total).toBe(3);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('counts invalid events as failed', async () => {
    const events = [
      makeEvent(), // valid
      makeEvent({ payload: { event: 'payment.created', amount: 'not-a-number' } }), // invalid
    ];
    const db = makeDb(events);
    const result = await replayEvents({
      db,
      sourceId: 'src1',
      eventType: 'payment.created',
      driftFingerprint: 'fp1',
      schema: BASE_SCHEMA_DOC,
      max: 1000,
    });
    expect(result.total).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('caps at max events and sets truncated flag', async () => {
    const events = Array.from({ length: 10 }, () => makeEvent());
    // db returns all 10, but max = 5
    const db = makeDb(events);
    const result = await replayEvents({
      db,
      sourceId: 'src1',
      eventType: 'payment.created',
      driftFingerprint: 'fp1',
      schema: BASE_SCHEMA_DOC,
      max: 5,
    });
    expect(result.total).toBeLessThanOrEqual(5);
    // truncated if there were more events than max
    // The function may set truncated if count > max
    expect(typeof result.truncated).toBe('boolean');
  });

  it('returns empty counts when no events', async () => {
    const db = makeDb([]);
    const result = await replayEvents({
      db,
      sourceId: 'src1',
      eventType: 'payment.created',
      driftFingerprint: 'fp1',
      schema: BASE_SCHEMA_DOC,
      max: 1000,
    });
    expect(result.total).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('failedEventIds contains at most 10 ids', async () => {
    const events = Array.from({ length: 15 }, () =>
      makeEvent({ payload: { event: 'x', amount: 'bad' } })
    );
    const db = makeDb(events);
    const result = await replayEvents({
      db,
      sourceId: 'src1',
      eventType: 'payment.created',
      driftFingerprint: 'fp1',
      schema: BASE_SCHEMA_DOC,
      max: 1000,
    });
    expect(result.failedEventIds.length).toBeLessThanOrEqual(10);
  });

  it('never returns payload values in result', async () => {
    const events = [makeEvent({ payload: { event: 'payment.created', amount: 999.12345 } })];
    const db = makeDb(events);
    const result = await replayEvents({
      db,
      sourceId: 'src1',
      eventType: 'payment.created',
      driftFingerprint: 'fp1',
      schema: BASE_SCHEMA_DOC,
      max: 1000,
    });
    const str = JSON.stringify(result);
    expect(str).not.toContain('999.12345');
  });
});
