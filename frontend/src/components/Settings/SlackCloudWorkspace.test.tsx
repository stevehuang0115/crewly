/**
 * SlackCloudWorkspace tests — the one-click Connect button, the workspace
 * card, the primary toggle, pending installs and workspace removal.
 *
 * @module components/Settings/SlackCloudWorkspace.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SlackCloudWorkspace, slackInstallReturnUrl, type SlackCloudStatus } from './SlackCloudWorkspace';

const mockFetch = vi.fn();
global.fetch = mockFetch;
const mockConfirm = vi.fn();
window.confirm = mockConfirm;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) };
}

const base: SlackCloudStatus = {
  cloudConnected: true,
  sourceMode: 'auto',
  activeSource: null,
  connected: false,
  transport: null,
  workspace: null,
  configFetchedAt: null,
  configError: null,
  primary: false,
  instanceId: 'device-1',
  lastHeartbeatAt: null,
  registryError: null,
  pendingInstalls: [],
  local: { env: false, saved: false },
};

const connected: SlackCloudStatus = {
  ...base,
  activeSource: 'cloud',
  connected: true,
  transport: 'cloud',
  workspace: { slackTeamId: 'T1', slackTeamName: 'Acme', botUserId: 'UBOT', appId: 'A0', agentIdentities: 2 },
  lastHeartbeatAt: '2026-09-18T10:00:00.000Z',
  pendingInstalls: [{ agentSession: 'alpha-kai-1', url: 'https://slack.com/oauth/kai' }],
};

describe('SlackCloudWorkspace', () => {
  let assign: ReturnType<typeof vi.fn>;
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReturnValue(true);
    assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, origin: 'http://localhost:3000', assign },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    vi.restoreAllMocks();
  });

  it('builds the dashboard return URL from the page origin', () => {
    expect(slackInstallReturnUrl()).toBe('http://localhost:3000/settings?tab=slack');
  });

  it('asks for a Cloud login when the instance is not signed in', () => {
    render(<SlackCloudWorkspace status={{ ...base, cloudConnected: false }} onRefresh={vi.fn()} />);
    expect(screen.getByText(/Log in to Crewly Cloud first/)).toBeInTheDocument();
    expect(screen.queryByText('Connect Slack')).not.toBeInTheDocument();
  });

  it('explains the env-only mode when CREWLY_SLACK_SOURCE=env', () => {
    render(<SlackCloudWorkspace status={{ ...base, sourceMode: 'env' }} onRefresh={vi.fn()} />);
    expect(screen.getByText(/CREWLY_SLACK_SOURCE=env/)).toBeInTheDocument();
  });

  it('Connect Slack fetches the install URL with the return URL and navigates to it', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { url: 'https://api.crewlyai.com/api/cloud/slack/install?token=x&returnUrl=y' } }),
    );
    render(<SlackCloudWorkspace status={base} onRefresh={vi.fn()} />);

    fireEvent.click(screen.getByText('Connect Slack'));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://api.crewlyai.com/api/cloud/slack/install?token=x&returnUrl=y'));
    expect(mockFetch).toHaveBeenCalledWith(
      `/api/slack/cloud/install-url?returnUrl=${encodeURIComponent('http://localhost:3000/settings?tab=slack')}`,
    );
  });

  it('shows the error when the install URL cannot be built', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: false, error: 'Log in to Crewly Cloud first' }, false, 401));
    render(<SlackCloudWorkspace status={base} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByText('Connect Slack'));
    await waitFor(() => expect(screen.getByText('Log in to Crewly Cloud first')).toBeInTheDocument());
    expect(assign).not.toHaveBeenCalled();
  });

  it('renders the connected workspace card with transport, identities and registration', () => {
    render(<SlackCloudWorkspace status={connected} onRefresh={vi.fn()} />);
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('UBOT')).toBeInTheDocument();
    expect(screen.getByText('Delivered by Crewly Cloud (no Socket Mode)')).toBeInTheDocument();
    expect(screen.getByText('2 installed')).toBeInTheDocument();
    expect(screen.getByText('device-1')).toBeInTheDocument();
    expect(screen.queryByText('Connect Slack')).not.toBeInTheDocument();
  });

  it('flags a self-hosted socket that ignores the Cloud config', () => {
    render(<SlackCloudWorkspace status={{ ...connected, activeSource: 'env', transport: 'socket' }} onRefresh={vi.fn()} />);
    expect(screen.getByText('Self-hosted Socket Mode (Cloud config ignored)')).toBeInTheDocument();
  });

  it('the primary toggle PUTs /api/slack/cloud/primary and refreshes', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { primary: true } }));
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<SlackCloudWorkspace status={connected} onRefresh={onRefresh} />);

    const toggle = screen.getByLabelText('Make this the primary instance') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/slack/cloud/primary', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primary: true }),
      }),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });


  it('Disconnect workspace asks for confirmation, then DELETEs /api/slack/cloud/workspace', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { removed: true } }));
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<SlackCloudWorkspace status={connected} onRefresh={onRefresh} />);

    mockConfirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByText('Disconnect workspace'));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockFetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Disconnect workspace'));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/slack/cloud/workspace', { method: 'DELETE' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it('with several workspaces and no choice yet, offers a picker and PUTs the chosen team', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { selectedWorkspaceId: 'T0CLIENT' } }));
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const status: SlackCloudStatus = {
      ...base,
      availableWorkspaces: [
        { slackTeamId: 'T0ACME', slackTeamName: 'Acme' },
        { slackTeamId: 'T0CLIENT', slackTeamName: 'Client' },
      ],
    };
    render(<SlackCloudWorkspace status={status} onRefresh={onRefresh} />);

    expect(screen.getByText(/has 2 Slack workspaces/)).toBeInTheDocument();
    const select = screen.getByLabelText('Slack workspace for this instance') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'T0CLIENT' } });
    fireEvent.click(screen.getByText('Use this workspace'));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/slack/cloud/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slackTeamId: 'T0CLIENT' }),
      }),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(true));
    expect(screen.getByText('Connect another workspace')).toBeInTheDocument();
  });

  it('when connected, shows the switcher only if the account has more than one workspace', () => {
    const { rerender } = render(
      <SlackCloudWorkspace status={{ ...connected, workspaces: [{ slackTeamId: 'T1', slackTeamName: 'Acme' }] }} onRefresh={vi.fn()} />,
    );
    expect(screen.queryByTestId('slack-cloud-workspace-picker')).toBeNull();
    expect(screen.getByText('Connect another workspace')).toBeInTheDocument();

    rerender(
      <SlackCloudWorkspace
        status={{ ...connected, workspaces: [{ slackTeamId: 'T1', slackTeamName: 'Acme' }, { slackTeamId: 'T2', slackTeamName: 'Client' }] }}
        onRefresh={vi.fn()}
      />,
    );
    const select = screen.getByLabelText('Slack workspace for this instance') as HTMLSelectElement;
    expect(select.value).toBe('T1');
    expect((screen.getByText('Use this workspace').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Refresh asks the parent for a Cloud re-fetch', () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<SlackCloudWorkspace status={connected} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByLabelText('Refresh Cloud Slack status'));
    expect(onRefresh).toHaveBeenCalledWith(true);
  });

  it('shows a loading line without a status', () => {
    render(<SlackCloudWorkspace status={null} onRefresh={vi.fn()} />);
    expect(screen.getByText('Loading Cloud Slack status...')).toBeInTheDocument();
  });
});
