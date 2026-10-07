/**
 * Channels Service
 *
 * API client for Crewly channels (`/api/channels`): named rooms whose members
 * are agents from any team, matched to a Slack channel when Slack is
 * connected. Uses the shared axios instance, so the API-token interceptors
 * apply.
 *
 * specs/2026-10-07-crewly-channels.md
 *
 * @module services/channels.service
 */

import axios, { isAxiosError } from 'axios';
import type { ApiResponse } from '../types';

/** A channel member. */
export interface CrewlyChannelMember {
  sessionName: string;
  name?: string;
  teamId?: string;
  teamName?: string;
}

/** A Crewly channel. `id` is stable (renames keep it). */
export interface CrewlyChannel {
  id: string;
  name: string;
  purpose?: string;
  origin: 'crewly' | 'slack';
  createdAt: string;
  archivedAt?: string;
  slack: { channelId: string; channelName: string } | null;
  members: CrewlyChannelMember[];
}

/** Endpoints. */
export const CHANNELS_API = {
  LIST: '/api/channels',
  channel: (ref: string) => `/api/channels/${encodeURIComponent(ref)}`,
  members: (ref: string) => `/api/channels/${encodeURIComponent(ref)}/members`,
  member: (ref: string, session: string) => `/api/channels/${encodeURIComponent(ref)}/members/${encodeURIComponent(session)}`,
  archive: (ref: string) => `/api/channels/${encodeURIComponent(ref)}/archive`,
} as const;

/**
 * Run a request and unwrap `{ success, data }`, surfacing the server's message.
 *
 * @param request - Request thunk
 * @param fallback - Message when the server gave none
 * @returns The payload
 * @throws Error with the server's message
 */
async function call<T>(request: () => Promise<{ data: ApiResponse<T> }>, fallback: string): Promise<T> {
  try {
    const { data: body } = await request();
    if (!body?.success || body.data === undefined || body.data === null) throw new Error(body?.error || fallback);
    return body.data;
  } catch (err) {
    if (isAxiosError(err)) {
      const body = err.response?.data as (ApiResponse<unknown> & { message?: string }) | undefined;
      throw new Error(body?.message || body?.error || err.message || fallback);
    }
    throw err instanceof Error ? err : new Error(fallback);
  }
}

/** Crewly channels API. */
export const channelsService = {
  /**
   * Every live channel.
   *
   * @returns Channels, newest first
   */
  async list(): Promise<CrewlyChannel[]> {
    const data = await call<{ channels: CrewlyChannel[] }>(() => axios.get(CHANNELS_API.LIST), 'Could not load channels');
    return data.channels ?? [];
  },

  /**
   * Create a channel (and its Slack channel when Slack is connected).
   *
   * @param input - Name, agent sessions from any team, optional purpose
   * @returns The channel, with the name Slack applied
   */
  create(input: { name: string; memberSessions: string[]; purpose?: string }): Promise<CrewlyChannel> {
    return call(() => axios.post(CHANNELS_API.LIST, input), 'Could not create the channel');
  },

  /**
   * Rename a channel (and its Slack channel).
   *
   * @param ref - Channel id
   * @param name - New name
   * @returns The channel
   */
  rename(ref: string, name: string): Promise<CrewlyChannel> {
    return call(() => axios.patch(CHANNELS_API.channel(ref), { name }), 'Could not rename the channel');
  },

  /**
   * Add an agent (its bot is invited to the Slack channel).
   *
   * @param ref - Channel id
   * @param sessionName - Agent session
   * @returns The channel
   */
  async addMember(ref: string, sessionName: string): Promise<CrewlyChannel> {
    const data = await call<{ channel: CrewlyChannel }>(() => axios.post(CHANNELS_API.members(ref), { sessionName }), 'Could not add the agent');
    return data.channel;
  },

  /**
   * Remove an agent (its bot leaves the Slack channel).
   *
   * @param ref - Channel id
   * @param sessionName - Agent session
   * @returns The channel
   */
  async removeMember(ref: string, sessionName: string): Promise<CrewlyChannel> {
    const data = await call<{ channel: CrewlyChannel }>(() => axios.delete(CHANNELS_API.member(ref, sessionName)), 'Could not remove the agent');
    return data.channel;
  },

  /**
   * Archive a channel.
   *
   * @param ref - Channel id
   * @returns The archived channel
   */
  archive(ref: string): Promise<CrewlyChannel> {
    return call(() => axios.post(CHANNELS_API.archive(ref)), 'Could not archive the channel');
  },
};

/** The part of {@link channelsService} the chat page uses (injectable in tests). */
export type ChannelsApi = Pick<typeof channelsService, 'list' | 'create'>;
