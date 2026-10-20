#!/usr/bin/env node
/**
 * smoke-gemini.js — Standalone live smoke test for Gemini API integration.
 * Run manually with: node packages/worker/scripts/smoke-gemini.js
 * NOT run during npm test.
 */

import { validateAiOutput } from '@hookmend/common';
import { createGeminiClient } from '../src/ai/gemini.js';

async function runSmokeTest() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('[smoke-gemini] SKIPPED: GEMINI_API_KEY is not set in environment.');
    process.exit(0);
  }

  console.log('[smoke-gemini] Starting live Gemini call...');
  const client = createGeminiClient({
    config: {
      ENABLE_AI: true,
      GEMINI_API_KEY: apiKey,
      GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    },
  });

  const baseSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['orderId', 'amount'],
    properties: {
      orderId: { type: 'string' },
      amount: { type: 'number' },
    },
    additionalProperties: false,
  };

  const diff = {
    added: ['/currency'],
    removed: [],
    typeChanged: [{ path: '/amount', from: 'number', to: 'string' }],
  };

  try {
    const result = await client.generate({
      system: 'You are a JSON Schema migration assistant. Resolve observed drift into a valid draft-07 JSON Schema.',
      user: {
        baseSchema,
        diff,
      },
    });

    console.log('[smoke-gemini] Received result from model:');
    console.log(' - confidence:', result.confidence);
    console.log(' - rationale:', result.rationale);
    console.log(' - fieldMappings:', result.fieldMappings);

    const validation = validateAiOutput(result, [], 102400);
    if (!validation.ok) {
      console.error('[smoke-gemini] FAIL: Containment validation failed:', validation.reason);
      process.exit(1);
    }

    console.log('[smoke-gemini] PASS: Containment validation succeeded!');
    process.exit(0);
  } catch (err) {
    console.error('[smoke-gemini] FAIL: Error calling Gemini API:', err.message);
    process.exit(1);
  }
}

runSmokeTest();
