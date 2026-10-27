/**
 * Private-share decisions (crewly#969, specs/per-person-access.md).
 *
 * When the audience check moves an agent's reply from a shared place to the
 * owner's DM (it draws on someone's private data), the owner gets a card
 * under it: *Share in #room?* — Share / Keep private. A tap on Share posts
 * the reply where it was going, as written, and logs the share; anything
 * else leaves it in the DM. The default, applied unanswered after a day, is
 * Keep private.
 *
 * The post happens in exactly one place, {@link PrivateShareDecisions.onSettled},
 * which the decision service calls when the card settles. Nothing an agent
 * can call reaches it, so an agent cannot share its own held reply (the
 * owner's word in the DM plus `reply --share` remains the other way).
 *
 * @module services/orc/private-share-decisions
 */

import type { OwnerDecision, PrivateShareSubject } from '../../types/decision.types.js';
import type { DecisionKindHandler } from '../decisions/decision.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { recordActivity, type ActivityActor, type ActivityEntryInput } from '../activity/activity-log.service.js';
import { PRIVATE_REPLY_ACTIONS } from './reply-audience.js';
import { stripTraceMarkers } from '../trace/trace-markers.js';
import type { ReplyDestination } from './reply-destination-resolver.js';

/** Option keys on the card. */
export const PRIVATE_SHARE_KEYS = { SHARE: 'share', KEEP: 'keep' } as const;

/** How long the card waits before the (safe) default, Keep private, applies. */
export const PRIVATE_SHARE_DEADLINE_MS = 24 * 60 * 60 * 1000;

/** Reply characters quoted on the card. */
const PREVIEW_CHARS = 400;

/** A reply the audience check held from a shared place. */
export interface HeldReply {
  session: string;
  /** The reply text (without the held-from note the DM copy opens with) */
  content: string;
  /** Where it was going */
  destination: Exclude<ReplyDestination, { kind: 'unresolved' }>;
  /** The shared place in words */
  heldFrom: string;
  /** People (ids) whose data it draws on */
  people: string[];
  /** The owner DM conversation it went to instead */
  ownerDm: string;
}

/** The decision-service surface used here. */
export interface PrivateShareDecisionService {
  askPrebuilt(ask: {
    kind: 'private_share';
    asker: string;
    question: string;
    options: Array<{ key: string; label: string; detail?: string }>;
    defaultKey: string;
    yesKey: string;
    deadline: Date;
    title?: string;
    body?: string[];
    place?: { slackChannelId: string; threadTs?: string };
    privateShare: PrivateShareSubject;
  }): Promise<OwnerDecision>;
  list(which: 'open' | 'all'): Promise<OwnerDecision[]>;
}

/** What posting the held reply did. */
export type HeldReplyPost = { ok: true; place: string } | { ok: false; error: string };

/** Collaborators. */
export interface PrivateShareDecisionsDeps {
  /** The decision service, or null before it is up */
  decisions: () => PrivateShareDecisionService | null;
  /** Whether a card can go up at all (Slack connected) */
  canAsk: () => boolean;
  /** Post the held reply where it was going (the delivery path, audience check skipped) */
  post: (held: HeldReply) => Promise<HeldReplyPost>;
  /** The Slack channel a chat-v2 conversation mirrors (the owner DM's Slack DM), or null */
  slackChannelOf: (conversationId: string) => string | null;
  /** Agent display name */
  agentNameOf?: (session: string) => Promise<string | undefined>;
  /** Person display name */
  personName?: (id: string) => string | undefined;
  /** Activity log sink (tests) */
  record?: (entry: ActivityEntryInput) => void;
  now?: () => number;
}

/**
 * Who acted on the card for the activity log: the owner when they answered
 * and how; a deadline outcome is the system.
 *
 * @param decision - Settled decision
 * @returns Actor
 */
function decisionActor(decision: OwnerDecision): ActivityActor {
  if (decision.answeredVia === 'deadline' || decision.status === 'expired' || decision.status === 'defaulted') return { type: 'system', via: 'deadline' };
  return { type: 'owner', ...(decision.answeredBy ? { id: decision.answeredBy } : {}), ...(decision.answeredVia ? { via: decision.answeredVia } : {}) };
}

/**
 * Names for a list of person ids ("Alice and Bob").
 *
 * @param people - Person ids
 * @param name - Lookup
 * @returns Names joined for a sentence
 */
