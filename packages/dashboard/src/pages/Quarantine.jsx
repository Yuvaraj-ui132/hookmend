/**
 * src/pages/Quarantine.jsx — (D46)
 * Lists quarantined events, shows diff/fingerprint, allows manual requeue.
 * NEVER renders payload or headers.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useSse } from '../context/SseContext.jsx';
import { apiGet, apiPost, asList } from '../api/client.js';
import StatusBadge from '../components/StatusBadge.jsx';

export default function Quarantine() {
  const { token } = useAuth();
  const { lastEvent, addRefetchCallback } = useSse();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [requeueing, setRequeueing] = useState(null);
  const [msg, setMsg] = useState('');

  const fetchEvents = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await apiGet('/api/quarantine?limit=100', token);
      setEvents(asList(data, 'items', '/api/quarantine'));
    } catch (e) {
      setError(e.friendlyMessage || e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchEvents();
    return addRefetchCallback(fetchEvents);
  }, [fetchEvents, addRefetchCallback]);

  // Live update on quarantine events
  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.event === 'event.quarantined') {
      fetchEvents();
    }
  }, [lastEvent, fetchEvents]);

  async function requeue(id) {
    setRequeueing(id);
    try {
      await apiPost(`/api/events/${id}/requeue`, token, {});
      setMsg('Event requeued successfully.');
      fetchEvents();
    } catch (e) {
      setMsg(`Requeue failed: ${e.friendlyMessage || e.message}`);
    } finally {
      setRequeueing(null);
    }
  }

  return (
    <section aria-label="Quarantined events">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="page-title">🔒 Quarantine</h1>
        </div>
        <button id="quarantine-refresh-btn" className="btn btn-ghost" onClick={fetchEvents}>↺ Refresh</button>
      </div>

      {msg && <p className="form-hint" style={{ marginBottom: '.5rem' }} role="status">{msg}</p>}
      {loading && <div className="state-box">Loading…</div>}
      {error   && <div className="state-box error" role="alert">{error}</div>}

      {!loading && !error && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Event type</th>
                <th>Status</th>
                <th>Drift fingerprint</th>
                <th>Received</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr><td colSpan={6} className="state-box">No quarantined events.</td></tr>
              )}
              {events.map((ev, idx) => {
                const id = ev._id || ev.id || ev.driftFingerprint || idx;
                const sourceDisplay = ev.sourceSlug || (ev.sourceId ? String(ev.sourceId).slice(-8) : '—');
                const statusDisplay = ev.status || 'quarantined';
                const timeDisplay = ev.receivedAt || ev.lastSeen || ev.firstSeen;
                const countSuffix = ev.count != null && ev.count > 1 ? ` (${ev.count})` : '';
                return (
                  <tr key={id}>
                    <td className="text-sm">{sourceDisplay}</td>
                    <td className="text-sm font-mono">{ev.eventType || '—'}{countSuffix}</td>
                    <td><StatusBadge status={statusDisplay} /></td>
                    <td className="text-xs font-mono text-muted">{(ev.driftFingerprint || '—').slice(0, 16)}</td>
                    <td className="text-xs text-muted">{timeDisplay ? new Date(timeDisplay).toLocaleString() : '—'}</td>
                    <td>
                      <button
                        id={`requeue-btn-${id}`}
                        className="btn btn-secondary"
                        style={{ padding: '.3rem .7rem', fontSize: '.75rem' }}
                        disabled={requeueing === id}
                        onClick={() => requeue(id)}
                      >
                        {requeueing === id ? 'Requeuing…' : 'Requeue'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
