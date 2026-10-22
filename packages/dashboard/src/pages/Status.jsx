/**
 * src/pages/Status.jsx — (D46)
 * System health, event breakdown, proposal counts, queue metrics, and SSE client counts.
 * Data from GET /api/stats.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useSse } from '../context/SseContext.jsx';
import { apiGet } from '../api/client.js';

export default function Status() {
  const { token } = useAuth();
  const { sseStatus, addRefetchCallback } = useSse();

  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchStats = useCallback(async () => {
    setError('');
    try {
      const data = await apiGet('/api/stats', token);
      setStats(data);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e.friendlyMessage || e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchStats();
    // Poll stats every 10 seconds for fresh counters
    const timer = setInterval(fetchStats, 10000);
    const removeRefetch = addRefetchCallback(fetchStats);
    return () => {
      clearInterval(timer);
      removeRefetch();
    };
  }, [fetchStats, addRefetchCallback]);

  const eventCounts = stats?.events || {};
  const proposalCounts = stats?.proposals || {};
  const queueCounts = stats?.queues || {};

  return (
    <div className="page" id="status-page">
      <div className="page-header flex-between">
        <div>
          <h1 className="page-title">System Status</h1>
          <p className="page-subtitle">Real-time health, counters, queue metrics, and throughput</p>
        </div>
        <div className="flex gap-2 align-center">
          {lastUpdated && (
            <span className="text-xs text-muted">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button id="refresh-stats-btn" className="btn btn-ghost" onClick={fetchStats}>
            🔄 Refresh
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      {loading && !stats ? (
        <div className="loading-state">Loading metrics…</div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Top overview cards */}
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-label">Active Sources</div>
              <div className="stat-value">{stats?.sourcesCount ?? 0}</div>
              <div className="stat-sub">Registered endpoints</div>
            </div>

            <div className="stat-card">
              <div className="stat-label">Delivered Events</div>
              <div className="stat-value text-success">{eventCounts.delivered ?? 0}</div>
              <div className="stat-sub">Successfully processed</div>
            </div>

            <div className="stat-card">
              <div className="stat-label">Quarantined Events</div>
              <div className="stat-value text-warning">{eventCounts.quarantined ?? 0}</div>
              <div className="stat-sub">Schema drift detected</div>
            </div>

            <div className="stat-card">
              <div className="stat-label">Dead Events</div>
              <div className="stat-value text-danger">{eventCounts.dead ?? 0}</div>
              <div className="stat-sub">Exhausted retries</div>
            </div>

            <div className="stat-card">
              <div className="stat-label">Pending Proposals</div>
              <div className="stat-value text-accent">{proposalCounts.pending_review ?? 0}</div>
              <div className="stat-sub">Awaiting admin review</div>
            </div>

            <div className="stat-card">
              <div className="stat-label">SSE Subscribers</div>
              <div className="stat-value">{stats?.sseClients ?? 0}</div>
              <div className="stat-sub">Stream state: {sseStatus}</div>
            </div>
          </div>

          {/* Event Status Breakdown */}
          <div className="card">
            <h2 className="card-title mb-3">Event Pipeline Counters</h2>
            <div className="grid-3 gap-3">
              <div className="p-3 surface-2 rounded">
                <div className="text-xs text-muted">Received</div>
                <div className="text-lg font-bold">{eventCounts.received ?? 0}</div>
              </div>
              <div className="p-3 surface-2 rounded">
                <div className="text-xs text-muted">Processing</div>
                <div className="text-lg font-bold">{eventCounts.processing ?? 0}</div>
              </div>
              <div className="p-3 surface-2 rounded">
                <div className="text-xs text-muted">Requeue Pending</div>
                <div className="text-lg font-bold">{eventCounts.requeue_pending ?? 0}</div>
              </div>
              <div className="p-3 surface-2 rounded">
                <div className="text-xs text-muted">Failed (retrying)</div>
                <div className="text-lg font-bold">{eventCounts.failed ?? 0}</div>
              </div>
              <div className="p-3 surface-2 rounded">
                <div className="text-xs text-muted">Quarantined</div>
                <div className="text-lg font-bold text-warning">{eventCounts.quarantined ?? 0}</div>
              </div>
              <div className="p-3 surface-2 rounded">
                <div className="text-xs text-muted">Delivered</div>
                <div className="text-lg font-bold text-success">{eventCounts.delivered ?? 0}</div>
              </div>
            </div>
          </div>

          {/* Queue & Worker Metrics */}
          {Object.keys(queueCounts).length > 0 && (
            <div className="card">
              <h2 className="card-title mb-3">BullMQ Queue Metrics</h2>
              <div className="table-responsive">
                <table className="table" aria-label="Queue metrics table">
                  <thead>
                    <tr>
                      <th>Queue</th>
                      <th>Active</th>
                      <th>Waiting</th>
                      <th>Delayed</th>
                      <th>Failed</th>
                      <th>Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(queueCounts).map(([queueName, counts]) => (
                      <tr key={queueName}>
                        <td className="font-semibold">{queueName}</td>
                        <td>{counts.active ?? 0}</td>
                        <td>{counts.waiting ?? 0}</td>
                        <td>{counts.delayed ?? 0}</td>
                        <td>{counts.failed ?? 0}</td>
                        <td>{counts.completed ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
