// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../src/test-setup.js';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import LiveFeed from '../src/pages/LiveFeed.jsx';
import Quarantine from '../src/pages/Quarantine.jsx';
import Proposals from '../src/pages/Proposals.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';
import { SseProvider } from '../src/context/SseContext.jsx';

// Mock client calls
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

import { apiGet } from '../src/api/client.js';

describe('Zero-Payload Redaction In UI (D22, D34, D46)', () => {
  const SENSITIVE_PAYLOAD_VALUE = 'SENSITIVE_CUSTOMER_CARD_NUM_9876_XYZ';
  const SENSITIVE_EMAIL = 'victim@topsecret.internal';

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  function renderWithProviders(ui) {
    sessionStorage.setItem('hookmend_token', 'test-token');
    return render(
      <AuthProvider>
        <SseProvider>
          {ui}
        </SseProvider>
      </AuthProvider>
    );
  }

  it('LiveFeed NEVER renders payload values even if included in API response', async () => {
    apiGet.mockResolvedValueOnce({
      events: [
        {
          _id: 'ev-101',
          sourceSlug: 'stripe-test',
          eventType: 'payment.succeeded',
          status: 'delivered',
          receivedAt: new Date().toISOString(),
          // Accidental payload leak in API response:
          payload: {
            cardNumber: SENSITIVE_PAYLOAD_VALUE,
            email: SENSITIVE_EMAIL,
          },
          headers: { 'x-secret': 'super-secret-hdr' },
          rawBodyHash: 'sha256:abcd1234abcd',
        },
      ],
    });

    const { container } = renderWithProviders(<LiveFeed />);

    await waitFor(() => {
      expect(screen.getAllByText('stripe-test').length).toBeGreaterThanOrEqual(1);
    });

    const renderedHtml = container.innerHTML;
    expect(renderedHtml).not.toContain(SENSITIVE_PAYLOAD_VALUE);
    expect(renderedHtml).not.toContain(SENSITIVE_EMAIL);
    expect(renderedHtml).not.toContain('super-secret-hdr');
    expect(renderedHtml).not.toContain('sha256:abcd1234abcd');
  });

  it('Quarantine page NEVER renders payload values', async () => {
    apiGet.mockResolvedValueOnce({
      events: [
        {
          driftFingerprint: 'fp-sha256-112233',
          sourceId: 'src-1234567890abcdef',
          eventType: 'invoice.created',
          count: 5,
          samplePayload: {
            secretKey: SENSITIVE_PAYLOAD_VALUE,
          },
        },
      ],
    });

    const { container } = renderWithProviders(<Quarantine />);

    await waitFor(() => {
      expect(screen.getByText('fp-sha256-112233')).toBeInTheDocument();
    });

    const renderedHtml = container.innerHTML;
    expect(renderedHtml).not.toContain(SENSITIVE_PAYLOAD_VALUE);
  });

  it('Proposals page renders structural diff paths but NEVER payload values', async () => {
    apiGet.mockResolvedValueOnce({
      proposals: [
        {
          _id: 'prop-999',
          sourceId: 'src-1234567890abcdef',
          eventType: 'payment.updated',
          status: 'pending_review',
          diff: {
            'metadata.tax_id': { type: 'added', sampleType: 'string' },
          },
          currentSchemaVersion: 1,
          proposedSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              metadata: {
                type: 'object',
                properties: {
                  tax_id: { type: 'string' },
                },
              },
            },
          },
          // Even if attached in object:
          samplePayload: {
            tax_id: SENSITIVE_PAYLOAD_VALUE,
          },
        },
      ],
    });

    const { container } = renderWithProviders(<Proposals />);

    await waitFor(() => {
      expect(screen.getByText('payment.updated')).toBeInTheDocument();
    });

    // Click the proposal row to open the diff drawer
    const row = screen.getByText('payment.updated').closest('tr');
    row.click();

    await waitFor(() => {
      expect(screen.getByText('metadata.tax_id')).toBeInTheDocument();
    });

    const renderedHtml = container.innerHTML;
    expect(renderedHtml).toContain('metadata.tax_id');
    expect(renderedHtml).not.toContain(SENSITIVE_PAYLOAD_VALUE);
  });
});
