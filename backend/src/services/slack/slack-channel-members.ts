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
