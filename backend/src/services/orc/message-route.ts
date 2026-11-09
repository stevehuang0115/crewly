/**
 * The destination a message carries: where the answer to it goes
 * (message-routing audit 2026-10-18, invariant).
 *
 * Every input an agent answers names its route: an owner message (its
 * conversation and thread), a work item, or another agent. The route of the
 * input an agent is working from is copied onto everything it sends on:
 * the `[MESSAGE from …]` header of `send-message`, the `parentRoute` of a
 * work item it delegates, and the `[RESULT]` relay its delegate's answer
 * comes back with. So the owner's thread travels across every agent hop,
 * and the final answer lands where the owner asked, without the harness
 * guessing "the newest owner turn" or "the newest work item".
 *
 * Pure helpers: the text token, parsing it back, and the reply command that
 * answers a route.
 *
 * @module services/orc/message-route
 */

import { MESSAGE_ROUTE_CONSTANTS } from '../../constants.js';
import { formatSlackThreadKey, parseSlackThreadKey } from '../slack/slack-thread-key.js';
import type { TurnTrigger } from '../trace/turn-trigger.js';
import type { TurnOrigin } from './orc-reply-route.service.js';

/** Where the answer to a message goes. */
export type MessageRoute =
  /** A work item: its origin decides (owner thread, ticket thread, delegator, …) */
  | { kind: 'work-item'; workItemId: string }
  /** An owner message: its conversation and thread (Slack thread key or chat-v2 thread root) */
  | { kind: 'owner'; conversationId: string; thread?: string };

/** An id the token may carry: no whitespace, no closing brace. */
const ID = /^[^\s{}]+$/;

/**
 * Shape check.
 *
 * @param value - Anything
 * @returns True for a {@link MessageRoute}
 */
export function isMessageRoute(value: unknown): value is MessageRoute {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.kind === 'work-item') return typeof v.workItemId === 'string' && ID.test(v.workItemId);
  if (v.kind === 'owner') {
    return typeof v.conversationId === 'string' && ID.test(v.conversationId) && (v.thread === undefined || (typeof v.thread === 'string' && ID.test(v.thread)));
  }
  return false;
}

/**
 * The text token for a route, e.g. `{route: owner room-1 thread C0A:1.2}`.
 * Text survives every queue a message may wait in, and the harness reads
 * it back with {@link parseRouteToken}.
 *
 * @param route - The route
 * @returns The token
 *
 * @example
 * ```typescript
 * formatRouteToken({ kind: 'work-item', workItemId: 'wi-1' }); // '{route: work-item wi-1}'
 * ```
 */
export function formatRouteToken(route: MessageRoute): string {
  const open = MESSAGE_ROUTE_CONSTANTS.TOKEN_OPEN;
  if (route.kind === 'work-item') return `${open}work-item ${route.workItemId}}`;
  return `${open}owner ${route.conversationId}${route.thread ? ` thread ${route.thread}` : ''}}`;
}

/** `{route: work-item <id>}` / `{route: owner <conversation>[ thread <thread>]}` */
const TOKEN_RE = /\{route: (?:work-item ([^\s{}]+)|owner ([^\s{}]+)(?: thread ([^\s{}]+))?)\}/;

/**
 * The route a text carries (the first token in it).
 *
 * @param text - Delivered text
 * @returns The route, or null when the text carries none
 */
export function parseRouteToken(text: string): MessageRoute | null {
  const m = TOKEN_RE.exec(typeof text === 'string' ? text : '');
  if (!m) return null;
  if (m[1]) return { kind: 'work-item', workItemId: m[1] };
  return { kind: 'owner', conversationId: m[2], ...(m[3] ? { thread: m[3] } : {}) };
}

/**
 * The reply command that answers a route.
 *
 * @param route - The route
 * @returns An English command line
 */
export function replyCommandFor(route: MessageRoute): string {
  if (route.kind === 'work-item') return `reply --work-item ${route.workItemId} "<message>"`;
  return `reply --conversation ${route.conversationId}${route.thread ? ` --thread ${route.thread}` : ''} "<message>"`;
}

/**
 * A route in words, for notes to agents.
 *
 * @param route - The route
 * @returns E.g. `work item wi-1` / `the owner's thread C0A:1.2 in conversation room-1`
 */
export function describeRoute(route: MessageRoute): string {
  if (route.kind === 'work-item') return `work item ${route.workItemId}`;
  return route.thread ? `the owner's thread ${route.thread} in conversation ${route.conversationId}` : `the owner's conversation ${route.conversationId}`;
}

