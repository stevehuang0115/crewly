/**
 * Agent-to-agent message envelope (crewly#1375).
 *
 * `send-message` writes another agent's text into the recipient's turn with
 * `POST /terminal/<to>/write {mode:"message"}`. Before this envelope the
 * recipient saw only the bare text: no sender, no reply route. On 2026-10-18
 * Pia (Flopost) got two such messages from Atlas (Think Tank) while she was
 * answering the owner's Shaw Brothers video thread; her bare `reply` landed
 * in that owner thread ("the owner asked (no work item running)"), and her
 * second answer went there too as `reply-channel "@Atlas …"`, because she had
 * no other address for him.
 *
 * Now the route puts one short header in front of an agent's message:
 *
 * `[MESSAGE from Atlas (Think Tank) — a colleague, not the owner. Answer with
 * send-message --to think-tank-atlas-b4e166f6; do not post it in an owner thread.]`
 *
 * The header is text, so it survives every queue the message may wait in,
 * and the harness reads the sender back from it ({@link parseAgentMessageSender})
 * to route a bare `reply` to that agent.
 *
 * The header also carries the sender's route — the owner message or work
 * item the sender is answering (message-route.ts) — so the destination of
 * the original request travels across every agent hop
 * (message-routing audit 2026-10-18).
 *
 * Pure helpers; the member lookup is injected.
 *
 * @module services/messaging/agent-message-envelope
 */

import { describeRoute, formatRouteToken, type MessageRoute } from '../orc/message-route.js';

/** Opening of the header. */
export const AGENT_MESSAGE_HEADER_PREFIX = '[MESSAGE from ';

/**
 * Harness envelopes a message may already carry: an owner chat message, a
 * dispatch, a system notice, a task, an earlier agent header, a delegated
 * result, a Slack / remote owner message, a scheduler note. Such text is
 * never wrapped a second time.
 */
const HARNESS_ENVELOPE =
  /^\s*\[(?:G?CHAT:|CREWLY-DISPATCH\]|SYSTEM\b|TASK\b|MESSAGE from |RESULT\]|OWNER MESSAGE\]|SLACK[A-Z_-]*[:\]]|REMOTE:|scheduler:)/;

/** The sender named in a header (its reply route). */
const HEADER_SENDER = /^\s*\[MESSAGE from [^\]\n]*?send-message --to ([A-Za-z0-9_.-]+)/;

/** Who sent a message, as the recipient should read it. */
export interface AgentMessageSender {
  /** Sender's session (its reply address) */
  session: string;
  /** Display name, when known */
  name?: string;
  /** Team display name, when known */
  team?: string;
  /** What the sender is answering (owner message / work item), carried to the recipient */
  route?: MessageRoute;
}

/**
 * Whether a text already opens with a harness envelope.
 *
 * @param text - Message text
 * @returns True when it must not be wrapped again
 *
 * @example
 * ```typescript
 * hasHarnessEnvelope('[CHAT:abc] <owner> hi'); // true
 * hasHarnessEnvelope('Thanks. Two things.'); // false
 * ```
 */
export function hasHarnessEnvelope(text: string): boolean {
  return HARNESS_ENVELOPE.test(typeof text === 'string' ? text : '');
}

/**
 * The header line for a message from `sender`.
 *
 * @param sender - Who sent it
 * @returns One header line (no trailing newline)
 *
 * @example
 * ```typescript
 * formatAgentMessageHeader({ session: 'think-tank-atlas-b4e166f6', name: 'Atlas', team: 'Think Tank' });
 * // '[MESSAGE from Atlas (Think Tank) — a colleague, not the owner. Answer with send-message --to think-tank-atlas-b4e166f6; do not post it in an owner thread.]'
 * ```
 */
export function formatAgentMessageHeader(sender: AgentMessageSender): string {
  const name = sender.name?.trim() || sender.session;
  const team = sender.team?.trim();
  const who = team && team !== name ? `${name} (${team})` : name;
  const route = sender.route
    ? ` It concerns ${describeRoute(sender.route)} ${formatRouteToken(sender.route)}; ${name} answers the owner on it.`
    : '';
  return (
    `${AGENT_MESSAGE_HEADER_PREFIX}${who} — a colleague, not the owner. ` +
    `Answer with send-message --to ${sender.session}; do not post it in an owner thread.${route}]`
  );
}

/**
 * The text with the sender's header in front, unless it already carries a
 * harness envelope.
 *
 * @param text - Message text
 * @param sender - Who sent it
 * @returns Text to deliver
 */
export function wrapAgentMessage(text: string, sender: AgentMessageSender): string {
  if (hasHarnessEnvelope(text)) return text;
  return `${formatAgentMessageHeader(sender)}\n${text}`;
}

/**
 * The sender session a delivered text's header names.
 *
 * @param text - Exactly what was delivered
 * @returns Sender session, or undefined when the text has no agent header
 */
export function parseAgentMessageSender(text: string): string | undefined {
  const m = HEADER_SENDER.exec(typeof text === 'string' ? text : '');
  return m ? m[1] : undefined;
}

/** Looks a session up as a team member. */
export type MemberLookup = (session: string) => Promise<{ member: { name?: string }; team: { name?: string } } | null>;

/**
 * Who a calling session is, when it is a team member. Harness services that
 * write with an agent badge (the WorkItem dispatcher, the worktree notifier,
 * …) are not members and get null — their notices are not wrapped.
 *
 * @param session - Caller session (from `X-Agent-Session`)
 * @param lookup - Member lookup
 * @returns The sender, or null
 */
export async function describeAgentSender(session: string, lookup: MemberLookup): Promise<AgentMessageSender | null> {
  if (!session) return null;
  const found = await lookup(session).catch(() => null);
  if (!found) return null;
  return {
    session,
    ...(found.member?.name ? { name: found.member.name } : {}),
    ...(found.team?.name ? { team: found.team.name } : {}),
  };
}
