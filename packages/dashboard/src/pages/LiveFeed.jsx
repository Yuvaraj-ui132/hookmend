/**
 * src/pages/LiveFeed.jsx — (D46)
 * Real-time event stream with source/status filters.
 * NEVER renders payload, headers, or rawBodyHash.
 * Capped at 200 entries in memory.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useSse } from '../context/SseContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { apiGet, asList } from '../api/client.js';
import StatusBadge from '../components/StatusBadge.jsx';

const MAX_ENTRIES = 200;

const EVENT_TO_STATUS = {
  'event.received':       'received',
  'event.processing':     'processing',
  'event.delivered':      'delivered',
  'event.quarantined':    'quarantined',
  'event.failed':         'failed',
  'event.dead':           'dead',
  'event.requeue_pending':'requeue_pending',
};

function fmtTime(dt) {
  const d = new Date(dt);
  return d.toLocaleTimeString();
}

export default function LiveFeed() {
  const { lastEvent, addRefetchCallback } = useSse();
  const { token } = useAuth();

  const [entries, setEntries] = useState([]);
  const [filterSource, setFilterSource] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Load recent events on mount and on refetch
  const fetchRecent = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiGet('/api/events?limit=100', token);
      const events = asList(data, 'items', '/api/events').map((ev) => ({
        id:          ev._id || ev.id || ev.eventId,
        sourceSlug:  ev.sourceSlug,
        eventType:   ev.eventType,
        status:      ev.status,
        receivedAt:  ev.receivedAt,
        // NEVER include payload, headers, rawBodyHash
      }));
      setEntries(events.slice(0, MAX_ENTRIES));
    } catch (e) {
      setError(e.friendlyMessage || e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchRecent();
    return addRefetchCallback(fetchRecent);
  }, [fetchRecent, addRefetchCallback]);

  // Apply live updates
  useEffect(() => {
    if (!lastEvent) return;
    const { event, data } = lastEvent;
    const newStatus = EVENT_TO_STATUS[event];
    if (!newStatus || !data?.id) return;

    setEntries((prev) => {
      const existing = prev.findIndex((e) => e.id === data.id);
      const updated = {
        id:         data.id,
        sourceSlug: data.sourceSlug,
        eventType:  data.eventType,
        status:     newStatus,
        receivedAt: data.receivedAt,
      };

      if (existing >= 0) {
        const next = [...prev];
        next[existing] = updated;
        return next;
      }

      // New event: prepend, cap at MAX_ENTRIES
      return [updated, ...prev].slice(0, MAX_ENTRIES);
    });
  }, [lastEvent]);

  const visible = entries.filter((e) => {
    if (filterSource && e.sourceSlug !== filterSource) return false;
    if (filterStatus && e.status !== filterStatus) return false;
    return true;
  });

  const sources = [...new Set(entries.map((e) => e.sourceSlug).filter(Boolean))].sort();

  return (
    <section aria-label="Live event feed">
      <h1 className="page-title">⚡ Live Feed</h1>
      <p className="page-subtitle">Real-time webhook event stream (last {MAX_ENTRIES}). No payloads shown.</p>

      <div className="filters">
        <select
          id="live-filter-source"
          className="filter-select"
          value={filterSource}
          onChange={(e) => setFilterSource(e.target.value)}
          aria-label="Filter by source"
        >
          <option value="">All sources</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <select
          id="live-filter-status"
          className="filter-select"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {Object.values(EVENT_TO_STATUS).filter((v, i, a) => a.indexOf(v) === i).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <button id="live-refresh-btn" className="btn btn-ghost" onClick={fetchRecent}>
          ↺ Refresh
        </button>
      </div>

      {loading && <div className="state-box">Loading events…</div>}
      {error   && <div className="state-box error" role="alert">{error}</div>}

      {!loading && !error && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Source</th>
                <th>Event type</th>
                <th>Status</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={5} className="state-box">No events match the current filters.</td></tr>
              )}
              {visible.map((ev) => (
                <tr key={ev.id}>
                  <td className="text-xs text-muted font-mono">{fmtTime(ev.receivedAt)}</td>
                  <td className="text-sm">{ev.sourceSlug || '—'}</td>
                  <td className="text-sm font-mono">{ev.eventType || '—'}</td>
                  <td><StatusBadge status={ev.status} /></td>
                  <td className="text-xs text-muted font-mono">{String(ev.id || '').slice(-8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
