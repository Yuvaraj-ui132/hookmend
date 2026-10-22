/**
 * src/api/sse.js — SSE client (D45)
 *
 * fetch + ReadableStream parser.
 * Handles: chunk boundaries, event:/data: lines, comment lines, multiple events per chunk.
 * Auto-reconnect with exponential backoff 1s–30s with jitter.
 * Calls onEvent(sseEvent) for each parsed event.
 * Calls onResync() after (re)connect and on `resync` events.
 * Calls onStatusChange('live'|'reconnecting'|'unavailable').
 * NEVER logs the token.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

function jitter(ms) {
  return ms + Math.random() * ms * 0.2;
}

/**
 * Parses SSE text into events.
 * @param {string} text
 * @returns {{ event: string, data: string }[]}
 */
export function parseSseChunk(text) {
  const events = [];
  let currentEvent = '';
  let currentData = '';

  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      currentData += (currentData ? '\n' : '') + line.slice(5).trim();
    } else if (line === '') {
      // end of event
      if (currentData || currentEvent) {
        events.push({ event: currentEvent, data: currentData });
      }
      currentEvent = '';
      currentData = '';
    }
    // comment lines (`: heartbeat`) are silently skipped
  }
  return events;
}

/**
 * Creates an SSE connection manager.
 * @returns {{ start, stop }}
 */
export function createSseClient({ token, onEvent, onResync, onStatusChange }) {
  let stopped = false;
  let controller = null;
  let backoffMs = MIN_BACKOFF_MS;
  let timer = null;

  function setStatus(s) {
    if (onStatusChange) onStatusChange(s);
  }

  async function connect() {
    if (stopped) return;
    setStatus('reconnecting');

    controller = new AbortController();

    try {
      const res = await fetch(`${BASE_URL}/api/sse`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });

      if (res.status === 401) {
        setStatus('unavailable');
        return; // don't reconnect on auth failure
      }

      if (!res.ok) {
        throw new Error(`SSE HTTP ${res.status}`);
      }

      // Connected
      backoffMs = MIN_BACKOFF_MS;
      setStatus('live');
      if (onResync) onResync();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on double newlines to handle boundaries
        const parts = buffer.split('\n\n');
        buffer = parts.pop(); // keep incomplete last part

        for (const part of parts) {
          const parsed = parseSseChunk(part + '\n\n');
          for (const evt of parsed) {
            if (evt.event === 'resync') {
              if (onResync) onResync();
            } else if (evt.event && onEvent) {
              let data = evt.data;
              try { data = JSON.parse(evt.data); } catch { /* keep string */ }
              onEvent({ event: evt.event, data });
            }
          }
        }
      }

      reader.cancel();
    } catch (err) {
      if (err?.name === 'AbortError') return; // intentionally stopped
    }

    if (!stopped) {
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    setStatus('reconnecting');
    const delay = jitter(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    timer = setTimeout(connect, delay);
  }

  function start() {
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (controller) { controller.abort(); controller = null; }
  }

  return { start, stop };
}
