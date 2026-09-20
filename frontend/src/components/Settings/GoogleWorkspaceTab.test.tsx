/**
 * GoogleWorkspaceTab Component Tests
 *
 * What these lock down: consent is per product (a Calendar connect must not
 * request Gmail), and a Crewly account can hold several Google accounts —
 * before 2026-09-19 connecting a second one silently replaced the first.
 *
 * @module components/Settings/GoogleWorkspaceTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GoogleWorkspaceTab,
  describeScopes,
  missingProducts,
  buildConnectRequest,
  type GoogleConnection,
} from './GoogleWorkspaceTab';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockConfirm = vi.fn();
window.confirm = mockConfirm;

/** Queue one JSON response. */
function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** One connected Google account. */
function connection(over: Partial<GoogleConnection> = {}): GoogleConnection {
  return {
    email: 'owner@example.com',
    products: ['gmail'],
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    grantedAt: '2026-09-18T00:00:00.000Z',
    isDefault: true,
    ...over,
  };
}

/** A `/status` payload. */
function status(connections: GoogleConnection[], cloudConnected = true) {
  return {
    success: true,
    data: { connected: connections.length > 0, cloudConnected, connections },
  };
}

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
    expect(screen.getByText('Loading Google status...')).toBeInTheDocument();
  });

  it('asks for Cloud sign-in before anything else', async () => {
    mockFetch.mockResolvedValueOnce(respond(200, status([], false)));
    render(<GoogleWorkspaceTab />);
    await waitFor(() => expect(screen.getByText(/Sign in to Crewly Cloud first/)).toBeInTheDocument());
  });

  it('offers each product separately when nothing is connected', async () => {
    mockFetch.mockResolvedValueOnce(respond(200, status([])));
    render(<GoogleWorkspaceTab />);
    await waitFor(() => expect(screen.getByTestId('google-connect-gmail')).toBeInTheDocument());
    expect(screen.getByTestId('google-connect-calendar')).toBeInTheDocument();
    expect(screen.getByTestId('google-connect-drive')).toBeInTheDocument();
    // The tier that forces a Google security review is called out.
    expect(screen.getAllByText('restricted')).toHaveLength(2);
  });

  it('requests only the product whose button was pressed', async () => {
    mockFetch
      .mockResolvedValueOnce(respond(200, status([])))
      .mockResolvedValueOnce(respond(200, { success: true, data: { url: 'https://accounts.google/x' } }));
    render(<GoogleWorkspaceTab />);
    await waitFor(() => expect(screen.getByTestId('google-connect-calendar')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('google-connect-calendar'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const url = mockFetch.mock.calls[1][0] as string;
    expect(url).toContain('products=calendar');
    expect(url).not.toContain('gmail');
  });

  it('lists every connected account with what it may be used for', async () => {
    mockFetch.mockResolvedValueOnce(
      respond(200, status([
        connection({ email: 'a@example.com', products: ['gmail', 'calendar'], isDefault: true }),
        connection({ email: 'b@example.com', products: ['drive'], isDefault: false }),
      ])),
    );
    render(<GoogleWorkspaceTab />);
    await waitFor(() => expect(screen.getByTestId('google-account-a@example.com')).toBeInTheDocument());
    expect(screen.getByTestId('google-account-b@example.com')).toBeInTheDocument();
    expect(screen.getByText('Gmail · Calendar')).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  it('adds a missing product to the account that lacks it, preselecting that account', async () => {
    mockFetch
      .mockResolvedValueOnce(respond(200, status([connection({ email: 'a@example.com', products: ['gmail'] })])))
      .mockResolvedValueOnce(respond(200, { success: true, data: { url: 'https://accounts.google/x' } }));
    render(<GoogleWorkspaceTab />);
    await waitFor(() => expect(screen.getByTestId('google-add-drive-a@example.com')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('google-add-drive-a@example.com'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const url = mockFetch.mock.calls[1][0] as string;
    expect(url).toContain('products=drive');
    expect(url).toContain('loginHint=a%40example.com');
  });

  it('asks Google for the account chooser when adding another account', async () => {
    mockFetch
      .mockResolvedValueOnce(respond(200, status([connection()])))
      .mockResolvedValueOnce(respond(200, { success: true, data: { url: 'https://accounts.google/x' } }));
    render(<GoogleWorkspaceTab />);
    await waitFor(() => expect(screen.getByTestId('google-add-account')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('google-add-account'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    // Without this Google reuses the signed-in session and re-consents the
    // account that is already connected.
    expect(mockFetch.mock.calls[1][0] as string).toContain('chooseAccount=1');
  });

  it('disconnects one named account rather than everything', async () => {
    mockFetch
      .mockResolvedValueOnce(respond(200, status([
        connection({ email: 'a@example.com' }),
        connection({ email: 'b@example.com', isDefault: false }),
      ])))
      .mockResolvedValueOnce(respond(200, { success: true, data: { removed: true } }))
      .mockResolvedValueOnce(respond(200, status([connection({ email: 'a@example.com' })])));
    render(<GoogleWorkspaceTab />);
    await waitFor(() => expect(screen.getByTestId('google-account-b@example.com')).toBeInTheDocument());

    const card = screen.getByTestId('google-account-b@example.com');
    fireEvent.click(within(card).getByText('Disconnect'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(mockFetch.mock.calls[1][0] as string).toContain('account=b%40example.com');
    expect((mockFetch.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
  });

  it('moves the default to another account', async () => {
    mockFetch
      .mockResolvedValueOnce(respond(200, status([
        connection({ email: 'a@example.com' }),
        connection({ email: 'b@example.com', isDefault: false }),
      ])))
      .mockResolvedValueOnce(respond(200, { success: true, data: { updated: true } }))
      .mockResolvedValueOnce(respond(200, status([connection({ email: 'a@example.com', isDefault: false })])));
    render(<GoogleWorkspaceTab />);
    await waitFor(() => expect(screen.getByText('Make default')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Make default'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(mockFetch.mock.calls[1][0]).toBe('/api/google/default');
    expect(JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string)).toEqual({ email: 'b@example.com' });
  });

  it('surfaces a failed status fetch', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));
    render(<GoogleWorkspaceTab />);
    await waitFor(() => expect(screen.getByText('Failed to fetch Google status')).toBeInTheDocument());
  });
});

describe('describeScopes', () => {
  it('labels known scopes and drops identity ones', () => {
    expect(
      describeScopes(['openid', 'https://www.googleapis.com/auth/gmail.readonly']),
    ).toEqual(['Read mail']);
    expect(describeScopes(undefined)).toEqual([]);
  });
});

describe('missingProducts', () => {
  it('lists what an account has not got yet', () => {
    expect(missingProducts(connection({ products: ['gmail'] })).map((p) => p.id)).toEqual(['calendar', 'drive']);
    expect(missingProducts(connection({ products: ['gmail', 'calendar', 'drive'] }))).toEqual([]);
  });
});

describe('buildConnectRequest', () => {
  it('carries the return URL, and nothing else by default', () => {
    const url = new URL(buildConnectRequest('https://x'), 'https://x');
    expect(url.searchParams.get('returnUrl')).toBe('https://x/connections?platform=google-workspace');
    expect(url.searchParams.has('products')).toBe(false);
    expect(url.searchParams.has('chooseAccount')).toBe(false);
  });

  it('carries products, a login hint and the chooser when asked', () => {
    const url = new URL(
      buildConnectRequest('https://x', { products: ['gmail', 'drive'], loginHint: 'a@b.com', chooseAccount: true }),
      'https://x',
    );
    expect(url.searchParams.get('products')).toBe('gmail,drive');
    expect(url.searchParams.get('loginHint')).toBe('a@b.com');
    expect(url.searchParams.get('chooseAccount')).toBe('1');
  });
});
