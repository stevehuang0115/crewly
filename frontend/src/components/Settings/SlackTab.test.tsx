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
        expect(screen.getByRole('button', { name: 'Connect to Slack' })).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: 'Connect to Slack' })).toBeDisabled();
    });

    it('keeps the manual token form under the "Advanced: self-hosted app" disclosure', async () => {
      render(<SlackTab />);

      await waitFor(() => {
        expect(screen.getByText('Advanced: self-hosted app')).toBeInTheDocument();
      });
      const details = screen.getByTestId('slack-advanced') as HTMLDetailsElement;
      expect(details.tagName).toBe('DETAILS');
      expect(details).toContainElement(screen.getByLabelText(/Bot Token/i));
      // Closed by default when nothing self-hosted is configured.
      expect(details.open).toBe(false);
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

      expect(screen.getByRole('button', { name: 'Connect to Slack' })).not.toBeDisabled();
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

  describe('Cloud-owned Slack (one-click path)', () => {
    const cloudStatus = {
      cloudConnected: true,
      sourceMode: 'auto',
      activeSource: 'cloud',
      connected: true,
      transport: 'cloud',
      workspace: { slackTeamId: 'T1', slackTeamName: 'Acme', botUserId: 'UBOT', appId: 'A0', agentIdentities: 1 },
      configFetchedAt: null,
      configError: null,
      primary: true,
      instanceId: 'device-1',
      lastHeartbeatAt: null,
      registryError: null,
      pendingInstalls: [{ agentSession: 'alpha-kai-1', url: 'https://slack.com/oauth/kai' }],
      local: { env: false, saved: false },
    };

    /** Route fetches by URL so the two status endpoints answer differently. */
    function routeFetch(cloud: Record<string, unknown> | null, slackConnected: boolean) {
      mockFetch.mockImplementation((url: string) => {
        if (url.startsWith('/api/slack/cloud/status')) {
          return Promise.resolve({
            ok: !!cloud,
            status: cloud ? 200 : 500,
            json: () => Promise.resolve(cloud ? { success: true, data: cloud } : { success: false, error: 'boom' }),
          });
        }
        if (url === '/api/slack/status') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { isConfigured: slackConnected } }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
      });
    }

    afterEach(() => {
      window.history.replaceState({}, '', '/');
    });

    it('fetches the Cloud status on mount and renders the Cloud card', async () => {
      routeFetch({ ...cloudStatus, activeSource: null, connected: false, transport: null, workspace: null, pendingInstalls: [] }, false);
      render(<SlackTab />);

      await waitFor(() => expect(screen.getByText('Connect Slack')).toBeInTheDocument());
      expect(mockFetch).toHaveBeenCalledWith('/api/slack/cloud/status');
      expect(screen.getByText('Slack via Crewly Cloud')).toBeInTheDocument();
      expect(screen.getByText('Not connected to Slack')).toBeInTheDocument();
    });

    it('when connected via Cloud: says so, hides the local Disconnect, keeps the primary toggle on', async () => {
      routeFetch(cloudStatus, true);
      render(<SlackTab />);

      await waitFor(() => expect(screen.getByText('Connected to Slack via Crewly Cloud')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /^Disconnect$/ })).not.toBeInTheDocument();
      expect(screen.getByText('Disconnect workspace')).toBeInTheDocument();
      expect((screen.getByLabelText('Make this the primary instance') as HTMLInputElement).checked).toBe(true);
      expect(screen.getByText('Acme')).toBeInTheDocument();
    });

    it('after the install redirect (?slack=connected) it asks Cloud for a fresh config and shows a banner', async () => {
      window.history.replaceState({}, '', '/settings?tab=slack&slack=connected');
      routeFetch(cloudStatus, true);
      render(<SlackTab />);

      await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/slack/cloud/status?refresh=1'));
      expect(screen.getByText(/Slack workspace connected to your Crewly account/)).toBeInTheDocument();
    });

    it('opens Advanced by default when the self-hosted app is the active source', async () => {
      routeFetch({ ...cloudStatus, activeSource: 'env', transport: 'socket' }, true);
      render(<SlackTab />);

      await waitFor(() => expect(screen.getByText('Connected to Slack')).toBeInTheDocument());
      await waitFor(() => expect((screen.getByTestId('slack-advanced') as HTMLDetailsElement).open).toBe(true));
      expect(screen.getByRole('button', { name: /^Disconnect$/ })).toBeInTheDocument();
    });

    it('survives a failing Cloud status request', async () => {
      routeFetch(null, false);
      render(<SlackTab />);
      await waitFor(() => expect(screen.getByText('Not connected to Slack')).toBeInTheDocument());
      expect(screen.getByText('Loading Cloud Slack status...')).toBeInTheDocument();
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
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss alert' }));

      expect(screen.queryByText('Connection failed')).not.toBeInTheDocument();
    });
  });
});