function namesOf(people: string[], name?: (id: string) => string | undefined): string {
  const names = people.map((p) => name?.(p) || p);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Raises the share card for a held reply and applies the owner's answer.
 */
export class PrivateShareDecisions implements DecisionKindHandler {
  private readonly logger: ComponentLogger;

  constructor(private readonly deps: PrivateShareDecisionsDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('PrivateShareDecisions');
  }

  /**
   * Whether a card would go up for a held reply right now (the DM copy's
   * note can then point at it).
   *
   * @returns True when the decision service is up and Slack is connected
   */
  offersCard(): boolean {
    try {
      return !!this.deps.decisions() && this.deps.canAsk();
    } catch {
      return false;
    }
  }

  /**
   * A reply was moved to the owner DM: ask the owner, in that DM, whether to
   * post it where it was going. One open card per agent + place + text.
   *
   * @param held - The held reply
   * @returns The card's decision, or null when none was raised
   */
  async onHeld(held: HeldReply): Promise<OwnerDecision | null> {
    const decisions = this.deps.decisions();
    if (!decisions || !this.deps.canAsk()) return null;
    const open = await decisions.list('open').catch(() => [] as OwnerDecision[]);
    const same = open.find(
      (d) => d.kind === 'private_share' && d.privateShare?.agentSession === held.session && d.privateShare.heldFrom === held.heldFrom && d.privateShare.content === held.content,
    );
    if (same) {
      this.logger.info('Held reply asked again while its card is open — reusing it', { decisionId: same.id, session: held.session });
      return same;
    }
    const agentName = (await this.deps.agentNameOf?.(held.session).catch(() => undefined)) ?? held.session;
    const who = namesOf(held.people, this.deps.personName);
    const slackDm = this.deps.slackChannelOf(held.ownerDm);
    const shown = stripTraceMarkers(held.content).trim();
    const preview = shown.length > PREVIEW_CHARS ? `${shown.slice(0, PREVIEW_CHARS)}…` : shown;
    const decision = await decisions.askPrebuilt({
      kind: 'private_share',
      asker: held.session,
      question: `Share ${agentName}'s reply in ${held.heldFrom}? It draws on ${who}'s data, which only you and they may see.`,
      options: [
        { key: PRIVATE_SHARE_KEYS.SHARE, label: 'Share', detail: `post it in ${held.heldFrom} as written, once` },
        { key: PRIVATE_SHARE_KEYS.KEEP, label: 'Keep private', detail: 'it stays here in your DM' },
      ],
      defaultKey: PRIVATE_SHARE_KEYS.KEEP,
      yesKey: PRIVATE_SHARE_KEYS.SHARE,
      deadline: new Date((this.deps.now?.() ?? Date.now()) + PRIVATE_SHARE_DEADLINE_MS),
      title: 'Private data',
      body: [`> ${preview.replace(/\n/g, '\n> ')}`],
      ...(slackDm ? { place: { slackChannelId: slackDm } } : {}),
      privateShare: {
        agentSession: held.session,
        agentName,
        content: held.content,
        destination: held.destination,
        heldFrom: held.heldFrom,
        people: held.people,
        ownerDm: held.ownerDm,
      },
    });
    this.logger.info('Asked the owner whether to share a held reply', { decisionId: decision.id, session: held.session, heldFrom: held.heldFrom });
    return decision;
  }

  /**
   * A `private_share` card settled. The only place a held reply is posted
   * from a card.
   *
   * @param decision - The settled decision
   * @returns Note for the agent, or null (a quiet default wakes nobody)
   */
  async onSettled(decision: OwnerDecision): Promise<string | null> {
    const subject = decision.privateShare;
    if (!subject) return null;
    const shareChosen = decision.status === 'resolved' && decision.chosenKey === PRIVATE_SHARE_KEYS.SHARE;
    const record = this.deps.record ?? recordActivity;
    if (!shareChosen) {
      this.logger.info('Held reply kept private', { decisionId: decision.id, status: decision.status });
      if (decision.status !== 'resolved') return null;
      record({
        actor: decisionActor(decision),
        action: PRIVATE_REPLY_ACTIONS.KEPT,
        target: { type: 'conversation', id: subject.ownerDm },
        after: { people: subject.people, heldFrom: subject.heldFrom, decisionId: decision.id },
        note: `the owner kept ${subject.agentSession}'s reply held from ${subject.heldFrom} private`,
      });
      return `[PRIVATE] The owner kept your reply held from ${subject.heldFrom} in their DM. Do not post it there another way.`;
    }
    const held: HeldReply = {
      session: subject.agentSession,
      content: subject.content,
      destination: subject.destination as HeldReply['destination'],
      heldFrom: subject.heldFrom,
      people: subject.people,
      ownerDm: subject.ownerDm,
    };
    let posted: HeldReplyPost;
    try {
      posted = await this.deps.post(held);
    } catch (err) {
      posted = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!posted.ok) {
      this.logger.warn('Owner tapped Share but the held reply could not be posted', { decisionId: decision.id, error: posted.error });
      return `[PRIVATE] The owner tapped Share on your reply held from ${subject.heldFrom}, but it could not be posted there: ${posted.error}. Tell the owner in your DM.`;
    }
    record({
      actor: decisionActor(decision),
      action: PRIVATE_REPLY_ACTIONS.SHARED,
      target: held.destination.kind === 'conversation' ? { type: 'conversation', id: held.destination.conversationId } : { type: 'reply', id: subject.agentSession },
      after: { people: subject.people, sharedTo: posted.place, decisionId: decision.id },
      note: `the owner shared ${subject.agentSession}'s reply drawing on ${namesOf(subject.people, this.deps.personName)}'s data in ${posted.place} from the card`,
    });
    this.logger.info('Held reply shared from the card', { decisionId: decision.id, session: subject.agentSession, place: posted.place });
    return `[PRIVATE] The owner shared your reply held from ${subject.heldFrom}; it is posted there now. Nothing more to send.`;
  }
}

let instance: PrivateShareDecisions | null = null;

/**
 * The private-share handler the composition root registered, or null.
 *
 * @returns Handler or null
 */
export function getPrivateShareDecisions(): PrivateShareDecisions | null {
  return instance;
}

/**
 * Register (or clear, with null) the private-share handler the reply
 * delivery raises cards through.
 *
 * @param handler - Handler or null
 */
export function setPrivateShareDecisions(handler: PrivateShareDecisions | null): void {
  instance = handler;
}
