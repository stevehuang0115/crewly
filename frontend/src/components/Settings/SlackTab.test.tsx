/**
 * SlackTab Component Tests
 *
 * Tests for the Slack integration configuration component.
 *
 * @module components/Settings/SlackTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SlackTab } from './SlackTab';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock window.confirm
const mockConfirm = vi.fn();
window.confirm = mockConfirm;

describe('SlackTab', () => {
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

      render(<SlackTab />);

      expect(screen.getByText('Loading Slack status...')).toBeInTheDocument();
    });
  });

  describe('Disconnected State', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { isConfigured: false },
        }),
      });
    });

    it('should show setup form when not connected', async () => {
      render(<SlackTab />);

      await waitFor(() => {
        expect(screen.getByText('Not connected to Slack')).toBeInTheDocument();
      });

      expect(screen.getByText('Setup Instructions')).toBeInTheDocument();
      expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/App Token/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Signing Secret/i)).toBeInTheDocument();
    });

    it('should disable connect button when required fields are empty', async () => {
      render(<SlackTab />);

      await waitFor(() => {
        expect(screen.getByText('Connect to Slack')).toBeInTheDocument();
      });

      const connectButton = screen.getByText('Connect to Slack');
      expect(connectButton).toBeDisabled();
    });

    it('should enable connect button when required fields are filled', async () => {
      render(<SlackTab />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/Bot Token/i), {
        target: { value: 'xoxb-test-token' },
      });
      fireEvent.change(screen.getByLabelText(/App Token/i), {
        target: { value: 'xapp-test-token' },
      });
      fireEvent.change(screen.getByLabelText(/Signing Secret/i), {
        target: { value: 'test-secret' },
      });

      const connectButton = screen.getByText('Connect to Slack');
      expect(connectButton).not.toBeDisabled();
    });

    it('should call connect API when form is submitted', async () => {
      render(<SlackTab />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
      });

      // Fill in the form
      fireEvent.change(screen.getByLabelText(/Bot Token/i), {
        target: { value: 'xoxb-test-token' },
      });
      fireEvent.change(screen.getByLabelText(/App Token/i), {
        target: { value: 'xapp-test-token' },
      });
      fireEvent.change(screen.getByLabelText(/Signing Secret/i), {
        target: { value: 'test-secret' },
      });
      fireEvent.change(screen.getByLabelText(/Default Channel/i), {
        target: { value: '#general' },
      });

      // Mock the connect response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      // Submit the form
      fireEvent.click(screen.getByText('Connect to Slack'));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/slack/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            botToken: 'xoxb-test-token',
            appToken: 'xapp-test-token',
            signingSecret: 'test-secret',
            defaultChannelId: '#general',
          }),
        });
      });
    });

    it('should show error when connection fails', async () => {
      render(<SlackTab />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
      });

      // Fill required fields
      fireEvent.change(screen.getByLabelText(/Bot Token/i), {
        target: { value: 'xoxb-test' },
      });
      fireEvent.change(screen.getByLabelText(/App Token/i), {
        target: { value: 'xapp-test' },
      });
      fireEvent.change(screen.getByLabelText(/Signing Secret/i), {
        target: { value: 'secret' },
      });

      // Mock failed connection
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ success: false, error: 'Invalid token' }),
      });

      fireEvent.click(screen.getByText('Connect to Slack'));

      await waitFor(() => {
        expect(screen.getByText('Invalid token')).toBeInTheDocument();
      });
    });
  });

  describe('Connected State', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: {
            isConfigured: true,
            workspaceName: 'Test Workspace',
            botName: 'Crewly Bot',
            channels: ['general', 'crewly'],
            messagesSent: 42,
            messagesReceived: 15,
          },
        }),
      });
    });

    it('should show connected status and details', async () => {
      render(<SlackTab />);

      await waitFor(() => {
        expect(screen.getByText('Connected to Slack')).toBeInTheDocument();
      });

      expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      expect(screen.getByText('Crewly Bot')).toBeInTheDocument();
      expect(screen.getByText('general, crewly')).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
      expect(screen.getByText('15')).toBeInTheDocument();
    });

    it('should show disconnect and refresh buttons', async () => {
      render(<SlackTab />);

      await waitFor(() => {
        expect(screen.getByText('Connected to Slack')).toBeInTheDocument();
      });

      expect(screen.getByText('Refresh Status')).toBeInTheDocument();
      expect(screen.getByText('Disconnect')).toBeInTheDocument();
    });

    it('should call refresh when refresh button is clicked', async () => {
      render(<SlackTab />);

      await waitFor(() => {
        expect(screen.getByText('Refresh Status')).toBeInTheDocument();
      });

      // Initial status fetch (the Team Channels card issues its own request,
      // so count only the status calls).
      const statusCalls = () => mockFetch.mock.calls.filter((c) => c[0] === '/api/slack/status').length;
      expect(statusCalls()).toBe(1);

      fireEvent.click(screen.getByText('Refresh Status'));

      await waitFor(() => {
        expect(statusCalls()).toBe(2);
      });
    });

    it('should call disconnect API when disconnect is confirmed', async () => {
      render(<SlackTab />);

      await waitFor(() => {
        expect(screen.getByText('Disconnect')).toBeInTheDocument();
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      fireEvent.click(screen.getByText('Disconnect'));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/slack/disconnect', {
          method: 'POST',
        });
      });
    });

    it('should not disconnect when confirmation is cancelled', async () => {
      mockConfirm.mockReturnValue(false);

      render(<SlackTab />);

      await waitFor(() => {
        expect(screen.getByText('Disconnect')).toBeInTheDocument();
      });

      const initialCallCount = mockFetch.mock.calls.length;

      fireEvent.click(screen.getByText('Disconnect'));

      // Should not make additional API calls
      expect(mockFetch.mock.calls.length).toBe(initialCallCount);
    });
  });

  describe('Error Handling', () => {
    it('should show error when fetch fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      render(<SlackTab />);

      await waitFor(() => {
        expect(screen.getByText('Not connected to Slack')).toBeInTheDocument();
      });
    });

    it('should allow dismissing error message', async () => {
      render(<SlackTab />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
      });

      // Fill required fields
      fireEvent.change(screen.getByLabelText(/Bot Token/i), {
        target: { value: 'xoxb-test' },
      });
      fireEvent.change(screen.getByLabelText(/App Token/i), {
        target: { value: 'xapp-test' },
      });
      fireEvent.change(screen.getByLabelText(/Signing Secret/i), {
        target: { value: 'secret' },
      });

      // Mock failed connection
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ success: false, error: 'Connection failed' }),
      });

      fireEvent.click(screen.getByText('Connect to Slack'));

      await waitFor(() => {
        expect(screen.getByText('Connection failed')).toBeInTheDocument();
      });

      // Dismiss error
      fireEvent.click(screen.getByRole('button', { name: '×' }));

      expect(screen.queryByText('Connection failed')).not.toBeInTheDocument();
    });
  });
});
