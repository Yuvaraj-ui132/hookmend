#!/usr/bin/env node
/**
 * simulator/src/sender.js — CLI webhook sender
 *
 * Usage:
 *   node sender.js --url http://localhost:3000 --slug sim-payments --count 20 --duplicates 5 --drift
 *
 * Reads SIM_WEBHOOK_SECRET from env.
 */

import { randomUUID } from 'node:crypto';
import { signGenericHmac, buildPaymentEvent } from './sign.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function sendEvent(url, slug, body, deliveryId, secret) {
  const ts = String(Date.now());
  const rawBody = JSON.stringify(body);
  const sig = signGenericHmac(secret, ts, rawBody);

  const res = await fetch(`${url}/ingest/${slug}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gateway-signature': sig,
      'x-gateway-timestamp': ts,
      'x-gateway-delivery-id': deliveryId,
    },
    body: rawBody,
  });

  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || 'http://localhost:3000';
  const slug = args.slug || 'sim-payments';
  const count = parseInt(args.count || '20', 10);
  const duplicates = parseInt(args.duplicates || '0', 10);
  const drift = args.drift === true || args.drift === 'true';
  const secret = process.env.SIM_WEBHOOK_SECRET;

  if (!secret) {
    console.error('SIM_WEBHOOK_SECRET is not set');
    process.exit(1);
  }

  console.log(`Sending ${count} events + ${duplicates} duplicates to ${url}/ingest/${slug}`);

  // Generate unique events
  const events = Array.from({ length: count }, () => ({
    deliveryId: randomUUID(),
    body: buildPaymentEvent({ drift }),
  }));

  const results = { '200': 0, other: {}, deduplicated: 0 };

  // Send unique events
  for (const ev of events) {
    const r = await sendEvent(url, slug, ev.body, ev.deliveryId, secret);
    if (r.status === 200) {
      results['200']++;
      if (r.body.deduplicated) results.deduplicated++;
    } else {
      results.other[r.status] = (results.other[r.status] || 0) + 1;
    }
  }

  // Send duplicates of first N events
  for (let i = 0; i < duplicates && i < events.length; i++) {
    const ev = events[i];
    const r = await sendEvent(url, slug, ev.body, ev.deliveryId, secret);
    if (r.status === 200) {
      results['200']++;
      if (r.body.deduplicated) results.deduplicated++;
    } else {
      results.other[r.status] = (results.other[r.status] || 0) + 1;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Total 200 OK:    ${results['200']}`);
  console.log(`Deduplicated:    ${results.deduplicated}`);
  if (Object.keys(results.other).length > 0) {
    console.log(`Other statuses:  ${JSON.stringify(results.other)}`);
  }
}

main().catch(console.error);
