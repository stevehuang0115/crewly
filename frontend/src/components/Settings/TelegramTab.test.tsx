/**
 * TelegramTab Component Tests
 *
 * Tests for the Telegram integration configuration component.
 *
 * @module components/Settings/TelegramTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TelegramTab } from './TelegramTab';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock window.confirm
const mockConfirm = vi.fn();
window.confirm = mockConfirm;

/**
 * Helper to mock the unified messenger status endpoint
 * returning Telegram as disconnected.
 */
function mockDisconnectedStatus() {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: [
        { platform: 'telegram', connected: false },
      ],
    }),
  });
}

/**
 * Helper to mock the unified messenger status endpoint
 * returning Telegram as connected with details.
 */
function mockConnectedStatus() {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: [
        {
          platform: 'telegram',
          connected: true,
          details: {
            botName: 'CrewlyTestBot',
            botId: '123456789',
            messagesSent: 10,
            messagesReceived: 5,
          },
        },
      ],
    }),
  });
}

describe('TelegramTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Loading State', () => {
    it('should show loading state initially', () => {
      mockFetch.mockImplementation(() => new Promise(() => {}));

      render(<TelegramTab />);

      expect(screen.getByText('Loading Telegram status...')).toBeInTheDocument();
    });
  });

  describe('Disconnected State', () => {
    beforeEach(() => {
      mockDisconnectedStatus();
    });

    it('should show setup form when not connected', async () => {
      render(<TelegramTab />);

      await waitFor(() => {
        expect(screen.getByText('Not connected to Telegram')).toBeInTheDocument();
      });

      expect(screen.getByText('Setup Instructions')).toBeInTheDocument();
      expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
    });

    it('should disable connect button when token is empty', async () => {
      render(<TelegramTab />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Connect to Telegram' })).toBeInTheDocument();
      });

      const connectButton = screen.getByRole('button', { name: 'Connect to Telegram' });
      expect(connectButton).toBeDisabled();
    });

    it('should enable connect button when token is filled', async () => {
      render(<TelegramTab />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/Bot Token/i), {
        target: { value: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11' },
      });

      const connectButton = screen.getByRole('button', { name: 'Connect to Telegram' });
      expect(connectButton).not.toBeDisabled();
    });

    it('should call connect API when form is submitted', async () => {
      render(<TelegramTab />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/Bot Token/i), {
        target: { value: '123456:test-token' },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      fireEvent.click(screen.getByRole('button', { name: 'Connect to Telegram' }));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/messengers/telegram/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: '123456:test-token' }),
        });
      });
    });

    it('should show error when connection fails', async () => {
      render(<TelegramTab />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/Bot Token/i), {
        target: { value: 'invalid-token' },
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ success: false, error: 'Invalid token' }),
      });

      fireEvent.click(screen.getByRole('button', { name: 'Connect to Telegram' }));

      await waitFor(() => {
        expect(screen.getByText('Invalid token')).toBeInTheDocument();
      });
    });
  });

  describe('Connected State', () => {
    beforeEach(() => {
      mockConnectedStatus();
    });

    it('should show connected status and details', async () => {
      render(<TelegramTab />);

      await waitFor(() => {
        expect(screen.getByText('Connected to Telegram')).toBeInTheDocument();
      });

      expect(screen.getByText('CrewlyTestBot')).toBeInTheDocument();
      expect(screen.getByText('123456789')).toBeInTheDocument();
      expect(screen.getByText('10')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
    });

    it('should show disconnect and refresh buttons', async () => {
      render(<TelegramTab />);

      await waitFor(() => {
        expect(screen.getByText('Connected to Telegram')).toBeInTheDocument();
      });

      expect(screen.getByText('Refresh Status')).toBeInTheDocument();
      expect(screen.getByText('Disconnect')).toBeInTheDocument();
    });

    it('should call disconnect API when disconnect is confirmed', async () => {
      render(<TelegramTab />);

      await waitFor(() => {
        expect(screen.getByText('Disconnect')).toBeInTheDocument();
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      fireEvent.click(screen.getByText('Disconnect'));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/messengers/telegram/disconnect', {
          method: 'POST',
        });
      });
    });

    it('should not disconnect when confirmation is cancelled', async () => {
      mockConfirm.mockReturnValue(false);

      render(<TelegramTab />);

      await waitFor(() => {
        expect(screen.getByText('Disconnect')).toBeInTheDocument();
      });

      const initialCallCount = mockFetch.mock.calls.length;

      fireEvent.click(screen.getByText('Disconnect'));

      expect(mockFetch.mock.calls.length).toBe(initialCallCount);
    });
  });

  describe('Error Handling', () => {
    it('should show disconnected state when fetch fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      render(<TelegramTab />);

      await waitFor(() => {
        expect(screen.getByText('Not connected to Telegram')).toBeInTheDocument();
      });
    });
  });
});
