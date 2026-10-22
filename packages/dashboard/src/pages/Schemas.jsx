/**
 * src/pages/Schemas.jsx — (D46)
 * Lists schemas, shows active versions, schema viewer, and create new schema form.
 * NEVER renders payload or headers.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useSse } from '../context/SseContext.jsx';
import { apiGet, apiPost } from '../api/client.js';

export default function Schemas() {
  const { token } = useAuth();
  const { lastEvent, addRefetchCallback } = useSse();

  const [schemas, setSchemas] = useState([]);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedSchema, setSelectedSchema] = useState(null);

  // New schema form state
  const [showCreate, setShowCreate] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [eventType, setEventType] = useState('');
  const [schemaText, setSchemaText] = useState('{\n  "type": "object",\n  "properties": {\n    "id": { "type": "string" }\n  },\n  "required": ["id"]\n}');
  const [createErr, setCreateErr] = useState('');
  const [createMsg, setCreateMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [schemaData, sourceData] = await Promise.all([
        apiGet('/api/schemas', token),
        apiGet('/api/sources', token).catch(() => ({ sources: [] })),
      ]);
      const list = schemaData?.schemas || schemaData || [];
      setSchemas(list);
      setSources(sourceData?.sources || sourceData || []);
      if (list.length > 0 && !selectedSchema) {
        setSelectedSchema(list[0]);
      }
    } catch (e) {
      setError(e.friendlyMessage || e.message);
    } finally {
      setLoading(false);
    }
  }, [token, selectedSchema]);

  useEffect(() => {
    fetchData();
    return addRefetchCallback(fetchData);
  }, [fetchData, addRefetchCallback]);

  // Live update if a proposal is approved (schema created/updated)
  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.event === 'proposal.approved' || lastEvent.event === 'source.created') {
      fetchData();
    }
  }, [lastEvent, fetchData]);

  async function handleCreate(e) {
    e.preventDefault();
    setCreateErr('');
    setCreateMsg('');
    if (!sourceId.trim()) {
      setCreateErr('Source ID is required.');
      return;
    }
    if (!eventType.trim()) {
      setCreateErr('Event Type is required.');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(schemaText);
    } catch {
      setCreateErr('Invalid JSON syntax in schema definition.');
      return;
    }

    setSubmitting(true);
    try {
      await apiPost('/api/schemas', token, {
        sourceId: sourceId.trim(),
        eventType: eventType.trim(),
        schema: parsed,
      });
      setCreateMsg('Schema created successfully.');
      setShowCreate(false);
      setEventType('');
      fetchData();
    } catch (err) {
      setCreateErr(err.friendlyMessage || err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page" id="schemas-page">
      <div className="page-header flex-between">
        <div>
          <h1 className="page-title">Event Schemas</h1>
          <p className="page-subtitle">Active JSON Schema contracts per source and event type</p>
        </div>
        <button
          id="toggle-create-schema-btn"
          className="btn btn-primary"
          onClick={() => setShowCreate(!showCreate)}
        >
          {showCreate ? 'Cancel' : '+ New Schema'}
        </button>
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {createMsg && <div className="alert alert-success" role="status">{createMsg}</div>}

      {showCreate && (
        <div className="card mb-4" id="create-schema-card">
          <h2 className="card-title mb-2">Create New Schema</h2>
          <form onSubmit={handleCreate}>
            <div className="grid-2 gap-4 mb-3">
              <div className="form-group">
                <label className="form-label" htmlFor="schema-source-select">Source</label>
                <select
                  id="schema-source-select"
                  className="form-input"
                  value={sourceId}
                  onChange={(e) => setSourceId(e.target.value)}
                  required
                >
                  <option value="">Select a source…</option>
                  {sources.map((s) => (
                    <option key={s._id || s.id} value={s._id || s.id}>
                      {s.slug} ({s.adapter})
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="schema-event-type-input">Event Type</label>
                <input
                  id="schema-event-type-input"
                  className="form-input"
                  type="text"
                  placeholder="e.g. payment.succeeded"
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="form-group mb-3">
              <label className="form-label" htmlFor="schema-definition-input">JSON Schema Definition</label>
              <textarea
                id="schema-definition-input"
                className="form-input font-mono"
                rows={8}
                value={schemaText}
                onChange={(e) => setSchemaText(e.target.value)}
                required
              />
            </div>

            {createErr && <div className="form-error mb-3" role="alert">{createErr}</div>}

            <button
              id="submit-schema-btn"
              type="submit"
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitting ? 'Creating…' : 'Save Schema'}
            </button>
          </form>
        </div>
      )}

      {loading ? (
        <div className="loading-state">Loading schemas…</div>
      ) : schemas.length === 0 ? (
        <div className="empty-state">No schemas registered yet.</div>
      ) : (
        <div className="grid-sidebar-layout">
          <div className="card">
            <h2 className="card-title mb-2">Schemas ({schemas.length})</h2>
            <div className="schema-list">
              {schemas.map((sc) => {
                const isSelected = selectedSchema?._id === sc._id;
                return (
                  <div
                    key={sc._id || sc.id}
                    className={`list-item clickable ${isSelected ? 'active' : ''}`}
                    onClick={() => setSelectedSchema(sc)}
                  >
                    <div className="font-semibold text-sm">{sc.eventType}</div>
                    <div className="text-xs text-muted">
                      Source: {sc.sourceId?.slice(-6) || '—'} · v{sc.version} · {sc.active ? 'Active' : 'Inactive'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            {selectedSchema ? (
              <div>
                <div className="flex-between mb-3">
                  <div>
                    <h2 className="card-title">{selectedSchema.eventType}</h2>
                    <span className="text-xs text-muted">
                      ID: {selectedSchema._id} · Version: v{selectedSchema.version} · {selectedSchema.active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>

                <div className="mb-2">
                  <span className="text-xs font-semibold uppercase text-muted">Schema Definition</span>
                  <pre className="code-block mt-1">
                    {JSON.stringify(selectedSchema.schema, null, 2)}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="text-muted text-sm">Select a schema from the left to view details.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
