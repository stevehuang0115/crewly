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

  // Distinguish "wrong wording" from "this channel records nothing" (issue
  // #730). When the window holds ZERO owner messages, the owner is almost
  // certainly talking on a surface that never persists `sender_type='user'`
  // rows — a bare orchestrator session with no `[CHAT:…]` wrapper. There, no
  // phrasing can ever satisfy the gate, and the generic "no such message
  // found" text sends both orc and owner into a pointless retry loop hunting
  // for the magic word.
  //
  // The lookup deliberately stays chat-only: the guard's whole value is that
  // the orchestrator cannot forge the evidence, and a session transcript is
  // something the orchestrator writes. Widening the search would hand it the
  // forgery it was built to prevent (2026-06-02 incident) — so we fix the
  // diagnosis, not the trust boundary.
  if (recentOwnerMessages.length === 0) {
    return {
      allowed: false,
      reason:
        'Cold-launching a dormant team requires an explicit owner approval, and ' +
        'NO owner chat messages at all were recorded in the lookback window. This ' +
        'is a channel problem, not a wording problem: approval must be given on a ' +
        'surface that records owner messages (Slack, or the Chat UI). Approving ' +
        'from a raw orchestrator session cannot satisfy this gate no matter how ' +
        'it is phrased — the guard reads the owner\'s real chat history precisely ' +
        'so the orchestrator cannot fabricate it. Ask the owner to send the ' +
        'approval (启动/批准/go ahead/do it/proceed/approved) in Slack or the Chat UI.',
    };
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

// ---------------------------------------------------------------------------
// Pre-authorized schedule exemption (cron / trigger)
// ---------------------------------------------------------------------------
//
// WHY: a wake driven by a CRON job or a TRIGGER the owner configured is already
// authorized — the owner set up the schedule, which is a durable, explicit
// "run this on this cadence" approval. The commitment gate (which demands a
// fresh "启动/go" in chat) would otherwise block ALL scheduled autonomy on a
// dormant team: a 3am cron with the owner asleep would sit blocked forever.
// That defeats the purpose of scheduling. So scheduled-origin wakes are exempt.
//
// SECURITY: the orchestrator can fabricate WorkItem fields, so we must NOT
// trust a WI that merely *claims* `source: 'cron'`. The exemption is honored
// ONLY when the claimed cron task / trigger id resolves to a REAL entry in the
// scheduler registry — which the orc cannot fabricate (same principle as the
// gate keying off the owner's real chat history). A forged claim whose id does
// not resolve is NOT exempt and falls through to the normal gate.

/** A minimal view of a WorkItem — only the fields the exemption needs. */
export interface GuardWorkItem {
  /** WorkItem type, e.g. 'cron_run' for scheduled runs. */
  type?: string;
  /** Trigger id, set when an event/time trigger created/woke the WorkItem. */
  triggerId?: string;
  /** Extensible metadata; cron runs carry `source:'cron'` + `cronTaskId`. */
  metadata?: Record<string, unknown> | null;
}

/** A WorkItem's self-declared scheduled origin, pending registry verification. */
export interface ScheduleClaim {
  /** Which scheduler the WorkItem claims to originate from. */
  kind: 'cron' | 'trigger';
  /** The id to verify against the real scheduler registry (unfakeable check). */
  refId: string;
}

/**
 * Extracts a WorkItem's claimed scheduled origin, if any.
 *
 * Returns the backing cron-task / trigger id that the CALLER must then verify
 * against the real scheduler registry. Returns null when the WorkItem makes no
 * verifiable scheduled-origin claim (e.g. a `cron_run` with no `cronTaskId`, or
 * an ordinary delegate WorkItem) — such items get no exemption.
 *
 * @param wi - The WorkItem that triggered the wake.
 * @returns The schedule claim to verify, or null if none.
 */
export function extractScheduleClaim(wi: GuardWorkItem): ScheduleClaim | null {
  const md = wi.metadata ?? undefined;
  const source = md && typeof md.source === 'string' ? (md.source as string) : undefined;

  // Cron-origin: a cron_run WorkItem (or one tagged source:'cron') must carry
  // the backing cron task id so it can be verified. No id → not verifiable → no claim.
  if (wi.type === 'cron_run' || source === 'cron') {
    const cronTaskId = md && typeof md.cronTaskId === 'string' ? (md.cronTaskId as string) : '';
    if (cronTaskId) return { kind: 'cron', refId: cronTaskId };
  }

  // Trigger-origin: a WorkItem woken by an event/time trigger carries triggerId.
  if (typeof wi.triggerId === 'string' && wi.triggerId) {
    return { kind: 'trigger', refId: wi.triggerId };
  }

  return null;
}

/**
 * Decides whether a wake is pre-authorized by a real owner-configured schedule.
 *
 * The decision is the whole exemption logic, made unit-testable by injecting the
 * registry lookups: a claim is honored ONLY when its id resolves in the real
 * scheduler, so a forged `source:'cron'` claim with a non-existent id is
 * rejected and falls through to the commitment gate.
 *
 * @param wi - The WorkItem that triggered the wake (may be null).
 * @param registry - Lookups against the REAL scheduler registry.
 * @param registry.cronTaskExists - Resolves true iff the cron task id is registered.
 * @param registry.triggerExists - True iff the trigger id is registered.
 * @returns True when the wake should bypass the commitment gate.
 */
export async function isPreAuthorizedSchedule(
  wi: GuardWorkItem | null | undefined,
  registry: {
    cronTaskExists: (id: string) => Promise<boolean>;
    triggerExists: (id: string) => boolean;
  },
): Promise<boolean> {
  if (!wi) return false;
  const claim = extractScheduleClaim(wi);
  if (!claim) return false;
  if (claim.kind === 'cron') return registry.cronTaskExists(claim.refId);
  return registry.triggerExists(claim.refId);
}
