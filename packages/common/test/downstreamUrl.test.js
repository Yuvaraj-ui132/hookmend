/**
 * packages/common/test/downstreamUrl.test.js
 * Unit tests for validateDownstreamUrl (D39).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateDownstreamUrl } from '../src/downstreamUrl.js';

describe('validateDownstreamUrl', () => {
  // ── Non-HTTP schemes rejected ──────────────────────────────────────────────
  it('rejects ftp:// scheme', () => {
    expect(validateDownstreamUrl('ftp://example.com/webhook', {})).not.toBeNull();
  });

  it('accepts http:// public URL', () => {
    expect(validateDownstreamUrl('http://api.example.com/webhook', {})).toBeNull();
  });

  it('accepts https:// public URL', () => {
    expect(validateDownstreamUrl('https://hooks.example.com/receive', {})).toBeNull();
  });

  // ── 169.254.x.x always rejected (link-local / IMDS) ──────────────────────
  it('always rejects 169.254.0.1 (link-local)', () => {
    expect(validateDownstreamUrl('http://169.254.0.1/path', {})).not.toBeNull();
  });

  it('always rejects 169.254.169.254 (AWS IMDS)', () => {
    expect(validateDownstreamUrl('http://169.254.169.254/latest/meta-data/', {})).not.toBeNull();
  });

  it('always rejects metadata.google.internal', () => {
    expect(validateDownstreamUrl('http://metadata.google.internal/computeMetadata/v1/', {})).not.toBeNull();
  });

  // ── Loopback always rejected in production ─────────────────────────────────
  it('rejects loopback 127.0.0.1 in production', () => {
    expect(validateDownstreamUrl('http://127.0.0.1/hook', { NODE_ENV: 'production' })).not.toBeNull();
  });

  it('rejects localhost in production', () => {
    expect(validateDownstreamUrl('http://localhost/hook', { NODE_ENV: 'production' })).not.toBeNull();
  });

  // ── Private ranges rejected in production unless ALLOW_PRIVATE_DOWNSTREAM ──
  it('rejects 10.0.0.1 in production', () => {
    expect(validateDownstreamUrl('http://10.0.0.1/hook', { NODE_ENV: 'production' })).not.toBeNull();
  });

  it('rejects 172.16.0.1 in production', () => {
    expect(validateDownstreamUrl('http://172.16.0.1/hook', { NODE_ENV: 'production' })).not.toBeNull();
  });

  it('rejects 192.168.1.1 in production', () => {
    expect(validateDownstreamUrl('http://192.168.1.1/hook', { NODE_ENV: 'production' })).not.toBeNull();
  });

  it('allows 10.0.0.1 in production with ALLOW_PRIVATE_DOWNSTREAM=true', () => {
    expect(validateDownstreamUrl('http://10.0.0.1/hook', {
      NODE_ENV: 'production',
      ALLOW_PRIVATE_DOWNSTREAM: true,
    })).toBeNull();
  });

  it('allows 192.168.1.1 in development without flag', () => {
    expect(validateDownstreamUrl('http://192.168.1.1/hook', { NODE_ENV: 'development' })).toBeNull();
  });

  // ── Invalid URL ────────────────────────────────────────────────────────────
  it('rejects invalid URL string', () => {
    expect(validateDownstreamUrl('not-a-url', {})).not.toBeNull();
  });

  it('rejects empty string', () => {
    expect(validateDownstreamUrl('', {})).not.toBeNull();
  });

  // ── 172.31.x.x boundary (within 172.16/12) ────────────────────────────────
  it('rejects 172.31.0.1 in production', () => {
    expect(validateDownstreamUrl('http://172.31.0.1/hook', { NODE_ENV: 'production' })).not.toBeNull();
  });

  it('allows 172.15.0.1 in production (not in 172.16/12)', () => {
    expect(validateDownstreamUrl('http://172.15.0.1/hook', { NODE_ENV: 'production' })).toBeNull();
  });
});
