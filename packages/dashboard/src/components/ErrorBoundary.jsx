/**
 * src/components/ErrorBoundary.jsx
 * React ErrorBoundary that catches uncaught rendering errors in routed content.
 * Displays page name, "Try again" button, and dev-only error message.
 */

import React, { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
    this.handleReset = this.handleReset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    if (typeof console !== 'undefined' && console.error) {
      console.error('ErrorBoundary caught a render error:', error, errorInfo);
    }
  }

  handleReset() {
    this.setState({ hasError: false, error: null });
    if (typeof this.props.onReset === 'function') {
      this.props.onReset();
    }
  }

  render() {
    if (this.state.hasError) {
      const pageName = this.props.pageName || 'This page';
      const isDev =
        (typeof import.meta !== 'undefined' && import.meta.env?.DEV) ||
        process.env.NODE_ENV !== 'production';

      return (
        <div className="state-box error" role="alert" style={{ margin: '2rem 1rem', padding: '1.5rem', textAlign: 'left' }}>
          <h2 style={{ fontSize: '1.1rem', marginBottom: '.5rem', color: 'var(--color-danger, #ef4444)' }}>
            ⚠️ {pageName} encountered an error
          </h2>
          <p className="text-sm text-muted" style={{ marginBottom: '1rem' }}>
            An unexpected error occurred while rendering this page. You can try reloading the section.
          </p>

          {isDev && this.state.error && (
            <pre style={{
              background: 'rgba(0,0,0,0.2)',
              padding: '.75rem',
              borderRadius: '6px',
              fontSize: '.75rem',
              overflowX: 'auto',
              marginBottom: '1rem',
              whiteSpace: 'pre-wrap',
            }}>
              {this.state.error.message || String(this.state.error)}
            </pre>
          )}

          <button
            id="error-boundary-retry-btn"
            className="btn btn-secondary"
            onClick={this.handleReset}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
