/**
 * CanvaTab Component Tests
 *
 * @module components/Settings/CanvaTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CanvaTab, describeCanvaScopes } from './CanvaTab';

const mockFetch = vi.fn();
global.fetch = mockFetch;
const mockConfirm = vi.fn();
window.confirm = mockConfirm;

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

const CONNECTED = {
  success: true,
  data: { connected: true, cloudConnected: true, canvaUserId: 'cu-1', displayName: 'Steve', scopes: ['openid', 'design:meta:read', 'asset:write'], grantedAt: '2026-09-19T00:00:00.000Z' },
};

describe('CanvaTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the connected account, access labels and Disconnect when connected', async () => {
    mockFetch.mockResolvedValueOnce(respond(200, CONNECTED));
    render(<CanvaTab />);
    await waitFor(() => expect(screen.getByText('Connected as Steve')).toBeInTheDocument());
    expect(mockFetch).toHaveBeenCalledWith('/api/canva/status');
    expect(screen.getByTestId('canva-account')).toHaveTextContent('Steve');
    expect(screen.getByText('List designs, Upload assets')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('offers Connect when signed in to Cloud but not connected, and navigates to the Cloud URL', async () => {
    mockFetch
      .mockResolvedValueOnce(respond(200, { success: true, data: { connected: false, cloudConnected: true } }))
      .mockResolvedValueOnce(respond(200, { success: true, data: { url: 'https://api.crewlyai.com/api/cloud/canva/start?token=j&returnUrl=x' } }));
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { ...original, href: '', origin: 'http://localhost:3000', search: '' }, writable: true });
    render(<CanvaTab />);
    await waitFor(() => expect(screen.getByText('Canva is not connected')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Connect Canva' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockFetch.mock.calls[1][0]).toBe('/api/canva/connect-url?returnUrl=http%3A%2F%2Flocalhost%3A3000%2Fsettings%3Ftab%3Dintegrations');
    await waitFor(() => expect(window.location.href).toBe('https://api.crewlyai.com/api/cloud/canva/start?token=j&returnUrl=x'));
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });

  it('explains Cloud sign-in is needed first; disconnects after confirmation; surfaces status errors', async () => {
    mockFetch.mockResolvedValueOnce(respond(200, { success: true, data: { connected: false, cloudConnected: false } }));
    const { unmount } = render(<CanvaTab />);
    await waitFor(() => expect(screen.getByText(/Sign in to Crewly Cloud first/)).toBeInTheDocument());
    unmount();

    mockFetch
      .mockResolvedValueOnce(respond(200, CONNECTED))
      .mockResolvedValueOnce(respond(200, { success: true, data: { removed: true } }))
      .mockResolvedValueOnce(respond(200, { success: true, data: { connected: false, cloudConnected: true } }));
    const r2 = render(<CanvaTab />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(screen.getByText('Canva is not connected')).toBeInTheDocument());
    expect(mockFetch.mock.calls.some((c) => c[0] === '/api/canva/disconnect' && c[1]?.method === 'DELETE')).toBe(true);
    r2.unmount();

    mockFetch.mockResolvedValueOnce(respond(503, { success: false, error: 'not_configured', hint: 'Crewly Cloud is not configured for Canva; nothing to do on this instance.' }));
    render(<CanvaTab />);
    await waitFor(() => expect(screen.getByText(/not configured for Canva/)).toBeInTheDocument());
  });

  it('describeCanvaScopes maps known scopes and drops identity ones', () => {
    expect(describeCanvaScopes(['openid', 'design:content:write', 'x'])).toEqual(['Create designs']);
    expect(describeCanvaScopes(undefined)).toEqual([]);
  });
});
