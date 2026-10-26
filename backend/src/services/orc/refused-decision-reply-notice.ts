/**
 * Tell the team lead (then the orchestrator, then as a last resort the
 * owner's card thread with a plain line) when an agent's reply to an
 * owner-answered decision could not be delivered anywhere (CREW-372, fix 4 of
 * the CREW-335 research). Owner contact goes through the orchestrator; the
 * internal text (session names, errors) never reaches the owner's thread.
 *
 * In CREW-335 the refusal went only to the agent that had just run the command
 * that failed; the owner's answer then sat for 1h34m until a later [BLOCKED]
 * report. When every fallback for a `source=decision` reply has failed, one
 * notice names the decision, the agent and the step that failed. One per
 * decision per window.
 */

import { REFUSED_DECISION_REPLY_CONSTANTS } from '../../constants.js';

/** A decision as far as the notice cares. */
export interface NoticeDecision {
  status: string;
  /** Where its card lives, when it has one */
  card?: { slackChannelId: string; threadTs: string };
}

/** Collaborators of {@link noticeRefusedDecisionReply}. */
export interface RefusedReplyNoticeDeps {
  /** The decision by id, or null when unknown */
  decision(id: string): Promise<NoticeDecision | null>;
  /** The agent's team lead, or null */
  leadOf(agentSession: string): Promise<string | null>;
  /** Message an agent; true when taken */
  tell(toSession: string, text: string): Promise<boolean>;
  /** The orchestrator's session name */
  orchestrator: string;
  /** Post a plain line into a decision card's Slack thread (as the orchestrator, never as the agent); true when it landed */
  postToCard(card: { slackChannelId: string; threadTs: string }, text: string): Promise<boolean>;
  /** Clock (epoch ms) */
  now(): number;
}

/** What the notice did. */
export type RefusedReplyNoticeResult =
  | { sent: true; to: 'lead' | 'orchestrator' | 'card'; target: string }
  | { sent: false; reason: string };

/** When each decision was last noticed (rate limit). */
const noticedAt = new Map<string, number>();

/** Forget every rate-limit entry (tests). */
export function resetRefusedReplyNoticesForTesting(): void {
  noticedAt.clear();
}

/** Decisions the owner has answered (their asker is waiting on the reply). */
const ANSWERED_STATUSES: ReadonlySet<string> = new Set(['resolved', 'defaulted']);

/**
 * Send the one notice about a refused reply to an answered decision. Never
 * throws: a failed notice must not change what the agent is told.
 *
 * @param input - The decision, the agent, and the step that failed
 * @param deps - Collaborators
 * @returns Whom it told, or why it did not
 */
export async function noticeRefusedDecisionReply(
  input: { decisionId: string; agentSession: string; failedStep: string },
  deps: RefusedReplyNoticeDeps,
): Promise<RefusedReplyNoticeResult> {
  try {
    const decision = await deps.decision(input.decisionId);
    if (!decision) return { sent: false, reason: `decision ${input.decisionId} not found` };
    if (!ANSWERED_STATUSES.has(decision.status)) return { sent: false, reason: `decision ${input.decisionId} is ${decision.status}, not answered` };

    const now = deps.now();
    const prior = noticedAt.get(input.decisionId);
    if (prior !== undefined && now - prior < REFUSED_DECISION_REPLY_CONSTANTS.NOTICE_WINDOW_MS) {
      return { sent: false, reason: `already noticed ${input.decisionId} within the window` };
    }
    if (noticedAt.size >= REFUSED_DECISION_REPLY_CONSTANTS.MAX_TRACKED) {
      for (const [k, at] of noticedAt) if (now - at >= REFUSED_DECISION_REPLY_CONSTANTS.NOTICE_WINDOW_MS) noticedAt.delete(k);
    }

    const text =
      `[REPLY NOT DELIVERED] ${input.agentSession}'s reply to the owner's answer on decision ${input.decisionId} was refused and no fallback took it. ` +
      `The owner has answered, so the work behind it may be waiting. Failed step: ${input.failedStep} ` +
      `Check with ${input.agentSession} and get the reply (or the result) to the owner another way.`;

    const tried: string[] = [];
    const lead = await deps.leadOf(input.agentSession);
    if (lead && lead !== input.agentSession) {
      if (await deps.tell(lead, text)) {
        noticedAt.set(input.decisionId, now);
        return { sent: true, to: 'lead', target: lead };
      }
      tried.push(`${lead} could not be reached`);
    }
    if (deps.orchestrator !== input.agentSession && deps.orchestrator !== lead) {
      if (await deps.tell(deps.orchestrator, text)) {
        noticedAt.set(input.decisionId, now);
        return { sent: true, to: 'orchestrator', target: deps.orchestrator };
      }
      tried.push('the orchestrator could not be reached');
    }
    if (decision.card) {
      const plain = `Your answer on ${input.decisionId} was received, but the follow-up message did not get through; we are on it.`;
      if (await deps.postToCard(decision.card, plain)) {
        noticedAt.set(input.decisionId, now);
        return { sent: true, to: 'card', target: `${decision.card.slackChannelId}:${decision.card.threadTs}` };
      }
      tried.push('the card thread did not take it');
    }
    return { sent: false, reason: tried.length ? tried.join('; ') : 'no team lead, orchestrator or card thread to tell' };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
