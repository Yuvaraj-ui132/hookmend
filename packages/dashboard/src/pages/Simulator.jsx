/**
 * src/pages/Simulator.jsx — (D41, D46)
 * Interactive webhook testing interface.
 * Dispatches synthetic signed webhooks into the ingest pipeline with configurable drift presets.
 * NEVER renders payload values (D22, D46).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { apiGet, apiPost } from '../api/client.js';

const DRIFT_PRESETS = [
  { value: 'none', label: 'none (Valid baseline payment event)' },
  { value: 'added_field', label: 'added_field (extra unmapped field "taxId")' },
  { value: 'type_changed', label: 'type_changed ("amount" sent as string instead of integer)' },
  { value: 'removed_field', label: 'removed_field (required "currency" field omitted)' },
  { value: 'nested_drift', label: 'nested_drift (nested object schema changed)' },
  { value: 'array_type_changed', label: 'array_type_changed (array element type mutated)' },
];

export default function Simulator() {
  const { token } = useAuth();

  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Form fields
  const [sourceId, setSourceId] = useState('');
  const [eventType, setEventType] = useState('payment.succeeded');
  const [driftPreset, setDriftPreset] = useState('added_field');
  const [count, setCount] = useState(1);
  const [simulating, setSimulating] = useState(false);
  const [results, setResults] = useState([]);

  const fetchSources = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet('/api/sources', token);
      const list = data?.sources || data || [];
      setSources(list);
      if (list.length > 0) {
        setSourceId((prev) => prev || list[0]._id || list[0].id);
      }
    } catch (e) {
      setError(e.friendlyMessage || e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  async function handleSimulate(e) {
    e.preventDefault();
    if (!sourceId) {
      setError('Please select a webhook source.');
      return;
    }
    setError('');
    setSimulating(true);

    const newResults = [];
    try {
      for (let i = 0; i < count; i++) {
        const res = await apiPost('/api/simulate', token, {
          sourceId,
          eventType: eventType.trim(),
          driftPreset,
        });
        newResults.unshift({
          timestamp: new Date().toLocaleTimeString(),
          eventId: res.eventId,
          sourceSlug: res.sourceSlug,
          eventType: res.eventType,
          driftPreset: res.driftPreset,
          status: res.status || 'received',
          success: true,
        });
      }
      setResults((prev) => [...newResults, ...prev].slice(0, 50));
    } catch (err) {
      setError(`Simulation failed: ${err.friendlyMessage || err.message}`);
    } finally {
      setSimulating(false);
    }
  }

  return (
    <div className="page" id="simulator-page">
      <div className="page-header">
        <h1 className="page-title">Webhook Simulator</h1>
        <p className="page-subtitle">
          Generate and inject synthetic signed webhooks into the ingestion pipeline to test validation, drift detection, and quarantine
        </p>
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      <div className="grid-sidebar-layout">
        <div className="card">
          <h2 className="card-title mb-3">Simulation Configuration</h2>
          <form onSubmit={handleSimulate}>
            <div className="form-group mb-3">
              <label className="form-label" htmlFor="sim-source-select">Target Webhook Source</label>
              {loading ? (
                <div className="text-xs text-muted">Loading sources…</div>
              ) : (
                <select
                  id="sim-source-select"
                  className="form-input"
                  value={sourceId}
                  onChange={(e) => setSourceId(e.target.value)}
                  required
                >
                  {sources.map((s) => (
                    <option key={s._id || s.id} value={s._id || s.id}>
                      {s.slug} ({s.adapter})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="form-group mb-3">
              <label className="form-label" htmlFor="sim-event-type-input">Event Type</label>
              <input
                id="sim-event-type-input"
                className="form-input"
                type="text"
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
                required
              />
            </div>

            <div className="form-group mb-3">
              <label className="form-label" htmlFor="sim-drift-select">Drift Mutation Preset</label>
              <select
                id="sim-drift-select"
                className="form-input"
                value={driftPreset}
                onChange={(e) => setDriftPreset(e.target.value)}
              >
                {DRIFT_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group mb-4">
              <label className="form-label" htmlFor="sim-count-input">Number of Events to Send</label>
              <input
                id="sim-count-input"
                className="form-input"
                type="number"
                min="1"
                max="20"
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)))}
              />
            </div>

            <button
              id="send-simulation-btn"
              type="submit"
              className="btn btn-primary w-full"
              disabled={simulating || loading || sources.length === 0}
            >
              {simulating ? 'Dispatching Events…' : '🚀 Dispatch Synthetic Webhook'}
            </button>
          </form>
        </div>

        <div className="card">
          <h2 className="card-title mb-3">Simulation History ({results.length})</h2>
          {results.length === 0 ? (
            <div className="empty-state">
              No simulated events dispatched yet in this session.
            </div>
          ) : (
            <div className="table-responsive">
              <table className="table" aria-label="Simulation results table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Source</th>
                    <th>Preset</th>
                    <th>Event ID</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={`${r.eventId}-${i}`}>
                      <td className="text-xs text-muted">{r.timestamp}</td>
                      <td><code>{r.sourceSlug}</code></td>
                      <td><span className="badge">{r.driftPreset}</span></td>
                      <td><code className="text-xs">{r.eventId}</code></td>
                      <td>
                        <span className="badge badge-success">{r.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
