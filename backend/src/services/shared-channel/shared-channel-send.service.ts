/**
 * Send side of shared channels (crewly#1543 slice 5): a message from this
 * account to another company's Crewly account, through Crewly Cloud.
 *
 * Who may send:
 * - the **owner**, from the channel's composer in Team Chat — straight through,
 *   no classifier and no hold (the owner is the authority);
 * - the **orchestrator**, with the `post-shared-channel` skill. Other agents
 *   are refused for now (per-link norms may widen this later).
 *
 * An agent message is classified ({@link classifySharedSend}):
 * - `refused` (secrets, children's data, another person's private data): not
 *   sent and not holdable; the agent is told why.
 * - otherwise, while the link is in its trial (fewer than
 *   `TRIAL_HELD_SENDS` owner-approved messages) or when it is `internal`, it
 *   is held on a `shared_send` owner card. The owner's Send posts it, with the
 *   message id fixed when it was held; Don't send (or no answer for a day)
 *   tells the orchestrator it was not sent.
 * - a `plain` message after the trial goes out at once.
 *
 * Per-link norms (slice 6, {@link SharedChannelNorm}): a hold reason the
 * link's allowances cover no longer holds the message once the trial is over
 * (the send is still logged with the reasons it allowed). Refusals and the
 * private-data holds can never be allowed. When every remaining hold reason
 * could be allowed, the card offers a third choice, "Send, always allow",
 * which sends and adds those allowances to the link's norm.
 *
 * Every message that went out is filed in the link's `external-<linkId>`
 * chat channel under its Cloud id, so the later history fetch of the receive
 * side dedupes it.
 *
 * Dependencies are injected so the service is testable without Cloud, chat or
 * the decision service.
 *
 * @module services/shared-channel/shared-channel-send.service
 */

import { ORCHESTRATOR_SESSION_NAME, SHARED_CHANNEL_CONSTANTS } from '../../constants.js';
import type { OwnerDecision, SharedSendSubject } from '../../types/decision.types.js';
import type { DecisionKindHandler } from '../decisions/decision.service.js';
import { recordActivity, type ActivityActor, type ActivityEntryInput } from '../activity/activity-log.service.js';
import { externalChannelIdOf, type SharedChannelLink, type SharedChannelPostAnswer } from './shared-channel.types.js';
import type { SharedChannelMirrorInput } from './shared-channel.service.js';
import { counterpartLabel } from './shared-channel-framing.js';
import { classifySharedSend, describeFindings } from './shared-channel-classifier.js';
import {
  EMPTY_NORM,
  SHARED_NORM_ACTIONS,
  allowancesCovering,
  describeAllowances,
  normalizeAllowances,
  splitByNorm,
  type SharedChannelNorm,
  type SharedNormAllowance,
} from './shared-channel-norms.js';

/** Option keys on the owner's card. */
export const SHARED_SEND_KEYS = { SEND: 'send', DONT_SEND: 'dont_send', SEND_ALLOW: 'send_allow' } as const;

/** Activity-log actions. */
export const SHARED_SEND_ACTIONS = {
  SENT: 'shared_channel.message.sent',
  HELD: 'shared_channel.message.held',
  REFUSED: 'shared_channel.message.refused',
  DECLINED: 'shared_channel.message.declined',
} as const;

/** Body of `POST /api/cloud/shared-channels/:linkId/messages` (crewly-auth contract). */
export interface SharedChannelPostBody {
  /** Client-generated id (idempotency key; `[A-Za-z0-9][A-Za-z0-9_-]{7,63}`) */
  id: string;
  text: string;
  fromAgentName: string;
  fromTeam?: string;
  replyTo?: string;
  /** The sending machine (informational) */
  instanceId?: string;
}

/** Cloud's answer to a send ({@link parseSharedChannelPostAnswer}). */
export type SharedChannelPostResult = SharedChannelPostAnswer;

