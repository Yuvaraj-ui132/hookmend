import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { verify as verifyGithub } from '../../src/adapters/github.js';
import { verify as verifyGenericHmac } from '../../src/adapters/generic-hmac.js';

const SECRET = 'test-secret-key-for-unit-tests';

function sign(secret, data) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function signGenericHmac(secret, timestamp, rawBodyStr) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBodyStr}`).digest('hex');
}

// ─── GitHub Adapter ───────────────────────────────────────────────────────────

describe('github adapter', () => {
  const body = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }));
  const deliveryId = 'github-delivery-001';
  const eventType = 'push';

  function validHeaders(overrides = {}) {
    return {
      'x-hub-signature-256': sign(SECRET, body),
      'x-github-delivery': deliveryId,
      'x-github-event': eventType,
      'content-type': 'application/json',
      ...overrides,
    };
  }

  it('returns ok for valid signature', async () => {
    const result = await verifyGithub(body, validHeaders(), SECRET);
    expect(result.ok).toBe(true);
    expect(result.eventId).toBe(deliveryId);
    expect(result.eventType).toBe(eventType);
    expect(typeof result.timestamp).toBe('number');
    expect(result.error).toBeNull();
  });

  it('returns SIGNATURE_INVALID for wrong secret', async () => {
    const result = await verifyGithub(body, validHeaders(), 'wrong-secret');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('SIGNATURE_INVALID');
  });

  it('returns SIGNATURE_FORMAT for non-hex signature', async () => {
    const result = await verifyGithub(body, validHeaders({ 'x-hub-signature-256': 'sha256=GGGGGG' + 'a'.repeat(58) }), SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('SIGNATURE_FORMAT');
  });

  it('returns SIGNATURE_FORMAT for wrong length hex', async () => {
    const result = await verifyGithub(body, validHeaders({ 'x-hub-signature-256': 'sha256=' + 'a'.repeat(32) }), SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('SIGNATURE_FORMAT');
  });

  it('returns SIGNATURE_MISSING when x-hub-signature-256 absent', async () => {
    const h = validHeaders();
    delete h['x-hub-signature-256'];
    const result = await verifyGithub(body, h, SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('SIGNATURE_MISSING');
  });

  it('returns EVENT_ID_MISSING when x-github-delivery absent', async () => {
    const h = validHeaders();
    delete h['x-github-delivery'];
    const result = await verifyGithub(body, h, SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('EVENT_ID_MISSING');
  });
});

// ─── Generic HMAC Adapter ─────────────────────────────────────────────────────

describe('generic-hmac adapter', () => {
  const bodyObj = { event: 'payment.created', orderId: 'ord-001' };
  const body = Buffer.from(JSON.stringify(bodyObj));
  const deliveryId = 'delivery-001';

  function makeTimestamp(offsetMs = 0) {
    return String(Date.now() + offsetMs);
  }

  function validHeaders(ts, overrides = {}) {
    return {
      'x-gateway-signature': signGenericHmac(SECRET, ts, body.toString()),
      'x-gateway-timestamp': ts,
      'x-gateway-delivery-id': deliveryId,
      'content-type': 'application/json',
      ...overrides,
    };
  }

  it('returns ok for valid signature', async () => {
    const ts = makeTimestamp();
    const result = await verifyGenericHmac(body, validHeaders(ts), SECRET);
    expect(result.ok).toBe(true);
    expect(result.eventId).toBe(deliveryId);
    expect(result.eventType).toBeNull();
    expect(result.error).toBeNull();
  });

  it('returns SIGNATURE_INVALID for wrong secret', async () => {
    const ts = makeTimestamp();
    const result = await verifyGenericHmac(body, validHeaders(ts), 'wrong-secret');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('SIGNATURE_INVALID');
  });

  it('returns SIGNATURE_FORMAT for non-hex signature', async () => {
    const ts = makeTimestamp();
    const h = validHeaders(ts, { 'x-gateway-signature': 'sha256=GGGGGG' + 'a'.repeat(58) });
    const result = await verifyGenericHmac(body, h, SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('SIGNATURE_FORMAT');
  });

  it('returns SIGNATURE_FORMAT for wrong length hex', async () => {
    const ts = makeTimestamp();
    const h = validHeaders(ts, { 'x-gateway-signature': 'sha256=' + 'a'.repeat(32) });
    const result = await verifyGenericHmac(body, h, SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('SIGNATURE_FORMAT');
  });

  it('returns SIGNATURE_MISSING when x-gateway-signature absent', async () => {
    const ts = makeTimestamp();
    const h = validHeaders(ts);
    delete h['x-gateway-signature'];
    const result = await verifyGenericHmac(body, h, SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('SIGNATURE_MISSING');
  });

  it('returns TIMESTAMP_MISSING when x-gateway-timestamp absent', async () => {
    const ts = makeTimestamp();
    const h = validHeaders(ts);
    delete h['x-gateway-timestamp'];
    const result = await verifyGenericHmac(body, h, SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('TIMESTAMP_MISSING');
  });

  it('returns TIMESTAMP_INVALID for non-integer timestamp', async () => {
    const ts = 'not-a-number';
    const h = validHeaders(ts);
    const result = await verifyGenericHmac(body, h, SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('TIMESTAMP_INVALID');
  });

  it('returns EVENT_ID_MISSING when x-gateway-delivery-id absent', async () => {
    const ts = makeTimestamp();
    const h = validHeaders(ts);
    delete h['x-gateway-delivery-id'];
    const result = await verifyGenericHmac(body, h, SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('EVENT_ID_MISSING');
  });

  it('returns TIMESTAMP_STALE for too-old timestamp', async () => {
    const ts = makeTimestamp(-400_000); // 400 seconds ago
    const h = validHeaders(ts);
    const result = await verifyGenericHmac(body, h, SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('TIMESTAMP_STALE');
  });

  it('returns TIMESTAMP_STALE for far-future timestamp', async () => {
    const ts = makeTimestamp(400_000); // 400 seconds in future
    const h = validHeaders(ts);
    const result = await verifyGenericHmac(body, h, SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('TIMESTAMP_STALE');
  });

  it('returns SIGNATURE_INVALID when signature computed over body only (no timestamp)', async () => {
    const ts = makeTimestamp();
    // Sign without timestamp prefix — this must fail
    const badSig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    const h = validHeaders(ts, { 'x-gateway-signature': badSig });
    const result = await verifyGenericHmac(body, h, SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('SIGNATURE_INVALID');
  });
});
