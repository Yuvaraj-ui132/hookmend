// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../src/test-setup.js';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LoginPage from '../src/components/LoginPage.jsx';
import StatusBadge from '../src/components/StatusBadge.jsx';
import Layout from '../src/components/Layout.jsx';
import ErrorBoundary from '../src/components/ErrorBoundary.jsx';
import Sources from '../src/pages/Sources.jsx';
import Simulator from '../src/pages/Simulator.jsx';
import { AuthProvider, useAuth } from '../src/context/AuthContext.jsx';
import { SseProvider } from '../src/context/SseContext.jsx';

vi.mock('../src/api/client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiPatch: vi.fn(),
    apiDel: vi.fn(),
  };
});

import { apiGet, apiPost } from '../src/api/client.js';

describe('Dashboard Auth & UI Components (D43, D46)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  describe('LoginPage (D43)', () => {
    it('never writes token to localStorage', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      });

      render(
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      );

      const input = screen.getByLabelText(/Admin Token/i);
      const form = input.closest('form');

      fireEvent.change(input, { target: { value: 'secret-admin-token-xyz' } });
      fireEvent.submit(form);

      await waitFor(() => {
        expect(localStorage.getItem('hm_token')).toBeNull();
        expect(localStorage.getItem('token')).toBeNull();
      });
    });

    it('displays error on 401 invalid token', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'UNAUTHORIZED' }),
      });

      render(
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      );

      const input = screen.getByLabelText(/Admin Token/i);
      const form = input.closest('form');

      fireEvent.change(input, { target: { value: 'wrong-token' } });
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/Invalid token/i);
      });
    });
  });

  describe('StatusBadge', () => {
    it('renders descriptive text label, not color only', () => {
      const { container } = render(<StatusBadge status="requeue_pending" />);
      expect(container.textContent).toBe('requeue pending');
      expect(screen.getByLabelText('Status: requeue pending')).toBeInTheDocument();
    });
  });

  describe('Layout Navigation Shell', () => {
    it('renders all required dashboard navigation links', () => {
      sessionStorage.setItem('hm_token', 'test-tok');
      render(
        <AuthProvider>
          <SseProvider>
            <MemoryRouter>
              <Layout />
            </MemoryRouter>
          </SseProvider>
        </AuthProvider>
      );

      expect(screen.getByText(/Live Feed/i)).toBeInTheDocument();
      expect(screen.getByText(/Quarantine/i)).toBeInTheDocument();
      expect(screen.getByText(/Proposals/i)).toBeInTheDocument();
      expect(screen.getByText(/Schemas/i)).toBeInTheDocument();
      expect(screen.getByText(/Sources/i)).toBeInTheDocument();
      expect(screen.getByText(/Status/i)).toBeInTheDocument();
      expect(screen.getByText(/Simulator/i)).toBeInTheDocument();
    });
  });

  describe('Sources page (D38, D46)', () => {
    it('loads and lists webhook sources without exposing secrets', async () => {
      sessionStorage.setItem('hm_token', 'test-tok');
      apiGet.mockResolvedValueOnce({
        sources: [
          {
            _id: 'src-1',
            slug: 'github-repo',
            adapter: 'github',
            secretEnvVar: 'GITHUB_WEBHOOK_SECRET',
            downstreamUrl: 'https://internal.corp/webhook',
            disabled: false,
          },
        ],
      });

      render(
        <AuthProvider>
          <SseProvider>
            <Sources />
          </SseProvider>
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('github-repo')).toBeInTheDocument();
      });

      expect(screen.getByText('github')).toBeInTheDocument();
      expect(screen.getByText('GITHUB_WEBHOOK_SECRET')).toBeInTheDocument();
      expect(screen.getByText('https://internal.corp/webhook')).toBeInTheDocument();
    });
  });

  describe('Simulator page (D41, D46)', () => {
    it('dispatches synthetic webhooks with drift presets', async () => {
      sessionStorage.setItem('hm_token', 'test-tok');
      apiGet.mockResolvedValueOnce({
        sources: [
          { _id: 'src-sim-1', slug: 'stripe-sim', adapter: 'generic-hmac' },
        ],
      });

      apiPost.mockResolvedValueOnce({
        simulated: true,
        eventId: 'sim-ev-12345',
        sourceSlug: 'stripe-sim',
        eventType: 'payment.succeeded',
        driftPreset: 'added_field',
        status: 'quarantined',
      });

      render(
        <AuthProvider>
          <SseProvider>
            <Simulator />
          </SseProvider>
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByText(/stripe-sim/)).toBeInTheDocument();
      });

      const button = screen.getByRole('button', { name: /Dispatch Synthetic Webhook/i });
      fireEvent.click(button);

      await waitFor(() => {
        expect(apiPost).toHaveBeenCalledWith(
          '/api/simulate',
          'test-tok',
          expect.objectContaining({
            sourceId: 'src-sim-1',
            eventType: 'payment.succeeded',
            driftPreset: 'added_field',
          })
        );
        expect(screen.getByText('sim-ev-12345')).toBeInTheDocument();
      });
    });
  });

  describe('ErrorBoundary component', () => {
    it('catches render error and displays readable page error message with try again button', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      function CrashingChild() {
        throw new Error('Test crash in Proposals page');
      }

      render(
        <ErrorBoundary pageName="Proposals">
          <CrashingChild />
        </ErrorBoundary>
      );

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/Proposals encountered an error/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
      consoleSpy.mockRestore();
    });
  });
});

