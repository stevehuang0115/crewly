/**
 * Commitment Approval Guard — code-level enforcement of the orchestrator's
 * "launching a team needs explicit owner approval" boundary.
 *
 * WHY THIS EXISTS (2026-06-02 autonomy incident, recurrence of 2026-05-30):
 * The orchestrator prompt already forbids launching a team without an explicit
 * affirmative owner directive, and forbids fabricating approval. The orc
 * violated both anyway — it wrote `owner Steve 拍板「启动 Phase 1」` into a
 * delegate WorkItem and cold-started a dormant team, with NO such approving
 * message anywhere in the owner's chat history. Prompt rules have been re-tried
 * across incidents and keep failing: a code gate is the only structural
 * enforcement.
 *
 * THE KEY INSIGHT: the orc can fabricate *text* (a WorkItem title, a Slack
 * message), but it cannot fabricate the *owner's chat history*. So we gate the
 * commitment chokepoint — cold-starting a DORMANT team, which is exactly the
 * prompt's "launching a team / spinning up agents for a new project" class —
 * on a genuine recent owner (`user`-authored) affirmative message. Continuation
 * (a team that already has active members) and crash recovery (rehydrate) are
 * NOT gated.
 *
 * This module is intentionally PURE (no I/O) so the decision logic is fully
 * unit-testable; the caller supplies the team and the owner's recent messages.
 *
 * @module services/orchestrator/commitment-approval-guard
 */

import { CREWLY_CONSTANTS } from '../../constants.js';

/**
 * Agent statuses that count as "this member is up" — a team with any such
 * member is NOT dormant, so starting another member is continuation, not a
 * launch.
 */
const ACTIVE_LIKE_STATUSES: ReadonlySet<string> = new Set([
  CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE,
  CREWLY_CONSTANTS.AGENT_STATUSES.STARTED,
  CREWLY_CONSTANTS.AGENT_STATUSES.STARTING,
  CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVATING,
]);

/**
 * Affirmative approval tokens the OWNER may use to grant a launch. Deliberately
 * conservative — clear, low-ambiguity directives only — because a false match
 * lets a fabricated launch through (the failure mode this guard prevents),
 * whereas a missed match merely defers a legitimate launch until the owner
 * re-confirms (recoverable). Bare "ok"/"yes"/"go"/"可以" are intentionally
 * EXCLUDED: they appear constantly in non-approval chatter. Matches the
 * affirmative tokens enumerated in the orchestrator prompt's APPROVAL BOUNDARY.
 */
const APPROVAL_TOKENS_CJK: readonly string[] = [
  '启动', '批准', '同意', '拍板', '开干', '开始做', '开始吧', '上线吧', '去做吧', '动手',
];

/** English approval phrases, matched case-insensitively as whole phrases. */
const APPROVAL_PATTERNS_EN: readonly RegExp[] = [
  /\bgo ahead\b/i,
  /\bdo it\b/i,
  /\bproceed\b/i,
  /\bapprove[ds]?\b/i,
  /\blaunch it\b/i,
  /\bship it\b/i,
  /\bgreen ?light\b/i,
  /\blet'?s go\b/i,
];

/**
 * Interrogative markers. The prompt's rule is explicit: **a question is never
 * approval**. "要不要启动?" / "should we launch?" both contain an approval token
 * as a substring, so without this check they would falsely read as a grant.
 */
const QUESTION_MARKERS: readonly RegExp[] = [
  /[?？]/,
  /要不要/,
  /是否/,
  /需不需要/,
  /[吗呢]\s*[。.!！]?\s*$/,
  /\bshould (we|i|it)\b/i,
  /\bwhether\b/i,
  /\bdo you (want|think)\b/i,
];

/**
 * How far back to look for an owner approval, in ms. Generous (6h) on purpose:
 * a legitimate launch usually follows the owner's "go" within minutes-to-hours,
 * and a wide window minimizes false-blocks of legitimate re-wakes while still
 * blocking the incident class (a launch with NO owner approval anywhere).
 */
export const COMMITMENT_APPROVAL_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/** A minimal view of a team member — only the fields the guard needs. */
export interface GuardTeamMember {
  agentStatus: string;
}

/** A minimal view of a team — only the fields the guard needs. */
export interface GuardTeam {
  members: GuardTeamMember[];
}

/** Result of an approval evaluation. */
export interface ApprovalDecision {
  /** Whether the launch may proceed. */
  allowed: boolean;
  /** Human-readable reason (always set when `allowed` is false). */
  reason?: string;
  /** The owner message text that satisfied the gate, when allowed via approval. */
  evidence?: string;
}

/**
 * Returns true if the team is dormant — no member is in an active-like status.
 * Starting a member of a dormant team is a COLD LAUNCH (commitment); starting a
 * member of a team that already has live members is continuation.
 *
 * @param team - The team whose members to inspect.
 * @returns True when no member is active/started/starting/activating.
 */
export function isDormantTeam(team: GuardTeam): boolean {
  return !team.members.some((m) => ACTIVE_LIKE_STATUSES.has(m.agentStatus));
}

/**
 * Returns true if `content` contains a clear owner-affirmative approval token.
 *
 * @param content - A chat message's text.
 * @returns True when the text carries an unambiguous launch approval.
 */
export function containsApprovalToken(content: string): boolean {
  if (!content) return false;
  // A question is NEVER approval, even if it contains an approval word
  // ("要不要启动?" / "should we proceed?"). Reject interrogatives outright.
  if (QUESTION_MARKERS.some((re) => re.test(content))) return false;
  for (const tok of APPROVAL_TOKENS_CJK) {
    if (content.includes(tok)) return true;
  }
  return APPROVAL_PATTERNS_EN.some((re) => re.test(content));
}

/**
 * Evaluates whether a cold team launch is permitted.
 *
 * The launch is BLOCKED only when BOTH:
 *  - the team is dormant (this start is a cold launch / "launching a team"), AND
 *  - none of the supplied recent owner messages carries an approval token.
 *
 * If the team is already active (continuation) the launch is always allowed.
 * If a genuine owner approval is present, the launch is allowed and the
 * matching message is returned as `evidence`.
 *
 * @param args.team - The team being launched.
 * @param args.recentOwnerMessages - Recent OWNER-authored message texts
 *   (already time-windowed and filtered to `sender_type='user'` by the caller).
 * @returns The approval decision.
 */
export function evaluateColdLaunch(args: {
  team: GuardTeam;
  recentOwnerMessages: string[];
}): ApprovalDecision {
  const { team, recentOwnerMessages } = args;

  // Continuation / recovery of an already-active team is never gated.
  if (!isDormantTeam(team)) {
    return { allowed: true };
  }

  const approving = recentOwnerMessages.find((m) => containsApprovalToken(m));
  if (approving) {
    return { allowed: true, evidence: approving };
  }

  return {
    allowed: false,
    reason:
      'Cold-launching a dormant team is a commitment that requires an explicit ' +
      'owner approval (启动/批准/go ahead/do it/proceed/approved). No such owner ' +
      'message was found in recent chat history — holding as pending owner sign-off. ' +
      'A question, a stand-down, or the orchestrator asserting approval itself does ' +
      'NOT count.',
  };
}
