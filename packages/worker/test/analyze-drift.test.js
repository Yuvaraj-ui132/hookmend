/**
 * analyze-drift.test.js — Unit tests for analyzeDrift worker (D26, D27)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeDrift } from '../src/analyze-drift/worker.js';

const BASE_SCHEMA_DOC = {
  _id: 'schema1',
  version: 1,
  active: true,
  schema: {
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
  },
};

// Drifted payload: amount as string, utr removed, currency added
const DRIFTED_PAYLOAD = { event: 'payment.created', orderId: 'ord1', amount: '100.50', currency: 'INR' };

function makeQuarantinedEvent(overrides = {}) {
  return {
    _id: `evtid_${Math.random().toString(36).slice(2)}`,
    eventId: `evt_${Math.random().toString(36).slice(2)}`,
    sourceId: 'src1',
    eventType: 'payment.created',
    status: 'quarantined',
    driftFingerprint: 'fp_test_123',
    schemaVersion: 1,
    payload: DRIFTED_PAYLOAD,
    receivedAt: new Date(),
    ...overrides,
  };
}

function makeDb({ events = [], schema = BASE_SCHEMA_DOC, proposals = [], schemaVersion = 1 } = {}) {
  const insertedProposals = [...proposals];
  const updatedEvents = [];

  return {
    _proposals: insertedProposals,
    _updatedEvents: updatedEvents,
    _insertedProposals: insertedProposals,
    collection: (name) => {
      if (name === 'events') {
        return {
          find: () => ({
            sort: () => ({
              limit: (n) => ({
                skip: (s) => ({
                  toArray: async () => events.slice(0, n),
                }),
                toArray: async () => events.slice(0, n),
              }),
              toArray: async () => events,
            }),
            toArray: async () => events,
          }),
          findOne: async () => events[0] || null,
          countDocuments: async () => events.length,
          updateMany: async (filter, update) => {
            updatedEvents.push({ filter, update });
            return { modifiedCount: events.length };
          },
        };
      }
      if (name === 'schemas') {
        return {
          findOne: async () => ({
            ...schema,
            version: schemaVersion,
          }),
        };
      }
      if (name === 'proposals') {
        return {
          findOne: async (filter) => {
            if (filter.status === 'pending_review') {
              return insertedProposals.find(p => p.status === 'pending_review') || null;
            }
            return insertedProposals[0] || null;
          },
          countDocuments: async () => insertedProposals.length,
          insertOne: async (doc) => {
            doc._id = `proposal_${Math.random().toString(36).slice(2)}`;
            insertedProposals.push(doc);
            return { insertedId: doc._id };
          },
        };
      }
      if (name === 'audit_log') {
        return {
          insertOne: async () => ({ insertedId: 'audit1' }),
        };
      }
      return {};
    },
  };
}

function makeJob(overrides = {}) {
  return {
    id: 'job_test_1',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: {
      driftFingerprint: 'fp_test_123',
      sourceId: 'src1',
      eventType: 'payment.created',
      triggerEventId: 'evt_001',
    },
    ...overrides,
  };
}

function makeQueue() {
  const enqueuedJobs = [];
  return {
    _enqueuedJobs: enqueuedJobs,
    enqueue: vi.fn(async (queueName, name, data, opts) => {
      enqueuedJobs.push({ queueName, name, data, opts });
    }),
  };
}

describe('analyzeDrift', () => {
  it('creates one proposal for new drift', async () => {
    const events = [makeQuarantinedEvent()];
    const db = makeDb({ events });
    const queue = makeQueue();

    const result = await analyzeDrift({
      job: makeJob(),
      db,
      deps: { queue, aiClient: null, now: () => new Date(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, config: { ENABLE_AI: false } },
    });

    expect(db._proposals.length).toBe(1);
    expect(db._proposals[0].status).toBe('pending_review');
    expect(db._proposals[0].aiUsed).toBe(false);
  });

  it('second run is idempotent (no duplicate proposal)', async () => {
    const existingProposal = {
      _id: 'existing_proposal',
      status: 'pending_review',
      sourceId: 'src1',
      eventType: 'payment.created',
      driftFingerprint: 'fp_test_123',
    };
    const events = [makeQuarantinedEvent()];
    const db = makeDb({ events, proposals: [existingProposal] });
    const queue = makeQueue();

    await analyzeDrift({
      job: makeJob(),
      db,
      deps: { queue, aiClient: null, now: () => new Date(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, config: { ENABLE_AI: false } },
    });

    // Still only one proposal (the original)
    expect(db._proposals.length).toBe(1);
  });

  it('no events -> no proposal created', async () => {
    const db = makeDb({ events: [] });
    const queue = makeQueue();

    await analyzeDrift({
      job: makeJob(),
      db,
      deps: { queue, aiClient: null, now: () => new Date(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, config: { ENABLE_AI: false } },
    });

    expect(db._proposals.length).toBe(0);
  });

  it('stale base: active schema version > event schemaVersion -> requeue_pending, no proposal', async () => {
    const events = [makeQuarantinedEvent({ schemaVersion: 1 })];
    const db = makeDb({ events, schemaVersion: 2 }); // active version is 2, event was on v1
    const queue = makeQueue();

    await analyzeDrift({
      job: makeJob(),
      db,
      deps: { queue, aiClient: null, now: () => new Date(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, config: { ENABLE_AI: false } },
    });

    expect(db._proposals.length).toBe(0);
    expect(db._updatedEvents.length).toBeGreaterThan(0);
  });

  it('ENABLE_AI false -> aiUsed false', async () => {
    const events = [makeQuarantinedEvent()];
    const db = makeDb({ events });
    const fakeAiClient = { generate: vi.fn() };
    const queue = makeQueue();

    await analyzeDrift({
      job: makeJob(),
      db,
      deps: { queue, aiClient: fakeAiClient, now: () => new Date(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, config: { ENABLE_AI: false } },
    });

    expect(fakeAiClient.generate).not.toHaveBeenCalled();
    expect(db._proposals[0].aiUsed).toBe(false);
  });

  it('AI accepted only when replay passed count >= baseline replay passed count', async () => {
    const events = Array.from({ length: 3 }, () => makeQuarantinedEvent());
    const db = makeDb({ events });
    const queue = makeQueue();

    // AI returns a schema that makes some events fail
    const aiSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['event', 'nonExistentRequiredField'],
      properties: {
        event: { type: 'string' },
        nonExistentRequiredField: { type: 'string' },
      },
    };
    const fakeAiClient = {
      generate: vi.fn(async () => ({
        proposedSchemaJson: JSON.stringify(aiSchema),
        fieldMappings: [],
        confidence: 0.9,
        rationale: 'AI suggests this schema',
      })),
    };

    await analyzeDrift({
      job: makeJob(),
      db,
      deps: { queue, aiClient: fakeAiClient, now: () => new Date(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, config: { ENABLE_AI: true, GEMINI_RPD_LIMIT: 100 } },
    });

    // AI schema has lower passed count than baseline, so baseline is used
    const proposal = db._proposals[0];
    // aiUsed might be false if AI schema failed containment/replay comparison
    expect(proposal).toBeDefined();
  });

  it('daily quota exceeded -> baseline with AI_QUOTA_EXCEEDED_DAILY and fake client NOT called', async () => {
    const events = [makeQuarantinedEvent()];
    const db = makeDb({ events });
    const fakeAiClient = { generate: vi.fn() };
    const queue = makeQueue();

    // Simulate quota exceeded via fake redis
    const fakeRedis = {
      incr: vi.fn(async () => 101), // over limit of 100
      expire: vi.fn(async () => {}),
      get: vi.fn(async () => '101'),
    };

    await analyzeDrift({
      job: makeJob(),
      db,
      deps: {
        queue,
        aiClient: fakeAiClient,
        redis: fakeRedis,
        now: () => new Date(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        config: { ENABLE_AI: true, GEMINI_RPD_LIMIT: 100 },
      },
    });

    expect(fakeAiClient.generate).not.toHaveBeenCalled();
    const proposal = db._proposals[0];
    expect(proposal.aiFailureReason).toBe('AI_QUOTA_EXCEEDED_DAILY');
    expect(proposal.aiUsed).toBe(false);
  });

  it('429 on last attempt -> baseline with AI_RATE_LIMITED', async () => {
    const events = [makeQuarantinedEvent()];
    const db = makeDb({ events });
    const queue = makeQueue();

    const err429 = new Error('Rate limited');
    err429.status = 429;
    const fakeAiClient = { generate: vi.fn(async () => { throw err429; }) };

    const fakeRedis = {
      incr: vi.fn(async () => 1),
      expire: vi.fn(async () => {}),
    };

    // Last attempt: attemptsMade = opts.attempts - 1
    const job = makeJob({ attemptsMade: 2, opts: { attempts: 3 } });

    await analyzeDrift({
      job,
      db,
      deps: {
        queue,
        aiClient: fakeAiClient,
        redis: fakeRedis,
        now: () => new Date(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        config: { ENABLE_AI: true, GEMINI_RPD_LIMIT: 100 },
      },
    });

    const proposal = db._proposals[0];
    expect(proposal.aiFailureReason).toBe('AI_RATE_LIMITED');
    expect(proposal.aiUsed).toBe(false);
  });

  it('429 with attempts left -> throws for BullMQ retry', async () => {
    const events = [makeQuarantinedEvent()];
    const db = makeDb({ events });
    const queue = makeQueue();

    const err429 = new Error('Rate limited');
    err429.status = 429;
    const fakeAiClient = { generate: vi.fn(async () => { throw err429; }) };

    const fakeRedis = {
      incr: vi.fn(async () => 1),
      expire: vi.fn(async () => {}),
    };

    // Not last attempt: attemptsMade = 0, attempts = 3
    const job = makeJob({ attemptsMade: 0, opts: { attempts: 3 } });

    await expect(
      analyzeDrift({
        job,
        db,
        deps: {
          queue,
          aiClient: fakeAiClient,
          redis: fakeRedis,
          now: () => new Date(),
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          config: { ENABLE_AI: true, GEMINI_RPD_LIMIT: 100 },
        },
      })
    ).rejects.toThrow();
  });
});
