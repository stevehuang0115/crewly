/**
 * Project Tickets Controller — HTTP handlers for a project's own backlog
 * (specs/2026-09-28-project-tickets.md §6).
 *
 * `:project` is a project id, name, or URL-encoded absolute path. The caller
 * is the `X-Agent-Session` header; no header = the owner. Every mutation is a
 * POST so the Cloud relay (GET/POST only) can carry it.
 *
 * @module controllers/project-tickets/project-tickets.controller
 */

import { getSpendCapService } from '../../services/spend/spend-cap.service.js';
import type { Request, Response } from 'express';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { isOwnerCaller, OwnerAuthRequiredError, ownerAuthRequiredBody } from '../../middleware/caller-identity.middleware.js';
import { ProjectTicketError, ProjectTicketService } from '../../services/project-tickets/project-ticket.service.js';
import {
  ProjectTicketWorkflowService,
  type ProjectTicketCaller,
} from '../../services/project-tickets/project-ticket-workflow.service.js';
import { migrateV1Tasks } from '../../services/project-tickets/v1-task-migration.js';
import { TaskPoolService } from '../../services/task-pool/task-pool.service.js';
import { StorageService } from '../../services/core/storage.service.js';
import { isProjectTicketStatus } from '../../types/project-ticket.types.js';
import { TicketAutopilotService, type AutopilotRetroDeps, type OwnerNotice } from '../../services/project-tickets/ticket-autopilot.service.js';
import { goalChangedAt, openExperimentsOf, readProjectGoal } from '../../services/project-tickets/ticket-autopilot-goal.js';
import { applyRetroGapDecision } from '../../services/project-tickets/ticket-autopilot-retro.js';
import { ExperimentService } from '../../services/experiments/experiment.service.js';
import { WikiIngestService } from '../../services/wiki/wiki-ingest.service.js';
import { resolveProjectDataDir } from '../../services/core/crewly-home.utils.js';
import { existsSync } from 'fs';
import { TokenUsageService } from '../../services/monitoring/token-usage.service.js';
import { getCrewlyHomePath } from '../../services/core/crewly-home.utils.js';
import { TICKET_AUTOPILOT_CONSTANTS } from '../../constants.js';
import { createHttpAssigneeWaker } from '../../services/project-tickets/ticket-assignee-waker.js';
import { getRoleService } from '../../services/settings/role.service.js';
import { DecisionError, DecisionService } from '../../services/decisions/decision.service.js';
import { getTicketThreadStore, slackArchiveLink } from '../../services/decisions/ticket-thread-store.js';
import { defaultLeadShareDigest } from '../../services/tl-delegation/lead-share.wiring.js';
import * as path from 'path';

/**
 * The wired workflow service; builds the default one from the process
 * singletons when boot has not installed it yet.
 *
 * @returns Workflow service
 */
export function projectTicketWorkflow(): ProjectTicketWorkflowService {
  let wf = ProjectTicketWorkflowService.getInstance();
  if (!wf) {
    wf = new ProjectTicketWorkflowService({
      tickets: ProjectTicketService.getInstance(),
      pool: TaskPoolService.getInstance(),
      directory: StorageService.getInstance(),
      // A stopped assignee is started through the normal member-start path.
      wakeAssignee: createHttpAssigneeWaker(),
    });
    ProjectTicketWorkflowService.setInstance(wf);
  }
  return wf;
}

/**
 * Build the ticket autopilot from the process singletons.
 *
 * @param notifyOwner - Owner notification path (boot passes the Slack owner
 *   DM); the default reports "not sent", so notices wait for the wired one
 * @returns A new service (not installed)
 */
