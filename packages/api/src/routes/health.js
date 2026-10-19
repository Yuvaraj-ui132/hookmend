/**
 * routes/health.js — GET /health
 *
 * Returns: { status, uptime, mongo, redis, version, timestamp }
 * Mongo check: db.command({ ping: 1 })
 * Redis: "not_configured" in Phase 1
 */

import { Router } from 'express';

export function createHealthRouter({ db, queue, config }) {
  const router = Router();

  router.get('/health', async (req, res) => {
    let mongoStatus = 'disconnected';
    try {
      await db.command({ ping: 1 });
      mongoStatus = 'connected';
    } catch {
      mongoStatus = 'disconnected';
    }

    let redisStatus = 'disconnected';
    if (queue && typeof queue.ping === 'function') {
      const ok = await queue.ping(1500);
      redisStatus = ok ? 'connected' : 'disconnected';
    } else {
      redisStatus = 'not_configured';
    }

    const isOk =
      mongoStatus === 'connected' &&
      (redisStatus === 'connected' || redisStatus === 'not_configured');
    const status = isOk ? 'ok' : 'degraded';

    res.json({
      status,
      uptime: Math.floor(process.uptime()),
      mongo: mongoStatus,
      redis: redisStatus,
      version: config.VERSION || '0.2.0',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
