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
export type DecisionSensitiveKind = 'email' | 'publish' | 'deploy' | 'spend' | 'browser_action';

/**
 * Decisions Crewly asks on an agent's behalf (not through ask-owner). The
 * kind's handler (see `DecisionService.registerKindHandler`) acts on the
 * answer and writes the note the agent gets.
 */
export type DecisionKind = 'browser_action';

/** The held browser action a `browser_action` decision is about. */
export interface BrowserActionSubject {
  /** Agent whose action is held */
  agentSession: string;
  /** Display name ("Vera") */
  agentName: string;
  /** `PendingConfirmation.id` in the browser session service */
  pendingId: string;
  /** "visa.careerengine.us/subscribe", when known */
  where?: string;
  /** What it wants to do, e.g. `click "Submit"` */
  target: string;
  /** Why it was held ("submitting") */
  matched: string;
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
  | 'cancelled'
  /** The thing asked about no longer exists (e.g. a held browser action lost to a restart) */
  | 'expired';

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
  /** Set for decisions Crewly asks itself (see {@link DecisionKind}) */
  kind?: DecisionKind;
  /** The held browser action (kind `browser_action`) */
  browser?: BrowserActionSubject;
  /** Option a plain "yes" / ✅ means (default: the default option, else the first) */
  yesKey?: string;
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
