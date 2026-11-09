/**
 * Refuse a post into the owner's thread that only talks to other agents
 * (crewly#1375, expected point 4).
 *
 * 2026-10-18: Atlas (Think Tank) messaged Pia (Flopost) with send-message
 * while Pia was answering the owner's video thread. Having no other address
 * for Atlas, Pia ran `reply-channel` into the owner's thread with "@Atlas …":
 * a cost/timing report about another project, in the middle of the owner's
 * conversation.
 *
 * R6 of the message-routing audit (2026-10-18): agents never converse
 * inside an owner thread, whatever prompted the post. The post is taken out
 * of the thread (and delivered privately to the agents it addresses) when
 * BOTH hold:
 *  - the owner wrote to the poster in this conversation recently (it is an
 *    owner thread, not an agents' room);
 *  - the text @-mentions someone, and every @-mention is a known agent (an
 *    unknown name or the owner keeps the post).
 * Only the final consolidated answer, written to the owner, goes in the
 * owner's thread.
 *
 * Pure decision; the lookups are injected.
 *
 * @module services/orc/agent-mention-post-guard
 */

import type { LatestInput } from './reply-destination-resolver.js';

/** `@Name` at a word start (`@Atlas`, `(@Atlas`); trailing punctuation dropped. */
const MENTION = /(?:^|[\s(])@([A-Za-z][\w.-]{0,40})/g;

/** Input of {@link misdirectedAgentMention}. */
export interface AgentMentionPostInput {
  /** Posting agent */
  session: string;
  /** Post text */
  content: string;
  /** The poster's latest input */
  latest: LatestInput | null;
  /** Whether the owner wrote to the poster in this conversation recently */
  ownerAskedHere: boolean;
  /** The agent session an @-name belongs to, or null when it is not a known agent */
  agentByName: (name: string) => string | null;
}

/** A refused post. */
export interface MisdirectedAgentMention {
  /** The agent whose message the poster is answering, when its latest input is one */
  sender?: string;
  /** Agent sessions the post @-mentions */
  mentioned: string[];
  /** What the poster is told */
  message: string;
}

/**
 * The `@names` a text mentions, in order, without duplicates.
 *
 * @param text - Post text
 * @returns Names (without `@`)
 *
 * @example
 * ```typescript
 * mentionedNames('@Atlas (1) your note…, cc @Lyra.'); // ['Atlas', 'Lyra']
 * ```
 */
export function mentionedNames(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? '').matchAll(MENTION)) {
    const name = m[1].replace(/[.-]+$/, '');
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Whether a post into an owner thread only talks to agents, unprompted by
 * that thread — and what to tell the poster.
 *
 * @param input - Poster, text, latest input and lookups
 * @returns The refusal, or null to post
 */
export function misdirectedAgentMention(input: AgentMentionPostInput): MisdirectedAgentMention | null {
  const { latest } = input;
  if (!input.ownerAskedHere) return null;
  const sender = latest?.kind === 'agent' && latest.sender && latest.sender !== input.session ? latest.sender : undefined;
  const names = mentionedNames(input.content);
  if (names.length === 0) return null;
  const mentioned: string[] = [];
  for (const name of names) {
    const agent = input.agentByName(name);
    if (!agent || agent === input.session) return null;
    if (!mentioned.includes(agent)) mentioned.push(agent);
  }
  const to = sender && mentioned.includes(sender) ? sender : mentioned[0];
  const from = sender ? `, your latest message came from ${sender} (another agent),` : '';
  return {
    ...(sender ? { sender } : {}),
    mentioned,
    message:
      `Not posted: this is the owner's thread${from} and your post only @-mentions agents. Agents do not talk to each other in the owner's thread. ` +
      `Send it to the agent instead: send-message --to ${to} "<your message>". ` +
      'Post in this thread only the final answer to the owner, without the @-mention.',
  };
}