export function createDefaultTicketAutopilot(
  notifyOwner: (notice: OwnerNotice) => Promise<boolean> = async () => false,
): TicketAutopilotService {
  return new TicketAutopilotService({
    tickets: ProjectTicketService.getInstance(),
    pool: TaskPoolService.getInstance(),
    directory: StorageService.getInstance(),
    workflow: projectTicketWorkflow(),
    ledger: TokenUsageService.getInstance(),
    // The same usage boosts the token caps use (team / everyone boosts).
    boosts: (teamIds) => getSpendCapService()?.boostForTeams(teamIds) ?? { extra: 0, unlimited: false },
    notifyOwner,
    stateFile: path.join(getCrewlyHomePath(), TICKET_AUTOPILOT_CONSTANTS.STATE_FILENAME),
    roleDescription: async (role) => (await getRoleService().getRoleByName(role))?.description ?? null,
    // The digest links waiting tickets to their decision-card thread.
    cardLinkOf: async (projectPath, ticketId) => {
      const thread = await getTicketThreadStore()?.get(projectPath, ticketId);
      return thread ? slackArchiveLink(thread.slackChannelId, thread.threadTs) : null;
    },
    // The daily retro is on by default while an autopilot experiment runs
    // (specs/2026-10-03-autopilot-experiments.md §4).
    runningExperiment: async (projectId) =>
      ((await ExperimentService.getInstance()?.list({ status: 'running' })) ?? []).some((e) => e.autopilot?.projectId === projectId),
    retro: createAutopilotRetroDeps(),
    // Goal replan (specs/2026-10-04-autopilot-goal-replan.md): the project's
    // goals log + active project OKRs, and its open experiment cards.
    goalOf: (project, now) => readProjectGoal(project, now),
    goalChangedAt: (project) => goalChangedAt(project),
    openExperiments: async (project) => openExperimentsOf((await ExperimentService.getInstance()?.list()) ?? [], project),
    // Lead share of team tokens in the evening digest (crewly#1083).
    leadShareDigest: (now) => defaultLeadShareDigest(now),
  });
}

/**
 * The retro's side effects from the process singletons: the project wiki,
 * harness-gap tickets on the Crewly project, and the owner's approval card.
 *
 * @returns Retro dependencies
 */
export function createAutopilotRetroDeps(): AutopilotRetroDeps {
  const tickets = ProjectTicketService.getInstance();
  return {
    writeWiki: async (projectPath, relativePath, markdown, by) => {
      const vaultPath = path.join(resolveProjectDataDir(projectPath), 'wiki');
      if (!existsSync(path.join(vaultPath, 'SCHEMA.md'))) return false;
      const outcome = await WikiIngestService.getInstance().ingest({
        vaultPath,
        sourceType: 'autopilot_retro',
        sourceRef: relativePath,
        sourceBody: markdown,
        callerSession: by,
        targetRelativePath: relativePath,
        title: path.basename(relativePath, '.md'),
        summary: 'Daily ticket-autopilot retro: what shipped, where it stalled and why.',
        replace: true,
      });
      return outcome.ok;
    },
    harnessProject: async () => {
      const wanted = TICKET_AUTOPILOT_CONSTANTS.RETRO_HARNESS_PROJECT.toLowerCase();
      return (await StorageService.getInstance().getProjects()).find((p) => p.name.toLowerCase() === wanted) ?? null;
    },
    createTicket: async (project, input) => {
      const t = await tickets.create(project.path, project.name, { ...input, status: 'backlog' }, 'autopilot');
      return { id: t.id, title: t.title };
    },
    applyGapDecision: (projectPath, id, approve, note) => applyRetroGapDecision(tickets, projectPath, id, approve, note),
    askOwner: async (input) => {
      const decisions = DecisionService.getInstance();
      if (!decisions) throw new Error('Decision cards are not running');
      return decisions.askSystem({
        kind: 'retro_harness_gaps',
        system: { key: input.key, defaultIsDecline: true },
        title: input.title,
        question: input.question,
        body: input.body,
        options: [`${input.approveLabel} — they go to the team as ready tickets`, `${input.skipLabel} — cancel them`],
        default: input.skipLabel,
        deadline: input.deadline,
      });
    },
  };
}

/**
 * The wired ticket autopilot; builds (and installs) a default one when boot
 * has not, so the settings API works even with the tick switched off.
 *
 * @returns Autopilot service
 */
