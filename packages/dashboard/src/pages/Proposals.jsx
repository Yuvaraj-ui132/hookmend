/**
 * src/pages/Proposals.jsx — (D46)
 * List of drift proposals with inline schema diff.
 * Approve / reject actions.
 * NEVER renders payload or headers.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useSse } from '../context/SseContext.jsx';
import { apiGet, apiPost, apiPatch } from '../api/client.js';
import StatusBadge from '../components/StatusBadge.jsx';

function DiffItem({ path, change }) {
  const label = change.type === 'added' ? 'added' : change.type === 'removed' ? 'removed' : 'changed';
  return (
    <div className={`diff-item diff-${change.type}`}>
      <span className="diff-label">{label}</span>
      <code className="text-xs">{path}</code>
    </div>
  );
}

function ProposalDrawer({ proposal, onClose, onUpdate }) {
  const { token } = useAuth();
  const [schema, setSchema] = useState(() => {
    try { return JSON.stringify(proposal.proposedSchema, null, 2); }
    catch { return '{}'; }
  });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [msg, setMsg] = useState('');
  const [allowPartial, setAllowPartial] = useState(false);

  const id = proposal._id || proposal.id;

  async function saveSchema() {
    setSaving(true); setErr('');
    try {
      const parsed = JSON.parse(schema);
      await apiPatch(`/api/proposals/${id}`, token, { proposedSchema: parsed });
      setMsg('Schema saved.');
      onUpdate();
    } catch (e) {
      setErr(e.friendlyMessage || e.message);
    } finally {
      setSaving(false);
    }
  }

  async function approve() {
    setApproving(true); setErr('');
    try {
      await apiPost(`/api/proposals/${id}/approve`, token, {
        currentSchemaVersion: proposal.currentSchemaVersion,
        allowPartial,
      });
      setMsg('Proposal approved!');
      onUpdate();
      onClose();
    } catch (e) {
      setErr(e.friendlyMessage || e.message);
    } finally {
      setApproving(false);
    }
  }

  async function reject() {
    setRejecting(true); setErr('');
    try {
      await apiPost(`/api/proposals/${id}/reject`, token, {});
      setMsg('Proposal rejected.');
      onUpdate();
      onClose();
    } catch (e) {
      setErr(e.friendlyMessage || e.message);
    } finally {
      setRejecting(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Proposal details">
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Proposal</h2>
          <button id="proposal-close-btn" className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="text-sm text-muted mb-2">
          <strong>Source:</strong> {proposal.sourceId?.toString?.() || proposal.sourceId}<br />
          <strong>Event type:</strong> <code>{proposal.eventType}</code><br />
          <strong>Drift fingerprint:</strong> <code className="font-mono text-xs">{(proposal.driftFingerprint || '').slice(0, 24)}</code><br />
          <strong>Status:</strong> <StatusBadge status={proposal.status} />
        </div>

        {(() => {
          const diffEntries = Array.isArray(proposal.diff)
            ? proposal.diff
            : typeof proposal.diff === 'object' && proposal.diff !== null
              ? Object.entries(proposal.diff).map(([path, change]) => ({ path, ...change }))
              : [];
          if (diffEntries.length === 0) return null;
          return (
            <div className="mb-3">
              <div className="form-label mb-2">Schema diff</div>
              <div className="diff-tree">
                {diffEntries.map((d, i) => (
                  <DiffItem key={i} path={d.path || d.field || '?'} change={d} />
                ))}
              </div>
            </div>
          );
        })()}

        <div className="form-group">
          <label className="form-label" htmlFor="proposal-schema-editor">Proposed schema</label>
          <textarea
            id="proposal-schema-editor"
            className="form-textarea font-mono text-xs"
            rows={12}
            value={schema}
            onChange={(e) => setSchema(e.target.value)}
            disabled={proposal.status !== 'pending_review'}
          />
        </div>

        {proposal.status === 'pending_review' && (
          <>
            <div className="form-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '.5rem' }}>
              <input
                type="checkbox"
                id="allow-partial"
                checked={allowPartial}
                onChange={(e) => setAllowPartial(e.target.checked)}
              />
              <label htmlFor="allow-partial" className="form-label" style={{ marginBottom: 0 }}>
                Allow partial replay failures
              </label>
            </div>

            <div className="flex gap-2">
              <button id="save-schema-btn" className="btn btn-secondary" disabled={saving} onClick={saveSchema}>
                {saving ? 'Saving…' : 'Save schema'}
              </button>
              <button id="approve-btn" className="btn btn-primary" disabled={approving} onClick={approve}>
                {approving ? 'Approving…' : 'Approve'}
              </button>
              <button id="reject-btn" className="btn btn-danger" disabled={rejecting} onClick={reject}>
                {rejecting ? 'Rejecting…' : 'Reject'}
              </button>
            </div>
          </>
        )}

        {err && <p className="form-error mt-2" role="alert">{err}</p>}
        {msg && <p className="text-muted text-sm mt-2" role="status">{msg}</p>}
      </div>
    </div>
  );
}

export default function Proposals() {
  const { token } = useAuth();
  const { lastEvent, addRefetchCallback } = useSse();
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [filterStatus, setFilterStatus] = useState('');

  const fetchProposals = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await apiGet('/api/proposals', token);
      setProposals(data?.proposals || data || []);
    } catch (e) {
      setError(e.friendlyMessage || e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchProposals();
    return addRefetchCallback(fetchProposals);
  }, [fetchProposals, addRefetchCallback]);

  useEffect(() => {
    if (!lastEvent) return;
    if (['proposal.created','proposal.approved','proposal.rejected','proposal.edited'].includes(lastEvent.event)) {
      fetchProposals();
    }
  }, [lastEvent, fetchProposals]);

  const visible = proposals.filter((p) => !filterStatus || p.status === filterStatus);

  return (
    <section aria-label="Drift proposals">
      <div className="flex items-center justify-between mb-4">
        <h1 className="page-title">📋 Proposals</h1>
        <button id="proposals-refresh-btn" className="btn btn-ghost" onClick={fetchProposals}>↺ Refresh</button>
      </div>

      <div className="filters">
        <select id="proposals-filter" className="filter-select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {['pending_review','approved','rejected'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {loading && <div className="state-box">Loading…</div>}
      {error   && <div className="state-box error" role="alert">{error}</div>}

      {!loading && !error && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Event type</th>
                <th>Source</th>
                <th>Status</th>
                <th>AI used</th>
                <th>Drift fp</th>
                <th>Affected</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={6} className="state-box">No proposals.</td></tr>
              )}
              {visible.map((p) => {
                const id = p._id || p.id;
                return (
                  <tr
                    key={id}
                    style={{ cursor: 'pointer' }}
                    id={`proposal-row-${id}`}
                    onClick={() => setSelected(p)}
                  >
                    <td className="text-sm font-mono">{p.eventType}</td>
                    <td className="text-sm text-muted">{String(p.sourceId || '').slice(-8)}</td>
                    <td><StatusBadge status={p.status} /></td>
                    <td className="text-xs">{p.aiUsed ? '✓' : '—'}</td>
                    <td className="text-xs font-mono text-muted">{(p.driftFingerprint || '').slice(0, 12)}</td>
                    <td className="text-xs">{p.affectedEventCount ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ProposalDrawer
          proposal={selected}
          onClose={() => setSelected(null)}
          onUpdate={fetchProposals}
        />
      )}
    </section>
  );
}
