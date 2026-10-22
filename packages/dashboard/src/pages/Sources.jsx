/**
 * src/pages/Sources.jsx — (D38, D46)
 * Source configuration management: list, create, edit downstreamUrl, toggle disabled, delete.
 * NEVER renders secret values or payload contents.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useSse } from '../context/SseContext.jsx';
import { apiGet, apiPost, apiPatch, apiDel, asList } from '../api/client.js';

export default function Sources() {
  const { token } = useAuth();
  const { lastEvent, addRefetchCallback } = useSse();

  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [slug, setSlug] = useState('');
  const [adapter, setAdapter] = useState('generic-hmac');
  const [secretEnvVar, setSecretEnvVar] = useState('');
  const [downstreamUrl, setDownstreamUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formErr, setFormErr] = useState('');

  // Editing state: { id, downstreamUrl, disabled }
  const [editingId, setEditingId] = useState(null);
  const [editUrl, setEditUrl] = useState('');

  const fetchSources = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiGet('/api/sources', token);
      setSources(asList(data, 'sources', '/api/sources'));
    } catch (e) {
      setError(e.friendlyMessage || e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchSources();
    return addRefetchCallback(fetchSources);
  }, [fetchSources, addRefetchCallback]);

  // Live update if a source is created or modified
  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.event === 'source.created') {
      fetchSources();
    }
  }, [lastEvent, fetchSources]);

  async function handleCreate(e) {
    e.preventDefault();
    setFormErr('');
    setMsg('');
    setSubmitting(true);
    try {
      await apiPost('/api/sources', token, {
        slug: slug.trim(),
        adapter,
        secretEnvVar: secretEnvVar.trim(),
        downstreamUrl: downstreamUrl.trim() || undefined,
      });
      setMsg(`Source "${slug}" created successfully.`);
      setShowCreate(false);
      setSlug('');
      setSecretEnvVar('');
      setDownstreamUrl('');
      fetchSources();
    } catch (err) {
      setFormErr(err.friendlyMessage || err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleDisabled(s) {
    const id = s._id || s.id;
    const isActive = s.active !== false && !s.disabled;
    try {
      await apiPatch(`/api/sources/${id}`, token, { active: !isActive });
      setMsg(`Source "${s.slug}" ${isActive ? 'disabled' : 'enabled'}.`);
      fetchSources();
    } catch (err) {
      setError(`Failed to toggle: ${err.friendlyMessage || err.message}`);
    }
  }

  async function handleSaveEdit(id) {
    try {
      await apiPatch(`/api/sources/${id}`, token, { downstreamUrl: editUrl.trim() });
      setEditingId(null);
      setMsg('Downstream URL updated.');
      fetchSources();
    } catch (err) {
      setError(`Update failed: ${err.friendlyMessage || err.message}`);
    }
  }

  async function handleDelete(s) {
    const id = s._id || s.id;
    if (!window.confirm(`Are you sure you want to delete source "${s.slug}"?`)) return;
    try {
      await apiDel(`/api/sources/${id}`, token);
      setMsg(`Source "${s.slug}" deleted.`);
      fetchSources();
    } catch (err) {
      setError(`Delete failed: ${err.friendlyMessage || err.message}`);
    }
  }

  return (
    <div className="page" id="sources-page">
      <div className="page-header flex-between">
        <div>
          <h1 className="page-title">Webhook Sources</h1>
          <p className="page-subtitle">Configure webhook providers, adapters, and downstream endpoints</p>
        </div>
        <button
          id="toggle-create-source-btn"
          className="btn btn-primary"
          onClick={() => setShowCreate(!showCreate)}
        >
          {showCreate ? 'Cancel' : '+ New Source'}
        </button>
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {msg && <div className="alert alert-success" role="status">{msg}</div>}

      {showCreate && (
        <div className="card mb-4" id="create-source-card">
          <h2 className="card-title mb-2">Register New Webhook Source</h2>
          <form onSubmit={handleCreate}>
            <div className="grid-2 gap-4 mb-3">
              <div className="form-group">
                <label className="form-label" htmlFor="source-slug-input">Slug (identifier)</label>
                <input
                  id="source-slug-input"
                  className="form-input"
                  type="text"
                  placeholder="e.g. acme-payments"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  pattern="^[a-z0-9][a-z0-9-]{1,40}$"
                  title="2-41 lowercase alphanumeric or dashes"
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="source-adapter-select">Adapter</label>
                <select
                  id="source-adapter-select"
                  className="form-input"
                  value={adapter}
                  onChange={(e) => setAdapter(e.target.value)}
                  required
                >
                  <option value="generic-hmac">generic-hmac (HMAC SHA256)</option>
                  <option value="github">github (GitHub Webhook HMAC)</option>
                </select>
              </div>
            </div>

            <div className="grid-2 gap-4 mb-3">
              <div className="form-group">
                <label className="form-label" htmlFor="source-secret-input">Secret Environment Variable</label>
                <input
                  id="source-secret-input"
                  className="form-input"
                  type="text"
                  placeholder="e.g. ACME_WEBHOOK_SECRET"
                  value={secretEnvVar}
                  onChange={(e) => setSecretEnvVar(e.target.value)}
                  pattern="^[A-Z][A-Z0-9_]{2,63}$"
                  title="Uppercase env var name e.g. STRIPE_SECRET"
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="source-url-input">Downstream URL</label>
                <input
                  id="source-url-input"
                  className="form-input"
                  type="url"
                  placeholder="https://api.internal.corp/webhooks"
                  value={downstreamUrl}
                  onChange={(e) => setDownstreamUrl(e.target.value)}
                />
              </div>
            </div>

            {formErr && <div className="form-error mb-3" role="alert">{formErr}</div>}

            <button
              id="submit-source-btn"
              type="submit"
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitting ? 'Registering…' : 'Register Source'}
            </button>
          </form>
        </div>
      )}

      {loading ? (
        <div className="loading-state">Loading sources…</div>
      ) : sources.length === 0 ? (
        <div className="empty-state">No sources registered yet.</div>
      ) : (
        <div className="table-responsive card">
          <table className="table" aria-label="Sources table">
            <thead>
              <tr>
                <th>Slug</th>
                <th>Adapter</th>
                <th>Secret Env</th>
                <th>Downstream URL</th>
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const id = s._id || s.id;
                const isEditing = editingId === id;
                return (
                  <tr key={id}>
                    <td className="font-semibold">{s.slug}</td>
                    <td><span className="badge">{s.adapter}</span></td>
                    <td><code>{s.secretEnvVar}</code></td>
                    <td>
                      {isEditing ? (
                        <div className="flex gap-2">
                          <input
                            type="url"
                            className="form-input form-input-sm"
                            value={editUrl}
                            onChange={(e) => setEditUrl(e.target.value)}
                          />
                          <button className="btn btn-primary btn-sm" onClick={() => handleSaveEdit(id)}>Save</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted">
                          {s.downstreamUrl || '—'}
                          <button
                            className="btn btn-ghost btn-sm ml-2"
                            onClick={() => { setEditingId(id); setEditUrl(s.downstreamUrl || ''); }}
                          >
                            ✏️
                          </button>
                        </span>
                      )}
                    </td>
                    <td>
                      {(() => {
                        const isActive = s.active !== false && !s.disabled;
                        return (
                          <span className={`badge ${isActive ? 'badge-success' : 'badge-danger'}`}>
                            {isActive ? 'Active' : 'Disabled'}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="text-right">
                      <div className="flex gap-2 justify-end">
                        {(() => {
                          const isActive = s.active !== false && !s.disabled;
                          return (
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleToggleDisabled(s)}
                            >
                              {isActive ? 'Disable' : 'Enable'}
                            </button>
                          );
                        })()}
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleDelete(s)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