/** Why a send did not go out. */
export type SharedSendCode =
  | 'invalid'
  | 'not_allowed'
  | 'not_found'
  | 'link_not_active'
  | 'refused'
  | 'too_long'
  | 'rate_limited'
  | 'cloud_unavailable'
  | 'send_failed'
  | 'cannot_hold';

/** What a send did. */
export interface SharedSendResult {
  success: boolean;
  /** `sent` = on its way to the other company; `held` = waiting for the owner */
  status?: 'sent' | 'held';
  linkId?: string;
  counterpart?: string;
  /** Cloud message id */
  messageId?: string;
  /** The owner card (held) */
  decisionId?: string;
  /** Local chat row of the sent message */
  chatMessageId?: string | null;
  code?: SharedSendCode;
  error?: string;
  /** Why it was held or refused */
  reasons?: string[];
  /** One line for the agent */
  note?: string;
}

/** The decision-service surface used here. */
export interface SharedSendDecisionService {
  askPrebuilt(ask: {
    kind: 'shared_send';
    asker: string;
    question: string;
    options: Array<{ key: string; label: string; detail?: string }>;
    defaultKey: string;
    yesKey: string;
    deadline: Date;
    title?: string;
    body?: string[];
    sharedSend: SharedSendSubject;
  }): Promise<OwnerDecision>;
  list(which: 'open' | 'all'): Promise<OwnerDecision[]>;
}

/** Collaborators. */
export interface SharedSendDeps {
  /** The account's links, or null when Cloud cannot be reached */
  listLinks(): Promise<SharedChannelLink[] | null>;
  /** POST one message to Cloud */
  post(linkId: string, body: SharedChannelPostBody): Promise<SharedChannelPostResult>;
  /** File a sent message in the link's chat channel; the new row id, or null when already there. May throw. */
  recordSent(input: SharedChannelMirrorInput): string | null;
  /** Owner-approved send counts per link */
  trial: { approvedCount(linkId: string): number; noteApproved(linkId: string): number };
  /** Per-link norms (slice 6); absent = no norms (every internal message held) */
  norms?: {
    get(linkId: string): SharedChannelNorm;
    addAllowances(linkId: string, keys: readonly SharedNormAllowance[]): { before: SharedChannelNorm; after: SharedChannelNorm };
  };
  /** The decision service, or null before it is up */
  decisions(): SharedSendDecisionService | null;
  /** Name (and team) the other side sees for an agent */
  agentIdentity(session: string): Promise<{ name: string; team?: string }>;
  /** People (ids) whose connector grants the session read recently (#969 tracker) */
  recentPeople(session: string): string[];
  /** A new client message id */
  newId(): string;
  /** This machine's instance id (informational on Cloud) */
  instanceId?(): Promise<string | undefined>;
  /** Activity log sink (default: the real one) */
  record?(entry: ActivityEntryInput): void;
  now?(): number;
  log?: { info(msg: string, meta?: object): void; warn(msg: string, meta?: object): void };
}

/** A link as `post-shared-channel --list` shows it. */
export interface SharedChannelLinkSummary {
  linkId: string;
  status: 'active' | 'revoked';
  /** The other company */
  counterpart: string;
  /** Agent messages the owner approved on it */
  approvedSends: number;
  /** Agent messages still held whatever they say (trial) */
  trialLeft: number;
  /** The owner's norm for this partner ('' when unset) */
  norm: string;
  /** Kinds of content that go without his approval after the trial */
  allow: SharedNormAllowance[];
}

/** An agent's request to send. */
export interface AgentSendInput {
  /** Calling agent session (caller identity, never the body) */
  fromSession: string;
  linkId: string;
  text: string;
  replyTo?: string;
}

/** The owner's post from Team Chat (by link id, or by its `external-*` chat channel id). */
export interface OwnerSendInput {
  linkId?: string;
  channelId?: string;
  text: string;
  replyTo?: string;
}

