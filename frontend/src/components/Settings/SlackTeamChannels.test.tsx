/**
 * SlackTeamChannels tests.
 *
 * @module components/Settings/SlackTeamChannels.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SlackTeamChannels } from './SlackTeamChannels';

const mockFetch = vi.fn();
global.fetch = mockFetch;
const mockConfirm = vi.fn();
window.confirm = mockConfirm;

const listPayload = {
  success: true,
  data: {
    settings: { autoCreate: true, channelPrefix: '' },
    teams: [
      { teamId: 't1', teamName: 'Alpha Team', memberCount: 2, mapping: null },
      {
        teamId: 't2',
        teamName: 'Beta Team',
        memberCount: 1,
        mapping: { slackChannelId: 'C2', slackChannelName: 'beta-team', chatChannelId: 'h2', autoCreated: true },
      },
    ],
  },
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) };
}

/** Route fetch calls by URL + method so each test can assert the writes. */
function routeFetch(overrides: Record<string, (init?: RequestInit) => unknown> = {}) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (key.startsWith(pattern)) return Promise.resolve(handler(init));
    }
    if (key === 'GET /api/slack/team-channels') return Promise.resolve(jsonResponse(listPayload));
    return Promise.resolve(jsonResponse({ success: true, data: {} }));
  });
}

describe('SlackTeamChannels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReturnValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists teams with their mapping state', async () => {
    routeFetch();
    render(<SlackTeamChannels />);
    await waitFor(() => expect(screen.getByText('Alpha Team')).toBeInTheDocument());
    expect(screen.getByText('Beta Team')).toBeInTheDocument();
    expect(screen.getByText(/beta-team/)).toBeInTheDocument();
    expect(screen.getByText('Create channel')).toBeInTheDocument();
    expect(screen.getByText('Unlink')).toBeInTheDocument();
  });

  it('shows the server error when Slack is not connected', async () => {
    routeFetch({
      'GET /api/slack/team-channels': () =>
        jsonResponse({ success: false, error: 'Slack team channels are unavailable — connect Slack first' }, false, 503),
    });
    render(<SlackTeamChannels />);
    await waitFor(() =>
      expect(screen.getByText(/connect Slack first/)).toBeInTheDocument(),
    );
  });

  it('creates a channel for an unmapped team', async () => {
    const post = vi.fn(() => jsonResponse({ success: true, data: { slackChannelId: 'C9' } }));
    routeFetch({ 'POST /api/slack/team-channels': post });
    render(<SlackTeamChannels />);
    await waitFor(() => expect(screen.getByText('Create channel')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Create channel'));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const init = post.mock.calls[0][0] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ teamId: 't1' });
    // Reloads the list afterwards.
    await waitFor(() =>
      expect(mockFetch.mock.calls.filter((c) => c[0] === '/api/slack/team-channels' && !c[1]?.method).length).toBe(2),
    );
  });

  it('links an existing channel by id', async () => {
    const post = vi.fn(() => jsonResponse({ success: true, data: {} }));
    routeFetch({ 'POST /api/slack/team-channels': post });
    render(<SlackTeamChannels />);
    await waitFor(() => expect(screen.getByText('Link')).toBeInTheDocument());

    const linkButton = screen.getByText('Link').closest('button')!;
    expect(linkButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Slack channel ID to link for Alpha Team'), { target: { value: ' C777 ' } });
    expect(linkButton).not.toBeDisabled();
    fireEvent.click(linkButton);

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(JSON.parse(String((post.mock.calls[0][0] as RequestInit).body))).toEqual({ teamId: 't1', slackChannelId: 'C777' });
  });

  it('unlinks a mapped team, archiving in Slack only when confirmed', async () => {
    const del = vi.fn(() => jsonResponse({ success: true, data: { removed: true } }));
    routeFetch({ 'DELETE /api/slack/team-channels/t2': del });
    mockConfirm.mockReturnValue(true);
    render(<SlackTeamChannels />);
    await waitFor(() => expect(screen.getByText('Unlink')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Unlink'));

    await waitFor(() => expect(del).toHaveBeenCalled());
    expect(mockFetch).toHaveBeenCalledWith('/api/slack/team-channels/t2?archive=true', { method: 'DELETE' });
  });

  it('toggles auto-create and saves the prefix', async () => {
    const put = vi.fn((init?: RequestInit) =>
      jsonResponse({ success: true, data: { autoCreate: true, channelPrefix: '', ...JSON.parse(String(init?.body)) } }),
    );
    routeFetch({ 'PUT /api/slack/team-channels/settings': put });
    render(<SlackTeamChannels />);
    await waitFor(() => expect(screen.getByLabelText(/Auto-create a channel/)).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/Auto-create a channel/));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((put.mock.calls[0][0] as RequestInit).body))).toEqual({ autoCreate: false });

    const saveButton = screen.getByText('Save prefix').closest('button')!;
    expect(saveButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Channel name prefix'), { target: { value: 'crew-' } });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((put.mock.calls[1][0] as RequestInit).body))).toEqual({ channelPrefix: 'crew-' });
  });

  it('surfaces a failed create as an error banner', async () => {
    routeFetch({
      'POST /api/slack/team-channels': () => jsonResponse({ success: false, error: 'name_taken' }, false, 500),
    });
    render(<SlackTeamChannels />);
    await waitFor(() => expect(screen.getByText('Create channel')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Create channel'));
    await waitFor(() => expect(screen.getByText('name_taken')).toBeInTheDocument());
  });

  it('renders an empty state when there are no teams', async () => {
    routeFetch({
      'GET /api/slack/team-channels': () =>
        jsonResponse({ success: true, data: { settings: { autoCreate: true, channelPrefix: '' }, teams: [] } }),
    });
    render(<SlackTeamChannels />);
    await waitFor(() => expect(screen.getByText(/No teams yet/)).toBeInTheDocument());
  });
});
