/**
 * GoogleWorkspaceTab Component Tests
 *
 * @module components/Settings/GoogleWorkspaceTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GoogleWorkspaceTab, describeScopes } from './GoogleWorkspaceTab';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockConfirm = vi.fn();
window.confirm = mockConfirm;

/**
 * Queue one JSON response.
 */
function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

const CONNECTED = {
  success: true,
  data: {
    connected: true,
    cloudConnected: true,
    email: 'owner@example.com',
    scopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events'],
    grantedAt: '2026-09-18T00:00:00.000Z',
  },
};

describe('GoogleWorkspaceTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading state first', () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));
    render(<GoogleWorkspaceTab />);
    expect(screen.getByText('Loading Google Workspace status...')).toBeInTheDocument();
  });

  it('shows the connected email, access labels and a Disconnect button when connected', async () => {
    mockFetch.mockResolvedValueOnce(respond(200, CONNECTED));
    render(<GoogleWorkspaceTab />);

    await waitFor(() => expect(screen.getByText('Connected as owner@example.com')).toBeInTheDocument());
    expect(mockFetch).toHaveBeenCalledWith('/api/google/status');
    expect(screen.getByTestId('google-workspace-email')).toHaveTextContent('owner@example.com');
    expect(screen.getByText('Read mail, Manage events')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Google Workspace' })).not.toBeInTheDocument();
  });

  it('offers Connect when signed in to Cloud but not connected, and navigates to the Cloud URL', async () => {
    mockFetch
      .mockResolvedValueOnce(respond(200, { success: true, data: { connected: false, cloudConnected: true } }))
      .mockResolvedValueOnce(respond(200, { success: true, data: { url: 'https://api.crewlyai.com/api/cloud/google/workspace/start?token=j&returnUrl=x' } }));

    const original = window.location;
    Object.defineProperty(window, 'location', { value: { ...original, href: '', origin: 'http://localhost:3000', search: '' }, writable: true });

    render(<GoogleWorkspaceTab />);
    await waitFor(() => expect(screen.getByText('Google Workspace is not connected')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Connect Google Workspace' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockFetch.mock.calls[1][0]).toBe('/api/google/connect-url?returnUrl=http%3A%2F%2Flocalhost%3A3000%2Fsettings%3Ftab%3Dintegrations');
    await waitFor(() => expect(window.location.href).toBe('https://api.crewlyai.com/api/cloud/google/workspace/start?token=j&returnUrl=x'));

    Object.defineProperty(window, 'location', { value: original, writable: true });
  });

  it('explains Cloud sign-in is needed first when not signed in to Cloud', async () => {
    mockFetch.mockResolvedValueOnce(respond(200, { success: true, data: { connected: false, cloudConnected: false } }));
    render(<GoogleWorkspaceTab />);
    await waitFor(() => expect(screen.getByText(/Sign in to Crewly Cloud first/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Connect Google Workspace' })).not.toBeInTheDocument();
  });

  it('surfaces the backend hint when connect-url fails', async () => {
    mockFetch
      .mockResolvedValueOnce(respond(200, { success: true, data: { connected: false, cloudConnected: true } }))
      .mockResolvedValueOnce(respond(401, { success: false, error: 'not_logged_in', hint: 'Sign in to Crewly Cloud first (Settings → Cloud).' }));
    render(<GoogleWorkspaceTab />);
    await waitFor(() => screen.getByRole('button', { name: 'Connect Google Workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google Workspace' }));
    await waitFor(() => expect(screen.getByText('Sign in to Crewly Cloud first (Settings → Cloud).')).toBeInTheDocument());
  });

  it('disconnects after confirmation and reloads status', async () => {
    mockFetch
      .mockResolvedValueOnce(respond(200, CONNECTED))
      .mockResolvedValueOnce(respond(200, { success: true, data: { removed: true } }))
      .mockResolvedValueOnce(respond(200, { success: true, data: { connected: false, cloudConnected: true } }));
    render(<GoogleWorkspaceTab />);
    await waitFor(() => screen.getByRole('button', { name: 'Disconnect' }));

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(screen.getByText('Google Workspace is not connected')).toBeInTheDocument());
    expect(mockConfirm).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenNthCalledWith(2, '/api/google/disconnect', { method: 'DELETE' });
  });

  it('does nothing when disconnect is cancelled', async () => {
    mockConfirm.mockReturnValue(false);
    mockFetch.mockResolvedValueOnce(respond(200, CONNECTED));
    render(<GoogleWorkspaceTab />);
    await waitFor(() => screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Connected as owner@example.com')).toBeInTheDocument();
  });

  it('shows an error when the status request fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));
    render(<GoogleWorkspaceTab />);
    await waitFor(() => expect(screen.getByText('Failed to fetch Google Workspace status')).toBeInTheDocument());
  });

  it('describeScopes maps known scopes and drops identity ones', () => {
    expect(describeScopes(['openid', 'https://www.googleapis.com/auth/gmail.send'])).toEqual(['Send mail']);
    expect(describeScopes(undefined)).toEqual([]);
  });
});
