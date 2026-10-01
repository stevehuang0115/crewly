/**
 * Owner decisions ("Waiting on you") — mirrors `backend/src/types/decision.types.ts`
 * (specs/2026-10-01-decision-cards.md §8).
 *
 * @module types/decision.types
 */

/** Sensitive asks are never auto-applied at the deadline. */
export type DecisionSensitiveKind = 'email' | 'publish' | 'deploy' | 'spend' | 'browser_action';

/** One answer the owner can pick. */
export interface DecisionOption {
  /** Stable key (`a`, `b`, `c`) */
  key: string;
  /** Short label (button text) */
  label: string;
  /** Optional one-line detail */
  detail?: string;
}

/** Lifecycle of a decision. */
export type DecisionStatus = 'open' | 'resolved' | 'defaulted' | 'parked' | 'cancelled' | 'expired';

/** How an answer arrived. */
export type DecisionAnswerVia = 'button' | 'reaction' | 'reply' | 'dashboard' | 'deadline';

/** Where the card lives in Slack. */
export interface DecisionCardRef {
  slackChannelId: string;
  messageTs: string;
  threadTs?: string;
  postedBy: string;
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
  requestedBy: string;
  /** Agent session that asks (its bot posted the card) */
  asker: string;
  ticket?: { projectId: string; projectPath: string; projectName?: string; id: string; title: string };
  teamId?: string;
  workItemId?: string;
  status: DecisionStatus;
  card?: DecisionCardRef;
  postError?: string;
  createdAt: string;
  updatedAt: string;
  remindAt?: string;
  reaskedAt?: string;
  chosenKey?: string;
  answerText?: string;
  answeredBy?: string;
  answeredVia?: DecisionAnswerVia;
  resolvedAt?: string;
}

/** Error from the decisions API. */
export class DecisionApiError extends Error {
  /**
   * @param message - Server error text
   * @param status - HTTP status
   */
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'DecisionApiError';
  }
}
