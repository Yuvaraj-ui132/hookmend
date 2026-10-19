#!/usr/bin/env node
/**
 * infra/seed/seed.js — Idempotent seed for sources collection.
 *
 * Upserts:
 *   - github-main  (adapter: github)
 *   - sim-payments (adapter: generic-hmac)
 *
 * Run: node infra/seed/seed.js
 * Requires MONGODB_URI env var (or docker compose mongo running on default).
 */

import { MongoClient } from 'mongodb';

const MONGODB_URI =
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

async function seed() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db();
    const sources = db.collection('sources');

    for (const src of SOURCES) {
      const now = new Date();
      const result = await sources.updateOne(
        { slug: src.slug },
        {
          $set: { ...src, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );
      const action = result.upsertedCount > 0 ? 'inserted' : 'updated';
      console.log(`[seed] ${action}: ${src.slug}`);
    }

    console.log('[seed] Done.');
  } finally {
    await client.close();
  }
}

seed().catch((err) => {
  console.error('[seed] Error:', err);
  process.exit(1);
});
