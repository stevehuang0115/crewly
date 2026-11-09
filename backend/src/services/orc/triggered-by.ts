/**
 * The "Triggered by …" line under an agent's message (agent-provenance audit
 * 2026-10-14): one muted line saying why the agent posted, when the post is
 * not simply its answer to the owner's message in the same conversation.
 *
 * Pure: the caller supplies the turn's trigger and the lookups.
 *
 * @module services/orc/triggered-by
 */

import { ORCHESTRATOR_SESSION_NAME, TURN_TRIGGER_CONSTANTS } from '../../constants.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { memberNameFromSession } from '../../utils/member-session-name.utils.js';
import type { TriggeredByMetadata, TurnTrigger } from '../trace/turn-trigger.js';
import { originOfWorkItem } from './work-item-destination.js';

const C = TURN_TRIGGER_CONSTANTS;

/** Where the post goes and how to name things. */
export interface TriggeredByContext {
  /** Conversation the post lands in (undefined: a Slack place outside chat) */
  postedConversationId?: string;
  /** The owner wrote to this agent in the posted conversation, or in the posted thread, recently: the post is an answer */
  ownerAskedHere?: boolean;
  /** The work item the trigger names, when it names one */
  workItem?: WorkItem | null;
  /** A conversation as the owner knows it (`#content-team`, `the DM with Ella`), or null */
  conversationPlace?: (conversationId: string) => string | null;
  /** An agent's readable name; default: the member name in its session id */
  agentName?: (session: string) => string;
}

/** Cut a title to one short line, without internal ids or a leading tag. */
export function shortTitle(title: string): string {
  const one = title
    .replace(C.LEADING_TAG_PATTERN, '')
    .replace(C.INTERNAL_ID_PATTERN, '')
    .replace(/[(（]\s*[)）]/g, '')
    .replace(/\s+([,，:：)）])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > C.MAX_TITLE_CHARS ? `${one.slice(0, C.MAX_TITLE_CHARS - 1)}…` : one;
}

/**
 * What the line says after "Triggered by ", or null when no line is shown
 * (a direct answer to the owner in the same conversation, or nothing known).
 *
 * @param trigger - The turn's trigger
 * @param ctx - Destination and lookups
 * @returns The phrase, or null
 *
 * @example
 * triggeredByPhrase({ triggerKind: 'agent_message', sender: 'crewly-marketing-ella-e6a6b8ea', rootKind: 'owner_message', viaAgents: ['crewly-marketing-ella-e6a6b8ea'], at: 0 }, {})
 * // "Ella's message (passing on your request)"
 */
export function triggeredByPhrase(trigger: TurnTrigger | null, ctx: TriggeredByContext): string | null {
  if (!trigger || ctx.ownerAskedHere) return null;
  const name = (s: string): string => (ctx.agentName ? ctx.agentName(s) : s === ORCHESTRATOR_SESSION_NAME ? 'Orc' : memberNameFromSession(s));
  switch (trigger.triggerKind) {
    case 'owner_message': {
      if (!trigger.conversationId || !ctx.postedConversationId || trigger.conversationId === ctx.postedConversationId) return null;
      const where = ctx.conversationPlace?.(trigger.conversationId);
      return where ? `your message in ${where}` : 'your message in another conversation';
    }
    case 'agent_message': {
      if (!trigger.sender) return 'a message from another agent';
      // Only the agent that wrote: a longer chain is noise to the owner (the record keeps it).
      const from = `${name(trigger.sender)}'s message`;
      if (trigger.rootKind === 'owner_message') return `${from} (passing on your request)`;
      if (trigger.rootKind === 'scheduled') return `${from} (from a scheduled task)`;
      return from;
    }
    case 'delegated_result': {
      // A result on work delegated for the owner, posted where the owner asked, needs no label.
      const route = trigger.route;
      if (route?.kind === 'owner' && route.conversationId === ctx.postedConversationId) return null;
      const who = trigger.sender ?? trigger.textSender;
      const from = who ? `${name(who)}'s result for work you delegated` : 'a result for work you delegated';
      return route?.kind === 'owner' || trigger.rootKind === 'owner_message' ? `${from} (passing on your request)` : from;
    }
    case 'dispatch':
    case 'scheduled': {
      const wi = ctx.workItem;
      const origin = wi ? originOfWorkItem(wi) : null;
      const title = wi?.title ? ` "${shortTitle(wi.title)}"` : '';
      if (trigger.triggerKind === 'scheduled' || origin?.kind === 'trigger') {
        const topic = origin?.kind === 'trigger' && origin.topic ? ` "${shortTitle(origin.topic)}"` : title;
        return `a scheduled task${topic}`;
      }
      if (origin?.kind === 'owner') {
        // Answering the owner where they asked needs no label.
        if (origin.conversationId && origin.conversationId === ctx.postedConversationId) return null;
        return `your request${title}`;
      }
      // Tickets are internal: name the task, never its ticket id.
      if (origin?.kind === 'ticket') return `a task${title}`;
      const by = (wi?.metadata as Record<string, unknown> | undefined)?.delegatedBy;
      if (typeof by === 'string' && by) return `a task from ${name(by)}${title}`;
      return `a queued task${title}`;
    }
    case 'redelivery':
      return 'an automatic reminder of queued work';
    case 'follow_up':
      return 'an automatic reminder of something promised to you';
    case 'owner_report_due':
      return 'an automatic reminder to report finished work';
    case 'follow_through':
      return 'an automatic reminder of something the agent said it would do';
    case 'stale_item':
      return 'a stale-item notice';
    case 'decision':
      return 'your answer on a decision card';
    case 'restart':
      return 'a Crewly restart (resuming interrupted work)';
    case 'app_change':
      return 'a change in a Crewly App';
    case 'status':
      return "a teammate's status report";
    case 'system':
    default:
      // Unrecognised prompts are not labelled: a wrong reason is worse than none.
      return null;
  }
}

/**
 * The muted line itself, or null.
 *
 * @param phrase - From {@link triggeredByPhrase}
 * @returns `_↳ Triggered by …_`, or null
 */
export function triggeredByLine(phrase: string | null): string | null {
  return phrase ? `${C.LINE_PREFIX}${phrase}${C.LINE_SUFFIX}` : null;
}

/**
 * The text with the line appended (once).
 *
 * @param content - The agent's text
 * @param phrase - From {@link triggeredByPhrase}
 * @returns The text to post
 */
export function withTriggeredByLine(content: string, phrase: string | null): string {
  const line = triggeredByLine(phrase);
  if (!line || content.includes(C.LINE_PREFIX)) return content;
  return `${content.replace(/\s+$/, '')}\n\n${line}`;
}

/**
 * The provenance record stored on the chat row.
 *
 * @param trigger - The turn's trigger
 * @param phrase - The shown phrase (null when no line is shown)
 * @param traceId - The session's current run trace, when the trigger has none
 * @returns Metadata value for {@link TURN_TRIGGER_CONSTANTS.METADATA_KEY}
 */
export function triggeredByMetadata(trigger: TurnTrigger, phrase: string | null, traceId?: string | null): TriggeredByMetadata {
  const id = trigger.traceId ?? traceId ?? undefined;
  return {
    ...(id ? { traceId: id } : {}),
    rootKind: trigger.rootKind,
    ...(trigger.rootRef ? { rootRef: trigger.rootRef } : {}),
    triggerKind: trigger.triggerKind,
    viaAgents: [...trigger.viaAgents],
    ...(phrase ? { label: `Triggered by ${phrase}` } : {}),
  };
}
