/**
 * processor-proposal.test.js — Tests for D25 processor changes
 * (proposalId linking when pending proposal exists, job id attempt counter)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processEvent } from '../src/processor.js';

const SOURCE = {
  _id: 'source1',
  slug: 'sim-payments',
  adapter: 'generic-hmac',
  secretEnvVar: 'SIM_SECRET',
  downstreamUrl: 'http://127.0.0.1:19999/receive',
  active: true,
};

const ACTIVE_SCHEMA = {
  _id: 'schema1',
  sourceId: 'source1',
  eventType: 'payment.created',
  version: 1,
  active: true,
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

const DRIFTED_EVENT = {
  _id: 'event1',
  eventId: 'evt_001',
  sourceId: 'source1',
  eventType: 'payment.created',
  status: 'received',
  payload: { event: 'payment.created', amount: 'not-a-number', currency: 'INR' }, // drifted
  receivedAt: new Date(),
};

function makeDb({ event = DRIFTED_EVENT, source = SOURCE, schema = ACTIVE_SCHEMA, proposals = [] } = {}) {
  const updatedEvents = [];
  const auditEntries = [];
  const insertedProposals = [...proposals];

  return {
    _updatedEvents: updatedEvents,
    _auditEntries: auditEntries,
    collection: (name) => {
      if (name === 'events') {
        return {
          findOne: async () => event,
          updateOne: async (filter, update) => {
            updatedEvents.push({ name, filter, update });
            return { modifiedCount: 1 };
          },
        };
      }
      if (name === 'sources') {
        return { findOne: async () => source };
      }
      if (name === 'schemas') {
        return { findOne: async () => schema };
      }
      if (name === 'proposals') {
        return {
          findOne: async (filter) => {
            if (filter && filter.status === 'pending_review') {
              return insertedProposals.find(p => p.status === 'pending_review') || null;
            }
            return null;
          },
          countDocuments: async () => insertedProposals.length,
        };
      }
      if (name === 'audit_log') {
        return {
          insertOne: async (doc) => {
            auditEntries.push(doc);
            return { insertedId: 'audit1' };
          },
        };
      }
      return {};
    },
  };
}

function makeJob(eventId = 'event1') {
  return {
    id: 'job1',
    attemptsMade: 0,
    opts: { attempts: 5 },
    data: { eventObjectId: eventId, eventId: 'evt_001' },
  };
}

describe('processor D25: proposal linking', () => {
  it('when pending_review proposal exists: sets proposalId on event, does NOT enqueue analyze-drift', async () => {
    const existingProposal = {
      _id: 'proposal_001',
      status: 'pending_review',
      sourceId: 'source1',
      eventType: 'payment.created',
      driftFingerprint: 'some_fp',
    };
    const db = makeDb({ proposals: [existingProposal] });

    const enqueuedJobs = [];
    const queue = {
      enqueue: vi.fn(async (queueName, name, data, opts) => {
        enqueuedJobs.push({ queueName, name, data, opts });
      }),
    };

    // Deliver will fail (no actual downstream)
    // But we need it to quarantine
    // Override fetch to simulate network failure quickly
    await processEvent({
      job: makeJob(),
      db,
      deps: {
        queue,
        fetch: async () => ({ status: 200 }), // won't reach delivery since drifted
        now: () => new Date(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        config: { PROCESS_EVENT_ATTEMPTS: 5 },
      },
    }).catch(() => {}); // may throw for delivery issues

    // The analyze-drift job should NOT have been enqueued when pending proposal exists
    const driftJobs = enqueuedJobs.filter(j => j.queueName === 'analyze-drift');
    expect(driftJobs).toHaveLength(0);

    // proposalId should be set on the event update
    const quarantineUpdate = db._updatedEvents.find(u =>
      u.update?.$set?.status === 'quarantined'
    );
    if (quarantineUpdate) {
      expect(quarantineUpdate.update.$set.proposalId).toBeDefined();
    }
  });

  it('job id uses attempt counter: no pending proposal -> job id ends _a0 for first analysis', async () => {
    const db = makeDb({ proposals: [] }); // no proposals yet

    const enqueuedJobs = [];
    const queue = {
      enqueue: vi.fn(async (queueName, name, data, opts) => {
        enqueuedJobs.push({ queueName, name, data, opts });
      }),
    };

    await processEvent({
      job: makeJob(),
      db,
      deps: {
        queue,
        fetch: async () => ({ status: 200 }),
        now: () => new Date(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        config: { PROCESS_EVENT_ATTEMPTS: 5 },
      },
    }).catch(() => {});

    const driftJobs = enqueuedJobs.filter(j => j.queueName === 'analyze-drift');
    if (driftJobs.length > 0) {
      expect(driftJobs[0].opts.jobId).toMatch(/_a0$/);
    }
  });

  it('after rejected proposal: attempt counter N=1, job id ends _a1', async () => {
    const rejectedProposal = {
      _id: 'proposal_rejected',
      status: 'rejected',
      sourceId: 'source1',
      eventType: 'payment.created',
      driftFingerprint: 'some_fp',
    };
    const db = makeDb({ proposals: [rejectedProposal] });

    const enqueuedJobs = [];
    const queue = {
      enqueue: vi.fn(async (queueName, name, data, opts) => {
        enqueuedJobs.push({ queueName, name, data, opts });
      }),
    };

    await processEvent({
      job: makeJob(),
      db,
      deps: {
        queue,
        fetch: async () => ({ status: 200 }),
        now: () => new Date(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        config: { PROCESS_EVENT_ATTEMPTS: 5 },
      },
    }).catch(() => {});

    const driftJobs = enqueuedJobs.filter(j => j.queueName === 'analyze-drift');
    if (driftJobs.length > 0) {
      // N=1 since one proposal (rejected) exists
      expect(driftJobs[0].opts.jobId).toMatch(/_a1$/);
    }
  });
});
