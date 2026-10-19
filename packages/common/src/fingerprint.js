/**
 * fingerprint.js — Deterministic drift fingerprint calculation.
 *
 * D8: sha256 hex of `${sourceId}:${eventType}:${baseSchemaVersion}:${canonicalJson}`
 * where canonicalJson is JSON.stringify of {added, removed, typeChanged, violations}
 * with every array sorted by path (and keyword).
 */

import { createHash } from 'node:crypto';

/**
 * Computes deterministic drift fingerprint.
 *
 * @param {object} params
 * @param {string} params.sourceId
 * @param {string} params.eventType
 * @param {number} params.baseSchemaVersion
 * @param {object} [params.diff]
 * @param {string[]} [params.diff.added]
 * @param {string[]} [params.diff.removed]
 * @param {Array<{ path: string, expected: string, actual: string }>} [params.diff.typeChanged]
 * @param {Array<{ path: string, keyword: string }>} [params.violations]
 * @returns {string} 64-character sha256 hex string
 */
export function computeFingerprint({
  sourceId,
  eventType,
  baseSchemaVersion,
  diff = {},
  violations = [],
}) {
  const sortedAdded = [...(diff.added || [])].sort();
  const sortedRemoved = [...(diff.removed || [])].sort();
  const sortedTypeChanged = [...(diff.typeChanged || [])]
    .map((item) => ({
      path: item.path || '',
      expected: item.expected || '',
      actual: item.actual || '',
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const sortedViolations = [...violations]
    .map((item) => ({
      path: item.path || '',
      keyword: item.keyword || '',
    }))
    .sort((a, b) => {
      const pathCmp = a.path.localeCompare(b.path);
      if (pathCmp !== 0) return pathCmp;
      return a.keyword.localeCompare(b.keyword);
    });

  const canonicalObj = {
    added: sortedAdded,
    removed: sortedRemoved,
    typeChanged: sortedTypeChanged,
    violations: sortedViolations,
  };

  const canonicalJson = JSON.stringify(canonicalObj);
  const rawInput = `${sourceId}:${eventType}:${baseSchemaVersion}:${canonicalJson}`;

  return createHash('sha256').update(rawInput).digest('hex');
}
