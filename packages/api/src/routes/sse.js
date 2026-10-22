/**
 * routes/sse.js — GET /api/sse (D33-D37).
 *
 * Auth: Authorization Bearer header only (D33).
 * Fan-out via watcher listeners (D35).
 * Heartbeat comment ": heartbeat" every SSE_HEARTBEAT_MS (default 25000) (D35).
 * Cap MAX_SSE_CLIENTS → 503 TOO_MANY_STREAMS (D35).
 * Drop slow consumers if writableLength > 1 MB (D35).
 * No replay buffer — clients refetch on reconnect (D35).
 * SSE data contains only allow-listed fields (D34).
 */

import { Router } from 'express';
import { createAdminAuthMiddleware } from '../middleware/adminAuth.js';
import { AppError } from '../middleware/errorHandler.js';
import logger from '../logger.js';

const ONE_MB = 1024 * 1024;

export function createSseRouter({ watcher, config }) {
  const router = Router();
  const auth = createAdminAuthMiddleware(config);

  const MAX_CLIENTS = config.MAX_SSE_CLIENTS != null ? config.MAX_SSE_CLIENTS : 20;
  const HEARTBEAT_MS = config.SSE_HEARTBEAT_MS != null ? config.SSE_HEARTBEAT_MS : 25000;

  // Track connected clients: Map<res, { id counter, heartbeat timer }>
  const clients = new Set();

  // Per-instance monotonic counter for `id:` field
  let globalEventId = 0;

  /**
   * Format a single SSE message.
   */
  function formatSse({ event, data, id }) {
    let msg = '';
    if (id != null) msg += `id: ${id}\n`;
    if (event) msg += `event: ${event}\n`;
    msg += `data: ${JSON.stringify(data)}\n\n`;
    return msg;
  }

  /**
   * Send an SSE event to a specific client response.
   * Returns false if write failed or client is a slow consumer.
   */
  function sendToClient(res, sseEvent) {
    if (!res.writable) return false;

    // Drop slow consumers
    if (res.writableLength > ONE_MB) {
      logger.warn('Dropping slow SSE consumer (writableLength > 1 MB)');
      res.end();
      return false;
    }

    const id = ++globalEventId;
    try {
      res.write(formatSse({ event: sseEvent.event, data: sseEvent.data, id }));
      if (typeof res.flush === 'function') res.flush();
    } catch (err) {
      logger.error({ err }, 'SSE write error');
      return false;
    }
    return true;
  }

  // Register watcher listener for fan-out
  if (watcher) {
    watcher.addListener((sseEvent) => {
      const dead = [];
      for (const res of clients) {
        if (!res.writable) {
          dead.push(res);
          continue;
        }
        const ok = sendToClient(res, sseEvent);
        if (!ok) dead.push(res);
      }
      for (const res of dead) clients.delete(res);
    });
  }

  router.get('/sse', auth, (req, res, next) => {
    // Check SSE availability
    if (watcher && watcher.getStatus() === 'unavailable') {
      return next(new AppError('SSE_UNAVAILABLE', 'Server-sent events are not available on this MongoDB deployment', 503));
    }

    // Client cap
    if (clients.size >= MAX_CLIENTS) {
      return next(new AppError('TOO_MANY_STREAMS', 'Maximum SSE client connections reached', 503));
    }

    // SSE headers (D35)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Register client
    clients.add(res);
    logger.info({ sseClients: clients.size }, 'SSE client connected');

    // Heartbeat timer
    const heartbeat = setInterval(() => {
      if (!res.writable) {
        clearInterval(heartbeat);
        clients.delete(res);
        return;
      }
      try {
        res.write(': heartbeat\n\n');
        if (typeof res.flush === 'function') res.flush();
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, HEARTBEAT_MS);

    // Cleanup on client disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      logger.info({ sseClients: clients.size }, 'SSE client disconnected');
    });
  });

  /**
   * Returns number of currently connected clients.
   */
  function getClientCount() {
    return clients.size;
  }

  return { router, getClientCount };
}
