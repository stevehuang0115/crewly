/**
 * Tests for WhatsAppTab Component
 *
 * @module components/Settings/WhatsAppTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WhatsAppTab } from './WhatsAppTab';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock window.confirm
const mockConfirm = vi.fn();
global.confirm = mockConfirm;

describe('WhatsAppTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Loading State', () => {
    it('should show loading spinner initially', () => {
      mockFetch.mockReturnValue(new Promise(() => {})); // Never resolves
      render(<WhatsAppTab />);

      expect(screen.getByText('Loading WhatsApp status...')).toBeInTheDocument();
    });
  });

  describe('Disconnected State', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({
          success: true,
          data: { connected: false, isConfigured: false },
        }),
      });
    });

    it('should show not connected status', async () => {
      render(<WhatsAppTab />);

      await waitFor(() => {
        expect(screen.getByText('Not connected to WhatsApp')).toBeInTheDocument();
      });
    });

    it('should show setup instructions', async () => {
      render(<WhatsAppTab />);

      await waitFor(() => {
        expect(screen.getByText('How to Connect')).toBeInTheDocument();
      });
    });

    it('should show connect button', async () => {
      render(<WhatsAppTab />);

      await waitFor(() => {
        expect(screen.getByText('Connect WhatsApp')).toBeInTheDocument();
      });
    });
  });

  describe('Connected State', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({
          success: true,
          data: {
            connected: true,
            isConfigured: true,
            phoneNumber: '+1234567890',
            messagesSent: 10,
            messagesReceived: 5,
          },
        }),
      });
    });

    it('should show connected status', async () => {
      render(<WhatsAppTab />);

      await waitFor(() => {
        expect(screen.getByText('Connected to WhatsApp')).toBeInTheDocument();
      });
    });

    it('should show connection details', async () => {
      render(<WhatsAppTab />);

      await waitFor(() => {
        expect(screen.getByText('+1234567890')).toBeInTheDocument();
        expect(screen.getByText('10')).toBeInTheDocument();
        expect(screen.getByText('5')).toBeInTheDocument();
      });
    });

    it('should show disconnect button', async () => {
      render(<WhatsAppTab />);

      await waitFor(() => {
        expect(screen.getByText('Disconnect')).toBeInTheDocument();
      });
    });

    it('should show refresh button', async () => {
      render(<WhatsAppTab />);

      await waitFor(() => {
        expect(screen.getByText('Refresh Status')).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('should show not connected when fetch fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      render(<WhatsAppTab />);

      await waitFor(() => {
        expect(screen.getByText('Not connected to WhatsApp')).toBeInTheDocument();
      });
    });

    it('should show error when API returns error', async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({
          success: false,
          error: 'Service unavailable',
        }),
      });
      render(<WhatsAppTab />);

      await waitFor(() => {
        expect(screen.getByText('Not connected to WhatsApp')).toBeInTheDocument();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Inbox mode + pending drafts
  // ---------------------------------------------------------------------------

  describe('Inbox mode and drafts', () => {
    const DRAFT = {
      id: 'd-1',
      code: 'W12',
      chatId: '491@s.whatsapp.net',
      recipient: 'Ann',
      text: 'Yes, 8 works!',
      createdAt: 1760000000000,
      createdBy: 'crewly-orc',
      status: 'pending',
    };

    /**
     * Route fetch by URL. `drafts` is read on every call so tests can change it.
     */
    function routeFetch(opts: {
      status?: Record<string, unknown>;
      drafts?: () => unknown[];
      onPost?: (url: string, init: RequestInit) => { ok: boolean; body: Record<string, unknown> } | undefined;
    }) {
      mockFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === 'POST' && opts.onPost) {
          const r = opts.onPost(url, init);
          if (r) return Promise.resolve({ ok: r.ok, json: () => Promise.resolve(r.body) });
        }
        if (url.startsWith('/api/whatsapp/drafts')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: opts.drafts ? opts.drafts() : [] }) });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: opts.status ?? { connected: false, isConfigured: false } }),
        });
      });
    }

    it('explains inbox mode in Chinese and English with the linked-device note', async () => {
      routeFetch({});
      render(<WhatsAppTab />);
      await waitFor(() => {
        expect(screen.getByText('只读+起草，发送前需要你确认；不会自动回复任何人。')).toBeInTheDocument();
      });
      expect(screen.getByText(/never auto-replies to anyone/)).toBeInTheDocument();
      expect(screen.getByText(/linked device/)).toBeInTheDocument();
    });

    it('connects in inbox mode as a dashboard (owner) call', async () => {
      routeFetch({ onPost: () => ({ ok: true, body: { success: true, data: { qrCode: 'qr-1' } } }) });
      render(<WhatsAppTab />);
      await waitFor(() => expect(screen.getByText('Connect WhatsApp')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Connect WhatsApp'));

      await waitFor(() => {
        const call = mockFetch.mock.calls.find(([u]) => u === '/api/whatsapp/connect');
        expect(call).toBeDefined();
        const init = call![1] as RequestInit;
        expect(JSON.parse(init.body as string)).toEqual({ mode: 'inbox' });
        expect(init.headers).toMatchObject({ 'X-Crewly-Caller': 'dashboard' });
        expect(init.headers).not.toHaveProperty('X-Agent-Session');
      });
    });

    it('shows the mode and warns when the connection is in assistant (auto-reply) mode', async () => {
      routeFetch({ status: { connected: true, isConfigured: true, mode: 'assistant' } });
      render(<WhatsAppTab />);
      await waitFor(() => expect(screen.getByTestId('whatsapp-mode')).toHaveTextContent('assistant'));
      expect(screen.getByText(/answered automatically/)).toBeInTheDocument();
      expect(screen.queryByTestId('whatsapp-inbox-notice')).not.toBeInTheDocument();
    });

    it('shows an empty state when no drafts are pending', async () => {
      routeFetch({ status: { connected: true, isConfigured: true, mode: 'inbox' } });
      render(<WhatsAppTab />);
      await waitFor(() => expect(screen.getByText(/No pending drafts/)).toBeInTheDocument());
    });

    it('lists pending drafts and sends one as the owner (no agent header)', async () => {
      let pending: unknown[] = [DRAFT];
      const posts: Array<[string, RequestInit]> = [];
      routeFetch({
        status: { connected: true, isConfigured: true, mode: 'inbox' },
        drafts: () => pending,
        onPost: (url, init) => {
          posts.push([url, init]);
          if (url === '/api/whatsapp/drafts/d-1/send') {
            pending = [];
            return { ok: true, body: { success: true, data: { ...DRAFT, status: 'sent' } } };
          }
          return undefined;
        },
      });
      render(<WhatsAppTab />);

      await waitFor(() => expect(screen.getByTestId('whatsapp-draft-W12')).toBeInTheDocument());
      expect(screen.getByText('Yes, 8 works!')).toBeInTheDocument();
      expect(screen.getByText(/Ann/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '发送 W12' }));

      await waitFor(() => expect(screen.queryByTestId('whatsapp-draft-W12')).not.toBeInTheDocument());
      expect(posts).toHaveLength(1);
      expect(posts[0][0]).toBe('/api/whatsapp/drafts/d-1/send');
      expect(posts[0][1].headers).toMatchObject({ 'X-Crewly-Caller': 'dashboard' });
      expect(posts[0][1].headers).not.toHaveProperty('X-Agent-Session');
    });

    it('discards a draft', async () => {
      let pending: unknown[] = [DRAFT];
      const posted: string[] = [];
      routeFetch({
        status: { connected: true, isConfigured: true, mode: 'inbox' },
        drafts: () => pending,
        onPost: (url) => {
          posted.push(url);
          pending = [];
          return { ok: true, body: { success: true, data: { ...DRAFT, status: 'discarded' } } };
        },
      });
      render(<WhatsAppTab />);
      await waitFor(() => expect(screen.getByTestId('whatsapp-draft-W12')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: '丢弃 W12' }));

      await waitFor(() => expect(screen.queryByTestId('whatsapp-draft-W12')).not.toBeInTheDocument());
      expect(posted).toEqual(['/api/whatsapp/drafts/d-1/discard']);
    });

    it('shows the server error when a send fails and keeps the draft listed', async () => {
      routeFetch({
        status: { connected: true, isConfigured: true, mode: 'inbox' },
        drafts: () => [DRAFT],
        onPost: () => ({ ok: false, body: { success: false, error: 'WhatsApp is not connected' } }),
      });
      render(<WhatsAppTab />);
      await waitFor(() => expect(screen.getByTestId('whatsapp-draft-W12')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: '发送 W12' }));

      await waitFor(() => expect(screen.getByText('WhatsApp is not connected')).toBeInTheDocument());
      expect(screen.getByTestId('whatsapp-draft-W12')).toBeInTheDocument();
    });
  });
});
