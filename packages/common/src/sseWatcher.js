/**
 * packages/common/src/sseWatcher.js
 * D36: MongoDB change stream watcher with resilience.
 *
 * - ONE change stream per API instance watching events + proposals
 * - $project drops payload, headers, rawBodyHash
 * - Fan-out to registered client callbacks
 * - Exponential backoff restart: 1s doubling to 30s
 * - Broadcasts resync after every restart
 * - Resume token kept in memory
 * - Graceful close via stop()
 * - Status: 'connected' | 'reconnecting' | 'unavailable'
 */

import { changeToSseEvent } from './sse.js';
import logger from './logger.js';

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

/**
 * @param {{ db: import('mongodb').Db, config: object }} options
 */
export function createSseWatcher({ db, config = {} }) {
  const minBackoff = config.SSE_WATCHER_MIN_BACKOFF_MS != null ? config.SSE_WATCHER_MIN_BACKOFF_MS : MIN_BACKOFF_MS;
  const maxBackoff = config.SSE_WATCHER_MAX_BACKOFF_MS != null ? config.SSE_WATCHER_MAX_BACKOFF_MS : MAX_BACKOFF_MS;

  let status = 'reconnecting';
  let stream = null;
  let resumeToken = null;
  let backoffMs = minBackoff;
  let stopped = false;
  let restartTimer = null;

  // Set of callback functions: (sseEvent: {event, data}) => void
  const listeners = new Set();

  function getStatus() {
    return status;
  }

  function addListener(fn) {
    listeners.add(fn);
  }

  function removeListener(fn) {
    listeners.delete(fn);
  }

  function broadcast(sseEvent) {
    for (const fn of listeners) {
      try {
        fn(sseEvent);
      } catch (err) {
        logger.error({ err }, 'SSE listener callback error');
      }
    }
  }

  function broadcastResync() {
    broadcast({ event: 'resync', data: {} });
  }

  async function openStream(isRestart = false) {
    if (stopped) return;

    // Security $project: drop payload, headers, rawBodyHash
    const project = {
      $project: {
        payload: 0,
        headers: 0,
        rawBodyHash: 0,
      },
    };

    const pipeline = [project];

    const changeStreamOptions = {
      fullDocument: 'updateLookup',
      fullDocumentBeforeChange: 'off',
    };

    if (resumeToken) {
      changeStreamOptions.resumeAfter = resumeToken;
    }

    try {
      stream = db.watch(pipeline, changeStreamOptions);

      stream.on('change', (change) => {
        resumeToken = change._id;
        backoffMs = minBackoff; // reset on successful event

        const sseEvent = changeToSseEvent(change);
        if (sseEvent) {
          broadcast(sseEvent);
        }
      });

      stream.on('error', (err) => {
        logger.error({ err }, 'SSE change stream error');
        scheduleRestart();
      });

      stream.on('close', () => {
        if (!stopped) {
          logger.warn('SSE change stream closed unexpectedly');
          scheduleRestart();
        }
      });

      status = 'connected';

      if (isRestart) {
        broadcastResync();
      }

      logger.info({ resumeToken: !!resumeToken }, 'SSE change stream opened');
    } catch (err) {
      // Change streams unsupported (standalone Mongo) or connection error
      const msg = err?.message || '';
      if (msg.includes('$changeStream') || msg.includes('oplog') || msg.includes('replica')) {
        logger.error({ err }, 'Change streams unsupported on this MongoDB deployment; SSE unavailable');
        status = 'unavailable';
        return;
      }

      // Transient error — try resume, then fresh
      if (resumeToken) {
        logger.warn({ err }, 'Change stream open failed with resume token; will retry without token');
        resumeToken = null;
      } else {
        logger.error({ err }, 'Change stream open failed; scheduling restart');
      }
      scheduleRestart();
    }
  }

  function scheduleRestart() {
    if (stopped) return;
    status = 'reconnecting';

    if (stream) {
      stream.removeAllListeners();
      stream.close().catch(() => {});
      stream = null;
    }

    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, maxBackoff);

    logger.info({ delayMs: delay }, 'Scheduling SSE change stream restart');
    restartTimer = setTimeout(() => {
      openStream(true);
    }, delay);
  }

  async function start() {
    stopped = false;
    await openStream(false);
  }

  async function stop() {
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (stream) {
      stream.removeAllListeners();
      await stream.close().catch(() => {});
      stream = null;
    }
    status = 'reconnecting';
    logger.info('SSE change stream watcher stopped');
  }

  /** For testing: force a restart so resync is broadcast */
  function forceRestart() {
    scheduleRestart();
  }

  return {
    start,
    stop,
    forceRestart,
    addListener,
    removeListener,
    getStatus,
    get status() {
      return status;
    },
  };
}
