/**
 * main.js — Entry point. Connects DB, starts server, handles graceful shutdown.
 */

import getConfig from './config.js';
import logger from './logger.js';
import { connectDb, closeDb, createBullQueue } from '@hookmend/common';
import { createApp } from './server.js';

async function main() {
  const config = getConfig();
  const mongoClient = await connectDb(config.MONGODB_URI);
  const db = mongoClient.db();

  const queue = createBullQueue({
    redisUrl: config.REDIS_URL,
    prefix: config.QUEUE_PREFIX,
  });

  const app = createApp({ db, queue, config });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'Hookmend API started');
  });

  async function shutdown(signal) {
    logger.info({ signal }, 'Graceful shutdown initiated');
    server.close(async () => {
      await queue.close();
      await closeDb();
      logger.info('Shutdown complete');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
