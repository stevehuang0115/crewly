/**
 * Ticket → Slack thread map (specs/2026-10-01-decision-cards.md §2, §6).
 *
 * Each project ticket gets ONE Slack thread in its team channel: the first
 * decision card (or the first top-level post about it) becomes the thread
 * root, and every later card, answer and update for that ticket goes into
 * that thread. Stored under CREWLY_HOME (not in the project), keyed by the
 * project path and ticket id.
 *
 * @module services/decisions/ticket-thread-store
 */

import * as path from 'path';
import { DECISION_CONSTANTS } from '../../constants.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';

/** One ticket's thread. */
export interface TicketThread {
  slackChannelId: string;
  threadTs: string;
  teamId?: string;
  createdAt: string;
}

/** On-disk shape. */
interface TicketThreadFile {
  threads: Record<string, TicketThread>;
}

/**
 * The key of a ticket.
 *
 * @param projectPath - Absolute project root
 * @param ticketId - Ticket id (`APP-12`)
 * @returns `<projectPath>#<ticketId>`
 */
export function ticketThreadKey(projectPath: string, ticketId: string): string {
  return `${projectPath}#${ticketId}`;
}

/**
 * Persistent ticket → Slack thread map. All writes are serialised.
 */
export class TicketThreadStore {
  private data: TicketThreadFile | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param filePath - JSON file (default: `<crewlyHome>/ticket-slack-threads.json`)
   */
  constructor(private readonly filePath: string) {}

  /**
   * Store under a CREWLY_HOME.
   *
   * @param crewlyHome - CREWLY_HOME
   * @returns The store
   */
  static inHome(crewlyHome: string): TicketThreadStore {
    return new TicketThreadStore(path.join(crewlyHome, DECISION_CONSTANTS.TICKET_THREADS_FILENAME));
  }

  /**
   * The ticket's thread, when it has one.
   *
   * @param projectPath - Project root
   * @param ticketId - Ticket id
   * @returns The thread, or null
   */
  async get(projectPath: string, ticketId: string): Promise<TicketThread | null> {
    const data = await this.load();
    return data.threads[ticketThreadKey(projectPath, ticketId)] ?? null;
  }

  /**
   * Record the ticket's thread. An existing thread is kept (first one wins).
   *
   * @param projectPath - Project root
   * @param ticketId - Ticket id
   * @param thread - Channel + root ts (+ team)
   * @returns The thread now on record
   */
  async set(projectPath: string, ticketId: string, thread: Omit<TicketThread, 'createdAt'>): Promise<TicketThread> {
    return this.serial(async () => {
      const data = await this.load();
      const key = ticketThreadKey(projectPath, ticketId);
      const existing = data.threads[key];
      if (existing) return existing;
      const entry: TicketThread = { ...thread, createdAt: new Date().toISOString() };
      data.threads[key] = entry;
      await atomicWriteJson(this.filePath, data);
      return entry;
    });
  }

  /**
   * Find the ticket a Slack thread belongs to.
   *
   * @param slackChannelId - Channel
   * @param threadTs - Thread root ts
   * @returns `{ projectPath, ticketId }`, or null
   */
  async findByThread(slackChannelId: string, threadTs: string): Promise<{ projectPath: string; ticketId: string } | null> {
    const data = await this.load();
    for (const [key, t] of Object.entries(data.threads)) {
      if (t.slackChannelId !== slackChannelId || t.threadTs !== threadTs) continue;
      const at = key.lastIndexOf('#');
      return { projectPath: key.slice(0, at), ticketId: key.slice(at + 1) };
    }
    return null;
  }

  private async load(): Promise<TicketThreadFile> {
    if (this.data) return this.data;
    const raw = await safeReadJson<Partial<TicketThreadFile>>(this.filePath, {});
    this.data = { threads: raw.threads && typeof raw.threads === 'object' ? raw.threads : {} };
    return this.data;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

let instance: TicketThreadStore | null = null;

/**
 * Install the process-wide store (composition root / tests).
 *
 * @param store - Store or null
 */
export function setTicketThreadStore(store: TicketThreadStore | null): void {
  instance = store;
}

/**
 * The process-wide store, or null before wiring.
 *
 * @returns Store or null
 */
export function getTicketThreadStore(): TicketThreadStore | null {
  return instance;
}

/**
 * A link to a Slack message that opens in the owner's workspace
 * (`https://slack.com/archives/<channel>/p<ts without the dot>`).
 *
 * @param slackChannelId - Channel
 * @param ts - Message ts
 * @returns URL
 */
export function slackArchiveLink(slackChannelId: string, ts: string): string {
  return `https://slack.com/archives/${slackChannelId}/p${ts.replace('.', '')}`;
}