/** Cloud error codes (crewly-auth `SharedChannelError`) mapped to ours. */
function codeOfCloud(r: Extract<SharedChannelPostResult, { ok: false }>): SharedSendCode {
  if (r.status === 0) return 'cloud_unavailable';
  switch (r.code) {
    case 'not_found':
      return 'not_found';
    case 'link_not_active':
      return 'link_not_active';
    case 'too_long':
      return 'too_long';
    case 'rate_limited':
      return 'rate_limited';
    case 'invalid_request':
      return 'invalid';
    default:
      return r.status === 404 ? 'not_found' : 'send_failed';
  }
}

/**
 * Who acted on a card for the activity log.
 *
 * @param decision - Settled decision
 * @returns Actor
 */
function decisionActor(decision: OwnerDecision): ActivityActor {
  if (decision.answeredVia === 'deadline' || decision.status === 'expired' || decision.status === 'defaulted') return { type: 'system', via: 'deadline' };
  return { type: 'owner', ...(decision.answeredBy ? { id: decision.answeredBy } : {}), ...(decision.answeredVia ? { via: decision.answeredVia } : {}) };
}

/**
 * Cut a text for a card line.
 *
 * @param text - Text
 * @param max - Characters kept
 * @returns One line, with an ellipsis when cut
 */
function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** Sends messages on shared channels — see module docs. */
export class SharedChannelSendService implements DecisionKindHandler {
  constructor(private readonly deps: SharedSendDeps) {}

  private record(entry: ActivityEntryInput): void {
    (this.deps.record ?? recordActivity)(entry);
  }

  /**
   * The link's norm; an empty one when there is no store or it cannot be read.
   *
   * @param linkId - Link id
   * @returns Norm
   */
  private normOf(linkId: string): SharedChannelNorm {
    try {
      return this.deps.norms?.get(linkId) ?? { ...EMPTY_NORM, allow: [] };
    } catch {
      return { ...EMPTY_NORM, allow: [] };
    }
  }

  /**
   * Validate text and find an active link.
   *
   * @returns The link, or a failed result
   */
  private async activeLink(ref: { linkId?: string; channelId?: string }, text: string): Promise<{ link: SharedChannelLink; text: string } | SharedSendResult> {
    const clean = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const linkId = ref.linkId ?? '';
    if (!linkId && !ref.channelId) return { success: false, code: 'invalid', error: 'link is required (post-shared-channel --list shows the links).' };
    if (!clean) return { success: false, code: 'invalid', error: 'message is required.' };
    if (clean.length > SHARED_CHANNEL_CONSTANTS.MAX_TEXT_LENGTH) {
      return { success: false, code: 'too_long', error: `A message is at most ${SHARED_CHANNEL_CONSTANTS.MAX_TEXT_LENGTH} characters.` };
    }
    const links = await this.deps.listLinks();
    if (!links) return { success: false, code: 'cloud_unavailable', error: 'Crewly Cloud cannot be reached from this machine right now. Try again later.' };
    const link = links.find((l) => (linkId && l.linkId === linkId) || (!!ref.channelId && externalChannelIdOf(l.linkId) === ref.channelId));
    if (!link) return { success: false, code: 'not_found', error: `No shared channel with link id ${linkId || ref.channelId} on this account.` };
    if (link.status !== 'active') return { success: false, code: 'link_not_active', error: 'This link was revoked; nothing can be sent on it.' };
    return { link, text: clean };
  }

