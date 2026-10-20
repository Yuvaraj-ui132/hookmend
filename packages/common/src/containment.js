/**
 * containment.js — Output containment validation for AI-generated schema proposals (D29).
 */

import Ajv from 'ajv';

const ALLOWED_OUTPUT_KEYS = new Set([
  'proposedSchemaJson',
  'fieldMappings',
  'confidence',
  'rationale',
]);

/**
 * Checks if any object in the schema tree contains a $ref starting with 'http'.
 */
function hasHttpRef(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.$ref === 'string' && obj.$ref.toLowerCase().startsWith('http')) {
    return true;
  }
  for (const val of Object.values(obj)) {
    if (hasHttpRef(val)) return true;
  }
  return false;
}

/**
 * Recursively extracts all string values of length >= 4 from payload objects.
 */
function extractPayloadStrings(payload, collected = new Set()) {
  if (!payload || typeof payload !== 'object') {
    if (typeof payload === 'string' && payload.length >= 4) {
      collected.add(payload);
    }
    return collected;
  }

  for (const val of Object.values(payload)) {
    if (typeof val === 'string' && val.length >= 4) {
      collected.add(val);
    } else if (val && typeof val === 'object') {
      extractPayloadStrings(val, collected);
    }
  }

  return collected;
}

/**
 * Validates AI output against strict containment rules before acceptance.
 *
 * @param {object} output
 * @param {Array<object>} [sampleEventPayloads=[]]
 * @param {number} [maxSchemaBytes=102400]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateAiOutput(output, sampleEventPayloads = [], maxSchemaBytes = 102400) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { ok: false, reason: 'AI output must be an object' };
  }

  // 1. Strict top-level key check
  for (const key of Object.keys(output)) {
    if (!ALLOWED_OUTPUT_KEYS.has(key)) {
      return { ok: false, reason: `Unknown top-level key: ${key}` };
    }
  }

  // 2. proposedSchemaJson checks
  if (typeof output.proposedSchemaJson !== 'string') {
    return { ok: false, reason: 'proposedSchemaJson must be a string' };
  }

  const byteLength = Buffer.byteLength(output.proposedSchemaJson, 'utf8');
  if (byteLength > maxSchemaBytes) {
    return { ok: false, reason: `proposedSchemaJson exceeds max size of ${maxSchemaBytes} bytes` };
  }

  let parsedSchema;
  try {
    parsedSchema = JSON.parse(output.proposedSchemaJson);
  } catch (err) {
    return { ok: false, reason: `proposedSchemaJson is not valid JSON: ${err.message}` };
  }

  if (!parsedSchema || typeof parsedSchema !== 'object' || Array.isArray(parsedSchema)) {
    return { ok: false, reason: 'proposedSchemaJson must parse to an object' };
  }

  // 3. Draft-07 check
  if (parsedSchema.$schema && !parsedSchema.$schema.includes('draft-07')) {
    return { ok: false, reason: '$schema must be draft-07' };
  }

  // 4. HTTP $ref check
  if (hasHttpRef(parsedSchema)) {
    return { ok: false, reason: 'Schema cannot contain $ref starting with http' };
  }

  // 5. Ajv compilation check
  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    ajv.compile(parsedSchema);
  } catch (err) {
    return { ok: false, reason: `Schema failed Ajv compilation: ${err.message}` };
  }

  // 6. Confidence range check
  if (
    typeof output.confidence !== 'number' ||
    Number.isNaN(output.confidence) ||
    output.confidence < 0 ||
    output.confidence > 1
  ) {
    return { ok: false, reason: 'confidence must be a number between 0 and 1' };
  }

  // 7. Rationale length check
  if (typeof output.rationale !== 'string' || output.rationale.length > 1000) {
    return { ok: false, reason: 'rationale must be a string <= 1000 characters' };
  }

  // 8. FieldMappings structure check
  if (output.fieldMappings && !Array.isArray(output.fieldMappings)) {
    return { ok: false, reason: 'fieldMappings must be an array' };
  }

  // 9. Payload value leakage check
  const payloadStrings = new Set();
  for (const sample of sampleEventPayloads) {
    extractPayloadStrings(sample, payloadStrings);
  }

  for (const str of payloadStrings) {
    if (output.rationale.includes(str)) {
      return { ok: false, reason: 'rationale contains leaked payload value' };
    }

    if (Array.isArray(output.fieldMappings)) {
      for (const mapping of output.fieldMappings) {
        if (typeof mapping.note === 'string' && mapping.note.includes(str)) {
          return { ok: false, reason: 'fieldMappings note contains leaked payload value' };
        }
      }
    }
  }

  return { ok: true };
}
