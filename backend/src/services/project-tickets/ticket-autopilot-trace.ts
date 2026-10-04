/**
 * Ticket autopilot tracing (specs/2026-10-03-autopilot-experiments.md §1).
 *
 * - The **run trace**: one `autopilot` root per project per local day,
 *   tagged `autopilot: {projectId, day}`, holding every autopilot step as an
 *   `autopilot.action` event (triage, goal replan, listed tickets, skips with
 *   a reason, budget pause / resume, picks, claims, dispatches, retro).
 * - **Ticket traces**: when work starts on a ticket of a project whose
 *   autopilot is on, the ticket runs in a trace tagged with the project and
 *   the start day plus the ticket's labels; its WorkItem carries that trace,
 *   and every later status change is a `ticket.status` event in it.
 *
 * Every function here is fire-and-forget: it catches its own errors and
 * never throws, so tracing can never break the autopilot or a ticket write.
 *
 * @module services/project-tickets/ticket-autopilot-trace
 */

import * as path from 'path';
import { getTraceContext } from '../trace/trace-context.service.js';
import type { TraceActor, TraceOutcome } from '../trace/trace.types.js';
import { resolveTicketAutopilotSettings, type TicketAutopilotSettings } from '../../types/ticket-autopilot.types.js';
import type { ProjectTicketStatus } from '../../types/project-ticket.types.js';
import { localDateKey } from './ticket-autopilot-decision.js';

/** Every autopilot step recorded in a run trace (`data.action`). */
export const AUTOPILOT_ACTIONS = [
  'triage',
  'triage_ticket',
  'replan',
  'skip',
  'budget_paused',
  'budget_resumed',
  'pick',
  'cancel',
  'claim',
  'dispatch',
  'retro_scheduled',
  'retro_filed',
  'retro_gap_ticket',
] as const;
/** One autopilot step. */
export type AutopilotAction = (typeof AUTOPILOT_ACTIONS)[number];

/** The part of a project the tracing needs. */
export interface AutopilotTraceProject {
  id: string;
  name: string;
  ticketAutopilot?: Partial<TicketAutopilotSettings> | null;
}

/** Input of {@link traceAutopilotAction}. */
export interface AutopilotActionInput {
  /** One English line */
  summary: string;
  outcome?: TraceOutcome;
  ticketId?: string;
  workItemId?: string;
  /** Agent the step concerns (driver, claimer, assignee) */
  session?: string;
  /** Who did it (default: the system) */
  actor?: TraceActor;
  data?: Record<string, unknown>;
  /** Also record the step in this trace (a ticket's) */
  alsoTraceId?: string | null;
  /** Start the day's run trace when there is none yet (default true; a skip alone never starts one) */
  create?: boolean;
  /** Record into this run trace instead of the one of `now`'s day */
  runTraceId?: string | null;
  now?: Date;
}

/** Non-agent actors written in ticket Log lines. */
const SYSTEM_ACTORS: ReadonlySet<string> = new Set(['crewly', 'system', 'experiments', 'autopilot', 'v1-migration']);

/**
 * Run a hook, swallowing any error.
 *
 * @param fn - Body
 * @param fallback - Value on error
 * @returns The body's value, or the fallback
 */
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * The index key of a project's run on a day.
 *
 * @param projectId - Project id
 * @param day - Local date (YYYY-MM-DD)
 * @returns `<projectId>:<day>`
 */
export function autopilotRunKey(projectId: string, day: string): string {
  return `${projectId}:${day}`;
}

/**
 * The index key of a ticket's autopilot trace.
 *
 * @param projectId - Project id
 * @param ticketId - Ticket id
 * @returns `<projectId>:<ticketId>`
 */
export function autopilotTicketKey(projectId: string, ticketId: string): string {
  return `${projectId}:${ticketId}`;
}

/**
 * Who a ticket Log actor is.
 *
 * @param actor - `owner`, a session, or a system label
 * @returns Trace actor
 */
