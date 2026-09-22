/**
 * BrowserView page tests.
 *
 * @module pages/BrowserView.test
 */

import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BrowserView } from './BrowserView';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** One session payload with sensible defaults. */
function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pia',
    agentSession: 'pia',
    agentName: 'Pia',
    status: 'reading',
    lastAction: 'Reading page',
    lastActionAt: 2,
    startedAt: 1,
    frameAt: 10,
    ...overrides,
  };
}

/** Route the list endpoint to a fixed set of sessions. */
function routeSessions(sessions: unknown[]) {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).startsWith('/api/browser/sessions?') || String(url) === '/api/browser/sessions') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { sessions } }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe('BrowserView', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('explains the empty state instead of showing a blank page', async () => {
    routeSessions([]);
    render(<BrowserView />);

    await waitFor(() => expect(screen.getByText('No agent is using the browser.')).toBeInTheDocument());
  });

  it('lists the sessions the backend reports', async () => {
    routeSessions([session(), session({ id: 'atlas', agentSession: 'atlas', agentName: 'Atlas' })]);
    render(<BrowserView />);

    await waitFor(() => expect(screen.getByText('Pia')).toBeInTheDocument());
    expect(screen.getByText('Atlas')).toBeInTheDocument();
  });

  it('opens the most recent session without making you click', async () => {
    // A page that shows nothing until you click is a page you stop opening.
    routeSessions([session()]);
    render(<BrowserView />);

    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
  });

  it('keeps your choice once you pick a card yourself', async () => {
    routeSessions([session(), session({ id: 'atlas', agentSession: 'atlas', agentName: 'Atlas' })]);
    render(<BrowserView />);

    await waitFor(() => expect(screen.getByText('Pia')).toBeInTheDocument());
    // Collapse the auto-opened one.
    fireEvent.click(screen.getByRole('button', { name: /Pia/ }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    // A later poll must not reopen it under the user.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('stops a session and refreshes the list', async () => {
    routeSessions([session()]);
    render(<BrowserView />);
    await waitFor(() => expect(screen.getByText('Pia')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Stop'));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/browser/sessions/pia/stop', { method: 'POST' }),
    );
  });
});
