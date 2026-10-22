/**
 * src/context/AuthContext.jsx — (D43)
 * Token kept in React state. Optionally mirrored to sessionStorage with try/catch.
 * Never logged or rendered.
 */

import React, { createContext, useContext, useState, useCallback } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => {
    // Try to restore from sessionStorage on load
    try {
      return sessionStorage.getItem('hm_token') || '';
    } catch {
      return '';
    }
  });

  const login = useCallback((t, remember) => {
    setToken(t);
    if (remember) {
      try { sessionStorage.setItem('hm_token', t); } catch { /* ignore */ }
    }
  }, []);

  const logout = useCallback(() => {
    setToken('');
    try { sessionStorage.removeItem('hm_token'); } catch { /* ignore */ }
  }, []);

  return (
    <AuthContext.Provider value={{ token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
