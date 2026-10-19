/**
 * diff.js — Structural schema diff (strictly value-free).
 *
 * Walks schema.properties and payload recursively for objects up to max depth 5.
 * Arrays are treated as type "array" and not descended.
 */

function getJsonType(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  const t = typeof val;
  if (t === 'boolean') return 'boolean';
  if (t === 'string') return 'string';
  if (t === 'number') {
    return Number.isInteger(val) ? 'integer' : 'number';
  }
  if (t === 'object') return 'object';
  return t;
}

function typesMatch(expectedType, actualType) {
  if (!expectedType) return true;
  if (Array.isArray(expectedType)) {
    return expectedType.some((t) => typesMatch(t, actualType));
  }
  // "number accepts integer"
  if (expectedType === 'number' && actualType === 'integer') return true;
  return expectedType === actualType;
}

/**
 * Computes structural difference between JSON Schema (draft-07) and a JSON payload.
 *
 * @param {object} schema - JSON Schema document
 * @param {object} payload - Parsed JSON object
 * @param {string} [prefix=''] - Current JSON Pointer prefix
 * @param {number} [depth=1] - Current recursion depth (max 5)
 * @returns {{
 *   added: string[],
 *   removed: string[],
 *   typeChanged: Array<{ path: string, expected: string, actual: string }>
 * }}
 */
export function computeStructuralDiff(schema, payload, prefix = '', depth = 1) {
  const added = [];
  const removed = [];
  const typeChanged = [];

  if (
    !schema ||
    typeof schema !== 'object' ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    depth > 5
  ) {
    return { added, removed, typeChanged };
  }

  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  // 1. Detect removed required fields
  for (const reqKey of required) {
    if (!(reqKey in payload)) {
      removed.push(`${prefix}/${reqKey}`);
    }
  }

  // 2. Iterate payload keys for added and typeChanged
  for (const [key, val] of Object.entries(payload)) {
    const fieldPath = `${prefix}/${key}`;

    if (!(key in properties)) {
      added.push(fieldPath);
      continue;
    }

    const fieldSchema = properties[key];
    const actualType = getJsonType(val);
    const expectedType = fieldSchema.type;

    if (expectedType && !typesMatch(expectedType, actualType)) {
      typeChanged.push({
        path: fieldPath,
        expected: Array.isArray(expectedType) ? expectedType.join('|') : expectedType,
        actual: actualType === 'integer' ? 'number' : actualType,
      });
    } else if (
      actualType === 'object' &&
      val !== null &&
      fieldSchema.type === 'object' &&
      depth < 5
    ) {
      // Recurse into nested objects
      const nestedDiff = computeStructuralDiff(fieldSchema, val, fieldPath, depth + 1);
      added.push(...nestedDiff.added);
      removed.push(...nestedDiff.removed);
      typeChanged.push(...nestedDiff.typeChanged);
    }
  }

  return { added, removed, typeChanged };
}