  /**
   * Post to Cloud and file the sent message in chat.
   *
   * @returns The result (success with the Cloud id, or the Cloud error)
   */
  private async deliver(
    link: Pick<SharedChannelLink, 'linkId'> & { counterpart: string },
    body: SharedChannelPostBody,
  ): Promise<SharedSendResult> {
    const instanceId = await this.deps.instanceId?.().catch(() => undefined);
    const posted = await this.deps.post(link.linkId, { ...body, ...(instanceId ? { instanceId } : {}) });
    if (!posted.ok) {
      const code = codeOfCloud(posted);
      const wait = posted.retryAfterS ? ` Try again in ${posted.retryAfterS} s.` : '';
      const base = (posted.error || 'Crewly Cloud refused the message').replace(/\.+$/, '');
      return { success: false, code, linkId: link.linkId, counterpart: link.counterpart, error: `${base}.${wait}` };
    }
    let chatMessageId: string | null = null;
    try {
      chatMessageId = this.deps.recordSent({
        linkId: link.linkId,
        counterpart: link.counterpart,
        messageId: posted.messageId,
        senderName: body.fromAgentName,
        direction: 'sent',
        text: body.text,
        createdAtMs: Date.parse(posted.createdAt) || (this.deps.now?.() ?? Date.now()),
        ...(body.replyTo ? { replyTo: body.replyTo } : {}),
      });
    } catch (err) {
      // The receive side's history fetch files it later.
      this.deps.log?.warn('Sent a shared-channel message but could not file it in chat yet', { linkId: link.linkId, error: err instanceof Error ? err.message : String(err) });
    }
    return { success: true, status: 'sent', linkId: link.linkId, counterpart: link.counterpart, messageId: posted.messageId, chatMessageId };
  }

  /**
   * The account's shared channels with their trial state (`post-shared-channel --list`).
   *
   * @returns Links, or null when Cloud cannot be reached
   */
  async listLinks(): Promise<SharedChannelLinkSummary[] | null> {
    const links = await this.deps.listLinks();
    if (!links) return null;
    return links.map((l) => {
      const approved = this.deps.trial.approvedCount(l.linkId);
      const norm = this.normOf(l.linkId);
      return {
        linkId: l.linkId,
        status: l.status,
        counterpart: counterpartLabel(l.counterpartDisplayName, l.counterpartEmail),
        approvedSends: approved,
        trialLeft: Math.max(0, SHARED_CHANNEL_CONSTANTS.TRIAL_HELD_SENDS - approved),
        norm: norm.norm,
        allow: norm.allow,
      };
    });
  }

  /**
   * The owner's own post from Team Chat: no classifier, no hold.
   *
   * @param input - Link, text, optional reply-to
   * @returns What happened
   */
  async sendFromOwner(input: OwnerSendInput): Promise<SharedSendResult> {
    const found = await this.activeLink({ ...(input.linkId ? { linkId: input.linkId } : {}), ...(input.channelId ? { channelId: input.channelId } : {}) }, input.text);
    if (!('link' in found)) return found;
    const counterpart = counterpartLabel(found.link.counterpartDisplayName, found.link.counterpartEmail);
    const result = await this.deliver(
      { linkId: found.link.linkId, counterpart },
      { id: this.deps.newId(), text: found.text, fromAgentName: SHARED_CHANNEL_CONSTANTS.OWNER_SENDER_NAME, ...(input.replyTo ? { replyTo: input.replyTo } : {}) },
    );
    if (result.success) {
      this.record({
        actor: { type: 'owner' },
        action: SHARED_SEND_ACTIONS.SENT,
        target: { type: 'shared_channel', id: found.link.linkId, name: counterpart },
        after: { messageId: result.messageId, by: 'owner' },
        note: `the owner wrote to ${counterpart}`,
      });
    }
    return result;
  }

