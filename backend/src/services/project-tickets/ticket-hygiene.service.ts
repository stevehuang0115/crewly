/**
 * Ticket hygiene service — keeps project tickets honest.
 *
 * Two jobs, both cheap:
 *
 * 1. **Auto-reconcile (no agent).** Each sweep closes or advances tickets
 *    whose state is objectively settled (the linked WorkItem is verified /
 *    done) and flags tickets whose assignee or team no longer exists. Every
 *    change is logged and written to the ticket's Log with the reason
 *    `auto-reconcile`.
 * 2. **Stale review (one lead, once a day).** Open tickets with no activity
 *    past a threshold are batched into ONE WorkItem per team for the team lead
 *    (the orchestrator when the team has none) to close, cancel or annotate.
 *
 * Loop safety: at most one live review item per team, at most one batch per
 * team per day, a ticket is not re-sent within the cooldown, and the sweep's
 * own Log lines never count as ticket activity. Nothing here messages the owner.
 *
 * @module services/project-tickets/ticket-hygiene.service
 */

import * as path from 'path';
import { ORCHESTRATOR_SESSION_NAME, TICKET_HYGIENE_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { Team } from '../../types/index.js';
import { createWorkItem, MAX_BRIEF_MARKDOWN_BYTES, type WorkItem } from '../../types/v2/work-item.types.js';
import { readProjectTicketLink, type ProjectTicket } from '../../types/project-ticket.types.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { isTeamPausedNow } from '../team/team-pause.registry.js';
import type { ProjectTicketService } from './project-ticket.service.js';
import { LIVE_STATUSES, type ChainEnd, type ProjectTicketDirectory } from './project-ticket-workflow.service.js';
import {
  OPEN_TICKET_STATUSES,
  buildReviewBrief,
  orphanReason,
  selectReviewBatches,
  ticketKey,
  type HygieneTicket,
  type OrphanReason,
} from './ticket-hygiene.js';

const C = TICKET_HYGIENE_CONSTANTS;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The pool operations the service uses. */
export interface TicketHygienePool {
  getAllItems(): Promise<WorkItem[]>;
  addToPool(workItem: WorkItem): Promise<void>;
  cancelQueued(workItemId: string, reason: string): Promise<void>;
}

/** Dependencies (injectable for tests). */
export interface TicketHygieneDeps {
  tickets: Pick<ProjectTicketService, 'list' | 'mutate'>;
  pool: TicketHygienePool;
  directory: ProjectTicketDirectory;
  /** Follow a WorkItem to where its work stands (the workflow service's) */
  followChain: (workItemId: string) => Promise<ChainEnd>;
  /** Where the bookkeeping lives */
  stateFile: string;
  logger?: ComponentLogger;
  now?: () => Date;
}

/** Persisted bookkeeping. */
interface HygieneState {
  /** Team key → last review batch */
  teams: Record<string, { lastSentAt: number; workItemId: string }>;
  /** Ticket key → when it was last sent to a lead (ms) */
  sent: Record<string, number>;
}

/** One automatic change, as logged. */
export interface HygieneChange {
  projectId: string;
  ticketId: string;
  kind: 'closed' | 'advanced' | 'flagged' | 'unflagged';
  message: string;
}

/** What a run did. */
export interface HygieneRunResult {
  changes: HygieneChange[];
  /** Review items created (one per team) */
  reviewItems: Array<{ teamKey: string; target: string; workItemId: string; tickets: number }>;
}

export class TicketHygieneService {
  private static instance: TicketHygieneService | null = null;

  private readonly logger: ComponentLogger;
  private state: HygieneState | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  /**
   * @param deps - Ticket store, pool, directory, chain follower, state file
   */
  constructor(private readonly deps: TicketHygieneDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('TicketHygiene');
  }

  /** @returns The wired instance, or null */
  static getInstance(): TicketHygieneService | null {
    return TicketHygieneService.instance;
  }

  /** @param service - Instance to install (null clears) */
  static setInstance(service: TicketHygieneService | null): void {
    TicketHygieneService.instance = service;
  }

  /**
   * Start the periodic sweep: a first run a few minutes after boot, then every
   * {@link TICKET_HYGIENE_CONSTANTS.SWEEP_INTERVAL_MS}.
   *
   * @param intervalMs - Sweep interval (0 disables the timers)
   * @param firstDelayMs - Delay of the first run
   */
  start(intervalMs: number = C.SWEEP_INTERVAL_MS, firstDelayMs: number = C.FIRST_SWEEP_DELAY_MS): void {
    this.stop();
    if (intervalMs <= 0) return;
    const run = (): void => {
      void this.runOnce().catch((err) =>
        this.logger.warn('Ticket hygiene sweep failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) }),
      );
    };
    this.firstTimer = setTimeout(run, firstDelayMs);
    this.firstTimer.unref?.();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  /** Stop the timers. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = null;
    this.firstTimer = null;
  }

  /**
   * One sweep: reconcile settled / orphaned tickets, then queue today's lead
   * reviews. Safe to call at any time (a run already in progress is skipped).
   *
   * @returns What changed and which review items went out
   */
  async runOnce(): Promise<HygieneRunResult> {
    const result: HygieneRunResult = { changes: [], reviewItems: [] };
    if (this.running) return result;
    this.running = true;
    try {
      const [projects, teams] = await Promise.all([this.deps.directory.getProjects(), this.deps.directory.getTeams()]);
      const poolItems = await this.deps.pool.getAllItems().catch(() => [] as WorkItem[]);
      const nowMs = this.now().getTime();
      const all: HygieneTicket[] = [];
      const orphans = new Map<string, OrphanReason>();

      for (const project of projects) {
        let tickets: ProjectTicket[];
        try {
          tickets = (await this.deps.tickets.list(project.path)).tickets;
        } catch {
          continue;
        }
        for (const listed of tickets) {
          if (!OPEN_TICKET_STATUSES.has(listed.status)) continue;
          let t = listed;
          try {
            const settled = await this.reconcileSettled(project.id, t, poolItems);
            if (settled) {
              result.changes.push(settled.change);
              t = settled.ticket;
            }
            if (!OPEN_TICKET_STATUSES.has(t.status)) continue;
            const orphan = orphanReason(t, teams);
            if (orphan) orphans.set(ticketKey(project.path, t.id), orphan);
            const flag = await this.reconcileOrphanFlag(project.id, t, orphan);
            if (flag) {
              result.changes.push(flag.change);
              t = flag.ticket;
            }
          } catch (err) {
            this.logger.warn('Ticket hygiene could not reconcile a ticket', {
              projectId: project.id,
              ticketId: t.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          if (OPEN_TICKET_STATUSES.has(t.status)) all.push({ ...t, projectId: project.id, projectName: project.name, projectPath: project.path });
        }
      }

      result.reviewItems = await this.queueReviews(all, teams, orphans, nowMs);
      if (result.changes.length > 0 || result.reviewItems.length > 0) {
        this.logger.info('Ticket hygiene sweep done', { changes: result.changes.length, reviewItems: result.reviewItems.length });
      }
    } finally {
      this.running = false;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Auto-reconcile
  // ---------------------------------------------------------------------------

  /**
   * Close or advance an `in_progress` / `review` ticket whose linked work is
   * all verified / done, honouring the done gate: a ticket with `ownerReview`
   * lands in `review` (and stays there, waiting for the owner) instead of `done`.
   *
   * Only these two statuses are touched, so a person's move of a ticket back to
   * `ready` / `backlog` is never fought.
   *
   * @param projectId - Project id (for the log)
   * @param ticket - The ticket
   * @param poolItems - Pool snapshot
   * @returns The change, or null when nothing is settled
   */
  private async reconcileSettled(projectId: string, ticket: ProjectTicket, poolItems: WorkItem[]): Promise<{ change: HygieneChange; ticket: ProjectTicket } | null> {
    if (ticket.status !== 'in_progress' && ticket.status !== 'review') return null;
    if (ticket.status === 'review' && ticket.ownerReview) return null;
    const root = path.resolve(ticket.projectPath);
    const linked = poolItems.filter((wi) => {
      const link = readProjectTicketLink(wi.metadata);
      return !!link && link.id === ticket.id && path.resolve(link.projectPath) === root;
    });
    if (linked.some((wi) => LIVE_STATUSES.has(wi.status))) return null;

    let doneWi: WorkItem | null = null;
    if (ticket.workItemId) {
      const end = await this.deps.followChain(ticket.workItemId);
      if (end.kind === 'success') doneWi = end.wi;
    } else if (linked.length > 0 && linked.every((wi) => wi.status === 'verified' || wi.status === 'done')) {
      doneWi = linked[linked.length - 1];
    }
    if (!doneWi) return null;

    const to = ticket.ownerReview ? 'review' : 'done';
    if (to === ticket.status) return null;
    let message = '';
    const updated = await this.deps.tickets.mutate(ticket.projectPath, ticket.id, C.ACTOR, (t) => {
      // Re-checked under the lock: a person or the event sync may have moved it.
      if (t.status !== ticket.status) return null;
      message = `${t.status} → ${to} — ${C.REASON}: WorkItem ${doneWi!.id} is ${doneWi!.status}${to === 'review' ? ' (waiting for the owner)' : ''}`;
      return { fields: { status: to, workItemId: doneWi!.id }, log: [message] };
    });
    if (!message) return null;
    this.logger.info(`Ticket ${ticket.id} moved ${ticket.status} → ${to} (${C.REASON}: WorkItem ${doneWi.id} is ${doneWi.status})`, { projectId, ticketId: ticket.id });
    return { change: { projectId, ticketId: ticket.id, kind: to === 'done' ? 'closed' : 'advanced', message }, ticket: updated };
  }

  /**
   * Keep the `orphaned` label in step with whether the assignee / team still
   * exist. Bookkeeping only: `updatedAt` is left alone so a flag never makes a
   * stale ticket look fresh.
   *
   * @param projectId - Project id (for the log)
   * @param ticket - The ticket
   * @param orphan - Missing parts, or null
   * @returns The change, or null when the label already matches
   */
  private async reconcileOrphanFlag(projectId: string, ticket: ProjectTicket, orphan: OrphanReason | null): Promise<{ change: HygieneChange; ticket: ProjectTicket } | null> {
    const has = ticket.labels.includes(C.ORPHAN_LABEL);
    if (!!orphan === has) return null;
    let message = '';
    const updated = await this.deps.tickets.mutate(ticket.projectPath, ticket.id, C.ACTOR, (t) => {
      const nowHas = t.labels.includes(C.ORPHAN_LABEL);
      if (nowHas === !!orphan) return null;
      if (orphan) {
        const what = [orphan.assignee ? `assignee ${orphan.assignee}` : '', orphan.team ? `team ${orphan.team}` : ''].filter(Boolean).join(' and ');
        message = `flagged ${C.ORPHAN_LABEL} — ${C.REASON}: ${what} no longer exists`;
        return { fields: { labels: [...t.labels, C.ORPHAN_LABEL] }, log: [message], keepUpdatedAt: true };
      }
      message = `${C.ORPHAN_LABEL} flag cleared — ${C.REASON}: assignee and team exist again`;
      return { fields: { labels: t.labels.filter((l) => l !== C.ORPHAN_LABEL) }, log: [message], keepUpdatedAt: true };
    });
    if (!message) return null;
    this.logger.info(`Ticket ${ticket.id}: ${message}`, { projectId, ticketId: ticket.id });
    return { change: { projectId, ticketId: ticket.id, kind: orphan ? 'flagged' : 'unflagged', message }, ticket: updated };
  }

  // ---------------------------------------------------------------------------
  // Stale review
  // ---------------------------------------------------------------------------

  /**
   * Send today's batches: one WorkItem per team that has stale tickets, no
   * more than one per team per day, none while a previous one is still live.
   *
   * @param tickets - Open tickets after reconcile
   * @param teams - All teams
   * @param orphans - Orphaned tickets
   * @param nowMs - Clock
   * @returns The items created
   */
  private async queueReviews(
    tickets: HygieneTicket[],
    teams: Team[],
    orphans: ReadonlyMap<string, OrphanReason>,
    nowMs: number,
  ): Promise<HygieneRunResult['reviewItems']> {
    const state = await this.loadState();
    this.pruneSent(state, nowMs);
    const skipTeamIds = new Set(teams.filter((t) => isTeamPausedNow(t, nowMs)).map((t) => t.id));
    const batches = selectReviewBatches({ tickets, teams, nowMs, sentAt: state.sent, orphans, skipTeamIds });
    const out: HygieneRunResult['reviewItems'] = [];
    if (batches.length === 0) {
      await this.saveState();
      return out;
    }
    const poolItems = await this.deps.pool.getAllItems().catch(() => [] as WorkItem[]);

    for (const batch of batches) {
      const last = state.teams[batch.key]?.lastSentAt;
      if (last !== undefined && nowMs - last < C.REVIEW_INTERVAL_MS) continue;

      // A previous batch still live? Wait for it — unless nobody ever picked it up.
      let live = false;
      for (const wi of poolItems) {
        if (wi.metadata?.kind !== C.REVIEW_METADATA_KIND || wi.metadata?.teamKey !== batch.key || !LIVE_STATUSES.has(wi.status)) continue;
        const age = nowMs - (Date.parse(wi.createdAt) || nowMs);
        if (wi.status === 'queued' && age >= C.REVIEW_STALE_QUEUED_MS) {
          await this.deps.pool.cancelQueued(wi.id, 'ticket review never picked up; replaced by a fresh one').catch(() => undefined);
          this.logger.info('Stale ticket review cancelled', { teamKey: batch.key, workItemId: wi.id });
          continue;
        }
        live = true;
      }
      if (live) continue;

      const n = batch.candidates.length;
      const toOrc = batch.target === ORCHESTRATOR_SESSION_NAME;
      const workItem = createWorkItem({
        type: C.REVIEW_WORK_ITEM_TYPE,
        owner: toOrc ? 'orchestrator' : 'team_lead',
        target: batch.target,
        title: `Ticket review: ${batch.teamName} (${n} stale ticket${n === 1 ? '' : 's'})`,
        description: `Close, cancel or update ${n} ticket${n === 1 ? '' : 's'} of ${batch.teamName} that had no activity for a while.`,
        briefMarkdown: capBrief(buildReviewBrief(batch)),
        metadata: {
          kind: C.REVIEW_METADATA_KIND,
          teamKey: batch.key,
          teamId: batch.teamId,
          requiresVerification: false,
          tickets: batch.candidates.map((c) => ({ projectId: c.ticket.projectId, id: c.ticket.id })),
        },
      });
      workItem.createdAt = new Date(nowMs).toISOString();
      workItem.targetSource = 'assigned';
      try {
        await this.deps.pool.addToPool(workItem);
      } catch (err) {
        this.logger.warn('Could not queue the ticket review', { teamKey: batch.key, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      state.teams[batch.key] = { lastSentAt: nowMs, workItemId: workItem.id };
      for (const c of batch.candidates) state.sent[ticketKey(c.ticket.projectPath, c.ticket.id)] = nowMs;
      await this.saveState();
      this.logger.info(`Ticket review for ${batch.teamName} sent to ${batch.target}: ${n} ticket(s)`, {
        teamKey: batch.key,
        workItemId: workItem.id,
        tickets: batch.candidates.map((c) => c.ticket.id),
      });
      out.push({ teamKey: batch.key, target: batch.target, workItemId: workItem.id, tickets: n });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private pruneSent(state: HygieneState, nowMs: number): void {
    const cutoff = nowMs - C.STATE_RETENTION_DAYS * DAY_MS;
    for (const [k, at] of Object.entries(state.sent)) if (at < cutoff) delete state.sent[k];
  }

  private async loadState(): Promise<HygieneState> {
    if (this.state) return this.state;
    const raw = await safeReadJson<Partial<HygieneState>>(this.deps.stateFile, {});
    this.state = {
      teams: raw.teams && typeof raw.teams === 'object' ? raw.teams : {},
      sent: raw.sent && typeof raw.sent === 'object' ? raw.sent : {},
    };
    return this.state;
  }

  private async saveState(): Promise<void> {
    if (!this.state) return;
    try {
      await atomicWriteJson(this.deps.stateFile, this.state);
    } catch (err) {
      this.logger.warn('Could not save ticket hygiene state', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Keep a brief within the WorkItem brief budget.
 *
 * @param text - Markdown
 * @returns Text within the budget
 */
function capBrief(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_BRIEF_MARKDOWN_BYTES) return text;
  let out = text.slice(0, MAX_BRIEF_MARKDOWN_BYTES);
  while (Buffer.byteLength(out, 'utf8') > MAX_BRIEF_MARKDOWN_BYTES - 64) out = out.slice(0, -64);
  return `${out}\n\n…(truncated — list the tickets with project-tickets)`;
}
