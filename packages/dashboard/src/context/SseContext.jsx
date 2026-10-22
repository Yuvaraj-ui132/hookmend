/**
 * src/context/SseContext.jsx — SSE connection context
 * Manages single SSE client shared across the whole app.
 */

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { createSseClient } from '../api/sse.js';
import { useAuth } from './AuthContext.jsx';

const SseContext = createContext(null);

export function SseProvider({ children }) {
  const { token } = useAuth();
  const [sseStatus, setSseStatus] = useState('reconnecting');
  const refetchCallbacks = useRef(new Set());
  const clientRef = useRef(null);

  const addRefetchCallback = useCallback((fn) => {
    refetchCallbacks.current.add(fn);
    return () => refetchCallbacks.current.delete(fn);
  }, []);

  const [lastEvent, setLastEvent] = useState(null);

  useEffect(() => {
    if (!token) {
      setSseStatus('reconnecting');
      return;
    }

    const client = createSseClient({
      token,
      onEvent: (evt) => {
        setLastEvent({ ...evt, _ts: Date.now() });
      },
      onResync: () => {
        refetchCallbacks.current.forEach((fn) => {
          try { fn(); } catch { /* ignore */ }
        });
      },
      onStatusChange: setSseStatus,
    });

    clientRef.current = client;
    client.start();

    return () => {
      client.stop();
      clientRef.current = null;
    };
  }, [token]);

  return (
    <SseContext.Provider value={{ sseStatus, lastEvent, addRefetchCallback }}>
      {children}
    </SseContext.Provider>
  );
}

export function useSse() {
  const ctx = useContext(SseContext);
  if (!ctx) throw new Error('useSse must be inside SseProvider');
  return ctx;
}
