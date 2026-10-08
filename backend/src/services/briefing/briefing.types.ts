/**
 * Drive mode briefing types (specs/2026-10-08-drive-mode.md).
 *
 * The briefing is the owner's queue of things waiting on them on this
 * machine, read out one at a time by the voice briefer on the phone. Every
 * item says who it is from, a short line to speak, the details for a
 * follow-up question, what the owner can answer and where the answer goes.
 *
 * @module services/briefing/briefing.types
 */

/** Where an item comes from. */
export type BriefingItemKind =
  /** An open owner decision card (`D-<n>`) */
  | 'decision'
  /** A question an agent asked the owner in a reply, not turned into a card */
  | 'question'
  /** Finished work handed back for the owner's OK (ticket in 待验收) */
  | 'review';

/** How soon the owner should hear it. Lower sorts first. */
export type BriefingUrgency = 'high' | 'normal' | 'low';

/** One answer the owner can give. */
export interface BriefingOption {
  /** Key to pass as `optionKey` */
  key: string;
  /** Label to speak */
  label: string;
  /** Extra detail, when the card has one */
  detail?: string;
}

/** Where an answer (or a follow-up question) goes. */
export type BriefingAnswerTarget =
  | { kind: 'decision'; decisionId: string }
  | { kind: 'thread'; channelId: string; threadId?: string; agentSession: string }
  | { kind: 'ticket'; ticketId: string; tkt?: string };

/** A question the owner asked about an item that the agent is looking up. */
export interface BriefingLookup {
  question: string;
  /** ISO — when it was handed to the agent */
  askedAt: string;
  /** chat-v2 channel the question was posted in (the agent answers there) */
  channelId: string;
  threadId?: string;
}

/** One item in the briefing queue. */
export interface BriefingItem {
  /** `d:D-7`, `q:<requestId>:<itemId>`, `t:<requestId>` */
  id: string;
  kind: BriefingItemKind;
  urgency: BriefingUrgency;
  /** Agent session that is waiting */
  agentSession: string;
  /** Display name ("Ella") */
  agentName: string;
  teamName?: string;
  /** One short, speech-friendly line (no URLs, no markdown) */
  summary: string;
  /** Everything known, plain text, for follow-up questions */
  details: string;
  options: BriefingOption[];
  /** Words are accepted as an answer (not just an option) */
  acceptsText: boolean;
  /** The answer needs a spoken confirmation first (deploy / money / delete / email) */
  sensitive: boolean;
  /** Why it is sensitive, when it is */
  sensitiveReason?: string;
  answerTarget: BriefingAnswerTarget;
  /** ISO — when the agent started waiting */
  since: string;
  /** ISO — the card's deadline / when silence accepts the ticket */
  deadline?: string;
  /** It came back because the owner asked to be reminded */
  reminder?: boolean;
  /** The agent answered the owner's follow-up question (read this first) */
  lookupAnswer?: { question: string; answer: string; at: string };
}

/** `GET /api/briefing` */
export interface BriefingQueue {
  items: BriefingItem[];
  /** Items waiting on an agent's lookup (not in `items`) */
  lookupsPending: Array<{ id: string; agentName: string; question: string; askedAt: string }>;
  /** Items hidden by "next" or "later" (not in `items`) */
  hidden: number;
  generatedAt: string;
}

/** Body of `POST /api/briefing/:id/answer`. */
export interface BriefingAnswerInput {
  /** An option key (or label) */
  optionKey?: string;
  /** The owner's words */
  text?: string;
  /** Second call for a sensitive item, after the owner said yes */
  confirm?: boolean;
  /** Token from the first call's `needs_confirmation` answer */
  confirmToken?: string;
}

/** What an action did. */
export type BriefingActionResult =
  | { status: 'done'; itemId: string; spoken: string }
  | { status: 'needs_confirmation'; itemId: string; confirmToken: string; confirmQuestion: string; spoken: string }
  | { status: 'lookup_pending'; itemId: string; handedTo: string; details: string; spoken: string }
  | { status: 'hidden'; itemId: string; until: string; spoken: string };

/** Persisted per-item state (snoozes, passes, lookups). */
export interface BriefingItemState {
  /** Hidden until (ISO): "next" or "later" */
  hiddenUntil?: string;
  /** Set when hidden by "later" (comes back flagged as a reminder) */
  later?: boolean;
  lookup?: BriefingLookup;
  /** The agent's answer to the lookup, once found */
  lookupAnswer?: { question: string; answer: string; at: string };
  /**
   * ISO — answered by voice into a conversation (questions): kept out of the
   * queue until the open item itself closes and the state is pruned
   */
  answeredAt?: string;
}

/** The state file. */
export interface BriefingStateFile {
  version: 1;
  items: Record<string, BriefingItemState>;
}

/** A briefing failure with an HTTP status and code. */
export class BriefingError extends Error {
  /**
   * @param status - HTTP status
   * @param code - Machine-readable code
   * @param message - Owner-readable message
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BriefingError';
  }
}