  /**
   * An agent's message (the `post-shared-channel` skill). Only the
   * orchestrator may send for now.
   *
   * @param input - Sender, link, text, optional reply-to
   * @returns Sent, held for the owner, or refused — with a note for the agent
   */
  async sendFromAgent(input: AgentSendInput): Promise<SharedSendResult> {
    if (input.fromSession !== ORCHESTRATOR_SESSION_NAME) {
      return {
        success: false,
        code: 'not_allowed',
        error: 'Only the orchestrator writes to external teams for now. Tell the orchestrator what to say, or ask the owner.',
      };
    }
    const found = await this.activeLink({ linkId: input.linkId }, input.text);
    if (!('link' in found)) return found;
    const { link, text } = found;
    const counterpart = counterpartLabel(link.counterpartDisplayName, link.counterpartEmail);
    const replyTo = input.replyTo?.trim() || undefined;

    let recent: string[] = [];
    try {
      recent = this.deps.recentPeople(input.fromSession);
    } catch {
      recent = [];
    }
    const verdict = classifySharedSend(text, { recentPeople: recent });
    if (verdict.verdict === 'refused') {
      const why = describeFindings(verdict.findings, 'refused');
      this.record({
        actor: { type: 'agent', id: input.fromSession },
        action: SHARED_SEND_ACTIONS.REFUSED,
        target: { type: 'shared_channel', id: link.linkId, name: counterpart },
        after: { codes: verdict.findings.map((f) => f.code) },
        note: `a message to ${counterpart} was refused: ${why}`,
      });
      return {
        success: false,
        code: 'refused',
        linkId: link.linkId,
        counterpart,
        reasons: verdict.findings.map((f) => f.reason),
        error: `Not sent and cannot be approved: it contains ${why}, which never leaves this account. Rewrite it without that; if the owner wants it shared, he writes it himself in Team Chat.`,
      };
    }

    const identity = await this.deps.agentIdentity(input.fromSession).catch(() => ({ name: SHARED_CHANNEL_CONSTANTS.ORCHESTRATOR_SENDER_NAME }) as { name: string; team?: string });
    const approved = this.deps.trial.approvedCount(link.linkId);
    const inTrial = approved < SHARED_CHANNEL_CONSTANTS.TRIAL_HELD_SENDS;
    // The link's norm lets some hold reasons through (never refusals; the trial gate stays).
    const { allowed, remaining } = splitByNorm(verdict.findings, this.normOf(link.linkId).allow);
    const allowedCodes = allowed.map((f) => f.code);
    const allowedNote = allowed.length > 0 ? ` (the owner's norm allows ${describeFindings(allowed)})` : '';
    if (!inTrial && remaining.length === 0) {
      const sent = await this.deliver(
        { linkId: link.linkId, counterpart },
        { id: this.deps.newId(), text, fromAgentName: identity.name, ...(identity.team ? { fromTeam: identity.team } : {}), ...(replyTo ? { replyTo } : {}) },
      );
      if (sent.success) {
        this.record({
          actor: { type: 'agent', id: input.fromSession },
          action: SHARED_SEND_ACTIONS.SENT,
          target: { type: 'shared_channel', id: link.linkId, name: counterpart },
          after: { messageId: sent.messageId, by: input.fromSession, ...(allowedCodes.length ? { allowedByNorm: allowedCodes } : {}) },
          note: `${identity.name} wrote to ${counterpart}${allowedNote}`,
        });
        sent.note = `Sent to ${counterpart}${allowedNote}.`;
      }
      return sent;
    }

    // Held for the owner.
    const reasons = [
      ...(inTrial ? [`trial: the first ${SHARED_CHANNEL_CONSTANTS.TRIAL_HELD_SENDS} messages on a new link wait for the owner (${approved} approved so far)`] : []),
      ...remaining.map((f) => f.reason),
    ];
    const decisions = this.deps.decisions();
    if (!decisions) {
      return {
        success: false,
        code: 'cannot_hold',
        linkId: link.linkId,
        counterpart,
        reasons,
        error: 'This message needs the owner\'s approval, but owner cards are not available on this machine right now. Nothing was sent; ask the owner directly.',
      };
    }
    const open = await decisions.list('open').catch(() => [] as OwnerDecision[]);
    const same = open.find((d) => d.kind === 'shared_send' && d.sharedSend?.linkId === link.linkId && d.sharedSend.text === text);
    if (same) {
      return {
        success: true,
        status: 'held',
        linkId: link.linkId,
        counterpart,
        decisionId: same.id,
        messageId: same.sharedSend?.messageId,
        reasons,
        note: `This message is already waiting for the owner (card ${same.id}). Do not send it again.`,
      };
    }
    const subject: SharedSendSubject = {
      linkId: link.linkId,
      counterpart,
      messageId: this.deps.newId(),
      text,
      agentSession: input.fromSession,
      agentName: identity.name,
      fromTeam: identity.team ?? '',
      ...(replyTo ? { replyTo } : {}),
      reasons,
      trialOnly: inTrial && remaining.length === 0,
    };
    // "Send, always allow" only when every remaining hold reason can be allowed by a norm.
    const allowOnSend = subject.trialOnly ? null : allowancesCovering(remaining);
    if (allowOnSend) subject.allowOnSend = allowOnSend;
    const why = subject.trialOnly
      ? `New link: the first ${SHARED_CHANNEL_CONSTANTS.TRIAL_HELD_SENDS} messages wait for your OK (${approved} approved so far).`
      : `It may contain internal information: ${describeFindings(remaining)}.`;
    const normLine = allowed.length > 0 ? [`Your norm for ${counterpart} already allows ${describeFindings(allowed)}.`] : [];
    const options = [
      { key: SHARED_SEND_KEYS.SEND, label: 'Send', detail: `send it to ${counterpart} as written, once` },
      ...(allowOnSend
        ? [{
            key: SHARED_SEND_KEYS.SEND_ALLOW,
            label: 'Send, always allow',
            detail: clip(`send it, and from now on let ${describeAllowances(allowOnSend)} go to ${counterpart} without asking`, SHARED_CHANNEL_CONSTANTS.SEND_ALLOW_DETAIL_CHARS),
          }]
        : []),
      { key: SHARED_SEND_KEYS.DONT_SEND, label: "Don't send", detail: `nothing goes out; ${identity.name} is told` },
    ];
    const decision = await decisions.askPrebuilt({
      kind: 'shared_send',
      asker: input.fromSession,
      question: `Send ${identity.name}'s message to ${counterpart}? "${clip(text, SHARED_CHANNEL_CONSTANTS.SEND_QUESTION_EXCERPT_CHARS)}"`,
      options,
      defaultKey: SHARED_SEND_KEYS.DONT_SEND,
      yesKey: SHARED_SEND_KEYS.SEND,
      deadline: new Date((this.deps.now?.() ?? Date.now()) + SHARED_CHANNEL_CONSTANTS.SEND_DECISION_DEADLINE_MS),
      title: `Message to ${counterpart}`,
      body: [`> ${clip(text, SHARED_CHANNEL_CONSTANTS.SEND_PREVIEW_CHARS).replace(/\n/g, '\n> ')}`, why, ...normLine],
      sharedSend: subject,
    });
    this.record({
      actor: { type: 'agent', id: input.fromSession },
      action: SHARED_SEND_ACTIONS.HELD,
      target: { type: 'shared_channel', id: link.linkId, name: counterpart },
      after: {
        decisionId: decision.id,
        trialOnly: subject.trialOnly,
        codes: remaining.map((f) => f.code),
        ...(allowedCodes.length ? { allowedByNorm: allowedCodes } : {}),
      },
      note: `a message to ${counterpart} is waiting for the owner`,
    });
    this.deps.log?.info('Held a shared-channel message for the owner', { decisionId: decision.id, linkId: link.linkId, trialOnly: subject.trialOnly });
    return {
      success: true,
      status: 'held',
      linkId: link.linkId,
      counterpart,
      decisionId: decision.id,
      messageId: subject.messageId,
      reasons,
      note: `Held for the owner's approval (card ${decision.id}). Nothing is sent until he taps Send; you will be told. Do not send it another way.`,
    };
  }

