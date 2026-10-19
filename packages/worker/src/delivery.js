/**
 * delivery.js — Downstream HTTP webhook delivery.
 *
 * D12: global fetch, POST JSON of event.payload, AbortSignal.timeout.
 * Headers: content-type, x-hookmend-event-id, x-hookmend-event-type, x-hookmend-attempt.
 * 2xx = delivered; 5xx, 408, 429, network error = retryable; any other 4xx = non-retryable.
 */

/**
 * Computes exponential backoff: min(2^attemptsMade * baseMs, maxMs)
 *
 * @param {number} attemptsMade
 * @param {number} baseMs
 * @param {number} maxMs
 * @returns {number}
 */
export function computeBackoff(attemptsMade, baseMs = 1000, maxMs = 30000) {
  const delay = Math.pow(2, attemptsMade) * baseMs;
  return Math.min(delay, maxMs);
}

/**
 * Classifies HTTP response status code.
 *
 * @param {number} status
 * @returns {{ delivered: boolean, retryable: boolean }}
 */
export function classifyDeliveryResponse(status) {
  if (status >= 200 && status < 300) {
    return { delivered: true, retryable: false };
  }
  if (status >= 500 || status === 408 || status === 429) {
    return { delivered: false, retryable: true };
  }
  return { delivered: false, retryable: false };
}

/**
 * Delivers an event payload to a source's downstreamUrl.
 *
 * @param {object} params
 * @param {object} params.event
 * @param {object} params.source
 * @param {number} params.attempt
 * @param {Function} [params.fetch]
 * @param {number} [params.timeoutMs=10000]
 * @returns {Promise<{ status: number }>}
 */
export async function deliverEvent({
  event,
  source,
  attempt = 1,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
}) {
  const signal = AbortSignal.timeout(timeoutMs);

  const res = await fetchImpl(source.downstreamUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hookmend-event-id': event.eventId,
      'x-hookmend-event-type': event.eventType,
      'x-hookmend-attempt': String(attempt),
    },
    body: JSON.stringify(event.payload),
    signal,
  });

  return { status: res.status };
}
