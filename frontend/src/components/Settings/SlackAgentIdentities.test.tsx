/**
 * SlackAgentIdentities tests.
 *
 * @module components/Settings/SlackAgentIdentities.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SlackAgentIdentities } from './SlackAgentIdentities';

const mockFetch = vi.fn();
global.fetch = mockFetch;
const mockConfirm = vi.fn();
window.confirm = mockConfirm;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) };
}

const basePayload = {
  success: true,
  data: {
    cloud: { enabled: true, configToken: { configured: true, status: 'ok' }, agents: { total: 2, installed: 1, pending: 1 } },
    identities: [
      { agentSession: 's', displayName: 'Sam', appId: 'A1', status: 'installed', botUserId: 'USAM', hasToken: true },
      { agentSession: 'l', displayName: 'Leo', appId: 'A2', status: 'pending_install', installUrl: 'https://slack.com/oauth/v2/authorize?x', hasToken: false },
    ],
  },
};

function routeFetch(overrides: Record<string, (init?: RequestInit) => unknown> = {}, list: unknown = basePayload) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (key.startsWith(pattern)) return Promise.resolve(handler(init));
    }
    if (key.startsWith('GET /api/slack/agent-identities')) return Promise.resolve(jsonResponse(list));
    return Promise.resolve(jsonResponse({ success: true, data: {} }));
  });
}

describe('SlackAgentIdentities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists identities with status and an install link for pending ones', async () => {
    routeFetch();
    render(<SlackAgentIdentities />);
    await waitFor(() => expect(screen.getByText('Sam')).toBeInTheDocument());
    expect(screen.getByText(/Installed · bot USAM/)).toBeInTheDocument();
    expect(screen.getByText('Waiting for your install click')).toBeInTheDocument();
    const link = screen.getByText('Install Leo').closest('a')!;
    expect(link.getAttribute('href')).toBe('https://slack.com/oauth/v2/authorize?x');
    expect(screen.getByText('Remove token')).toBeInTheDocument();
    expect(screen.queryByLabelText('Refresh token (xoxe-…)')).not.toBeInTheDocument();
  });

  it('shows the token form when no token is stored and submits both values', async () => {
    const put = vi.fn(() => jsonResponse({ success: true, data: { configured: true, status: 'ok' } }));
    routeFetch(
      { 'PUT /api/slack/agent-identities/config-token': put },
      { success: true, data: { cloud: { enabled: true, configToken: { configured: false }, agents: { total: 0, installed: 0, pending: 0 } }, identities: [] } },
    );
    render(<SlackAgentIdentities />);
    await waitFor(() => expect(screen.getByLabelText('Refresh token (xoxe-…)')).toBeInTheDocument());
    const submit = screen.getByText('Save configuration token').closest('button')!;
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Access token (xoxe.xoxp-…)'), { target: { value: 'xoxe.xoxp-1' } });
    fireEvent.change(screen.getByLabelText('Refresh token (xoxe-…)'), { target: { value: 'xoxe-1' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(JSON.parse(String((put.mock.calls[0][0] as RequestInit).body))).toEqual({ token: 'xoxe.xoxp-1', refreshToken: 'xoxe-1' });
    expect(screen.getByText(/No agent identities yet/)).toBeInTheDocument();
  });

  it('shows an invalid-token warning with the form to replace it', async () => {
    routeFetch(
      {},
      { success: true, data: { cloud: { enabled: true, configToken: { configured: true, status: 'invalid', lastError: 'invalid_refresh_token' }, agents: { total: 0, installed: 0, pending: 0 } }, identities: [] } },
    );
    render(<SlackAgentIdentities />);
    await waitFor(() => expect(screen.getByText(/no longer valid/)).toBeInTheDocument());
    expect(screen.getByText(/invalid_refresh_token/)).toBeInTheDocument();
    expect(screen.getByLabelText('Refresh token (xoxe-…)')).toBeInTheDocument();
  });

  it('explains when Cloud login is missing (401) or the feature is off on Cloud', async () => {
    routeFetch({ 'GET /api/slack/agent-identities': () => jsonResponse({ success: false, error: 'Log in to Crewly Cloud first', code: 'CLOUD_NOT_CONNECTED' }, false, 401) });
    render(<SlackAgentIdentities />);
    await waitFor(() => expect(screen.getByText('Log in to Crewly Cloud first')).toBeInTheDocument());
  });

  it('deletes an identity and removes the token after confirmation', async () => {
    const del = vi.fn(() => jsonResponse({ success: true, data: { removed: true } }));
    routeFetch({ 'DELETE /api/slack/agent-identities': del });
    render(<SlackAgentIdentities />);
    await waitFor(() => expect(screen.getByLabelText('Delete identity for Leo')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Delete identity for Leo'));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/slack/agent-identities/l', { method: 'DELETE' }));
    fireEvent.click(screen.getByText('Remove token'));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/slack/agent-identities/config-token', { method: 'DELETE' }));
    expect(del).toHaveBeenCalledTimes(2);
  });

  it('refresh asks Cloud for fresh data', async () => {
    routeFetch();
    render(<SlackAgentIdentities />);
    await waitFor(() => expect(screen.getByText('Sam')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Refresh agent identities'));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/slack/agent-identities?refresh=1'));
  });
});
