/**
 * SlackAgentIdentities tests.
 *
 * @module components/Settings/SlackAgentIdentities.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SlackAgentIdentities, buildTeamLookup, isOrchestratorGroup } from './SlackAgentIdentities';

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

  it('offers a re-authorization link for an installed bot that needs new permissions', async () => {
    routeFetch({}, {
      ...basePayload,
      data: {
        ...basePayload.data,
        identities: [{ agentSession: 's', displayName: 'Sam', appId: 'A1', status: 'installed', botUserId: 'USAM', hasToken: true, reinstall: true, installUrl: 'https://slack.com/oauth/v2/authorize?re' }],
      },
    });
    render(<SlackAgentIdentities />);
    // 'Sam' appears twice once it is stale — in its row and in the summary banner above the
    // team list — so anchor the wait on the row's own link instead.
    await waitFor(() => expect(screen.getByText('Re-authorize Sam')).toBeInTheDocument());
    expect(screen.getByText(/new permissions need your re-authorization/)).toBeInTheDocument();
    expect(screen.getByText('Re-authorize Sam').closest('a')!.getAttribute('href')).toBe('https://slack.com/oauth/v2/authorize?re');
  });

  it('summarizes, above the team list, which installed agents are waiting on a re-authorization', async () => {
    routeFetch({}, {
      ...basePayload,
      data: {
        ...basePayload.data,
        identities: [
          { agentSession: 's', displayName: 'Sam', appId: 'A1', status: 'installed', botUserId: 'USAM', hasToken: true, reinstall: true, installUrl: 'https://slack.com/oauth/v2/authorize?re' },
          { agentSession: 'a', displayName: 'Ada', appId: 'A3', status: 'installed', botUserId: 'UADA', hasToken: true, reinstall: true, installUrl: 'https://slack.com/oauth/v2/authorize?re2' },
          { agentSession: 'l', displayName: 'Leo', appId: 'A2', status: 'pending_install', installUrl: 'https://slack.com/oauth/v2/authorize?x', hasToken: false },
        ],
      },
    });
    render(<SlackAgentIdentities />);
    await waitFor(() => expect(screen.getByText('Sam')).toBeInTheDocument());
    // The count covers only the installed-but-stale ones: Leo was never installed, so it is not
    // waiting on anything the owner has to re-click.
    expect(screen.getByText('2 installed agents need re-authorization.')).toBeInTheDocument();
    expect(screen.getByText('Sam · Ada')).toBeInTheDocument();
  });

  it('shows no re-authorization banner when every installed agent is current', async () => {
    routeFetch();
    render(<SlackAgentIdentities />);
    await waitFor(() => expect(screen.getByText('Sam')).toBeInTheDocument());
    expect(screen.queryByText(/need(s)? re-authorization\./)).not.toBeInTheDocument();
  });

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

  it('groups identities by team with an installed count, and Sync agents re-provisions then reloads', async () => {
    routeFetch({
      'GET /api/teams': () =>
        jsonResponse({
          success: true,
          data: [
            { name: 'Alpha', members: [{ sessionName: 's', name: 'Sam' }, { sessionName: 'l', name: 'Leo' }] },
          ],
        }),
      'POST /api/slack/cloud/agents/sync': () => jsonResponse({ success: true, data: { installUrls: [] } }),
    });
    render(<SlackAgentIdentities pendingInstalls={[{ agentSession: 'beta-zed-1', url: 'https://slack.com/oauth/zed' }]} />);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    expect(screen.getByText('1 / 2 installed')).toBeInTheDocument();
    expect(screen.getByText('Other agents')).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 agents installed/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Sync agents with Crewly Cloud'));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/slack/cloud/agents/sync', { method: 'POST' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/slack/agent-identities?refresh=1'));
  });

  it('refresh asks Cloud for fresh data', async () => {
    routeFetch();
    render(<SlackAgentIdentities />);
    await waitFor(() => expect(screen.getByText('Sam')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Refresh agent identities'));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/slack/agent-identities?refresh=1'));
  });

  it('renders Cloud-sync pending install links for agents without a local record (and not for known ones)', async () => {
    routeFetch();
    render(
      <SlackAgentIdentities
        pendingInstalls={[
          { agentSession: 'alpha-zed-1', url: 'https://slack.com/oauth/zed' },
          { agentSession: 'l', url: 'https://slack.com/oauth/dup' },
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByText('Sam')).toBeInTheDocument());
    const link = screen.getByText('Install alpha-zed-1').closest('a')!;
    expect(link.getAttribute('href')).toBe('https://slack.com/oauth/zed');
    // Leo already has a local record → only his own install link is shown.
    expect(screen.getAllByText(/^Install /)).toHaveLength(2);
  });
});

describe('buildTeamLookup', () => {
  it('derives the session name for a stopped member so it groups under its team', () => {
    const map = buildTeamLookup([
      { name: 'Think Tank', members: [
        { id: 'b4e166f6-1', name: 'Atlas', sessionName: 'think-tank-atlas-b4e166f6' },
        { id: '2ffacc8f-0000-4000-8000-000000000000', name: 'Sage', sessionName: '' },
      ] },
    ]);
    expect(map['think-tank-atlas-b4e166f6']?.teamName).toBe('Think Tank');
    expect(map['think-tank-sage-2ffacc8f']).toEqual({ teamName: 'Think Tank', memberName: 'Sage' });
  });
});


/**
 * The orchestrator is the one bot the owner talks to directly, and it
 * arrives last in the sync payload — so it rendered at the bottom of a list
 * thirty agents long, below every team (owner, 2026-09-21).
 */
describe('isOrchestratorGroup', () => {
  it('spots the orchestrator by session, not by the team name', () => {
    expect(isOrchestratorGroup([{ agentSession: 'crewly-orc' }])).toBe(true);
    // Cloud registers it per instance so two machines do not share an app;
    // matching on equality alone stopped recognising it the moment that
    // shipped, and it fell to the bottom of the list under "Other agents"
    // (owner, 2026-09-21).
    expect(isOrchestratorGroup([{ agentSession: 'crewly-orc@f4b6f0db-a047' }])).toBe(true);
    // The display name is qualified by machine once a second one appears,
    // so matching on it would break exactly when two machines exist.
    expect(isOrchestratorGroup([{ agentSession: 'marketing-ella-1234' }])).toBe(false);
  });

  it('is false for an empty group', () => {
    expect(isOrchestratorGroup([])).toBe(false);
  });

  it('spots it among other members', () => {
    expect(isOrchestratorGroup([{ agentSession: 'a' }, { agentSession: 'crewly-orc' }])).toBe(true);
  });
});
