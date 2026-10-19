import { describe, it, expect, vi } from 'vitest';
import {
  computeBackoff,
  classifyDeliveryResponse,
  deliverEvent,
} from '../src/delivery.js';

describe('computeBackoff', () => {
  it('computes exponential backoff min(2^attemptsMade * baseMs, maxMs)', () => {
    const base = 1000;
    const max = 30000;

    expect(computeBackoff(0, base, max)).toBe(1000); // 2^0 * 1000 = 1000
    expect(computeBackoff(1, base, max)).toBe(2000); // 2^1 * 1000 = 2000
    expect(computeBackoff(2, base, max)).toBe(4000); // 2^2 * 1000 = 4000
    expect(computeBackoff(5, base, max)).toBe(30000); // 32 * 1000 capped at 30000
  });
});

describe('classifyDeliveryResponse', () => {
  it('classifies 2xx as delivered', () => {
    expect(classifyDeliveryResponse(200)).toEqual({ delivered: true, retryable: false });
    expect(classifyDeliveryResponse(201)).toEqual({ delivered: true, retryable: false });
    expect(classifyDeliveryResponse(204)).toEqual({ delivered: true, retryable: false });
  });

  it('classifies 5xx, 408, 429 as retryable', () => {
    expect(classifyDeliveryResponse(500)).toEqual({ delivered: false, retryable: true });
    expect(classifyDeliveryResponse(502)).toEqual({ delivered: false, retryable: true });
    expect(classifyDeliveryResponse(503)).toEqual({ delivered: false, retryable: true });
    expect(classifyDeliveryResponse(408)).toEqual({ delivered: false, retryable: true });
    expect(classifyDeliveryResponse(429)).toEqual({ delivered: false, retryable: true });
  });

  it('classifies client errors other than 408 and 429 as non-retryable', () => {
    expect(classifyDeliveryResponse(400)).toEqual({ delivered: false, retryable: false });
    expect(classifyDeliveryResponse(401)).toEqual({ delivered: false, retryable: false });
    expect(classifyDeliveryResponse(404)).toEqual({ delivered: false, retryable: false });
    expect(classifyDeliveryResponse(422)).toEqual({ delivered: false, retryable: false });
  });
});

describe('deliverEvent', () => {
  it('delivers event payload to downstreamUrl with proper headers', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      status: 200,
    });

    const event = {
      eventId: 'evt_123',
      eventType: 'payment.created',
      payload: { amount: 1000 },
    };
    const source = {
      downstreamUrl: 'http://downstream.test/webhook',
    };

    const result = await deliverEvent({
      event,
      source,
      attempt: 1,
      fetch: fakeFetch,
      timeoutMs: 5000,
    });

    expect(result.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledWith(
      'http://downstream.test/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-hookmend-event-id': 'evt_123',
          'x-hookmend-event-type': 'payment.created',
          'x-hookmend-attempt': '1',
        }),
        body: JSON.stringify({ amount: 1000 }),
      })
    );
  });

  it('handles fetch network timeout as retryable error', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('fetch timeout'));

    const event = { eventId: 'evt_123', eventType: 'payment.created', payload: {} };
    const source = { downstreamUrl: 'http://downstream.test/webhook' };

    await expect(
      deliverEvent({
        event,
        source,
        attempt: 1,
        fetch: fakeFetch,
        timeoutMs: 5000,
      })
    ).rejects.toThrow();
  });
});
