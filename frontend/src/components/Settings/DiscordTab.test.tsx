/**
 * DiscordTab Component Tests
 *
 * Tests for the Discord integration configuration component.
 *
 * @module components/Settings/DiscordTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DiscordTab } from './DiscordTab';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock window.confirm
const mockConfirm = vi.fn();
window.confirm = mockConfirm;

/**
 * Helper to mock the unified messenger status endpoint
 * returning Discord as disconnected.
 */
function mockDisconnectedStatus() {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: [
        { platform: 'discord', connected: false },
      ],
    }),
  });
}

/**
 * Helper to mock the unified messenger status endpoint
 * returning Discord as connected with details.
 */
function mockConnectedStatus() {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: [
        {
          platform: 'discord',
          connected: true,
          details: {
            botName: 'CrewlyDiscordBot',
            botId: '987654321',
            messagesSent: 20,
            messagesReceived: 8,
          },
        },
      ],
    }),
  });
}

describe('DiscordTab', () => {
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

      render(<DiscordTab />);

      expect(screen.getByText('Loading Discord status...')).toBeInTheDocument();
    });
  });

  describe('Disconnected State', () => {
    beforeEach(() => {
      mockDisconnectedStatus();
    });

    it('should show setup form when not connected', async () => {
      render(<DiscordTab />);

      await waitFor(() => {
        expect(screen.getByText('Not connected to Discord')).toBeInTheDocument();
      });

      expect(screen.getByText('Setup Instructions')).toBeInTheDocument();
      expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
    });

    it('should disable connect button when token is empty', async () => {
      render(<DiscordTab />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Connect to Discord' })).toBeInTheDocument();
      });

      const connectButton = screen.getByRole('button', { name: 'Connect to Discord' });
      expect(connectButton).toBeDisabled();
    });

    it('should enable connect button when token is filled', async () => {
      render(<DiscordTab />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/Bot Token/i), {
        target: { value: 'MTEyMzQ1Njc4OTAxMjM0NTY3OC.test.token' },
      });

      const connectButton = screen.getByRole('button', { name: 'Connect to Discord' });
      expect(connectButton).not.toBeDisabled();
    });

    it('should call connect API when form is submitted', async () => {
      render(<DiscordTab />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/Bot Token/i), {
        target: { value: 'test-discord-token' },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      fireEvent.click(screen.getByRole('button', { name: 'Connect to Discord' }));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/messengers/discord/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'test-discord-token' }),
        });
      });
    });

    it('should show error when connection fails', async () => {
      render(<DiscordTab />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/Bot Token/i), {
        target: { value: 'invalid-token' },
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ success: false, error: 'Invalid bot token' }),
      });

      fireEvent.click(screen.getByRole('button', { name: 'Connect to Discord' }));

      await waitFor(() => {
        expect(screen.getByText('Invalid bot token')).toBeInTheDocument();
      });
    });
  });

  describe('Connected State', () => {
    beforeEach(() => {
      mockConnectedStatus();
    });

    it('should show connected status and details', async () => {
      render(<DiscordTab />);

      await waitFor(() => {
        expect(screen.getByText('Connected to Discord')).toBeInTheDocument();
      });

      expect(screen.getByText('CrewlyDiscordBot')).toBeInTheDocument();
      expect(screen.getByText('987654321')).toBeInTheDocument();
      expect(screen.getByText('20')).toBeInTheDocument();
      expect(screen.getByText('8')).toBeInTheDocument();
    });

    it('should show disconnect and refresh buttons', async () => {
      render(<DiscordTab />);

      await waitFor(() => {
        expect(screen.getByText('Connected to Discord')).toBeInTheDocument();
      });

      expect(screen.getByText('Refresh Status')).toBeInTheDocument();
      expect(screen.getByText('Disconnect')).toBeInTheDocument();
    });

    it('should call disconnect API when disconnect is confirmed', async () => {
      render(<DiscordTab />);

      await waitFor(() => {
        expect(screen.getByText('Disconnect')).toBeInTheDocument();
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      fireEvent.click(screen.getByText('Disconnect'));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/messengers/discord/disconnect', {
          method: 'POST',
        });
      });
    });

    it('should not disconnect when confirmation is cancelled', async () => {
      mockConfirm.mockReturnValue(false);

      render(<DiscordTab />);

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

      render(<DiscordTab />);

      await waitFor(() => {
        expect(screen.getByText('Not connected to Discord')).toBeInTheDocument();
      });
    });
  });
});
