/**
 * What the harness last prompted each agent about
 * (specs/2026-10-02-harness-owned-routing.md §4).
 *
 * A `[FOLLOW-UP TKT-187]` or `[DECISION D-12]` prompt names the ticket /
 * decision / work item the agent should answer about. When the agent then
 * runs `reply "<text>"` with no ids, the reply follows that reference rather
 * than whichever work item happens to be the newest running one (an
 * unrelated cron item put Owen's TKT-187 delivery top-level, 2026-10-02).
 *
 * In-memory: a restart forgets it, and the resolver falls back to the turn
 * origin — the prompts also print the exact command with the reference.
 *
 * @module services/orc/agent-prompt-reference.service
 */

import { REPLY_ROUTING_CONSTANTS } from '../../constants.js';

/** A reference an agent's reply can name (see reply-destination-resolver). */
export interface ReplyReference {
  /** chat-v2 message id the agent is answering */
  messageId?: string;
  /** Request ticket (`TKT-187`) or project ticket (`CE-7`) */
  ticket?: string;
  /** Work item id */
  workItemId?: string;
  /** Owner decision id (`D-12`) */
  decisionId?: string;
}

/** A recorded prompt reference. */
export interface PromptReference {
  reference: ReplyReference;
  /** Epoch ms the prompt was delivered */
  at: number;
}

/**
 * Whether a reference names anything.
 *
 * @param ref - Reference
 * @returns True when at least one id is set
 */
export function hasReference(ref: ReplyReference | undefined | null): ref is ReplyReference {
  return !!ref && !!(ref.messageId || ref.ticket || ref.workItemId || ref.decisionId);
}

/**
 * Per-agent registry of the last harness prompt's reference.
 */
export class AgentPromptReferenceService {
  private static instance: AgentPromptReferenceService | null = null;
  private readonly refs = new Map<string, PromptReference>();

  /**
   * @param now - Clock (tests)
   */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** @returns The process-wide instance */
  static getInstance(): AgentPromptReferenceService {
    if (!AgentPromptReferenceService.instance) AgentPromptReferenceService.instance = new AgentPromptReferenceService();
    return AgentPromptReferenceService.instance;
  }

  /** Reset the singleton (tests). */
  static resetInstance(): void {
    AgentPromptReferenceService.instance = null;
  }

  /**
   * Record that the harness just prompted `session` about `reference`.
   *
   * @param session - Agent session
   * @param reference - What the prompt was about
   */
  note(session: string, reference: ReplyReference): void {
    if (!session || !hasReference(reference)) return;
    this.refs.set(session, { reference: { ...reference }, at: this.now() });
  }

  /**
   * The agent's last prompt reference while it is fresh.
   *
   * @param session - Agent session
   * @returns The reference, or undefined (none / expired)
   */
  get(session: string): PromptReference | undefined {
    const r = this.refs.get(session);
    if (!r) return undefined;
    if (this.now() - r.at > REPLY_ROUTING_CONSTANTS.PROMPT_REFERENCE_FRESH_MS) {
      this.refs.delete(session);
      return undefined;
    }
    return r;
  }

  /**
   * Forget the agent's reference (it was answered).
   *
   * @param session - Agent session
   */
  clear(session: string): void {
    this.refs.delete(session);
  }
}
