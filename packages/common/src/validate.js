/**
 * validate.js — Ajv draft-07 wrapper for payload schema validation.
 *
 * D6: draft-07 Ajv with allErrors:true and strict:false.
 * Caches compiled validators by schema _id + version.
 * Converts Ajv errors to [{path: instancePath, keyword}] only (max 20 items).
 * Never leaks payload values or raw schema definitions in stored errors.
 */

import Ajv from 'ajv';

const ajv = new Ajv({
  allErrors: true,
  strict: false,
});

/** @type {Map<string, import('ajv').ValidateFunction>} */
const validatorCache = new Map();

/**
 * Validates a payload against a versioned JSON Schema document.
 *
 * @param {object} schemaDoc - Schema document with { _id, version, schema }
 * @param {object} payload - Parsed JSON object to validate
 * @returns {{
 *   valid: boolean,
 *   errors: Array<{ path: string, keyword: string }>
 * }}
 */
export function validatePayload(schemaDoc, payload) {
  if (!schemaDoc) {
    return { valid: true, errors: [] };
  }

  const schemaObj = schemaDoc.schema || schemaDoc;
  const cacheKey = `${schemaDoc._id || 'schema'}_v${schemaDoc.version || 1}`;

  let validateFn = validatorCache.get(cacheKey);
  if (!validateFn) {
    validateFn = ajv.compile(schemaObj);
    validatorCache.set(cacheKey, validateFn);
  }

  const valid = validateFn(payload);

  if (valid) {
    return { valid: true, errors: [] };
  }

  // Convert Ajv errors to value-free { path, keyword } entries (capped at 20)
  const errors = (validateFn.errors || []).slice(0, 20).map((err) => ({
    path: err.instancePath || '',
    keyword: err.keyword || '',
  }));

  return { valid: false, errors };
}
