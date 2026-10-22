/**
 * src/components/Layout.jsx — App shell with sidebar and SSE indicator
 */

import React from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSse } from '../context/SseContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';

const NAV_ITEMS = [
  { to: '/',            label: '⚡ Live Feed' },
  { to: '/quarantine',  label: '🔒 Quarantine' },
  { to: '/proposals',   label: '📋 Proposals' },
  { to: '/schemas',     label: '📄 Schemas' },
  { to: '/sources',     label: '🔗 Sources' },
  { to: '/status',      label: '📊 Status' },
  { to: '/simulator',   label: '🧪 Simulator' },
];

export default function Layout() {
  const { sseStatus } = useSse();
  const { logout } = useAuth();
  const location = useLocation();

  const currentItem = NAV_ITEMS.find((item) =>
    item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
  );
  const pageName = currentItem ? currentItem.label.replace(/^[^\p{L}\p{N}]+/u, '').trim() : 'Page';

  const dotClass = `sse-dot ${
    sseStatus === 'live' ? 'live' :
    sseStatus === 'unavailable' ? 'unavailable' :
    'reconnecting'
  }`;

  const statusLabel =
    sseStatus === 'live' ? 'Live' :
    sseStatus === 'unavailable' ? 'Unavailable' :
    'Connecting…';

  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="Main navigation">
        <div className="sidebar-logo">
          Hookmend<br /><span>Dashboard</span>
        </div>
        <ul className="sidebar-nav" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {NAV_ITEMS.map(({ to, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === '/'}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="sse-indicator">
          <div className={dotClass} aria-hidden="true" />
          <span className="text-xs text-muted">{statusLabel}</span>
          <button
            id="logout-btn"
            className="btn btn-ghost text-xs"
            onClick={logout}
            style={{ marginLeft: 'auto', padding: '.2rem .5rem' }}
          >
            Sign out
          </button>
        </div>
      </nav>
      <main className="main-content" id="main">
        <ErrorBoundary key={location.pathname} pageName={pageName}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
