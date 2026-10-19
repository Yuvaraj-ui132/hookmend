#!/usr/bin/env node
/**
 * receiver.js — Lightweight HTTP webhook receiver for testing delivery.
 *
 * Exposes:
 *   POST /receive  — Main webhook destination
 *   GET  /__stats  — Request counts per x-hookmend-event-id
 *   POST /__mode   — Change behavior: "ok" | "fail503" | "fail400" | "timeout"
 */

import { createServer } from 'node:http';

export function startReceiver({ port = 4001 } = {}) {
  let mode = 'ok';
  const stats = {};
  let totalRequests = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/__stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ stats, totalRequests, mode }));
    }

    if (req.method === 'POST' && url.pathname === '/__mode') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const json = JSON.parse(body || '{}');
          if (json.mode) mode = json.mode;
        } catch {
          // ignore
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ mode }));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/receive') {
      const eventId = req.headers['x-hookmend-event-id'] || 'unknown';
      stats[eventId] = (stats[eventId] || 0) + 1;
      totalRequests++;

      // Read stream
      req.on('data', () => {});
      req.on('end', () => {
        if (mode === 'fail503') {
          res.writeHead(503, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Service Unavailable' }));
        }

        if (mode === 'fail400') {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Bad Request' }));
        }

        if (mode === 'timeout') {
          // Hold request open longer than client timeout
          setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(504, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'Gateway Timeout' }));
            }
          }, 30000);
          return;
        }

        // Default: ok (200)
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, eventId }));
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const resolvedPort = server.address().port;
      resolve({
        server,
        port: resolvedPort,
        getStats: () => ({ stats: { ...stats }, totalRequests }),
        setMode: (m) => {
          mode = m;
        },
        clear: () => {
          for (const k of Object.keys(stats)) delete stats[k];
          totalRequests = 0;
          mode = 'ok';
        },
        close: () => new Promise((cb) => server.close(cb)),
      });
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith('receiver.js')) {
  const port = parseInt(process.env.PORT || '4001', 10);
  startReceiver({ port }).then(() => {
    console.log(`[receiver] Listening on port ${port}`);
  });
}