export function ticketActor(actor: string | undefined): TraceActor {
  if (!actor || SYSTEM_ACTORS.has(actor)) return { kind: 'system' };
  if (actor === 'owner') return { kind: 'owner' };
  return { kind: 'agent', session: actor };
}

/**
 * The run trace of a project for a local day, started (and tagged) on first use.
 *
 * @param project - Project id and name
 * @param now - Clock (its local date is the run's day)
 * @param create - Start it when missing (default true)
 * @returns Trace id, or null
 */
export function autopilotRunTrace(project: Pick<AutopilotTraceProject, 'id' | 'name'>, now: Date = new Date(), create = true): string | null {
  return safely(() => {
    const ctx = getTraceContext();
    const day = localDateKey(now);
    const key = autopilotRunKey(project.id, day);
    const existing = ctx.store.traceByRef('autopilotRun', key);
    if (existing || !create) return existing;
    const traceId = ctx.startTrace({
      kind: 'autopilot',
      summary: `Autopilot run: ${project.name} ${day}`,
      actor: { kind: 'system' },
      refs: {},
      now,
    });
    if (!traceId) return null;
    ctx.store.linkRef('autopilotRun', key, traceId);
    ctx.store.tag(traceId, { autopilot: { projectId: project.id, day } });
    return traceId;
  }, null);
}

/**
 * Record one autopilot step in the project's run trace of the day (and,
 * when given, in a ticket's trace too).
 *
 * @param project - Project id and name
 * @param action - The step
 * @param input - Summary, refs, data
 * @returns The run trace id, or null
 */
export function traceAutopilotAction(project: Pick<AutopilotTraceProject, 'id' | 'name'>, action: AutopilotAction, input: AutopilotActionInput): string | null {
  return safely(() => {
    const now = input.now ?? new Date();
    const runTrace = input.runTraceId !== undefined ? input.runTraceId : autopilotRunTrace(project, now, input.create ?? true);
    const ctx = getTraceContext();
    const refs = {
      ...(input.ticketId ? { ticketId: input.ticketId } : {}),
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      ...(input.session ? { session: input.session } : {}),
    };
    const data = { action, projectId: project.id, ...(input.data ?? {}) };
    for (const traceId of new Set([runTrace, input.alsoTraceId].filter((t): t is string => !!t))) {
      ctx.record({
        traceId,
        type: 'autopilot.action',
        actor: input.actor ?? { kind: 'system' },
        summary: input.summary,
        outcome: input.outcome ?? 'info',
        refs,
        data,
        at: now,
      });
    }
    return runTrace;
  }, null);
}

/**
 * A new trace for one triage turn, tagged with the project and day: the
 * driver's turn (its calls, usage) stays out of the run trace's event cap.
 *
 * @param project - Project id and name
 * @param ticketCount - Tickets listed
 * @param now - Clock
 * @returns Trace id, or null
 */
export function startTriageTrace(project: Pick<AutopilotTraceProject, 'id' | 'name'>, ticketCount: number, now: Date = new Date()): string | null {
  return safely(() => {
    const ctx = getTraceContext();
    const day = localDateKey(now);
    const traceId = ctx.startTrace({
      kind: 'triage',
      summary: `Triage: ${project.name} ${day} (${ticketCount} ticket${ticketCount === 1 ? '' : 's'})`,
      actor: { kind: 'system' },
      refs: {},
      now,
    });
    if (traceId) ctx.store.tag(traceId, { autopilot: { projectId: project.id, day } });
    return traceId;
  }, null);
}

/**
 * A new trace for one goal-replan turn (specs/2026-10-04-autopilot-goal-replan.md),
 * tagged with the project and day. Same `triage` root kind as a triage turn:
 * autopilot bookkeeping, not a ticket's work.
 *
 * @param project - Project id and name
 * @param now - Clock
 * @returns Trace id, or null
 */
