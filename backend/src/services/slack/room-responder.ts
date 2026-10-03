/**
 * One responder per owner message in Slack rooms — the pure parts
 * (specs/2026-10-03-one-responder-per-message.md).
 *
 * - {@link threadOwnerFromSlack}: who owns a Slack thread, read from the
 *   thread itself, so every machine names the same agent.
 * - {@link findPriorRoomAnswer} / {@link heldReplyMessage}: the reply gate —
 *   a colleague already answered the owner's latest message in this thread.
 *
 * Incident (2026-10-03, #content-team): the owner's un-@'d reply to Atlas's
 * D-92 reminder resolved the card (delivered to Atlas) and was also
 * broadcast to the room; Atlas answered, and Ella answered the same thing
 * six minutes later.
 *
 * @module services/slack/room-responder
 */

import { OWNER_EVIDENCE_METADATA, ROOM_RESPONDER_CONSTANTS, SLACK_TYPING_CONSTANTS } from '../../constants.js';
import type { SlackContextMessage, SlackThreadContext } from '../../types/slack.types.js';
import type { ChatMessageDTO } from '../chat-v2/types.js';

/** An agent of the room, on this machine or another. */
export interface RoomAgentRef {
  /** Session name (as this machine knows it; Cloud's for a remote agent) */
  session: string;
  /** Display name */
  name: string;
  /** Whether it runs on this machine */
  local: boolean;
}

/** What {@link buildRoomAgentDirectory} needs. */
export interface RoomAgentDirectoryInput {
  /** This machine's room members, with their own bot user id when installed */
  local: ReadonlyArray<{ session: string; name: string; botUserId?: string | null }>;
  /** Room members on other machines (Cloud's room roster minus this machine) */
  remote: ReadonlyArray<{ session: string; name: string }>;
}

/** Maps Slack authors and names to room agents. */
export interface RoomAgentDirectory {
  /** The agent that wrote a Slack message, or null (a person, an unknown bot, or an unclear name) */
  authorOf(m: SlackContextMessage): RoomAgentRef | null;
  /** Agents a text @'s by name (`@Name`) */
  mentionedIn(text: string): RoomAgentRef[];
}

/**
 * Whether two display names name the same agent: equal (case-insensitive),
 * or one is the other plus a team suffix — "Ella" / "Ella (Crewly Marketing)".
 *
 * @param a - A name
 * @param b - Another name
 * @returns True when they match
 */