export function ticketAutopilot(): TicketAutopilotService {
  let svc = TicketAutopilotService.getInstance();
  if (!svc) {
    svc = createDefaultTicketAutopilot();
    TicketAutopilotService.setInstance(svc);
  }
  return svc;
}

/**
 * The caller of a request. `{}` (owner rights) only for an owner credential
 * (#999) — a caller that merely left out X-Agent-Session is not the owner.
 *
 * @param req - Request
 * @returns `{ session }` for an agent, `{}` for the owner
 * @throws OwnerAuthRequiredError with no owner credential and no agent identity
 */
function callerOf(req: Request): ProjectTicketCaller {
  if (isOwnerCaller(req)) return {};
  const session = readAgentSessionHeader(req);
  if (session) return { session };
  throw new OwnerAuthRequiredError(ownerAuthRequiredBody(req));
}

/**
 * First value of a query parameter.
 *
 * @param value - Raw value
 * @returns Trimmed string or undefined
 */
function q(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Run a handler body, mapping errors to HTTP answers.
 *
 * @param res - Response
 * @param body - Produces the `data` payload
 */
async function respond(res: Response, body: () => Promise<unknown>): Promise<void> {
  try {
    res.json({ success: true, data: await body() });
  } catch (err) {
    if (err instanceof OwnerAuthRequiredError) {
      res.status(401).json(err.body);
      return;
    }
    if (err instanceof ProjectTicketError) {
      res.status(err.status).json({ success: false, error: err.message });
      return;
    }
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Read a status from a body, or fail with 400.
 *
 * @param value - Raw status
 * @returns The status
 * @throws ProjectTicketError(400)
 */
function requireStatus(value: unknown): Parameters<ProjectTicketWorkflowService['transition']>[2] {
  if (!isProjectTicketStatus(value)) throw new ProjectTicketError(400, `Unknown status: ${String(value)}`);
  return value;
}

/**
 * GET /api/project-tickets?session=&status= — tickets of every project the
 * session's teams work on (the calling agent's by default). Without any
 * session (the owner) it lists every project.
 *
 * @param req - Request
 * @param res - `{ success, data: [{ project, tickets }] }`
 */
export async function listMyProjectTickets(req: Request, res: Response): Promise<void> {
  await respond(res, async () => {
    const wf = projectTicketWorkflow();
    const session = q(req.query.session) ?? readAgentSessionHeader(req);
    const status = q(req.query.status);
    if (session) return wf.listForSession(session, { status });
    const projects = await StorageService.getInstance().getProjects();
    const out = [];
    for (const p of projects) {
      const { tickets } = await wf.list(p.id, { status });
      out.push({ project: { id: p.id, name: p.name, path: p.path }, tickets });
    }
    return out;
  });
}

/**
 * GET /api/project-tickets/:project?status=&assignee=&label=
 *
 * @param req - Request
 * @param res - `{ success, data: { project, tickets, invalid } }`
 */
export async function listProjectTickets(req: Request, res: Response): Promise<void> {
  await respond(res, async () => {
    const r = await projectTicketWorkflow().list(req.params.project, {
      status: q(req.query.status),
      assignee: q(req.query.assignee),
      label: q(req.query.label),
    });
    return { project: { id: r.project.id, name: r.project.name, path: r.project.path }, tickets: r.tickets, invalid: r.invalid };
  });
}

/**
 * GET /api/project-tickets/:project/:id
 *
 * @param req - Request
 * @param res - `{ success, data: ticket }` (with `body`)
 */
export async function getProjectTicket(req: Request, res: Response): Promise<void> {
  await respond(res, () => projectTicketWorkflow().get(req.params.project, req.params.id));
}

/**
 * POST /api/project-tickets/:project — create.
 *
 * @param req - Body: title, description, acceptance[], priority, labels[], team, status, ownerReview, requestId, source
 * @param res - `{ success, data: ticket }`
 */
export async function createProjectTicket(req: Request, res: Response): Promise<void> {
  await respond(res, () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.status !== undefined) requireStatus(b.status);
    return projectTicketWorkflow().create(
      req.params.project,
      {
        title: String(b.title ?? ''),
        description: typeof b.description === 'string' ? b.description : undefined,
        acceptance: Array.isArray(b.acceptance) ? (b.acceptance as Array<string>) : undefined,
        priority: typeof b.priority === 'string' ? b.priority : undefined,
        labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
        team: typeof b.team === 'string' ? b.team : undefined,
        status: b.status as never,
        ownerReview: b.ownerReview === true,
        requestId: typeof b.requestId === 'string' ? b.requestId : undefined,
        source: typeof b.source === 'string' ? b.source : undefined,
        metric: typeof b.metric === 'string' ? b.metric : undefined,
      },
      callerOf(req),
    );
  });
}

/**
 * POST /api/project-tickets/:project/:id/update — fields, sections, optional status.
 *
 * @param req - Body: title, priority, labels, team, ownerReview, requestId, description, acceptance, status, note
 * @param res - `{ success, data: ticket }`
 */
export async function updateProjectTicket(req: Request, res: Response): Promise<void> {
  await respond(res, () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const status = b.status !== undefined ? requireStatus(b.status) : undefined;
    return projectTicketWorkflow().update(
      req.params.project,
      req.params.id,
      {
        ...(typeof b.title === 'string' ? { title: b.title } : {}),
        ...(typeof b.priority === 'string' ? { priority: b.priority } : {}),
        ...(Array.isArray(b.labels) ? { labels: b.labels.map(String) } : {}),
        ...(b.team !== undefined ? { team: typeof b.team === 'string' ? b.team : null } : {}),
        ...(typeof b.ownerReview === 'boolean' ? { ownerReview: b.ownerReview } : {}),
        ...(b.requestId !== undefined ? { requestId: typeof b.requestId === 'string' ? b.requestId : null } : {}),
        ...(typeof b.description === 'string' ? { description: b.description } : {}),
        ...(Array.isArray(b.acceptance) ? { acceptance: b.acceptance as Array<string> } : {}),
        ...(status ? { status } : {}),
      },
      callerOf(req),
      typeof b.note === 'string' ? b.note : undefined,
    );
  });
}

