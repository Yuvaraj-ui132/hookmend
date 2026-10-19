#!/usr/bin/env node
/**
 * infra/seed/seed.js — Idempotent seed for sources and active schemas collections.
 *
 * Upserts:
 *   - Sources: github-main (github), sim-payments (generic-hmac)
 *   - Schemas:
 *       sim-payments / payment.created v1 (draft-07 strict)
 *       github-main / push v1 (draft-07 permissive)
 */

import { MongoClient } from 'mongodb';
import { createIndexes } from '@hookmend/common';

const DEFAULT_MONGODB_URI =
  process.env.MONGODB_URI ||
  'mongodb://localhost:27017/hookmend?directConnection=true';

const SOURCES = [
  {
    slug: 'github-main',
    name: 'GitHub Main Repository',
    adapter: 'github',
    secretEnvVar: 'GITHUB_WEBHOOK_SECRET',
    downstreamUrl: 'http://localhost:4001/receive',
    active: true,
  },
  {
    slug: 'sim-payments',
    name: 'Payment Simulator',
    adapter: 'generic-hmac',
    secretEnvVar: 'SIM_WEBHOOK_SECRET',
    downstreamUrl: 'http://localhost:4001/receive',
    active: true,
  },
];

export async function seed(uri = DEFAULT_MONGODB_URI) {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();

    // Ensure idempotent indexes are created
    await createIndexes(db);

    const sources = db.collection('sources');
    const schemas = db.collection('schemas');
    const now = new Date();

    // 1. Seed sources
    for (const src of SOURCES) {
      const result = await sources.updateOne(
        { slug: src.slug },
        {
          $set: { ...src, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );
      const action = result.upsertedCount > 0 ? 'inserted' : 'updated';
      console.log(`[seed] Source ${action}: ${src.slug}`);
    }

    const simSource = await sources.findOne({ slug: 'sim-payments' });
    const ghSource = await sources.findOne({ slug: 'github-main' });

    // 2. Seed active schema v1 for sim-payments / payment.created
    if (simSource) {
      await schemas.updateOne(
        { sourceId: simSource._id, eventType: 'payment.created', version: 1 },
        {
          $set: {
            sourceId: simSource._id,
            eventType: 'payment.created',
            version: 1,
            active: true,
            activatedBy: 'system:seed',
            activatedAt: now,
            schema: {
              $schema: 'http://json-schema.org/draft-07/schema#',
              type: 'object',
              required: ['event', 'orderId', 'amount', 'amountPaise', 'utr', 'paymentId'],
              properties: {
                event: { type: 'string' },
                orderId: { type: 'string' },
                amount: { type: 'number' },
                amountPaise: { type: 'number' },
                utr: { type: 'string' },
                paymentId: { type: 'string' },
              },
              additionalProperties: false,
            },
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );
      console.log('[seed] Schema active: sim-payments / payment.created v1');
    }

    // 3. Seed active schema v1 for github-main / push
    if (ghSource) {
      await schemas.updateOne(
        { sourceId: ghSource._id, eventType: 'push', version: 1 },
        {
          $set: {
            sourceId: ghSource._id,
            eventType: 'push',
            version: 1,
            active: true,
            activatedBy: 'system:seed',
            activatedAt: now,
            schema: {
              $schema: 'http://json-schema.org/draft-07/schema#',
              type: 'object',
              additionalProperties: true,
            },
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );
      console.log('[seed] Schema active: github-main / push v1');
    }

    console.log('[seed] Done.');
  } finally {
    await client.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seed().catch((err) => {
    console.error('[seed] Error:', err);
    process.exit(1);
  });
}
