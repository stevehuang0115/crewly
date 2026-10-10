/**
 * Stable Slack thread keys — `<slack channel id>:<thread root ts>`.
 *
 * An agent that is handed messages from two Slack threads of one DM has to
 * be able to say which thread each answer belongs to. Before this key the
 * reply path could only guess, and it guessed "the thread the owner wrote in
 * last": an answer owed in thread A was posted in thread B together with the
 * answer for B (2026-09-28, Ella: EFT form + HSA screenshots). The key is
 * shown to the agent as `[SLACK-THREAD:<key>]` on every delivered Slack
 * message, and every reply tool accepts it back.
 *
 * @module services/slack/slack-thread-key
 */

import { SLACK_THREAD_KEY_CONSTANTS } from '../../constants.js';

/** One Slack thread: conversation + root ts. */
export interface SlackThreadKeyParts {
  /** Slack conversation id (`C…`, `D…`, `G…`) */
  slackChannelId: string;
  /** Thread root ts (a top-level message's own ts) */
  threadTs: string;
}

/** `C0ABC:1790392986.498639` — conversation id, a colon, a Slack ts. */
const KEY_PATTERN = /^([CDG][A-Z0-9]+):(\d{6,}\.\d{1,})$/;

/**
 * `[SLACK-THREAD:<key>]` anywhere in a text. Built on use, not at load:
 * suites that partially mock the constants module import this file too.
 *
 * @returns A fresh global regex
 */
function tagPattern(): RegExp {
  return new RegExp(`\\[${SLACK_THREAD_KEY_CONSTANTS.TAG}:([^\\]\\s]+)\\]`, 'g');
}

/**
 * Build the key for a Slack thread.
 *
 * @param slackChannelId - Slack conversation id
 * @param threadTs - Thread root ts (the message's own ts when top-level)
 * @returns `<channel>:<ts>`
 *
 * @example
 * formatSlackThreadKey('D0C31U6JWBF', '1790392986.498639') // 'D0C31U6JWBF:1790392986.498639'
 */
export function formatSlackThreadKey(slackChannelId: string, threadTs: string): string {
  return `${slackChannelId}:${threadTs}`;
}

/**
 * Parse a key. Tolerates the whole tag being passed (`[SLACK-THREAD:…]`) —
 * an agent copying from its prompt may take the brackets along.
 *
 * @param raw - Key, tag, or anything else
 * @returns The parts, or null when `raw` is not a Slack thread key
 */
export function parseSlackThreadKey(raw: unknown): SlackThreadKeyParts | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const tagPrefix = `[${SLACK_THREAD_KEY_CONSTANTS.TAG}:`;
  if (s.startsWith(tagPrefix) && s.endsWith(']')) s = s.slice(tagPrefix.length, -1);
  const m = KEY_PATTERN.exec(s);
  return m ? { slackChannelId: m[1], threadTs: m[2] } : null;
}

/**
 * The tag an agent sees on a delivered Slack message.
 *
 * @param slackChannelId - Slack conversation id
 * @param threadTs - Thread root ts
 * @returns `[SLACK-THREAD:<channel>:<ts>]`
 */
export function slackThreadTag(slackChannelId: string, threadTs: string): string {
  return `[${SLACK_THREAD_KEY_CONSTANTS.TAG}:${formatSlackThreadKey(slackChannelId, threadTs)}]`;
}

/**
 * Every distinct valid thread key tagged in a text, in order of appearance.
 *
 * @param text - Any text (a delivered prompt, a reply)
 * @returns Parsed keys, de-duplicated
 */
export function extractSlackThreadKeys(text: string): SlackThreadKeyParts[] {
  const out: SlackThreadKeyParts[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(tagPattern())) {
    const parts = parseSlackThreadKey(m[1]);
    if (!parts) continue;
    const k = formatSlackThreadKey(parts.slackChannelId, parts.threadTs);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(parts);
  }
  return out;
}

/**
 * The thread a chat-v2 message's metadata names, when it names exactly one.
 *
 * Reads the agent-reply field ({@link SLACK_THREAD_KEY_CONSTANTS.METADATA_KEY})
 * first, then the inbound Slack correlation fields (`slackChannelId` +
 * `slackThreadTs`) every bridged Slack turn carries.
 *
 * @param metadata - chat-v2 message metadata
 * @returns The thread, or null
 */
export function slackThreadOfMetadata(metadata: Record<string, unknown> | undefined | null): SlackThreadKeyParts | null {
  if (!metadata) return null;
  const explicit = parseSlackThreadKey(metadata[SLACK_THREAD_KEY_CONSTANTS.METADATA_KEY]);
  if (explicit) return explicit;
  const ch = metadata.slackChannelId;
  const ts = metadata.slackThreadTs;
  if (typeof ch === 'string' && ch && typeof ts === 'string' && ts) return { slackChannelId: ch, threadTs: ts };
  return null;
}

/**
 * Read any reference to a Slack place an agent might hold: a thread key
 * (`C…:ts`), a `slack-` chat channel id (`slack-C…:ts`, `slack-C…-ts` or
 * `slack-C…-sec-micro`), or a bare Slack conversation id (`C…`).
 *
 * @param raw - Reference
 * @returns Channel (+ thread ts when the reference names one), or null for anything else
 */
export function parseSlackChannelRef(raw: unknown): { slackChannelId: string; threadTs?: string } | null {
  if (typeof raw !== 'string') return null;
  const key = parseSlackThreadKey(raw);
  if (key) return key;
  const s = raw.trim().replace(/^slack-/, '');
  const m = /^([CDG][A-Z0-9]{6,})(?:[:-](\d{6,})[.-](\d{1,}))?(?:-msg-\d+\.\d+)?$/.exec(s);
  if (!m) return null;
  return m[2] ? { slackChannelId: m[1], threadTs: `${m[2]}.${m[3]}` } : { slackChannelId: m[1] };
}
