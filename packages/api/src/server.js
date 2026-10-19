/**
 * server.js — createApp factory.
 *
 * Does NOT listen. main.js calls app.listen().
 * Receives db, queue, config, logger as injected dependencies.
 */

import express from 'express';
import { requestIdMiddleware } from './middleware/requestId.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createHealthRouter } from './routes/health.js';
import { createIngestRouter } from './routes/ingest.js';

/**
 * @param {{ db: import('mongodb').Db, queue: object, config: object, logger?: object }} deps
 * @returns {import('express').Application}
 */
export function createApp({ db, queue, config }) {
  const app = express();

  // Trust proxy for correct IP in rate-limit keying
  app.set('trust proxy', 1);

  // Request ID on all routes
  app.use(requestIdMiddleware);

  // Routes
  app.use(createHealthRouter({ db, queue, config }));
  app.use(createIngestRouter({ db, queue, config }));

  // Central error handler (must be last)
  app.use(errorHandler);

  return app;
}