export function startReplanTrace(project: Pick<AutopilotTraceProject, 'id' | 'name'>, now: Date = new Date()): string | null {
  return safely(() => {
    const ctx = getTraceContext();
    const day = localDateKey(now);
    const traceId = ctx.startTrace({
      kind: 'triage',
      summary: `Goal replan: ${project.name} ${day}`,
      actor: { kind: 'system' },
      refs: {},
      now,
    });
    if (traceId) ctx.store.tag(traceId, { autopilot: { projectId: project.id, day } });
    return traceId;
  }, null);
}

/**
 * Work is about to start on a ticket (`startWork`: AutoClaim, claim,
 * assign). When the project's autopilot is on, the ticket runs in a trace
 * tagged with the project and the start day plus its labels. Reuses the
 * ticket's earlier autopilot trace, else its Request / ticket trace, else
 * starts a `ticket` root. A ticket linked to a broader trace (e.g. the owner
 * conversation that created it) gets its own root, so its numbers are its
 * own. Call before the WorkItem enters the pool and put the id on it; record
 * the start with {@link traceAutopilotTicketStarted} once it succeeded.
 *
 * @param project - The project (its stored autopilot settings decide)
 * @param ticket - Ticket id, title, labels
 * @param opts - Assignee, whether it is a self-claim, who started it
 * @returns The trace id for the ticket's WorkItem, or null (autopilot off / no trace)
 */
export function autopilotTicketTraceForStart(
  project: AutopilotTraceProject,
  ticket: { id: string; title: string; labels?: string[] },
  opts: { assignee: string; self: boolean; actor?: string; now?: Date },
): string | null {
  return safely(() => {
    if (!resolveTicketAutopilotSettings(project.ticketAutopilot).enabled) return null;
    const ctx = getTraceContext();
    const store = ctx.store;
    const now = opts.now ?? new Date();
    const key = autopilotTicketKey(project.id, ticket.id);
    let traceId = store.traceByRef('autopilotTicket', key);
    if (!traceId) {
      const linked = store.traceByRef('ticket', ticket.id);
      const entry = linked ? store.getEntry(linked) : null;
      const own =
        !!entry &&
        (entry.root.kind === 'request' || entry.root.kind === 'ticket') &&
        (!entry.tags?.autopilot || entry.tags.autopilot.projectId === project.id);
      traceId = own
        ? linked
        : ctx.startTrace({
            kind: 'ticket',
            summary: `${ticket.id}: ${ticket.title}`,
            actor: opts.self ? { kind: 'agent', session: opts.assignee } : ticketActor(opts.actor),
            refs: { ticketId: ticket.id },
            now,
          });
      if (!traceId) return null;
      store.linkRef('autopilotTicket', key, traceId);
      store.linkRef('ticket', ticket.id, traceId);
    }
    store.tag(traceId, { autopilot: { projectId: project.id, day: localDateKey(now) }, labels: ticket.labels ?? [] });
    return traceId;
  }, null);
}

/**
 * Work started on a ticket of an autopilot project: record the claim /
 * dispatch in the ticket's trace and in the day's run trace.
 *
 * @param project - The project
 * @param ticket - Ticket id, title, labels
 * @param opts - Assignee, self-claim or not, who started it, the WorkItem, the ticket's trace
 */
export function traceAutopilotTicketStarted(
  project: AutopilotTraceProject,
  ticket: { id: string; title: string; labels?: string[] },
  opts: { assignee: string; self: boolean; actor?: string; workItemId?: string; traceId: string; now?: Date },
): void {
  safely(() => {
    traceAutopilotAction(project, opts.self ? 'claim' : 'dispatch', {
      summary: opts.self
        ? `${opts.assignee} claimed ${ticket.id}: ${ticket.title}`
        : `${ticket.id} assigned to ${opts.assignee}${opts.actor ? ` by ${opts.actor}` : ''}: ${ticket.title}`,
      outcome: 'ok',
      ticketId: ticket.id,
      ...(opts.workItemId ? { workItemId: opts.workItemId } : {}),
      session: opts.assignee,
      actor: opts.self ? { kind: 'agent', session: opts.assignee } : ticketActor(opts.actor),
      data: { labels: (ticket.labels ?? []).join(',') },
      alsoTraceId: opts.traceId,
      ...(opts.now ? { now: opts.now } : {}),
    });
  }, undefined);
}