/**
 * POST /api/project-tickets/:project/:id/transition — `{ status, note }`.
 *
 * @param req - Request
 * @param res - `{ success, data: ticket }`
 */
export async function transitionProjectTicket(req: Request, res: Response): Promise<void> {
  await respond(res, () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return projectTicketWorkflow().transition(
      req.params.project,
      req.params.id,
      requireStatus(b.status),
      callerOf(req),
      typeof b.note === 'string' ? b.note : undefined,
    );
  });
}

/**
 * POST /api/project-tickets/:project/:id/claim — the calling agent claims it.
 *
 * @param req - Request (X-Agent-Session required)
 * @param res - `{ success, data: { ticket, workItem, claimed } }`
 */
export async function claimProjectTicket(req: Request, res: Response): Promise<void> {
  await respond(res, () => projectTicketWorkflow().claim(req.params.project, req.params.id, callerOf(req)));
}

/**
 * POST /api/project-tickets/:project/:id/assign — `{ assignee, start? }`.
 *
 * @param req - Request
 * @param res - `{ success, data: { ticket, workItem?, wake? } }` (`wake`: a stopped assignee was started, or why not)
 */
export async function assignProjectTicket(req: Request, res: Response): Promise<void> {
  await respond(res, () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return projectTicketWorkflow().assign(req.params.project, req.params.id, String(b.assignee ?? ''), callerOf(req), {
      start: b.start === false ? false : true,
    });
  });
}

/**
 * POST /api/project-tickets/:project/:id/link — `{ workItemId }`: link a live
 * WorkItem already in flight to the ticket (owner / orchestrator / lead).
 *
 * @param req - Request
 * @param res - `{ success, data: { ticket, workItem } }`
 */