export function sameAgentName(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y} (`) || y.startsWith(`${x} (`);
}

/**
 * Build the directory every machine uses to read the same thread the same way.
 *
 * A post by a local agent's own bot is that agent. Any other bot post is
 * matched by name against the remote members — and against local members
 * when it was posted with a username override (an agent with no app of its
 * own). A name that matches several agents is unclear and maps to nobody.
 *
 * @param input - Local and remote room members
 * @returns The directory
 */
export function buildRoomAgentDirectory(input: RoomAgentDirectoryInput): RoomAgentDirectory {
  const local: RoomAgentRef[] = input.local.map((m) => ({ session: m.session, name: m.name, local: true }));
  const remote: RoomAgentRef[] = input.remote.map((m) => ({ session: m.session, name: m.name, local: false }));
  const byBot = new Map<string, RoomAgentRef>();
  for (const m of input.local) {
    if (m.botUserId) byBot.set(m.botUserId, { session: m.session, name: m.name, local: true });
  }
  const unique = (pool: RoomAgentRef[], name: string): RoomAgentRef | null => {
    const hits = pool.filter((a) => sameAgentName(a.name, name));
    if (hits.length === 1) return hits[0];
    // Prefer an exact name over a suffix match ("Ella" vs "Ella (Marketing)").
    const exact = hits.filter((a) => a.name.trim().toLowerCase() === name.trim().toLowerCase());
    return exact.length === 1 ? exact[0] : null;
  };
  return {
    authorOf(m) {
      if (m.userId && byBot.has(m.userId)) return byBot.get(m.userId)!;
      if (!m.isBot) return null;
      return unique([...(m.usernameOverride ? local : []), ...remote], m.authorName);
    },
    mentionedIn(text) {
      const lower = text.toLowerCase();
      return [...local, ...remote].filter((a) => a.name.trim() && lower.includes(`@${a.name.trim().toLowerCase()}`));
    },
  };
}

/**
 * Whether a Slack post is a decision card or a card reminder — the post an
 * owner's reply in that thread answers. Cards carry `Decision D-n` (or
 * `[D-n]` when titled by a ticket); the reminder says "Still waiting on you".
 *
 * @param text - Normalised Slack text
 * @returns True for a card or reminder
 */
export function isDecisionCardText(text: string): boolean {
  return /\bDecision D-\d+\b/.test(text) || /\[D-\d+\]/.test(text) || /Still waiting on you\b/.test(text);
}

/**
 * Who owns a Slack thread (specs/2026-10-03-one-responder-per-message.md §1 c):
 *
 * 1. the latest decision card / reminder posted by an agent;
 * 2. else the agent that started the thread — unless people have since @'d
 *    a different agent in it (the conversation moved on);
 * 3. else the agent that spoke last.
 *
 * @param ctx - The Slack thread before the owner's message (oldest first)
 * @param dir - Room directory
 * @returns The owner, or null when no agent has spoken in the thread
 */
export function threadOwnerFromSlack(ctx: SlackThreadContext | null | undefined, dir: RoomAgentDirectory): RoomAgentRef | null {
  if (!ctx || ctx.kind !== 'thread' || ctx.messages.length === 0) return null;
  const msgs = ctx.messages;
  const authors = msgs.map((m) => dir.authorOf(m));
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (authors[i] && isDecisionCardText(msgs[i].text)) return authors[i];
  }
  const rootKnown = !!ctx.threadTs && msgs[0].ts === ctx.threadTs;
  const starter = rootKnown ? authors[0] : null;
  if (starter) {
    const movedOn = msgs
      .slice(1)
      .some((m) => !dir.authorOf(m) && !m.isBot && dir.mentionedIn(m.text).some((a) => a.session !== starter.session));
    if (!movedOn) return starter;
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (authors[i]) return authors[i];
  }
  return null;
}

/** An answer already in the thread after the owner's latest message. */
export interface PriorRoomAnswer {
  /** Who wrote it (display name when known, else its session) */
  by: string;
  /** The agent's session (local) or the recorded sender id (a colleague's Slack post) */
  bySession: string;
  /** The start of the answer */
  excerpt: string;
  /** Its chat message id */
  messageId: string;
}

/**
 * The agent session behind a chat row, when an agent wrote it.
 *
 * @param m - Chat row
 * @returns Session (or sender id for a colleague's post), or null for a person
 */
function agentWriterOf(m: ChatMessageDTO): string | null {
  if (m.senderType === 'agent') return m.senderId;
  const md = m.metadata ?? {};
  for (const key of [OWNER_EVIDENCE_METADATA.AUTHOR_AGENT_SESSION, OWNER_EVIDENCE_METADATA.REMOTE_AGENT_SESSION]) {
    const v = md[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * The reply gate (specs/2026-10-03-one-responder-per-message.md §2): a
 * different agent already answered after the owner's latest message in this
 * thread. Interim notes are not answers.
 *
 * @param thread - The thread's rows, oldest first
 * @param session - The agent about to post
 * @param nameFor - Display name of a session, when known
 * @returns The earlier answer, or null when posting is fine
 */
export function findPriorRoomAnswer(
  thread: readonly ChatMessageDTO[],
  session: string,
  nameFor?: (session: string) => string | undefined,
): PriorRoomAnswer | null {
  let ownerIdx = -1;
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i].senderType === 'user' && !agentWriterOf(thread[i])) {
      ownerIdx = i;
      break;
    }
  }
  if (ownerIdx < 0) return null;
  for (let j = ownerIdx + 1; j < thread.length; j++) {
    const m = thread[j];
    const writer = agentWriterOf(m);
    if (!writer || writer === session) continue;
    if (m.metadata?.[SLACK_TYPING_CONSTANTS.INTERIM_METADATA_KEY] === true) continue;
    if (!m.content.trim()) continue;
    const flat = m.content.replace(/\s+/g, ' ').trim();
    const max = ROOM_RESPONDER_CONSTANTS.GATE_EXCERPT_CHARS;
    const by = m.senderType === 'agent' ? nameFor?.(writer) ?? writer : m.senderId.replace(/\s*\(agent\)$/, '');
    return {
      by,
      bySession: writer,
      excerpt: flat.length > max ? `${flat.slice(0, max)}…` : flat,
      messageId: m.id,
    };
  }
  return null;
}

/**
 * What the agent is told when its post is held.
 *
 * @param prior - The answer already there
 * @returns English harness text
 */
export function heldReplyMessage(prior: Pick<PriorRoomAnswer, 'by' | 'excerpt'>): string {
  return (
    `Held, not posted: ${prior.by} already answered the owner's latest message in this thread: "${prior.excerpt}". ` +
    'If your reply adds something new, send it again with --adds-new (reply or reply-channel). Otherwise drop it: reply --none.'
  );
}
