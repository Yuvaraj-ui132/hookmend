// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../src/test-setup.js';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LiveFeed from '../src/pages/LiveFeed.jsx';
import Quarantine from '../src/pages/Quarantine.jsx';
import Proposals, { ProposalDrawer } from '../src/pages/Proposals.jsx';
import Schemas from '../src/pages/Schemas.jsx';
import Sources from '../src/pages/Sources.jsx';
import Status from '../src/pages/Status.jsx';
import Simulator from '../src/pages/Simulator.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';
import { SseProvider } from '../src/context/SseContext.jsx';

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual('../src/api/client.js');
  return {
    ...actual,
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiPatch: vi.fn(),
    apiDel: vi.fn(),
    getEvents: vi.fn(),
    getQuarantine: vi.fn(),
    getProposals: vi.fn(),
    getProposal: vi.fn(),
    getSchemas: vi.fn(),
    getSources: vi.fn(),
    getStats: vi.fn(),
  };
});

import {
  apiGet,
  getEvents,
  getQuarantine,
  getProposals,
  getProposal,
  getSchemas,
  getSources,
  getStats,
} from '../src/api/client.js';

function renderWithProviders(ui) {
  sessionStorage.setItem('hm_token', 'test-token');
  return render(
    <AuthProvider>
      <SseProvider>
        <MemoryRouter>
          {ui}
        </MemoryRouter>
      </SseProvider>
    </AuthProvider>
  );
}

// REAL API SHAPES copied directly from live stack responses
const REAL_SHAPES = {
  events: {
    items: [
      {
        _id: '6ad5d8ed24a62bd0c8aa079a',
        sourceId: '6ad5a49bbc96565440b1804b',
        sourceSlug: 'sim-payments',
        eventId: 'evt-001',
        eventType: 'payment.created',
        status: 'delivered',
        receivedAt: '2026-10-19T08:46:37.559Z',
        updatedAt: '2026-10-19T08:54:44.314Z',
      },
    ],
    page: 1,
    limit: 100,
    total: 1,
  },
  eventsEmpty: {
    items: [],
    page: 1,
    limit: 100,
    total: 0,
  },
  quarantine: [
    {
      driftFingerprint: 'fp_sim_payments_001',
      sourceId: '6ad5a49bbc96565440b1804b',
      eventType: 'payment.created',
      count: 3,
      firstSeen: '2026-10-19T05:10:06.438Z',
      lastSeen: '2026-10-19T08:54:44.322Z',
      samplePayload: { event: 'payment.created' },
      proposalId: '6ad5af54bc96565440b198fa',
    },
  ],
  quarantineEmpty: [],
  proposals: {
    items: [
      {
        _id: '6ad5af54bc96565440b198fa',
        sourceId: '6ad5a49bbc96565440b1804b',
        eventType: 'payment.created',
        driftFingerprint: 'fp_sim_payments_001',
        status: 'pending_review',
        baseSchemaVersion: 1,
        proposedSchema: {
          type: 'object',
          properties: { id: { type: 'string' }, extra: { type: 'boolean' } },
        },
        diff: [{ path: '/extra', type: 'added' }],
        affectedEventCount: 3,
        aiUsed: true,
        createdAt: '2026-10-19T06:00:00.000Z',
      },
    ],
    page: 1,
    limit: 50,
    total: 1,
  },
  proposalsEmpty: {
    items: [],
    page: 1,
    limit: 50,
    total: 0,
  },
  schemas: [
    {
      _id: '6ad5af54bc96565440b198f1',
      version: 1,
      eventType: 'payment.created',
      sourceId: '6ad5a49bbc96565440b1804b',
      active: true,
      schema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { id: { type: 'string' } },
      },
      createdAt: '2026-10-19T05:49:08.304Z',
      activatedAt: '2026-10-22T10:35:18.478Z',
    },
  ],
  schemasEmpty: [],
  sources: [
    {
      _id: '6ad5a49bbc96565440b1804b',
      slug: 'sim-payments',
      name: 'Payment Simulator',
      adapter: 'generic-hmac',
      active: true,
      downstreamUrl: 'http://localhost:4001/receive',
      secretEnvVar: 'SIM_WEBHOOK_SECRET',
      createdAt: '2026-10-19T05:03:23.743Z',
      updatedAt: '2026-10-22T10:35:18.478Z',
    },
  ],
  sourcesEmpty: [],
  stats: {
    byStatus: {
      received: 2,
      processing: 0,
      delivered: 10,
      quarantined: 3,
      failed: 0,
      dead: 1,
      requeue_pending: 0,
    },
    last24h: [{ hour: '2026-10-22T10:00:00.000Z', received: 16 }],
    queues: {
      processEvent: { waiting: 0, active: 0, delayed: 0, failed: 0 },
      analyzeDrift: { waiting: 0, active: 0, delayed: 0, failed: 0 },
    },
    pendingProposals: 1,
    sseClients: 1,
  },
};

