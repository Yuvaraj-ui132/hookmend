/**
 * server.js — createApp factory.
 *
 * Does NOT listen. main.js calls app.listen().
 * Receives db, queue, config, watcher as injected dependencies.
 */

import express from 'express';
import { requestIdMiddleware } from './middleware/requestId.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createCorsMiddleware } from './middleware/cors.js';
import { secureHeaders } from './middleware/secureHeaders.js';
import { createHealthRouter } from './routes/health.js';
import { createIngestRouter } from './routes/ingest.js';
import { createAdminRouter } from './routes/admin.js';
import { createSseRouter } from './routes/sse.js';

/**
 * @param {{ db: import('mongodb').Db, queue: object, config: object, watcher?: object }} deps
 * @returns {import('express').Application}
 */
export function createApp({ db, queue, config, watcher = null }) {
  const app = express();

  // Trust proxy for correct IP in rate-limit keying
  app.set('trust proxy', 1);

  // Request ID on all routes
  app.use(requestIdMiddleware);

  // Create SSE router (before admin so we can pass sseClientCount)
  const { router: sseRouter, getClientCount } = createSseRouter({ watcher, config });

  // CORS — ONLY for /api routes (not /ingest) (D40)
  const corsMiddleware = createCorsMiddleware(config);
  app.use('/api', corsMiddleware);

  // Secure headers — D54(d): applied to all /api responses
  app.use('/api', secureHeaders);

  // Routes
  app.use(createHealthRouter({ db, queue, config, watcher, sseClientCount: getClientCount }));
  app.use(createIngestRouter({ db, queue, config }));
  app.use('/api', sseRouter);
  app.use('/api', express.json(), createAdminRouter({
    db,
    queue,
    config,
    sseClientCount: getClientCount,
    watcher,
  }));

  // Central error handler (must be last)
  app.use(errorHandler);

  return app;
}
