import { describe, it, expect } from 'vitest';
import { parseSseChunk } from '../src/api/sse.js';

describe('Dashboard SSE Chunk Parser (D45)', () => {
  it('parses single SSE event with event and data lines', () => {
    const raw = 'event: event.delivered\ndata: {"id":"ev-1","status":"delivered"}\n\n';
    const events = parseSseChunk(raw);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('event.delivered');
    expect(events[0].data).toBe('{"id":"ev-1","status":"delivered"}');
  });

  it('parses multiple events in a single chunk', () => {
    const raw =
      'event: event.received\ndata: {"id":"ev-1"}\n\n' +
      'event: event.delivered\ndata: {"id":"ev-2"}\n\n';
    const events = parseSseChunk(raw);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('event.received');
    expect(events[1].event).toBe('event.delivered');
  });

  it('ignores SSE comment lines such as heartbeats', () => {
    const raw = ': heartbeat\n\nevent: proposal.created\ndata: {"id":"p-1"}\n\n: another comment\n\n';
    const events = parseSseChunk(raw);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('proposal.created');
  });

  it('handles CRLF line endings', () => {
    const raw = 'event: event.quarantined\r\ndata: {"id":"ev-3"}\r\n\r\n';
    const events = parseSseChunk(raw);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('event.quarantined');
    expect(events[0].data).toBe('{"id":"ev-3"}');
  });
});