  /**
   * A `shared_send` card settled: the only place a held message is sent from.
   *
   * @param decision - The settled decision
   * @returns Note for the orchestrator, or null (a withdrawn card)
   */
  async onSettled(decision: OwnerDecision): Promise<string | null> {
    const s = decision.sharedSend;
    if (!s) return null;
    const alsoAllow = decision.chosenKey === SHARED_SEND_KEYS.SEND_ALLOW;
    const sendChosen = decision.status === 'resolved' && (decision.chosenKey === SHARED_SEND_KEYS.SEND || alsoAllow);
    if (!sendChosen) {
      if (decision.status === 'cancelled') return null;
      this.record({
        actor: decisionActor(decision),
        action: SHARED_SEND_ACTIONS.DECLINED,
        target: { type: 'shared_channel', id: s.linkId, name: s.counterpart },
        after: { decisionId: decision.id, status: decision.status },
        note: `the message to ${s.counterpart} was not sent`,
      });
      const how = decision.status === 'resolved' || decision.status === 'skipped' ? 'The owner declined' : 'The owner did not answer in time about';
      return `[EXTERNAL] ${how} your message to ${s.counterpart} (card ${decision.id}); it was NOT sent. Do not send it another way. If ${s.counterpart} is waiting, tell them only what the owner allows.`;
    }
    const result = await this.deliver(
      { linkId: s.linkId, counterpart: s.counterpart },
      { id: s.messageId, text: s.text, fromAgentName: s.agentName, ...(s.fromTeam ? { fromTeam: s.fromTeam } : {}), ...(s.replyTo ? { replyTo: s.replyTo } : {}) },
    ).catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) }) as SharedSendResult);
    if (!result.success) {
      this.deps.log?.warn('Owner approved a shared-channel message but it could not be sent', { decisionId: decision.id, error: result.error });
      return `[EXTERNAL] The owner approved your message to ${s.counterpart} (card ${decision.id}), but it could not be sent: ${result.error}. Tell the owner.`;
    }
    const count = this.deps.trial.noteApproved(s.linkId);
    this.record({
      actor: decisionActor(decision),
      action: SHARED_SEND_ACTIONS.SENT,
      target: { type: 'shared_channel', id: s.linkId, name: s.counterpart },
      after: { messageId: result.messageId, by: s.agentSession, decisionId: decision.id, approvedOnLink: count },
      note: `the owner approved ${s.agentName}'s message to ${s.counterpart}`,
    });
    const left = SHARED_CHANNEL_CONSTANTS.TRIAL_HELD_SENDS - count;
    const trialNote = left > 0 ? ` ${left} more of your messages on this link will wait for the owner.` : '';
    const normNote = alsoAllow ? this.allowFromCard(decision, s) : '';
    return `[EXTERNAL] The owner approved your message to ${s.counterpart}; it is sent.${normNote}${trialNote}`;
  }

  /**
   * "Send, always allow": add the card's allowances to the link's norm and log it.
   *
   * @param decision - The settled decision
   * @param s - Its held message
   * @returns A sentence for the orchestrator ('' when nothing was added)
   */
  private allowFromCard(decision: OwnerDecision, s: SharedSendSubject): string {
    const keys = normalizeAllowances(s.allowOnSend ?? []);
    if (keys.length === 0 || !this.deps.norms) return '';
    try {
      const { before, after } = this.deps.norms.addAllowances(s.linkId, keys);
      this.record({
        actor: decisionActor(decision),
        action: SHARED_NORM_ACTIONS.UPDATED,
        target: { type: 'shared_channel', id: s.linkId, name: s.counterpart },
        before: { allow: before.allow },
        after: { allow: after.allow, decisionId: decision.id },
        note: `the owner allowed ${describeAllowances(keys)} for ${s.counterpart} from a held message`,
      });
      return ` From now on ${describeAllowances(keys)} may go to ${s.counterpart} without his approval (after the trial).`;
    } catch (err) {
      this.deps.log?.warn('Could not save the allowance the owner chose on a shared-send card', { decisionId: decision.id, error: err instanceof Error ? err.message : String(err) });
      return ' His "always allow" could not be saved, so such messages will still wait for him.';
    }
  }
}
