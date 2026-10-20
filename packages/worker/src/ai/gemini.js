/**
 * ai/gemini.js — Google Gemini client for schema drift proposals (D28).
 */

import { GoogleGenAI } from '@google/genai';

const PROPOSAL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    proposedSchemaJson: {
      type: 'string',
      description: 'JSON Schema (draft-07) as a JSON-encoded string resolving the drift',
    },
    fieldMappings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['from', 'to'],
      },
    },
    confidence: {
      type: 'number',
      description: 'Confidence score between 0.0 and 1.0',
    },
    rationale: {
      type: 'string',
      description: 'Brief explanation (max 1000 characters) of the schema changes',
    },
  },
  required: ['proposedSchemaJson', 'fieldMappings', 'confidence', 'rationale'],
};

/**
 * Creates a Gemini client wrapper for schema drift analysis.
 *
 * @param {{
 *   config?: object,
 *   logger?: object
 * }} options
 * @returns {{
 *   generate: (params: { system: string, user: string | object }) => Promise<object>,
 *   model: string
 * }}
 */
export function createGeminiClient({ config = {}, logger = console } = {}) {
  const apiKey = config.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  const model = config.GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const enableAi = Boolean(config.ENABLE_AI ?? (process.env.ENABLE_AI === 'true'));

  if (enableAi && !apiKey) {
    throw new Error('GEMINI_API_KEY is required when ENABLE_AI is true');
  }

  const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

  return {
    model,
    async generate({ system, user }) {
      if (!ai) {
        throw new Error('Gemini client not initialized: missing API key');
      }

      const promptText = typeof user === 'string' ? user : JSON.stringify(user, null, 2);

      const response = await ai.models.generateContent({
        model,
        contents: promptText,
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseSchema: PROPOSAL_RESPONSE_SCHEMA,
        },
      });

      const rawText = response.text?.trim() || '{}';
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch (err) {
        throw new Error(`Failed to parse Gemini JSON response: ${err.message}`);
      }

      // Normalize if model returned object instead of string
      if (typeof parsed.proposedSchemaJson === 'object' && parsed.proposedSchemaJson !== null) {
        parsed.proposedSchemaJson = JSON.stringify(parsed.proposedSchemaJson);
      } else if (!parsed.proposedSchemaJson && parsed.proposedSchema) {
        parsed.proposedSchemaJson = typeof parsed.proposedSchema === 'string'
          ? parsed.proposedSchema
          : JSON.stringify(parsed.proposedSchema);
      }

      if (!Array.isArray(parsed.fieldMappings)) {
        parsed.fieldMappings = [];
      }

      if (typeof parsed.confidence !== 'number') {
        parsed.confidence = 0.5;
      }

      if (typeof parsed.rationale !== 'string') {
        parsed.rationale = 'Schema updated to reflect observed drift';
      }

      return {
        proposedSchemaJson: parsed.proposedSchemaJson,
        fieldMappings: parsed.fieldMappings,
        confidence: parsed.confidence,
        rationale: parsed.rationale,
      };
    },
  };
}
