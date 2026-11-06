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

/** Route the list endpoint to a fixed set of sessions; `status` is the /api/browser/status answer (null = it fails). */
function routeSessions(sessions: unknown[], status: Record<string, unknown> | null = { clientCount: 0, drivable: false }) {
  mockFetch.mockImplementation((url: string) => {
    if (String(url) === '/api/browser/status') {
      return status ? Promise.resolve({ ok: true, json: () => Promise.resolve(status) }) : Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    }
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

  it('offers a one-click install of Crewly in Chrome in the empty state, in a new tab, tagged browser-empty', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    routeSessions([]);
    render(<BrowserView />);

    const button = await screen.findByTestId('browser-install-extension');
    expect(button).toHaveTextContent('Install Crewly in Chrome');
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith(
      'https://chromewebstore.google.com/detail/crewly-in-chrome/mekcefkcdgefjhadkcbkdpmilcaekhnc?utm_source=crewly-app&utm_medium=browser-empty&utm_campaign=chrome-ext-usage',
      '_blank',
      'noopener,noreferrer',
    );
    open.mockRestore();
  });

  it.each([
    ['a direct extension client', { clientCount: 1, drivable: false }],
    ['a browser through the Cloud relay', { clientCount: 0, drivable: true }],
  ])('connected (%s) and no sessions: no install button, the empty state stays', async (_label, status) => {
    routeSessions([], status);
    render(<BrowserView />);

    await waitFor(() => expect(screen.getByText('No agent is using the browser.')).toBeInTheDocument());
    expect(screen.queryByTestId('browser-install-extension')).not.toBeInTheDocument();
  });

  it('status unreadable: does not guess, so no install button', async () => {
    routeSessions([], null);
    render(<BrowserView />);

    await waitFor(() => expect(screen.getByText('No agent is using the browser.')).toBeInTheDocument());
    expect(screen.queryByTestId('browser-install-extension')).not.toBeInTheDocument();
  });

  it('does not show the install button once agents have browser sessions', async () => {
    routeSessions([session()]);
    render(<BrowserView />);

    await waitFor(() => expect(screen.getByText('Pia')).toBeInTheDocument());
    expect(screen.queryByTestId('browser-install-extension')).not.toBeInTheDocument();
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

  it('says how many sessions are live in the header, leaving finished ones out', async () => {
    routeSessions([session(), session({ id: 'atlas', agentSession: 'atlas', agentName: 'Atlas', status: 'done' })]);
    render(<BrowserView />);
    await waitFor(() => expect(screen.getByTestId('browser-live-count')).toHaveTextContent('1 live session'));
    expect(screen.getByRole('heading', { name: 'Browser' })).toBeInTheDocument();
  });
});
