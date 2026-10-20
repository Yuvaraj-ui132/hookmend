/**
 * redact.js — Schema redaction allow-list for AI prompts (D28).
 * Strips enums, descriptions, examples, defaults, titles, and non-structural metadata.
 */

const ALLOWED_KEYS = new Set([
  '$schema',
  'type',
  'properties',
  'required',
  'items',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
  'format',
]);

/**
 * Returns a redacted copy of a JSON Schema containing only structural keys.
 *
 * @param {object} schema
 * @returns {object}
 */
export function redactSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }

  const result = {};

  for (const [key, val] of Object.entries(schema)) {
    if (!ALLOWED_KEYS.has(key)) {
      continue;
    }

    if (key === 'properties' && val && typeof val === 'object' && !Array.isArray(val)) {
      result.properties = {};
      for (const [pKey, pVal] of Object.entries(val)) {
        result.properties[pKey] = redactSchema(pVal);
      }
    } else if (key === 'items') {
      if (Array.isArray(val)) {
        result.items = val.map(redactSchema);
      } else if (val && typeof val === 'object') {
        result.items = redactSchema(val);
      } else {
        result.items = val;
      }
    } else if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(val)) {
      result[key] = val.map(redactSchema);
    } else if (key === 'required' && Array.isArray(val)) {
      result.required = [...val];
    } else {
      result[key] = val;
    }
  }

  return result;
}
