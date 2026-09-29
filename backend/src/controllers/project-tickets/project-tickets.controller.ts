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

import type { Request, Response } from 'express';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { ProjectTicketError, ProjectTicketService } from '../../services/project-tickets/project-ticket.service.js';
import {
  ProjectTicketWorkflowService,
  type ProjectTicketCaller,
} from '../../services/project-tickets/project-ticket-workflow.service.js';
import { migrateV1Tasks } from '../../services/project-tickets/v1-task-migration.js';
import { TaskPoolService } from '../../services/task-pool/task-pool.service.js';
import { StorageService } from '../../services/core/storage.service.js';
import { isProjectTicketStatus } from '../../types/project-ticket.types.js';

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
    });
    ProjectTicketWorkflowService.setInstance(wf);
  }
  return wf;
}

/**
 * The caller of a request.
 *
 * @param req - Request
 * @returns `{ session }` for an agent, `{}` for the owner
 */
function callerOf(req: Request): ProjectTicketCaller {
  const session = readAgentSessionHeader(req);
  return session ? { session } : {};
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
 * @param res - `{ success, data: { ticket, workItem? } }`
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
