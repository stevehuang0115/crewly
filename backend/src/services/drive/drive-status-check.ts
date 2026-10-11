/**
 * Drive mode "let me check with the teams" (owner feedback of 2026-10-10:
 * the briefing read out stale cached items).
 *
 * When a Drive session opens, Cloud pushes `op:'refresh'`. Instead of
 * reading what the last snapshot happened to say, this machine:
 *
 *  1. finds the agents that hold the owner's open items (cards, questions,
 *     finished work) and are running right now;
 *  2. asks each one to bring those items up to date: close what is done or
 *     shipped, leave a one-line current status on what is still open. The
 *     agents write to the source of truth (cards, tickets), not to the owner;
 *  3. waits a short, fixed time for them;
 *  4. rebuilds and uploads the status snapshot, so the voice reads fresh state.
 *
 * Stopped agents are not woken for this: their items are checked against
 * current state by the briefing queue itself (closed tickets, answered
 * threads, age). Nothing here is logged beyond counts.
 *
 * @module services/drive/drive-status-check
 */

import { DRIVE_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { clip } from '../briefing/briefing.utils.js';

const C = DRIVE_CONSTANTS;

/** An agent and the owner's open items it holds. */
export interface StatusCheckTarget {
  agentSession: string;
  agentName: string;
  /** One short line per open item */
  items: string[];
}

/** Collaborators. */
export interface DriveStatusCheckDeps {
  /** Agents holding the owner's open items (the live briefing queue, by agent) */
  targets: () => Promise<StatusCheckTarget[]>;
  /** Whether the agent's session runs right now (stopped ones are not woken) */
  isRunning: (agentSession: string) => boolean;
  /** Send the agent a harness note; true when delivered */
  nudge: (agentSession: string, text: string) => Promise<boolean>;
  /** Rebuild and upload the status snapshot now, caches dropped */
  rebuild: () => Promise<void>;
  /** Wait (default: setTimeout) */
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  maxAgents?: number;
  logger?: ComponentLogger;
}

/** What a check did. */
export interface StatusCheckOutcome {
  asked: number;
  skippedStopped: number;
}

/**
 * The note an agent gets. Written for the agent: it updates state, it does
 * not message the owner.
 *
 * @param items - The agent's open items, one line each
 * @returns Note text
 */
export function statusCheckText(items: readonly string[]): string {
  return [
    'The owner just opened Drive mode and will hear a status summary shortly. Before that, bring the state of your open items up to date:',
    ...items.map((i) => `- ${i}`),
    'For each one: if it is already done or shipped, close it the usual way (answer or resolve the card, report the work done, update its ticket). If it is still open, make sure its ticket or card says in one line where it stands right now.',
    'Do not message the owner and do not start new work for this. Be quick: the summary is built in a few seconds.',
  ].join('\n');
}

/** Asks the agents to refresh, then rebuilds the snapshot. */
export class DriveStatusCheck {
  private readonly logger: ComponentLogger;
  private running: Promise<StatusCheckOutcome> | null = null;

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: DriveStatusCheckDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('DriveStatusCheck');
  }

  /**
   * Run one check. Calls made while one runs share it. Never throws: a
   * failure still rebuilds the snapshot from what is on disk.
   *
   * @returns How many agents were asked
   */
  run(): Promise<StatusCheckOutcome> {
    if (!this.running) {
      this.running = this.runOnce().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runOnce(): Promise<StatusCheckOutcome> {
    const outcome: StatusCheckOutcome = { asked: 0, skippedStopped: 0 };
    try {
      const all = await this.deps.targets();
      const max = this.deps.maxAgents ?? C.STATUS_CHECK_MAX_AGENTS;
      const running = all.filter((t) => this.deps.isRunning(t.agentSession));
      outcome.skippedStopped = all.length - running.length;
      const chosen = [...running].sort((a, b) => b.items.length - a.items.length).slice(0, max);
      const sent = await Promise.all(
        chosen.map((t) =>
          this.deps
            .nudge(t.agentSession, statusCheckText(t.items.slice(0, C.STATUS_CHECK_MAX_ITEMS).map((i) => clip(i, 160))))
            .catch(() => false),
        ),
      );
      outcome.asked = sent.filter(Boolean).length;
      if (outcome.asked > 0) await (this.deps.sleep ?? defaultSleep)(this.deps.waitMs ?? C.STATUS_CHECK_WAIT_MS);
    } catch (error) {
      this.logger.warn('Drive status check: asking the agents failed', { error: error instanceof Error ? error.message : String(error) });
    }
    try {
      await this.deps.rebuild();
    } catch (error) {
      this.logger.warn('Drive status check: rebuild failed', { error: error instanceof Error ? error.message : String(error) });
    }
    this.logger.info('Drive status check done', { ...outcome });
    return outcome;
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
