/**
 * MicrosoftTodoTab Component Tests
 *
 * @module components/Settings/MicrosoftTodoTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MicrosoftTodoTab, describeMicrosoftScopes, describeConnectFailure } from './MicrosoftTodoTab';

const mockFetch = vi.fn();
global.fetch = mockFetch;
const mockConfirm = vi.fn();
window.confirm = mockConfirm;

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

const CONNECTED = {
  success: true,
  data: {
    connected: true,
    cloudConnected: true,
    microsoftUserId: 'mu-1',
    displayName: 'Steve',
    email: 'steve@outlook.com',
    scopes: ['User.Read', 'Tasks.ReadWrite'],
    grantedAt: '2026-09-23T00:00:00.000Z',
  },
};

describe('MicrosoftTodoTab', () => {
  const original = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReturnValue(true);
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { value: original, writable: true });
    vi.restoreAllMocks();
  });

  it('shows the connected account (name + email), access labels and Disconnect', async () => {
    mockFetch.mockResolvedValueOnce(respond(200, CONNECTED));
    render(<MicrosoftTodoTab />);
    await waitFor(() => expect(screen.getByText('Connected as Steve')).toBeInTheDocument());
    expect(mockFetch).toHaveBeenCalledWith('/api/microsoft-todo/status');
    expect(screen.getByTestId('microsoft-todo-account')).toHaveTextContent('Steve');
    expect(screen.getByTestId('microsoft-todo-account')).toHaveTextContent('steve@outlook.com');
    expect(screen.getByText('Read and write tasks')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('offers Connect when signed in to Cloud, and navigates to the Cloud URL with the Connections return path', async () => {
    mockFetch
      .mockResolvedValueOnce(respond(200, { success: true, data: { connected: false, cloudConnected: true } }))
      .mockResolvedValueOnce(respond(200, { success: true, data: { url: 'https://api.crewlyai.com/api/cloud/microsoft/start?token=j&returnUrl=x' } }));
    Object.defineProperty(window, 'location', { value: { ...original, href: '', origin: 'http://localhost:3000', search: '' }, writable: true });
    render(<MicrosoftTodoTab />);
    await waitFor(() => expect(screen.getByText('Microsoft To Do is not connected')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Connect Microsoft To Do' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockFetch.mock.calls[1][0]).toBe(
      '/api/microsoft-todo/connect-url?returnUrl=http%3A%2F%2Flocalhost%3A3000%2Fconnections%3Fplatform%3Dmicrosoft-todo',
    );
    await waitFor(() => expect(window.location.href).toBe('https://api.crewlyai.com/api/cloud/microsoft/start?token=j&returnUrl=x'));
  });

  it('explains a failed return (admin consent) from ?microsoft=error&reason=', async () => {
    mockFetch.mockResolvedValueOnce(respond(200, { success: true, data: { connected: false, cloudConnected: true } }));
    Object.defineProperty(window, 'location', {
      value: { ...original, href: '', origin: 'http://localhost:3000', search: '?platform=microsoft-todo&microsoft=error&reason=consent_required' },
      writable: true,
    });
    render(<MicrosoftTodoTab />);
    await waitFor(() => expect(screen.getByText(/requires an administrator/)).toBeInTheDocument());
  });

  it('explains Cloud sign-in is needed first; disconnects after confirmation; surfaces not_configured', async () => {
    mockFetch.mockResolvedValueOnce(respond(200, { success: true, data: { connected: false, cloudConnected: false } }));
    const { unmount } = render(<MicrosoftTodoTab />);
    await waitFor(() => expect(screen.getByText(/Sign in to Crewly Cloud first/)).toBeInTheDocument());
    unmount();

    mockFetch
      .mockResolvedValueOnce(respond(200, CONNECTED))
      .mockResolvedValueOnce(respond(200, { success: true, data: { removed: true } }))
      .mockResolvedValueOnce(respond(200, { success: true, data: { connected: false, cloudConnected: true } }));
    const r2 = render(<MicrosoftTodoTab />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(screen.getByText('Microsoft To Do is not connected')).toBeInTheDocument());
    expect(mockFetch.mock.calls.some((c) => c[0] === '/api/microsoft-todo/disconnect' && c[1]?.method === 'DELETE')).toBe(true);
    r2.unmount();

    mockFetch.mockResolvedValueOnce(
      respond(503, { success: false, error: 'not_configured', hint: 'Crewly Cloud is not configured for Microsoft yet; nothing to do on this instance.' }),
    );
    render(<MicrosoftTodoTab />);
    await waitFor(() => expect(screen.getByText(/not configured for Microsoft/)).toBeInTheDocument());
  });

  it('does not disconnect when the confirmation is cancelled', async () => {
    mockConfirm.mockReturnValue(false);
    mockFetch.mockResolvedValueOnce(respond(200, CONNECTED));
    render(<MicrosoftTodoTab />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('describeMicrosoftScopes maps known scopes (bare or full URI) and drops identity ones', () => {
    expect(describeMicrosoftScopes(['openid', 'offline_access', 'User.Read', 'https://graph.microsoft.com/Tasks.ReadWrite', 'tasks.readwrite'])).toEqual([
      'Read and write tasks',
    ]);
    expect(describeMicrosoftScopes(undefined)).toEqual([]);
  });

  it('describeConnectFailure words the common reasons', () => {
    expect(describeConnectFailure('access_denied')).toMatch(/declined/);
    expect(describeConnectFailure('invalid_state')).toMatch(/expired/);
    expect(describeConnectFailure('exchange_failed')).toMatch(/\(exchange_failed\)/);
    expect(describeConnectFailure(null)).toBe('Microsoft To Do connection failed. Please try again.');
  });
});