/**
 * Whether two routes name the same place.
 *
 * @param a - Route
 * @param b - Route
 * @returns True when equal
 */
export function sameRoute(a: MessageRoute | null | undefined, b: MessageRoute | null | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'work-item' && b.kind === 'work-item') return a.workItemId === b.workItemId;
  if (a.kind === 'owner' && b.kind === 'owner') return a.conversationId === b.conversationId && (a.thread ?? '') === (b.thread ?? '');
  return false;
}

/** A place a post landed in (or is expected in). */
export interface PostPlace {
  /** chat-v2 conversation */
  conversationId?: string;
  /** Thread in it: Slack thread key or chat-v2 thread root id */
  thread?: string;
  /** Slack channel */
  slackChannelId?: string;
  /** Slack thread ts (undefined: top level) */
  threadTs?: string;
}

/** Outcome of {@link comparePostPlace}. */
export type RouteCheckOutcome = 'match' | 'mismatch' | 'unknown';

/**
 * Compare where a post landed with where the request it answers came from
 * (the regression check of the routing invariant). Places are compared on
 * the Slack thread when both know one, else on the chat conversation and
 * thread; anything the two do not both know is `unknown`, never a mismatch.
 *
 * @param expected - The originating request's place
 * @param landed - Where the post landed
 * @returns The outcome
 */
export function comparePostPlace(expected: PostPlace | null | undefined, landed: PostPlace | null | undefined): RouteCheckOutcome {
  if (!expected || !landed) return 'unknown';
  const slackOf = (p: PostPlace): { ch: string; ts?: string } | null => {
    const key = parseSlackThreadKey(p.thread);
    if (key) return { ch: key.slackChannelId, ts: key.threadTs };
    return p.slackChannelId ? { ch: p.slackChannelId, ...(p.threadTs ? { ts: p.threadTs } : {}) } : null;
  };
  const e = slackOf(expected);
  const l = slackOf(landed);
  if (e && l) return e.ch === l.ch && (e.ts ?? '') === (l.ts ?? '') ? 'match' : 'mismatch';
  if (expected.conversationId && landed.conversationId) {
    if (expected.conversationId !== landed.conversationId) return 'mismatch';
    // Same conversation: the thread decides when both name one in the same form.
    const et = expected.thread && !parseSlackThreadKey(expected.thread) ? expected.thread : undefined;
    const lt = landed.thread && !parseSlackThreadKey(landed.thread) ? landed.thread : undefined;
    if (et && lt) return et === lt ? 'match' : 'mismatch';
    if (!expected.thread && !landed.thread) return 'match';
    return 'unknown';
  }
  return 'unknown';
}

/**
 * The place an owner route names.
 *
 * @param route - An owner route
 * @returns Its place
 */
export function placeOfOwnerRoute(route: Extract<MessageRoute, { kind: 'owner' }>): PostPlace {
  const key = parseSlackThreadKey(route.thread);
  return {
    conversationId: route.conversationId,
    ...(route.thread ? { thread: key ? formatSlackThreadKey(key.slackChannelId, key.threadTs) : route.thread } : {}),
    ...(key ? { slackChannelId: key.slackChannelId, threadTs: key.threadTs } : {}),
  };
}

/**
 * The route of what an agent is answering, from its latest routed trigger
 * (turn-trigger.ts `routedTrigger`): the owner message (with the thread its
 * turn origin knows), the route an agent message or result carries, or the
 * work item a dispatch handed over. This is what the agent's own messages
 * carry onward.
 *
 * @param trigger - The agent's latest routed trigger, or null
 * @param origin - Its turn origin (the thread of the owner message), if any
 * @returns The route, or null when the input names none
 */
export function routeOfTrigger(trigger: TurnTrigger | null, origin?: TurnOrigin): MessageRoute | null {
  if (!trigger) return null;
  switch (trigger.triggerKind) {
    case 'owner_message': {
      const conversationId = trigger.conversationId ?? origin?.conversationId;
      if (!conversationId) return null;
      const sameAsOrigin = origin?.conversationId === conversationId;
      const thread = trigger.thread ?? (sameAsOrigin ? origin?.slackThreadKey ?? origin?.chatThreadId : undefined);
      return { kind: 'owner', conversationId, ...(thread ? { thread } : {}) };
    }
    case 'agent_message':
    case 'delegated_result':
      return trigger.route ?? null;
    case 'dispatch':
    case 'scheduled':
      return trigger.workItemId ? { kind: 'work-item', workItemId: trigger.workItemId } : null;
    default:
      return null;
  }
}
