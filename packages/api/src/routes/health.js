/**
 * routes/health.js — GET /health
 *
 * Returns: { status, uptime, mongo, redis, version, timestamp }
 * Mongo check: db.command({ ping: 1 })
 * Redis: "not_configured" in Phase 1
 */

import { Router } from 'express';

export function createHealthRouter({ db, config }) {
  const router = Router();

  router.get('/health', async (req, res) => {
    let mongoStatus = 'disconnected';
    try {
      await db.command({ ping: 1 });
      mongoStatus = 'connected';
    } catch {
      mongoStatus = 'disconnected';
    }

    const status = mongoStatus === 'connected' ? 'ok' : 'degraded';

    res.json({
      status,
      uptime: Math.floor(process.uptime()),
      mongo: mongoStatus,
      redis: 'not_configured',
      version: config.VERSION || '0.2.0',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
