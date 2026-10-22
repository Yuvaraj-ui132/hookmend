/**
 * src/components/LoginPage.jsx — (D43)
 * Asks for admin token at runtime. Never stores to localStorage.
 */

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

export default function LoginPage() {
  const { login } = useAuth();
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!value.trim()) {
      setError('Token is required.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      // Quick auth check
      const res = await fetch(
        `${import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000'}/api/stats`,
        { headers: { Authorization: `Bearer ${value.trim()}` } }
      );
      if (res.status === 401) {
        setError('Invalid token. Please check and try again.');
        setLoading(false);
        return;
      }
      login(value.trim(), remember);
    } catch {
      setError('Could not reach the API. Check VITE_API_BASE_URL.');
      setLoading(false);
    }
  }

  return (
    <main className="login-page" aria-label="Login">
      <div className="login-card">
        <h1 className="login-logo">Hookmend</h1>
        <p className="login-sub">Webhook drift monitoring</p>

        <form onSubmit={handleSubmit} aria-label="Login form">
          <div className="form-group">
            <label className="form-label" htmlFor="token-input">Admin Token</label>
            <input
              id="token-input"
              type="password"
              className="form-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Enter your admin token"
              autoComplete="current-password"
              required
            />
          </div>

          <div className="form-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '.5rem' }}>
            <input
              type="checkbox"
              id="remember-tab"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <label htmlFor="remember-tab" className="form-label" style={{ marginBottom: 0 }}>
              Remember for this tab
            </label>
          </div>

          {error && <p className="form-error" role="alert">{error}</p>}

          <button
            id="login-btn"
            type="submit"
            className="btn btn-primary w-full"
            style={{ marginTop: '.5rem' }}
            disabled={loading}
          >
            {loading ? 'Connecting…' : 'Sign In'}
          </button>
        </form>
      </div>
    </main>
  );
}
