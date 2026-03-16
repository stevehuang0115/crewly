/**
 * Tests for GoogleChatTab Component
 *
 * @module components/Settings/GoogleChatTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { GoogleChatTab } from './GoogleChatTab';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('GoogleChatTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Loading State', () => {
    it('should show loading spinner initially', () => {
      mockFetch.mockReturnValue(new Promise(() => {}));
      render(<GoogleChatTab />);

      expect(screen.getByText('Loading Google Chat status...')).toBeInTheDocument();
    });
  });

  describe('Disconnected State', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({
          success: true,
          data: [{ platform: 'google-chat', connected: false, details: { mode: 'none' } }],
        }),
      });
    });

    it('should show not connected status', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Not connected to Google Chat')).toBeInTheDocument();
      });
    });

    it('should show all three connection mode toggles', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByTestId('mode-pubsub')).toBeInTheDocument();
        expect(screen.getByTestId('mode-webhook')).toBeInTheDocument();
        expect(screen.getByTestId('mode-service-account')).toBeInTheDocument();
      });
    });

    it('should default to pubsub mode', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Pub/Sub Setup (Bidirectional)')).toBeInTheDocument();
      });
    });

    it('should show projectId and subscriptionName fields in pubsub mode', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByLabelText(/GCP Project ID/)).toBeInTheDocument();
        expect(screen.getByLabelText(/Pub\/Sub Subscription Name/)).toBeInTheDocument();
        expect(screen.getByLabelText(/Service Account Key/)).toBeInTheDocument();
      });
    });

    it('should switch to webhook mode', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByTestId('mode-webhook')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('mode-webhook'));

      expect(screen.getByText('Webhook Setup (Send-only)')).toBeInTheDocument();
      expect(screen.getByLabelText(/Webhook URL/)).toBeInTheDocument();
    });

    it('should switch to service account mode', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByTestId('mode-service-account')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('mode-service-account'));

      expect(screen.getByText('Service Account Setup (Send-only)')).toBeInTheDocument();
    });

    it('should show connect button', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Connect Google Chat')).toBeInTheDocument();
      });
    });
  });

  describe('Connected State (webhook)', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({
          success: true,
          data: [{ platform: 'google-chat', connected: true, details: { mode: 'webhook' } }],
        }),
      });
    });

    it('should show connected status', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Connected to Google Chat')).toBeInTheDocument();
      });
    });

    it('should show connection mode in details', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Webhook')).toBeInTheDocument();
      });
    });

    it('should show disconnect and refresh buttons', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Disconnect')).toBeInTheDocument();
        expect(screen.getByText('Refresh Status')).toBeInTheDocument();
      });
    });
  });

  describe('Connected State (pubsub)', () => {
    beforeEach(() => {
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/messengers/google-chat/status') {
          return Promise.resolve({
            json: () => Promise.resolve({
              success: true,
              data: {
                mode: 'pubsub',
                pullActive: true,
                pullPaused: false,
                consecutiveFailures: 0,
                lastPullAt: null,
                subscriptionName: 'projects/my-project/subscriptions/chat-sub',
              },
            }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            data: [{
              platform: 'google-chat',
              connected: true,
              details: {
                mode: 'pubsub',
                projectId: 'my-project',
                subscriptionName: 'projects/my-project/subscriptions/chat-sub',
                pullActive: true,
                pullPaused: false,
              },
            }],
          }),
        });
      });
    });

    it('should show pubsub mode label', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Pub/Sub (Bidirectional)')).toBeInTheDocument();
      });
    });

    it('should show project ID', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('my-project')).toBeInTheDocument();
      });
    });

    it('should show pull status as Running', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Running')).toBeInTheDocument();
      });
    });

    it('should show Pull Now button in pubsub mode', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Pull Now')).toBeInTheDocument();
      });
    });

    it('should show subscription name', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('projects/my-project/subscriptions/chat-sub')).toBeInTheDocument();
      });
    });

    it('should show Last Pull as Never when no pulls have occurred', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByTestId('last-pull-at')).toHaveTextContent('Never');
      });
    });
  });

  describe('ADC Auth Mode', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({
          success: true,
          data: [{ platform: 'google-chat', connected: false, details: { mode: 'none' } }],
        }),
      });
    });

    it('should show auth mode selector in pubsub mode', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByTestId('auth-service-account')).toBeInTheDocument();
        expect(screen.getByTestId('auth-adc')).toBeInTheDocument();
      });
    });

    it('should hide SA key input and show ADC instructions when ADC is selected', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByTestId('auth-adc')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('auth-adc'));

      expect(screen.getByText(/gcloud auth application-default login/)).toBeInTheDocument();
      expect(screen.queryByLabelText(/Service Account Key/)).not.toBeInTheDocument();
    });

    it('should show SA key input when service account auth is selected', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByTestId('auth-service-account')).toBeInTheDocument();
      });

      // Service account is default
      expect(screen.getByLabelText(/Service Account Key/)).toBeInTheDocument();
    });

    it('should show auth mode selector in service-account connection mode', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByTestId('mode-service-account')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('mode-service-account'));
      expect(screen.getByTestId('auth-adc')).toBeInTheDocument();
    });

    it('should not show auth mode selector in webhook mode', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByTestId('mode-webhook')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('mode-webhook'));
      expect(screen.queryByTestId('auth-adc')).not.toBeInTheDocument();
    });
  });

  describe('Pull Now functionality', () => {
    beforeEach(() => {
      mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
        if (url === '/api/messengers/google-chat/pull' && opts?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, messagesReceived: 2 }),
          });
        }
        if (url === '/api/messengers/google-chat/status') {
          return Promise.resolve({
            json: () => Promise.resolve({
              success: true,
              data: { mode: 'pubsub', pullActive: true, pullPaused: false, lastPullAt: null },
            }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            data: [{
              platform: 'google-chat',
              connected: true,
              details: { mode: 'pubsub', projectId: 'test', pullActive: true, pullPaused: false },
            }],
          }),
        });
      });
    });

    it('should call pull endpoint and show result', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Pull Now')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Pull Now'));

      await waitFor(() => {
        expect(screen.getByTestId('pull-result')).toHaveTextContent('Pulled 2 messages');
      });
    });

    it('should show "No new messages" when pull returns 0', async () => {
      mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
        if (url === '/api/messengers/google-chat/pull' && opts?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, messagesReceived: 0 }),
          });
        }
        if (url === '/api/messengers/google-chat/status') {
          return Promise.resolve({
            json: () => Promise.resolve({
              success: true,
              data: { mode: 'pubsub', pullActive: true, pullPaused: false, lastPullAt: null },
            }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            data: [{
              platform: 'google-chat',
              connected: true,
              details: { mode: 'pubsub', projectId: 'test', pullActive: true, pullPaused: false },
            }],
          }),
        });
      });

      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Pull Now')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Pull Now'));

      await waitFor(() => {
        expect(screen.getByTestId('pull-result')).toHaveTextContent('No new messages');
      });
    });
  });

  describe('Connected State (ADC)', () => {
    beforeEach(() => {
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/messengers/google-chat/status') {
          return Promise.resolve({
            json: () => Promise.resolve({
              success: true,
              data: { mode: 'pubsub', authMode: 'adc', pullActive: true, pullPaused: false, lastPullAt: null },
            }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            data: [{
              platform: 'google-chat',
              connected: true,
              details: {
                mode: 'pubsub',
                authMode: 'adc',
                projectId: 'my-project',
                pullActive: true,
                pullPaused: false,
              },
            }],
          }),
        });
      });
    });

    it('should show ADC auth mode in connection details', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Application Default Credentials')).toBeInTheDocument();
      });
    });
  });

  describe('Connected State (pubsub paused)', () => {
    beforeEach(() => {
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/messengers/google-chat/status') {
          return Promise.resolve({
            json: () => Promise.resolve({
              success: true,
              data: { mode: 'pubsub', pullActive: false, pullPaused: true, consecutiveFailures: 5, lastPullAt: null },
            }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            data: [{
              platform: 'google-chat',
              connected: true,
              details: {
                mode: 'pubsub',
                projectId: 'my-project',
                pullActive: false,
                pullPaused: true,
              },
            }],
          }),
        });
      });
    });

    it('should show pull status as Paused', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Paused (errors)')).toBeInTheDocument();
      });
    });

    it('should show consecutive failures count', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByTestId('consecutive-failures')).toHaveTextContent('5');
      });
    });
  });

  describe('Test Send functionality', () => {
    beforeEach(() => {
      mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
        if (url === '/api/messengers/google-chat/test-send' && opts?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, message: 'Test message sent' }),
          });
        }
        if (url === '/api/messengers/google-chat/status') {
          return Promise.resolve({
            json: () => Promise.resolve({
              success: true,
              data: { mode: 'pubsub', pullActive: true, pullPaused: false, lastPullAt: null },
            }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            data: [{
              platform: 'google-chat',
              connected: true,
              details: { mode: 'pubsub', projectId: 'test', pullActive: true, pullPaused: false },
            }],
          }),
        });
      });
    });

    it('should show Test Send section in pubsub mode', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByTestId('test-send-btn')).toBeInTheDocument();
        expect(screen.getByTestId('test-send-space')).toBeInTheDocument();
      });
    });

    it('should disable Test Send button when space is empty', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByTestId('test-send-btn')).toBeDisabled();
      });
    });

    it('should send test message and show success', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByTestId('test-send-space')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('test-send-space'), { target: { value: 'spaces/AAAA' } });
      fireEvent.click(screen.getByTestId('test-send-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('test-send-result')).toHaveTextContent('Message sent successfully');
      });
    });
  });

  describe('Webhook mode (no Pull Now button)', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({
          success: true,
          data: [{
            platform: 'google-chat',
            connected: true,
            details: { mode: 'webhook' },
          }],
        }),
      });
    });

    it('should NOT show Pull Now button in webhook mode', async () => {
      render(<GoogleChatTab />);

      await waitFor(() => {
        expect(screen.getByText('Connected to Google Chat')).toBeInTheDocument();
      });

      expect(screen.queryByText('Pull Now')).not.toBeInTheDocument();
    });
  });
});