describe('Page-Level Rendering with Real API Shapes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  describe('LiveFeed', () => {
    it('shows loading state initially', () => {
      apiGet.mockReturnValue(new Promise(() => {}));
      if (getEvents) getEvents.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<LiveFeed />);
      expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    });

    it('renders populated state from real { items: [...] } shape without crashing', async () => {
      apiGet.mockResolvedValue(REAL_SHAPES.events);
      if (getEvents) getEvents.mockResolvedValue(REAL_SHAPES.events.items);
      renderWithProviders(<LiveFeed />);
      await waitFor(() => {
        expect(screen.getAllByText('sim-payments').length).toBeGreaterThan(0);
        expect(screen.getByText('payment.created')).toBeInTheDocument();
      });
    });

    it('renders empty state when items is empty', async () => {
      apiGet.mockResolvedValue(REAL_SHAPES.eventsEmpty);
      if (getEvents) getEvents.mockResolvedValue([]);
      renderWithProviders(<LiveFeed />);
      await waitFor(() => {
        expect(screen.getByText(/No events match the current filters/i)).toBeInTheDocument();
      });
    });

    it('renders error state on API error', async () => {
      apiGet.mockRejectedValue(new Error('Network error on events'));
      if (getEvents) getEvents.mockRejectedValue(new Error('Network error on events'));
      renderWithProviders(<LiveFeed />);
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Network error on events');
      });
    });
  });

  describe('Quarantine', () => {
    it('shows loading state initially', () => {
      apiGet.mockReturnValue(new Promise(() => {}));
      if (getQuarantine) getQuarantine.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<Quarantine />);
      expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    });

    it('renders populated state from real quarantine groups array', async () => {
      apiGet.mockResolvedValue(REAL_SHAPES.quarantine);
      if (getQuarantine) getQuarantine.mockResolvedValue(REAL_SHAPES.quarantine);
      renderWithProviders(<Quarantine />);
      await waitFor(() => {
        expect(screen.getByText(/payment\.created/)).toBeInTheDocument();
        expect(screen.getByText(/fp_sim_payments/i)).toBeInTheDocument();
      });
    });

    it('renders empty state when array is empty', async () => {
      apiGet.mockResolvedValue(REAL_SHAPES.quarantineEmpty);
      if (getQuarantine) getQuarantine.mockResolvedValue([]);
      renderWithProviders(<Quarantine />);
      await waitFor(() => {
        expect(screen.getByText(/No quarantined events/i)).toBeInTheDocument();
      });
    });

    it('renders error state on API failure', async () => {
      apiGet.mockRejectedValue(new Error('Failed to load quarantine'));
      if (getQuarantine) getQuarantine.mockRejectedValue(new Error('Failed to load quarantine'));
      renderWithProviders(<Quarantine />);
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Failed to load quarantine');
      });
    });
  });

  describe('Proposals', () => {
    it('shows loading state initially', () => {
      apiGet.mockReturnValue(new Promise(() => {}));
      if (getProposals) getProposals.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<Proposals />);
      expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    });

    it('renders populated state from real { items: [...] } without white screen crash', async () => {
      apiGet.mockResolvedValue(REAL_SHAPES.proposals);
      if (getProposals) getProposals.mockResolvedValue(REAL_SHAPES.proposals.items);
      renderWithProviders(<Proposals />);
      await waitFor(() => {
        expect(screen.getByText('payment.created')).toBeInTheDocument();
        expect(screen.getByText(/fp_sim_pay/i)).toBeInTheDocument();
      });
    });

    it('renders empty state when proposals items is empty', async () => {
      apiGet.mockResolvedValue(REAL_SHAPES.proposalsEmpty);
      if (getProposals) getProposals.mockResolvedValue([]);
      renderWithProviders(<Proposals />);
      await waitFor(() => {
        expect(screen.getByText(/No proposals/i)).toBeInTheDocument();
      });
    });

    it('renders error state on API failure', async () => {
      apiGet.mockRejectedValue(new Error('Proposals API down'));
      if (getProposals) getProposals.mockRejectedValue(new Error('Proposals API down'));
      renderWithProviders(<Proposals />);
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Proposals API down');
      });
    });

    it('renders ProposalDrawer detail with diff and schema editor', () => {
      renderWithProviders(
        <ProposalDrawer
          proposal={REAL_SHAPES.proposals.items[0]}
          onClose={() => {}}
          onUpdate={() => {}}
        />
      );
      expect(screen.getByText(/Schema diff/i)).toBeInTheDocument();
      expect(screen.getByDisplayValue(/extra/i)).toBeInTheDocument();
      expect(screen.getByText('Approve')).toBeInTheDocument();
      expect(screen.getByText('Reject')).toBeInTheDocument();
    });
  });

  describe('Schemas', () => {
    it('shows loading state initially', () => {
      apiGet.mockReturnValue(new Promise(() => {}));
      if (getSchemas) getSchemas.mockReturnValue(new Promise(() => {}));
      if (getSources) getSources.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<Schemas />);
      expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    });

    it('renders populated state from real schemas array', async () => {
      apiGet.mockImplementation((url) => {
        if (url.includes('/api/schemas')) return Promise.resolve(REAL_SHAPES.schemas);
        if (url.includes('/api/sources')) return Promise.resolve(REAL_SHAPES.sources);
        return Promise.resolve([]);
      });
      if (getSchemas) getSchemas.mockResolvedValue(REAL_SHAPES.schemas);
      if (getSources) getSources.mockResolvedValue(REAL_SHAPES.sources);
      renderWithProviders(<Schemas />);
      await waitFor(() => {
        expect(screen.getAllByText('payment.created').length).toBeGreaterThan(0);
        expect(screen.getAllByText(/v1/).length).toBeGreaterThan(0);
      });
    });

    it('renders empty state when schemas array is empty', async () => {
      apiGet.mockImplementation((url) => {
        if (url.includes('/api/schemas')) return Promise.resolve(REAL_SHAPES.schemasEmpty);
        if (url.includes('/api/sources')) return Promise.resolve(REAL_SHAPES.sources);
        return Promise.resolve([]);
      });
      if (getSchemas) getSchemas.mockResolvedValue([]);
      if (getSources) getSources.mockResolvedValue(REAL_SHAPES.sources);
      renderWithProviders(<Schemas />);
      await waitFor(() => {
        expect(screen.getByText(/No schemas registered/i)).toBeInTheDocument();
      });
    });

    it('renders error state on failure', async () => {
      apiGet.mockRejectedValue(new Error('Schemas unavailable'));
      if (getSchemas) getSchemas.mockRejectedValue(new Error('Schemas unavailable'));
      renderWithProviders(<Schemas />);
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Schemas unavailable');
      });
    });
  });

  describe('Sources', () => {
    it('shows loading state initially', () => {
      apiGet.mockReturnValue(new Promise(() => {}));
      if (getSources) getSources.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<Sources />);
      expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    });

    it('renders populated state and correctly displays active source badge', async () => {
      apiGet.mockResolvedValue(REAL_SHAPES.sources);
      if (getSources) getSources.mockResolvedValue(REAL_SHAPES.sources);
      renderWithProviders(<Sources />);
      await waitFor(() => {
        expect(screen.getByText('sim-payments')).toBeInTheDocument();
        expect(screen.getByText('Active')).toBeInTheDocument();
      });
    });

    it('renders empty state when sources is empty', async () => {
      apiGet.mockResolvedValue(REAL_SHAPES.sourcesEmpty);
      if (getSources) getSources.mockResolvedValue([]);
      renderWithProviders(<Sources />);
      await waitFor(() => {
        expect(screen.getByText(/No sources registered/i)).toBeInTheDocument();
      });
    });

    it('renders error state on error', async () => {
      apiGet.mockRejectedValue(new Error('Sources error'));
      if (getSources) getSources.mockRejectedValue(new Error('Sources error'));
      renderWithProviders(<Sources />);
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Sources error');
      });
    });
  });

  describe('Status', () => {
    it('shows loading state initially', () => {
      apiGet.mockReturnValue(new Promise(() => {}));
      if (getStats) getStats.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<Status />);
      expect(screen.getByText(/Loading metrics/i)).toBeInTheDocument();
    });

    it('renders populated metrics mapping real byStatus numbers to cards', async () => {
      apiGet.mockResolvedValue(REAL_SHAPES.stats);
      if (getStats) getStats.mockResolvedValue(REAL_SHAPES.stats);
      renderWithProviders(<Status />);
      await waitFor(() => {
        expect(screen.getAllByText('10').length).toBeGreaterThan(0); // delivered
        expect(screen.getAllByText('3').length).toBeGreaterThan(0);  // quarantined
      });
    });

    it('renders error state on error', async () => {
      apiGet.mockRejectedValue(new Error('Stats service unavailable'));
      if (getStats) getStats.mockRejectedValue(new Error('Stats service unavailable'));
      renderWithProviders(<Status />);
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Stats service unavailable');
      });
    });
  });

  describe('Simulator', () => {
    it('shows loading state initially', () => {
      apiGet.mockReturnValue(new Promise(() => {}));
      if (getSources) getSources.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<Simulator />);
      expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    });

    it('renders simulator form with real sources dropdown', async () => {
      apiGet.mockResolvedValue(REAL_SHAPES.sources);
      if (getSources) getSources.mockResolvedValue(REAL_SHAPES.sources);
      renderWithProviders(<Simulator />);
      await waitFor(() => {
        expect(screen.getByText(/sim-payments/i)).toBeInTheDocument();
        expect(screen.getByText(/Dispatch Synthetic Webhook/i)).toBeInTheDocument();
      });
    });

    it('renders error state on sources failure', async () => {
      apiGet.mockRejectedValue(new Error('Failed to load simulator sources'));
      if (getSources) getSources.mockRejectedValue(new Error('Failed to load simulator sources'));
      renderWithProviders(<Simulator />);
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Failed to load simulator sources');
      });
    });
  });
});
