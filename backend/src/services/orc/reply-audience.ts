/**
 * Audience check for an agent's reply (issue #969).
 *
 * What an agent read through a person's connector grant is that person's
 * data. A reply the agent writes shortly after such a read must not land in
 * a place other people can see: a shared room, a Slack channel thread, a
 * ticket thread. Such a reply goes to the agent's DM with the owner instead,
 * opened with a line saying where it was held from and whose data it draws
 * on; when the agent has no owner DM it is held and the agent is told.
 *
 * The owner sees everything, so an owner-only instance (every turn acts for
 * `owner`) is unaffected. The check runs after the destination resolver and
 * before any post.
 *
 * @module services/orc/reply-audience
 */

import { PEOPLE_CONSTANTS } from '../../constants.js';
import { recordActivity, type ActivityEntryInput } from '../activity/activity-log.service.js';
import { isSlackDm } from './orc-reply-route.service.js';
import type { ReplyDestination } from './reply-destination-resolver.js';

/** Activity-log actions written by the check. */
export const PRIVATE_REPLY_ACTIONS = {
  /** The reply was moved to the owner DM */
  REDIRECTED: 'connector.private_output.redirected',
  /** The reply was held: no owner DM to move it to */
  HELD: 'connector.private_output.held',
  /** The owner said to share it: posted to the shared place with `--share` */
  SHARED: 'connector.private_output.shared',
  /** The owner kept a held reply in their DM (the card's Keep private) */
  KEPT: 'connector.private_output.kept',
} as const;

/** What the check needs to know. */
export interface ReplyAudienceDeps {
  /** People (ids) whose grants the session read inside the private-source window */
  recentPeople(session: string): string[];
  /** A chat-v2 conversation's kind: a DM with the owner, a shared room, or unknown */
  conversationKind(conversationId: string): 'dm' | 'shared' | 'unknown';
  /** The Slack channel a conversation mirrors to, when any (a Slack DM counts as private) */
  slackChannelOf?(conversationId: string): string | null;
  /** The agent's owner DM conversation, or null */
  ownerDm(session: string): Promise<string | null>;
  /** A person's display name */
  personName?(id: string): string | undefined;
  /** A conversation as the owner knows it (`#content-team`) */
  conversationPlace?(conversationId: string): string | null;
  /** Activity-log writer (default: the real one) */
  record?(input: ActivityEntryInput): void;
  /** Whether a Share / Keep private card follows the DM copy (the note then points at it) */
  offersCard?(): boolean;
}

/** The check's verdict. */
export type ReplyAudienceVerdict =
  /** Nothing private, or a private place: post as resolved */
  | { kind: 'open' }
  /** A shared place: post to the owner DM instead, with `note` above the text */
  | { kind: 'redirect'; destination: Extract<ReplyDestination, { kind: 'conversation' }>; note: string; people: string[]; heldFrom: string }
  /** A shared place and no owner DM: do not post; the agent gets `reason` and `fix` */
  | { kind: 'held'; reason: string; fix: string; people: string[]; heldFrom: string };

/**
 * Whether a resolved destination is a place other people can read.
 *
 * @param dest - The resolved destination
 * @param deps - Lookups
 * @returns True for a room, channel thread, ticket thread or unknown conversation
 */
export function isSharedPlace(dest: Exclude<ReplyDestination, { kind: 'unresolved' }>, deps: ReplyAudienceDeps): boolean {
  if (dest.kind === 'conversation') {
    if (deps.conversationKind(dest.conversationId) === 'dm') return false;
    const slack = deps.slackChannelOf?.(dest.conversationId) ?? null;
    if (slack && isSlackDm(slack)) return false;
    return true;
  }
  const w = dest.destination;
  // An internal message to a colleague is not a post anyone else reads.
  if (w.kind === 'agent') return false;
  if (w.kind === 'slack' && isSlackDm(w.target)) return false;
  return true;
}

/**
 * The place a destination stands for, as the owner would name it.
 *
 * @param dest - The resolved destination
 * @param deps - Lookups
 * @returns `#room`, `the ticket thread`, …
 */
function placeOf(dest: Exclude<ReplyDestination, { kind: 'unresolved' }>, deps: ReplyAudienceDeps): string {
  if (dest.kind === 'conversation') return deps.conversationPlace?.(dest.conversationId) ?? `conversation ${dest.conversationId}`;
  const w = dest.destination;
  if (w.kind === 'slack') return w.target.startsWith('#') ? w.target : `Slack channel ${w.target}`;
  if (w.kind === 'ticket-thread') return `the ${w.ticketId} ticket thread`;
  if (w.kind === 'new-top-level') return 'the team channel';
  return 'that place';
}