/** A ticket write the listener sees (status and / or labels changed). */
export interface AutopilotTicketChange {
  projectPath: string;
  ticket: { id: string; title: string; status: ProjectTicketStatus; labels: string[]; assignee: string | null; workItemId: string | null };
  before: { status: ProjectTicketStatus; labels: string[] };
  actor: string;
}

/** Outcome of a ticket status in its trace. */
const TICKET_STATUS_OUTCOME: Partial<Record<ProjectTicketStatus, TraceOutcome>> = {
  done: 'ok',
  cancelled: 'skipped',
  review: 'queued',
};

/**
 * Record a ticket write: `ticket.status` (and new labels) in the ticket's
 * autopilot trace, and `pick` / `cancel` in the run trace when a lead or the
 * orchestrator readies or cancels a ticket of an autopilot project.
 *
 * @param project - The ticket's project (null when unknown)
 * @param change - What changed
 * @param now - Clock
 */
export function traceAutopilotTicketChange(project: AutopilotTraceProject | null, change: AutopilotTicketChange, now: Date = new Date()): void {
  safely(() => {
    if (!project) return;
    const ctx = getTraceContext();
    const { ticket, before } = change;
    const traceId = ctx.store.traceByRef('autopilotTicket', autopilotTicketKey(project.id, ticket.id));
    if (traceId) {
      const added = ticket.labels.filter((l) => !before.labels.includes(l));
      if (added.length > 0) ctx.store.tag(traceId, { labels: added });
      if (ticket.status !== before.status) {
        ctx.record({
          traceId,
          type: 'ticket.status',
          actor: ticketActor(change.actor),
          summary: `Ticket ${ticket.id} ${before.status} → ${ticket.status}: ${ticket.title}`,
          outcome: TICKET_STATUS_OUTCOME[ticket.status] ?? 'info',
          refs: { ticketId: ticket.id, ...(ticket.assignee ? { session: ticket.assignee } : {}), ...(ticket.workItemId ? { workItemId: ticket.workItemId } : {}) },
          data: { from: before.status, to: ticket.status, projectId: project.id },
          at: now,
        });
      }
    }
    if (ticket.status === before.status || !resolveTicketAutopilotSettings(project.ticketAutopilot).enabled) return;
    const actor = ticketActor(change.actor);
    if (actor.kind !== 'agent') return;
    if (ticket.status === 'ready') {
      traceAutopilotAction(project, 'pick', {
        summary: `${change.actor} made ${ticket.id} ready: ${ticket.title}`,
        outcome: 'ok',
        ticketId: ticket.id,
        session: change.actor,
        actor,
        data: { from: before.status, labels: ticket.labels.join(',') },
        now,
      });
    } else if (ticket.status === 'cancelled') {
      traceAutopilotAction(project, 'cancel', {
        summary: `${change.actor} cancelled ${ticket.id}: ${ticket.title}`,
        outcome: 'skipped',
        ticketId: ticket.id,
        session: change.actor,
        actor,
        data: { from: before.status, labels: ticket.labels.join(',') },
        now,
      });
    }
  }, undefined);
}

/**
 * Listener for {@link ProjectTicketService.onChange}: resolves the ticket's
 * project by path, then {@link traceAutopilotTicketChange}.
 *
 * @param getProjects - Project list (StorageService)
 * @param now - Clock
 * @returns The listener (never throws, never awaited by the ticket write)
 */
export function createAutopilotTicketListener(
  getProjects: () => Promise<Array<AutopilotTraceProject & { path: string }>>,
  now: () => Date = () => new Date(),
): (change: AutopilotTicketChange) => void {
  return (change) => {
    void (async () => {
      try {
        const projects = await getProjects();
        const wanted = path.resolve(change.projectPath);
        const project = projects.find((p) => !!p.path && path.resolve(p.path) === wanted) ?? null;
        traceAutopilotTicketChange(project, change, now());
      } catch {
        // Tracing never affects a ticket write.
      }
    })();
  };
}
