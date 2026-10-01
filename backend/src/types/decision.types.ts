/**
 * Decision cards — structured owner questions (specs/2026-10-01-decision-cards.md).
 *
 * An agent that needs the owner asks ONE question with 2–3 options, a default
 * and a deadline. The responsible agent's own Slack bot posts it as a card in
 * the team channel (ticket thread, or a new thread), and the owner answers
 * with a button, a reaction or a thread reply. The decision is stored here
 * until it is resolved, applied at its deadline, or parked.
 *
 * @module types/decision.types
 */

/** Sensitive asks are never auto-applied at the deadline. */
export type DecisionSensitiveKind = 'email' | 'publish' | 'deploy' | 'spend' | 'runtime_terms';

/**
 * A decision the harness itself asks (not an agent): posted from this
 * machine's orc bot in the owner's DM, handled by a backend listener, never
 * delivered to an agent. specs/2026-10-01-runtime-terms-consent.md
 */
export interface DecisionSystemRef {
  /** What the harness does with the answer */
  kind: 'runtime_terms';
  /** Subject within the kind (the runtime id) */
  key: string;
  /**
   * The default is the declining option, so it IS applied at the deadline
   * even when the decision is sensitive (declining is always safe).
   */
  defaultIsDecline?: boolean;
}

/** One answer the owner can pick. */
export interface DecisionOption {
  /** Stable key (`a`, `b`, `c`) carried in the button value */
  key: string;
  /** Short label (button text) */
  label: string;
  /** Optional one-line detail shown under the question */
  detail?: string;
}

/** Lifecycle of a decision. */
export type DecisionStatus =
  /** Card posted (or waiting to be posted), no answer yet */
  | 'open'
  /** The owner chose an option (button, reaction, reply, dashboard) */
  | 'resolved'
  /** The deadline passed and the default was applied */
  | 'defaulted'
  /** Sensitive ask with no answer after the re-ask: nothing happens until the owner reopens it */
  | 'parked'
  /** Withdrawn by the asking agent (or its ticket closed) */
  | 'cancelled';

/** How an answer arrived. */
export type DecisionAnswerVia = 'button' | 'reaction' | 'reply' | 'dashboard' | 'deadline';

/** Where the card lives in Slack. */
export interface DecisionCardRef {
  slackChannelId: string;
  /** The card message's own ts */
  messageTs: string;
  /** Thread the card was posted in (undefined = the card is the thread root) */
  threadTs?: string;
  /** Session whose bot posted it (`crewly` = the shared bot) */
  postedBy: string;
  /** True when the agent's own bot token was used */
  ownBot: boolean;
}

/** A pending or settled owner decision. */
export interface OwnerDecision {
  /** `D-<n>` */
  id: string;
  question: string;
  options: DecisionOption[];
  /** An option key, or `wait` */
  defaultKey: string;
  /** ISO deadline */
  deadline: string;
  sensitive?: DecisionSensitiveKind;
  /** Session that called ask-owner */
  requestedBy: string;
  /** Session that owns the question (assignee / lead / the caller) — its bot posts and it gets the answer */
  asker: string;
  /** Ticket the question belongs to */
  ticket?: { projectId: string; projectPath: string; projectName?: string; id: string; title: string };
  /** Team whose channel carries the card */
  teamId?: string;
  /** Work item the asker was on when it asked */
  workItemId?: string;
  /** Harness-owned decision (owner DM, backend listener) */
  system?: DecisionSystemRef;
  /** Card header instead of "Decision D-n" (system decisions) */
  title?: string;
  /** Extra mrkdwn sections shown under the question (system decisions) */
  body?: string[];
  status: DecisionStatus;
  card?: DecisionCardRef;
  /** Why the card could not be posted (shown in the dashboard; retried on the next tick) */
  postError?: string;
  createdAt: string;
  updatedAt: string;
  /** "Remind me tomorrow": when to remind */
  remindAt?: string;
  /** When the sensitive re-ask was posted */
  reaskedAt?: string;
  /** `wait` default: when the "no answer by the deadline — still waiting" notice was posted */
  deadlineNoticeAt?: string;
  /** Settlement */
  chosenKey?: string;
  /** Free-text answer, when the owner replied with words that matched no option */
  answerText?: string;
  answeredBy?: string;
  answeredVia?: DecisionAnswerVia;
  resolvedAt?: string;
}

/** Input of ask-owner (skill / API). */
export interface AskOwnerInput {
  question?: unknown;
  /** `[{label, detail?}]`, or `["Label", "Label — detail"]` */
  options?: unknown;
  /** An option label/key/number, or `wait` */
  default?: unknown;
  /** ISO time, or omitted (next day 12:00 local) */
  deadline?: unknown;
  sensitive?: unknown;
  /** Ticket id (with `project`) */
  ticket?: unknown;
  project?: unknown;
}

/** A validated ask. */
export interface ValidatedAsk {
  question: string;
  options: DecisionOption[];
  defaultKey: string;
  deadline: Date;
  sensitive?: DecisionSensitiveKind;
  ticketId?: string;
  project?: string;
}

/** Button `value` JSON (also read by Cloud: only `i`). */
export interface DecisionButtonValue {
  /** Decision id */
  d: string;
  /** Option key, or `remind` */
  o: string;
  /** Instance id the card belongs to (Cloud routes the click there) */
  i: string;
}

/** A click / reaction / reply normalised for {@link OwnerDecision} resolution. */
export type DecisionChoice =
  | { kind: 'option'; key: string }
  | { kind: 'remind' }
  | { kind: 'text'; text: string };