export async function linkProjectTicket(req: Request, res: Response): Promise<void> {
  await respond(res, () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return projectTicketWorkflow().link(req.params.project, req.params.id, String(b.workItemId ?? ''), callerOf(req));
  });
}

/**
 * POST /api/project-tickets/:project/:id/log — `{ note }`.
 *
 * @param req - Request
 * @param res - `{ success, data: ticket }`
 */
export async function logProjectTicket(req: Request, res: Response): Promise<void> {
  await respond(res, () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return projectTicketWorkflow().log(req.params.project, req.params.id, callerOf(req), String(b.note ?? ''));
  });
}

/**
 * POST /api/project-tickets-migrate/:project — `{ apply?, milestones? }`.
 * Owner / orchestrator only; dry-run unless `apply: true`.
 *
 * @param req - Request
 * @param res - `{ success, data: report }`
 */
export async function migrateProjectTickets(req: Request, res: Response): Promise<void> {
  await respond(res, async () => {
    const wf = projectTicketWorkflow();
    const project = await wf.resolveProject(req.params.project);
    const { access } = await wf.accessOf(callerOf(req), project);
    if (access !== 'owner' && access !== 'orchestrator') {
      throw new ProjectTicketError(403, 'Only the owner or the orchestrator runs the v1 migration');
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    return migrateV1Tasks(ProjectTicketService.getInstance(), project.path, project.name, {
      apply: b.apply === true,
      milestones: Array.isArray(b.milestones) ? b.milestones.map(String) : undefined,
    });
  });
}

/**
 * POST /api/project-tickets/:project/:id/ask-owner — ask the owner a
 * structured question about the ticket (specs/2026-10-01-decision-cards.md):
 * `{ question, options: [2–3], default, deadline?, sensitive? }`. The
 * ticket's assignee (else its team lead) posts it as a Block Kit card in the
 * ticket's Slack thread; the ticket gets `needs-owner` until it is answered.
 * `{ clear: true, note? }` withdraws open questions and removes the mark.
 * Callers: the owner, the orchestrator, a lead, or the ticket's assignee.
 *
 * @param req - Request
 * @param res - `{ success, data: { decision, ticket } }` (clear: `{ ticket, withdrawn }`)
 */
export async function askOwnerProjectTicket(req: Request, res: Response): Promise<void> {
  const b = (req.body ?? {}) as Record<string, unknown>;
  let caller: ProjectTicketCaller;
  try {
    caller = callerOf(req);
  } catch (err) {
    await respond(res, async () => {
      throw err;
    });
    return;
  }
  if (b.clear === true) {
    await respond(res, async () => {
      const wf = projectTicketWorkflow();
      const ticket = await wf.askOwner(req.params.project, req.params.id, caller, {
        clear: true,
        note: typeof b.note === 'string' ? b.note : undefined,
      });
      const withdrawn =
        (await DecisionService.getInstance()?.cancelWhere(
          (d) => d.ticket?.projectPath === ticket.projectPath && d.ticket?.id === ticket.id,
          typeof b.note === 'string' ? b.note : 'cleared',
        )) ?? 0;
      return { ticket, withdrawn };
    });
    return;
  }
  try {
    const service = DecisionService.getInstance();
    if (!service) throw new DecisionError(503, 'Decision cards are not ready yet — Crewly is still starting');
    const decision = await service.ask(caller.session, {
      question: b.question,
      options: b.options,
      default: b.default,
      deadline: b.deadline,
      sensitive: b.sensitive,
      ticket: req.params.id,
      project: req.params.project,
    });
    const ticket = decision.ticket ? await projectTicketWorkflow().get(decision.ticket.projectId, decision.ticket.id).catch(() => null) : null;
    res.json({ success: true, data: { decision, ticket } });
  } catch (err) {
    if (err instanceof DecisionError || err instanceof ProjectTicketError) {
      res.status(err.status).json({ success: false, error: err.message });
      return;
    }
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * GET /api/project-ticket-autopilot/:project — the project's ticket autopilot
 * settings and status. Owner / orchestrator only.
 *
 * @param req - Request
 * @param res - `{ success, data: status }`
 */
export async function getTicketAutopilot(req: Request, res: Response): Promise<void> {
  await respond(res, () => ticketAutopilot().getStatus(req.params.project, callerOf(req)));
}

/**
 * `?days=` / `?stallMinutes=` as a number, or undefined.
 *
 * @param value - Raw query value
 * @returns Number or undefined
 * @throws ProjectTicketError(400) when it is not a number
 */
function qNumber(value: unknown): number | undefined {
  const v = q(value);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ProjectTicketError(400, `Not a positive number: ${v}`);
  return n;
}

/**
 * GET /api/project-ticket-autopilot/:project/stats?days=&label=&stallMinutes= —
 * the autopilot's numbers per day and in total
 * (specs/2026-10-03-autopilot-experiments.md §2). Owner, orchestrator or a
 * lead of the project.
 *
 * @param req - Request
 * @param res - `{ success, data: AutopilotStats & { project, settings, pausedForToday } }`
 */
export async function getTicketAutopilotStats(req: Request, res: Response): Promise<void> {
  await respond(res, () =>
    ticketAutopilot().getStats(req.params.project, callerOf(req), {
      days: qNumber(req.query.days),
      label: q(req.query.label),
      stallMinutes: qNumber(req.query.stallMinutes),
    }),
  );
}

/**
 * GET /api/project-ticket-autopilot/:project/runs?days=&label= — run traces
 * and ticket traces per day.
 *
 * @param req - Request
 * @param res - `{ success, data: { project, days } }`
 */
export async function getTicketAutopilotRuns(req: Request, res: Response): Promise<void> {
  await respond(res, () => ticketAutopilot().getRuns(req.params.project, callerOf(req), { days: qNumber(req.query.days), label: q(req.query.label) }));
}

/**
 * POST /api/project-ticket-autopilot/:project/retro — the driver's daily
 * retro `{ day, summary, problems: [{class, title, detail?, evidence?}] }`.
 *
 * @param req - Request
 * @param res - `{ success, data: RetroResult }`
 */
export async function submitTicketAutopilotRetro(req: Request, res: Response): Promise<void> {
  await respond(res, () => ticketAutopilot().submitRetro(req.params.project, req.body ?? {}, callerOf(req)));
}

/**
 * POST /api/project-ticket-autopilot/:project/self-review — the driver's
 * self-review `{ gap, moved?, nextBet }` (specs/2026-10-04-autopilot-speed-modes.md).
 *
 * @param req - Request
 * @param res - `{ success, data: SelfReviewRecord }`
 */
export async function submitTicketAutopilotSelfReview(req: Request, res: Response): Promise<void> {
  await respond(res, () => ticketAutopilot().submitSelfReview(req.params.project, req.body ?? {}, callerOf(req)));
}

/**
 * POST /api/project-ticket-autopilot/:project — change the switch:
 * `{ enabled?, driver?, dailyBudgetTokens?, maxInFlightPerMember?, retro?, replansPerDay?, replanTtlHours?, speedMode? }` (null resets
 * a field to its default). Owner / orchestrator only.
 *
 * @param req - Request
 * @param res - `{ success, data: status }`
 */
export async function setTicketAutopilot(req: Request, res: Response): Promise<void> {
  await respond(res, () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return ticketAutopilot().updateSettings(
      req.params.project,
      {
        enabled: b.enabled,
        driver: b.driver,
        dailyBudgetTokens: b.dailyBudgetTokens,
        dailyBudgetUsd: b.dailyBudgetUsd,
        maxInFlightPerMember: b.maxInFlightPerMember,
        retro: b.retro,
        replansPerDay: b.replansPerDay,
        replanTtlHours: b.replanTtlHours,
        speedMode: b.speedMode,
      },
      callerOf(req),
    );
  });
}
