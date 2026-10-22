/**
 * packages/common/test/sse.test.js
 * Unit tests for changeToSseEvent (D34).
 * Verifies: all mappings, payload/headers/rawBodyHash never present, unknown → null.
 */

import { describe, it, expect } from 'vitest';
import { changeToSseEvent } from '../src/sse.js';

function makeEventChange(status, updatedFields = {}) {
  return {
    ns: { coll: 'events' },
    operationType: 'insert',
    fullDocument: {
      _id: 'evtid1',
      sourceSlug: 'sim-payments',
      eventType: 'payment.created',
      status,
      driftFingerprint: 'fp1',
      deliveryAttempts: 0,
      lastErrorCode: null,
      receivedAt: new Date('2024-01-01'),
      schemaVersion: 1,
      // These must never appear in output:
      payload: { secret: 'value' },
      headers: { authorization: 'Bearer tok' },
      rawBodyHash: 'abc123',
    },
    updateDescription: { updatedFields },
  };
}

function makeInsertEventChange() {
  const ch = makeEventChange('received');
  ch.operationType = 'insert';
  return ch;
}

function makeUpdateEventChange(newStatus) {
  const ch = makeEventChange(newStatus, { status: newStatus });
  ch.operationType = 'update';
  return ch;
}

function makeInsertProposalChange() {
  return {
    ns: { coll: 'proposals' },
    operationType: 'insert',
    fullDocument: {
      _id: 'propid1',
      status: 'pending_review',
      driftFingerprint: 'fp1',
      sourceId: 'srcid1',
      eventType: 'payment.created',
      aiUsed: true,
      affectedEventCount: 5,
      replayPassed: 3,
      replayTotal: 5,
      newSchemaVersion: null,
    },
    updateDescription: {},
  };
}

function makeUpdateProposalChange(newStatus, extraFields = {}) {
  return {
    ns: { coll: 'proposals' },
    operationType: 'update',
    fullDocument: {
      _id: 'propid1',
      status: newStatus,
      driftFingerprint: 'fp1',
      sourceId: 'srcid1',
      eventType: 'payment.created',
      aiUsed: true,
      affectedEventCount: 5,
      replayPassed: 5,
      replayTotal: 5,
      newSchemaVersion: 2,
      ...extraFields,
    },
    updateDescription: { updatedFields: { status: newStatus, ...extraFields } },
  };
}

describe('changeToSseEvent', () => {
  // ── Events insert ──────────────────────────────────────────────────────────
  it('events insert → event.received', () => {
    const result = changeToSseEvent(makeInsertEventChange());
    expect(result).not.toBeNull();
    expect(result.event).toBe('event.received');
    expect(result.data.id).toBe('evtid1');
    expect(result.data.sourceSlug).toBe('sim-payments');
    expect(result.data.status).toBe('received');
  });

  // ── Events status updates ──────────────────────────────────────────────────
  it.each([
    ['delivered', 'event.delivered'],
    ['quarantined', 'event.quarantined'],
    ['failed', 'event.failed'],
    ['dead', 'event.dead'],
    ['requeue_pending', 'event.requeue_pending'],
    ['processing', 'event.processing'],
  ])('events update status=%s → %s', (status, expectedEvent) => {
    const result = changeToSseEvent(makeUpdateEventChange(status));
    expect(result).not.toBeNull();
    expect(result.event).toBe(expectedEvent);
    expect(result.data.id).toBeDefined();
  });

  // ── Proposals ─────────────────────────────────────────────────────────────
  it('proposals insert → proposal.created', () => {
    const result = changeToSseEvent(makeInsertProposalChange());
    expect(result).not.toBeNull();
    expect(result.event).toBe('proposal.created');
    expect(result.data.id).toBe('propid1');
  });

  it('proposals status→approved → proposal.approved', () => {
    const result = changeToSseEvent(makeUpdateProposalChange('approved'));
    expect(result).not.toBeNull();
    expect(result.event).toBe('proposal.approved');
  });

  it('proposals status→rejected → proposal.rejected', () => {
    const result = changeToSseEvent(makeUpdateProposalChange('rejected'));
    expect(result).not.toBeNull();
    expect(result.event).toBe('proposal.rejected');
  });

  it('proposals editedByHuman set → proposal.edited', () => {
    const ch = makeUpdateProposalChange('pending_review', { editedByHuman: true });
    const result = changeToSseEvent(ch);
    expect(result).not.toBeNull();
    expect(result.event).toBe('proposal.edited');
  });

  // ── Payload / headers / rawBodyHash NEVER present ─────────────────────────
  it('event.received data never contains payload, headers, or rawBodyHash', () => {
    const result = changeToSseEvent(makeInsertEventChange());
    const str = JSON.stringify(result.data);
    expect(str).not.toContain('payload');
    expect(str).not.toContain('headers');
    expect(str).not.toContain('rawBodyHash');
    expect(str).not.toContain('secret');
    expect(str).not.toContain('Bearer');
  });

  it('event update data never contains payload, headers, or rawBodyHash', () => {
    const result = changeToSseEvent(makeUpdateEventChange('delivered'));
    const str = JSON.stringify(result.data);
    expect(str).not.toContain('payload');
    expect(str).not.toContain('headers');
    expect(str).not.toContain('rawBodyHash');
  });

  // ── Unknown / unsupported changes → null ──────────────────────────────────
  it('unknown collection → null', () => {
    const ch = makeInsertEventChange();
    ch.ns.coll = 'audit_log';
    expect(changeToSseEvent(ch)).toBeNull();
  });

  it('events update without status change → null', () => {
    const ch = makeUpdateEventChange('received');
    ch.updateDescription.updatedFields = { deliveryAttempts: 1 }; // no status change
    expect(changeToSseEvent(ch)).toBeNull();
  });

  it('proposals update without status or editedByHuman change → null', () => {
    const ch = makeUpdateProposalChange('pending_review');
    ch.updateDescription.updatedFields = { replayPassed: 3 }; // no relevant fields
    expect(changeToSseEvent(ch)).toBeNull();
  });

  // ── Data allow-list for proposals ─────────────────────────────────────────
  it('proposal.created data includes allow-list fields only', () => {
    const result = changeToSseEvent(makeInsertProposalChange());
    expect(result.data).toHaveProperty('id');
    expect(result.data).toHaveProperty('status');
    expect(result.data).toHaveProperty('driftFingerprint');
    expect(result.data).toHaveProperty('sourceId');
    expect(result.data).toHaveProperty('eventType');
    expect(result.data).toHaveProperty('aiUsed');
    expect(result.data).toHaveProperty('affectedEventCount');
  });
});
