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

/** Who owns a Slack thread, and by which rule. */
export interface SlackThreadOwner {
  agent: RoomAgentRef;
  /**
   * `card`: a decision card / reminder went up since a person last spoke —
   * the reply answers it, and the card's machine handles it whatever Cloud's
   * presence says. `last-speaker`: the agent that spoke last.
   */
  via: 'card' | 'last-speaker';
}

/**
 * Who owns a Slack thread (specs/2026-10-03-one-responder-per-message.md §1 c):
 *
 * 1. a decision card or reminder an agent posted since a person last spoke
 *    in the thread — the reply answers that card (the decision path's own
 *    rule, read from Slack so every machine agrees);
 * 2. otherwise the agent that spoke last (owner's rule, 2026-09-21: a bare
 *    follow-up addresses whoever just spoke).
 *
 * @param ctx - The Slack thread before the owner's message (oldest first)
 * @param dir - Room directory
 * @returns The owner and the rule, or null when no agent has spoken in the thread
 */
export function threadOwnerFromSlack(ctx: SlackThreadContext | null | undefined, dir: RoomAgentDirectory): SlackThreadOwner | null {
  if (!ctx || ctx.kind !== 'thread' || ctx.messages.length === 0) return null;
  const msgs = ctx.messages;
  const authors = msgs.map((m) => dir.authorOf(m));
  let lastPerson = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!authors[i] && !msgs[i].isBot) {
      lastPerson = i;
      break;
    }
  }
  for (let i = msgs.length - 1; i > lastPerson; i--) {
    const agent = authors[i];
    if (agent && isDecisionCardText(msgs[i].text)) return { agent, via: 'card' };
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const agent = authors[i];
    if (agent) return { agent, via: 'last-speaker' };
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
 * The responders the harness chose for a room message, as recorded on its row.
 *
 * @param m - Chat row
 * @returns Sessions (local or Cloud names), empty when none was recorded
 */
export function chosenRespondersOf(m: Pick<ChatMessageDTO, 'metadata'>): string[] {
  const v = m.metadata?.[ROOM_RESPONDER_CONSTANTS.CHOSEN_RESPONDERS_METADATA_KEY];
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * Whether an agent's post @'s a session: in its resolved mentions, or as
 * `@Name` in its text.
 *
 * @param m - Chat row
 * @param session - The agent
 * @param name - Its display name, when known
 * @returns True when it addresses that agent
 */
function addresses(m: ChatMessageDTO, session: string, name: string | undefined): boolean {
  if ((m.mentions ?? []).includes(session)) return true;
  if (!name?.trim()) return false;
  const re = new RegExp(`@${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu');
  return re.test(m.content);
}

/**
 * The reply gate (specs/2026-10-03-one-responder-per-message.md §2). A post
 * is held only when ALL of these hold:
 *
 * - the owner's latest message in the thread has recorded responders, and
 *   the agent posting is not one of them nor @'d in it;
 * - the agent owes no earlier owner message in this thread (it was the
 *   responder for, or @'d in, one it has not posted after);
 * - one of those responders already answered (an interim note is not an
 *   answer), and that answer does not @ the agent posting.
 *
 * @param thread - The thread's rows, oldest first
 * @param session - The agent about to post
 * @param nameFor - Display name of a session, when known
 * @returns The responder's answer when the post should be held, else null
 */
export function findPriorRoomAnswer(
  thread: readonly ChatMessageDTO[],
  session: string,
  nameFor?: (session: string) => string | undefined,
): PriorRoomAnswer | null {
  const isOwnerRow = (m: ChatMessageDTO) => m.senderType === 'user' && !agentWriterOf(m);
  const isAnswer = (m: ChatMessageDTO) =>
    !!agentWriterOf(m) && m.metadata?.[SLACK_TYPING_CONSTANTS.INTERIM_METADATA_KEY] !== true && !!m.content.trim();
  let ownerIdx = -1;
  for (let i = thread.length - 1; i >= 0; i--) {
    if (isOwnerRow(thread[i])) {
      ownerIdx = i;
      break;
    }
  }
  if (ownerIdx < 0) return null;
  const latest = thread[ownerIdx];
  const chosen = chosenRespondersOf(latest);
  if (chosen.length === 0 || chosen.includes(session) || (latest.mentions ?? []).includes(session)) return null;
  // An earlier owner message this agent was asked (or chosen) to answer and has not answered yet.
  for (let i = 0; i < ownerIdx; i++) {
    const m = thread[i];
    if (!isOwnerRow(m)) continue;
    if (!chosenRespondersOf(m).includes(session) && !(m.mentions ?? []).includes(session)) continue;
    const answered = thread.slice(i + 1).some((r) => agentWriterOf(r) === session && isAnswer(r));
    if (!answered) return null;
  }
  const name = nameFor?.(session);
  for (let j = ownerIdx + 1; j < thread.length; j++) {
    const m = thread[j];
    const writer = agentWriterOf(m);
    if (!writer || writer === session || !chosen.includes(writer) || !isAnswer(m)) continue;
    if (addresses(m, session, name)) return null;
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
 * What the agent is told when its post is held. Never "drop it": an agent
 * that was asked must still be able to answer.
 *
 * @param prior - The answer already there
 * @returns English harness text
 */
export function heldReplyMessage(prior: Pick<PriorRoomAnswer, 'by' | 'excerpt'>): string {
  return (
    `Held, not posted: ${prior.by}, the agent answering the owner's latest message in this thread, already replied: "${prior.excerpt}". ` +
    'Post with --adds-new if you have something new, or if you were asked.'
  );
}
