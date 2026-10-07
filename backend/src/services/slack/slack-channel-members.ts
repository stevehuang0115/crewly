/**
 * `conversations.members` with a specific bot token — who is actually in a
 * Slack channel, read by one of the agents' own bots (the workspace bot is
 * usually not in a private room).
 *
 * @module services/slack/slack-channel-members
 */

/** Result of a member read. */
export type ChannelMembersResult = { ok: true; members: string[] } | { ok: false; error: string };

/** Pages read at most (200 members each). */
const MAX_PAGES = 10;
const API = 'https://slack.com/api/conversations.members';
const TIMEOUT_MS = 10_000;

/**
 * Member user ids of a channel, bots included, as `token`'s bot sees it.
 * Never throws.
 *
 * @param channelId - Slack channel id
 * @param token - A bot token
 * @param fetchImpl - fetch (injectable for tests)
 * @returns The members, or Slack's error (`not_in_channel` / `channel_not_found`
 *   mean this bot is not in the channel)
 */
export async function listChannelMembersWithToken(channelId: string, token: string, fetchImpl: typeof fetch = fetch): Promise<ChannelMembersResult> {
  const members: string[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const params = new URLSearchParams({ channel: channelId, limit: '200', ...(cursor ? { cursor } : {}) });
      const res = await fetchImpl(`${API}?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (res.status === 429) return { ok: false, error: 'rate_limited' };
      const body = (await res.json()) as { ok?: boolean; error?: string; members?: string[]; response_metadata?: { next_cursor?: string } };
      if (!body?.ok) return { ok: false, error: body?.error ?? `http_${res.status}` };
      members.push(...(body.members ?? []));
      cursor = (body.response_metadata?.next_cursor ?? '').trim();
      if (!cursor) break;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: true, members };
}

/** Result of a single Slack Web API call made with a bot token. */
export type SlackTokenCallResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/**
 * One Slack Web API call (form-encoded POST) with a specific bot token.
 * Never throws: network failures and Slack refusals come back as `error`.
 *
 * Used for the channel operations an agent's own bot can do in a room the
 * workspace bot is not in (a private channel the owner invited agents to):
 * read its name, invite another agent's bot, leave, rename.
 *
 * @param method - Web API method, e.g. `conversations.info`
 * @param params - Form fields
 * @param token - A bot token
 * @param fetchImpl - fetch (injectable for tests)
 * @returns The response body, or Slack's error code
 */
export async function slackCallWithToken(
  method: string,
  params: Record<string, string>,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SlackTokenCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    if (res.status === 429) return { ok: false, error: 'rate_limited' };
    const body = (await res.json()) as Record<string, unknown> & { ok?: boolean; error?: string };
    if (!body?.ok) return { ok: false, error: body?.error ?? `http_${res.status}` };
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Channel operations with an agent's own bot token (see {@link slackCallWithToken}). */
export interface ChannelTokenOps {
  /** `conversations.info` → the channel's current name. */
  info(channelId: string, token: string): Promise<{ ok: true; name: string; isArchived: boolean } | { ok: false; error: string }>;
  /** `conversations.invite` → put a user (another agent's bot) into the channel. */
  invite(channelId: string, userId: string, token: string): Promise<{ ok: boolean; error?: string }>;
  /** `conversations.leave` → the token's own bot leaves the channel. */
  leave(channelId: string, token: string): Promise<{ ok: boolean; error?: string }>;
  /** `chat.postMessage` as the token's bot. */
  post(channelId: string, text: string, token: string): Promise<{ ok: boolean; error?: string }>;
  /** `conversations.rename` → the name Slack applied. */
  rename(channelId: string, name: string, token: string): Promise<{ ok: true; name: string } | { ok: false; error: string }>;
}

/**
 * The default {@link ChannelTokenOps}, over the real Slack Web API.
 *
 * @param fetchImpl - fetch (injectable for tests)
 * @returns The ops
 */
export function createChannelTokenOps(fetchImpl: typeof fetch = fetch): ChannelTokenOps {
  const channelOf = (body: Record<string, unknown>) => (body.channel ?? {}) as { name?: string; is_archived?: boolean };
  return {
    async info(channelId, token) {
      const r = await slackCallWithToken('conversations.info', { channel: channelId }, token, fetchImpl);
      if (!r.ok) return r;
      const ch = channelOf(r.body);
      return { ok: true, name: ch.name ?? '', isArchived: ch.is_archived === true };
    },
    async invite(channelId, userId, token) {
      const r = await slackCallWithToken('conversations.invite', { channel: channelId, users: userId }, token, fetchImpl);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    async leave(channelId, token) {
      const r = await slackCallWithToken('conversations.leave', { channel: channelId }, token, fetchImpl);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    async post(channelId, text, token) {
      const r = await slackCallWithToken('chat.postMessage', { channel: channelId, text }, token, fetchImpl);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    async rename(channelId, name, token) {
      const r = await slackCallWithToken('conversations.rename', { channel: channelId, name }, token, fetchImpl);
      if (!r.ok) return r;
      return { ok: true, name: channelOf(r.body).name ?? name };
    },
  };
}