/**
 * Names for a list of person ids ("Alice and Bob").
 *
 * @param people - Person ids
 * @param deps - Lookups
 * @returns A readable list
 */
function namesOf(people: string[], deps: ReplyAudienceDeps): string {
  const names = people.map((p) => deps.personName?.(p) || p);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The people (other than the owner) whose grants the session read recently.
 *
 * @param session - Agent session
 * @param deps - Lookups
 * @returns Person ids; empty when none or when the tracker fails
 */
export function privatePeopleOf(session: string, deps: Pick<ReplyAudienceDeps, 'recentPeople'>): string[] {
  try {
    return deps.recentPeople(session).filter((p) => p && p !== PEOPLE_CONSTANTS.OWNER_ID);
  } catch {
    return [];
  }
}

/**
 * Note that the owner had a private-sourced reply posted to a shared place
 * (`reply --share` after the owner said so in the agent's DM).
 *
 * @param session - Agent session
 * @param dest - Where it goes
 * @param deps - Lookups
 * @returns The people the reply draws on (empty: nothing private, nothing logged)
 */
export function recordPrivateShare(session: string, dest: Exclude<ReplyDestination, { kind: 'unresolved' }>, deps: ReplyAudienceDeps): string[] {
  const people = privatePeopleOf(session, deps);
  if (people.length === 0 || !isSharedPlace(dest, deps)) return [];
  const place = placeOf(dest, deps);
  (deps.record ?? recordActivity)({
    actor: { type: 'agent', id: session },
    action: PRIVATE_REPLY_ACTIONS.SHARED,
    target: dest.kind === 'conversation' ? { type: 'conversation', id: dest.conversationId } : { type: 'reply', id: session },
    after: { people, sharedTo: place },
    note: `${session} posted a reply drawing on ${namesOf(people, deps)}'s data to ${place} after the owner said to share it`,
  });
  return people;
}

/**
 * Whether a share card follows the DM copy (never throws).
 *
 * @param deps - Lookups
 * @returns True when the card is offered
 */
function offersCard(deps: ReplyAudienceDeps): boolean {
  try {
    return deps.offersCard?.() === true;
  } catch {
    return false;
  }
}

/**
 * Check whether a reply may go where the resolver sent it.
 *
 * @param session - Agent session
 * @param dest - The resolved destination
 * @param deps - Lookups
 * @returns The verdict (never throws)
 */
export async function checkReplyAudience(
  session: string,
  dest: Exclude<ReplyDestination, { kind: 'unresolved' }>,
  deps: ReplyAudienceDeps,
): Promise<ReplyAudienceVerdict> {
  const people = privatePeopleOf(session, deps);
  if (people.length === 0) return { kind: 'open' };
  if (!isSharedPlace(dest, deps)) return { kind: 'open' };

  const heldFrom = placeOf(dest, deps);
  const who = namesOf(people, deps);
  const record = deps.record ?? recordActivity;
  const ownerDm = await deps.ownerDm(session).catch(() => null);
  if (!ownerDm) {
    record({
      actor: { type: 'agent', id: session },
      action: PRIVATE_REPLY_ACTIONS.HELD,
      target: { type: 'reply', id: session },
      after: { people, heldFrom },
      note: `${session}'s reply to ${heldFrom} was held: it draws on ${who}'s data and the agent has no DM with the owner`,
    });
    return {
      kind: 'held',
      reason: `it draws on ${who}'s data (read through their connection in the last minutes) and ${heldFrom} has other members`,
      fix: `send it to the owner's DM (ask your team lead to open one); once the owner says to share it there, run the same reply with --share`,
      people,
      heldFrom,
    };
  }
  record({
    actor: { type: 'agent', id: session },
    action: PRIVATE_REPLY_ACTIONS.REDIRECTED,
    target: { type: 'conversation', id: ownerDm },
    after: { people, heldFrom },
    note: `${session}'s reply to ${heldFrom} went to the owner DM instead: it draws on ${who}'s data`,
  });
  return {
    kind: 'redirect',
    destination: {
      kind: 'conversation',
      conversationId: ownerDm,
      source: 'owner-dm',
      reason: `held from ${heldFrom}: it draws on ${who}'s data`,
    },
    note: offersCard(deps)
      ? `_Held from ${heldFrom}: this draws on ${who}'s data, which only you and they may see. Tap *Share* on the card below, or say "share it" here, and I will post it there._`
      : `_Held from ${heldFrom}: this draws on ${who}'s data, which only you and they may see. Say "share it" here and I will post it there._`,
    people,
    heldFrom,
  };
}
