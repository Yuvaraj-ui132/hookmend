/**
 * baseline.js — Deterministic baseline schema generation and breaking change detection (D21, D22).
 */

/**
 * Deep clones an object (JSON-safe).
 */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Parses a JSON Pointer path into keys.
 * E.g. '/currency' -> ['currency'], '/meta/ref' -> ['meta', 'ref']
 */
function parsePath(ptr) {
  if (!ptr || typeof ptr !== 'string') return [];
  return ptr.split('/').filter(Boolean);
}

/**
 * Traverses schema.properties along keys up to the parent of the last key.
 * Returns { parentSchema, key } or null if path cannot be resolved.
 */
function resolveParent(schema, path) {
  const keys = parsePath(path);
  if (keys.length === 0) return null;

  let current = schema;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!current.properties || typeof current.properties[k] !== 'object') {
      return null;
    }
    current = current.properties[k];
  }

  return { parent: current, key: keys[keys.length - 1] };
}

/**
 * Builds a deterministic baseline schema by applying structural diff changes.
 *
 * @param {object} baseSchema - Original JSON Schema (draft-07)
 * @param {{
 *   added?: Array<string | { path: string, type?: string }>,
 *   removed?: string[],
 *   typeChanged?: Array<{ path: string, from?: string, to?: string, expected?: string, actual?: string }>
 * }} diff
 * @returns {{ schema: object | null, applied: string[], skipped: string[] }}
 */
export function buildBaselineSchema(baseSchema, diff) {
  const added = diff?.added || [];
  const removed = diff?.removed || [];
  const typeChanged = diff?.typeChanged || [];

  if (added.length === 0 && removed.length === 0 && typeChanged.length === 0) {
    return { schema: null, applied: [], skipped: [] };
  }

  const schema = clone(baseSchema);
  const applied = [];
  const skipped = [];

  // 1. Process added fields
  for (const item of added) {
    const path = typeof item === 'string' ? item : item.path;
    const res = resolveParent(schema, path);
    if (!res) {
      skipped.push(path);
      continue;
    }

    const { parent, key } = res;
    if (!parent.properties) {
      parent.properties = {};
    }

    const propSchema = typeof item === 'object' && item.type ? { type: item.type } : {};
    parent.properties[key] = propSchema;
    applied.push(path);
  }

  // 2. Process removed fields
  for (const item of removed) {
    const path = typeof item === 'string' ? item : item.path;
    const res = resolveParent(schema, path);
    if (!res) {
      skipped.push(path);
      continue;
    }

    const { parent, key } = res;
    if (Array.isArray(parent.required)) {
      parent.required = parent.required.filter((k) => k !== key);
    }
    applied.push(path);
  }

  // 3. Process typeChanged fields
  for (const item of typeChanged) {
    const path = item.path;
    const fromType = item.from || item.expected;
    const toType = item.to || item.actual;

    const res = resolveParent(schema, path);
    if (!res) {
      skipped.push(path);
      continue;
    }

    const { parent, key } = res;
    if (!parent.properties || !parent.properties[key]) {
      skipped.push(path);
      continue;
    }

    const targetProp = parent.properties[key];
    const existingType = targetProp.type;
    const typesSet = new Set();

    if (Array.isArray(existingType)) {
      existingType.forEach((t) => typesSet.add(t));
    } else if (existingType) {
      typesSet.add(existingType);
    }

    if (fromType) {
      if (fromType.includes('|')) {
        fromType.split('|').forEach((t) => typesSet.add(t));
      } else {
        typesSet.add(fromType);
      }
    }

    if (toType) {
      if (toType.includes('|')) {
        toType.split('|').forEach((t) => typesSet.add(t));
      } else {
        typesSet.add(toType);
      }
    }

    targetProp.type = Array.from(typesSet).sort();
    applied.push(path);
  }

  return { schema, applied, skipped };
}

/**
 * Detects breaking changes between base schema and diff.
 *
 * @param {object} baseSchema - Original JSON Schema (draft-07)
 * @param {{
 *   added?: Array<string | { path: string }>,
 *   removed?: string[],
 *   typeChanged?: Array<{ path: string, from?: string, to?: string }>
 * }} diff
 * @returns {Array<{ path: string, kind: string }>}
 */
export function buildBreakingChanges(baseSchema, diff) {
  const breaking = [];
  const removed = diff?.removed || [];
  const typeChanged = diff?.typeChanged || [];

  for (const item of removed) {
    const path = typeof item === 'string' ? item : item.path;
    const res = resolveParent(baseSchema, path);
    if (res) {
      const { parent, key } = res;
      if (Array.isArray(parent.required) && parent.required.includes(key)) {
        breaking.push({ path, kind: 'required_field_removed' });
      }
    }
  }

  for (const item of typeChanged) {
    const path = item.path;
    breaking.push({ path, kind: 'type_changed' });
  }

  return breaking;
}
