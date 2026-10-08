/**
 * The Slack side of remote MCP sign-in: a card in the owner's DM whose
 * button opens a single-use Crewly Cloud ticket link (never the server URL
 * or its key), and a receipt when the sign-in finished.
 *
 * Posted in the owner's DM with the agent whose call needed it (that
 * agent's bot), else the orchestrator's / workspace bot. A DM, so only the
 * owner sees the link.
 *
 * @module services/connector/remote-mcp-auth-card
 */

import { CLOUD_DISCONNECT_NOTICE_CONSTANTS } from '../../../../config/constants.js';
import type { RemoteMcpAuthNotifier } from './remote-mcp-auth.service.js';

const SLACK = CLOUD_DISCONNECT_NOTICE_CONSTANTS;

/** `fetch` signature (tests). */
export type CardFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Build the card. Pure, so the wording is testable.
 *
 * @param label - Server name ("Zoho")
 * @param url - Ticket link
 * @param expiresAt - When the link stops working
 * @param now - Clock (tests)
 * @returns Fallback text and Block Kit blocks
 */
export function buildRemoteMcpAuthCard(label: string, url: string, expiresAt: string, now: number = Date.now()): { text: string; blocks: unknown[] } {
  const hours = Math.max(1, Math.round((new Date(expiresAt).getTime() - now) / 3_600_000));
  const safe = label.replace(/[<>&*_~`]/g, '');
  return {
    text: `${safe} needs you to sign in once. Tap to authorize (works on your phone).`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${safe}* needs you to sign in once.\nTap to authorize — it works on your phone.` },
        accessory: { type: 'button', text: { type: 'plain_text', text: 'Authorize' }, url, style: 'primary' },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `The link works once, for about ${hours} hour${hours === 1 ? '' : 's'}. Your agents get access after you allow it.` }],
      },
    ],
  };
}

/** What the Slack notifier needs from the running Slack integration. */
export interface SlackNotifierDeps {
  /** The owner's Slack user id, or null when Slack is not set up. */
  ownerUserId: () => string | null;
  /** Bot token to post with: the agent's own bot when it has one. */
  botTokenFor: (agentSession?: string) => string | null;
  fetchImpl?: CardFetch;
}

/**
 * Open the owner DM on a bot and post.
 *
 * @param fetchImpl - fetch
 * @param botToken - Bot token (never logged)
 * @param ownerUserId - Owner
 * @param message - Text and optional blocks
 * @returns True when Slack accepted it
 */
async function postDm(fetchImpl: CardFetch, botToken: string, ownerUserId: string, message: { text: string; blocks?: unknown[] }): Promise<boolean> {
  const call = async (method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(`${SLACK.SLACK_API_BASE}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SLACK.SLACK_REQUEST_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data['ok'] !== true) throw new Error(`Slack ${method} failed: ${String(data['error'] ?? res.status)}`);
    return data;
  };
  const opened = await call('conversations.open', { users: ownerUserId });
  const channel = (opened['channel'] as { id?: string } | undefined)?.id;
  if (!channel) throw new Error('Slack conversations.open returned no channel');
  await call('chat.postMessage', { channel, text: message.text, ...(message.blocks ? { blocks: message.blocks } : {}), unfurl_links: false, unfurl_media: false });
  return true;
}

/**
 * The notifier the auth service posts through.
 *
 * @param deps - Owner id, bot token lookup, fetch
 * @returns Notifier
 */
export function createSlackRemoteMcpNotifier(deps: SlackNotifierDeps): RemoteMcpAuthNotifier {
  const fetchImpl = deps.fetchImpl ?? (fetch as CardFetch);
  const target = (agentSession?: string): { owner: string; token: string } | null => {
    const owner = deps.ownerUserId();
    const token = deps.botTokenFor(agentSession) ?? (agentSession ? deps.botTokenFor(undefined) : null);
    return owner && token ? { owner, token } : null;
  };
  return {
    async postAuthCard({ serverLabel, url, expiresAt, agentSession }) {
      const t = target(agentSession);
      if (!t) return false;
      return postDm(fetchImpl, t.token, t.owner, buildRemoteMcpAuthCard(serverLabel, url, expiresAt));
    },
    async postReceipt({ text, agentSession }) {
      const t = target(agentSession);
      if (!t) return false;
      return postDm(fetchImpl, t.token, t.owner, { text });
    },
  };
}
