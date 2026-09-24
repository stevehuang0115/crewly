/**
 * Microsoft To Do controller — `/api/microsoft-todo/*` on this instance.
 *
 * Grant management goes through Cloud (status / connect-url / disconnect);
 * lists and tasks go straight to Microsoft Graph with the token Cloud
 * mints. Backs the todo-* skills.
 *
 * @module controllers/microsoft/microsoft-todo.controller
 */

import type { Request, Response } from 'express';
import { MICROSOFT_TODO_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { MicrosoftTokenService, MicrosoftError } from '../../services/microsoft/microsoft-token.service.js';
import { MicrosoftTodoService } from '../../services/microsoft/microsoft-todo.service.js';

const logger = LoggerService.getInstance().createComponentLogger('MicrosoftTodoController');

/** The services the handlers use; swappable for tests. */
export interface MicrosoftTodoControllerDeps {
  tokens: MicrosoftTokenService;
  todo: MicrosoftTodoService;
}

let deps: MicrosoftTodoControllerDeps | null = null;

function getDeps(): MicrosoftTodoControllerDeps {
  if (!deps) {
    const tokens = MicrosoftTokenService.getInstance();
    deps = { tokens, todo: new MicrosoftTodoService({ tokens }) };
  }
  return deps;
}

/**
 * Replace the dependency set (tests).
 *
 * @param next - Deps or null to rebuild lazily
 */
export function setMicrosoftTodoControllerDeps(next: MicrosoftTodoControllerDeps | null): void {
  deps = next;
}

function resolveReturnUrl(req: Request): string {
  const explicit = typeof req.query.returnUrl === 'string' ? req.query.returnUrl : '';
  if (/^https?:\/\//i.test(explicit)) return explicit;
  return `${req.protocol}://${req.get('host')}${MICROSOFT_TODO_CONSTANTS.SETTINGS_RETURN_PATH}`;
}

function connectUrlOrNull(req: Request): string | null {
  try {
    return getDeps().tokens.buildConnectUrl(resolveReturnUrl(req));
  } catch {
    return null;
  }
}

/**
 * Answer a failure with `{ success:false, error, message, hint }` (plus
 * `retryAfter` seconds for `rate_limited`).
 *
 * @param req - Request (for the connect URL hint)
 * @param res - Response
 * @param err - The failure
 */
export function sendMicrosoftTodoError(req: Request, res: Response, err: unknown): void {
  const CODES = MICROSOFT_TODO_CONSTANTS.ERROR_CODES;
  if (err instanceof MicrosoftError) {
    let hint: string;
    switch (err.code) {
      case CODES.NOT_CONNECTED:
        hint = connectUrlOrNull(req) ?? 'Sign in to Crewly Cloud (Settings → Cloud), then connect Microsoft To Do under Connections.';
        break;
      case CODES.NOT_LOGGED_IN:
        hint = 'Sign in to Crewly Cloud first (Settings → Cloud).';
        break;
      case CODES.NOT_CONFIGURED:
        hint = 'Crewly Cloud is not configured for Microsoft yet; nothing to do on this instance.';
        break;
      case CODES.VALIDATION:
        hint = 'Fix the request and retry.';
        break;
      case CODES.NOT_FOUND:
        hint = 'Check the list name (todo-lists shows them) or the task id (todo-tasks shows them).';
        break;
      case CODES.FORBIDDEN:
        hint =
          'Microsoft refused access. To Do needs an Exchange Online mailbox: personal Microsoft accounts work; a work/school account needs a mailbox licence, and some organisations require admin consent.';
        break;
      case CODES.RATE_LIMITED:
        hint = `Microsoft is throttling; wait ${err.retryAfterSeconds ?? 'a few'} seconds and retry.`;
        break;
      case CODES.UNAUTHORIZED:
        hint = 'Microsoft rejected the token twice; reconnect Microsoft To Do under Connections if this persists.';
        break;
      default:
        hint = 'Microsoft Graph or Crewly Cloud failed; retry later.';
    }
    if (err.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(err.retryAfterSeconds));
    res.status(err.status).json({
      success: false,
      error: err.code,
      message: err.message,
      hint,
      ...(err.retryAfterSeconds !== undefined ? { retryAfter: err.retryAfterSeconds } : {}),
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error('Unexpected Microsoft To Do failure', { error: message });
  res.status(500).json({ success: false, error: 'internal', message, hint: 'Check the backend log.' });
}

function q(req: Request, name: string): string {
  const v = req.query[name];
  return typeof v === 'string' ? v.trim() : '';
}

function qInt(req: Request, name: string): number | undefined {
  const v = q(req, name);
  return v ? Number.parseInt(v, 10) : undefined;
}

function qBool(req: Request, name: string): boolean {
  return ['1', 'true', 'yes'].includes(q(req, name).toLowerCase());
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** GET /api/microsoft-todo/status */
export async function getStatus(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await getDeps().tokens.status() });
  } catch (err) {
    sendMicrosoftTodoError(req, res, err);
  }
}

/** GET /api/microsoft-todo/connect-url — `{ url }` to open in the browser. */
export async function getConnectUrl(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: { url: getDeps().tokens.buildConnectUrl(resolveReturnUrl(req)) } });
  } catch (err) {
    sendMicrosoftTodoError(req, res, err);
  }
}

/** DELETE /api/microsoft-todo/disconnect */
export async function disconnect(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await getDeps().tokens.disconnect() });
  } catch (err) {
    sendMicrosoftTodoError(req, res, err);
  }
}

/** GET /api/microsoft-todo/lists */
export async function listLists(req: Request, res: Response): Promise<void> {
  try {
    const lists = await getDeps().todo.listLists();
    res.json({ success: true, data: { count: lists.length, lists } });
  } catch (err) {
    sendMicrosoftTodoError(req, res, err);
  }
}

/** POST /api/microsoft-todo/lists — `{ name }` */
export async function createList(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { name?: unknown; displayName?: unknown };
    const list = await getDeps().todo.createList(str(body.name) ?? str(body.displayName) ?? '');
    logger.info('To Do list created', { id: list.id, name: list.name });
    res.json({ success: true, data: list });
  } catch (err) {
    sendMicrosoftTodoError(req, res, err);
  }
}

/** GET /api/microsoft-todo/tasks?list=&all=&limit= */
export async function listTasks(req: Request, res: Response): Promise<void> {
  try {
    const out = await getDeps().todo.listTasks({ list: q(req, 'list') || undefined, includeCompleted: qBool(req, 'all'), limit: qInt(req, 'limit') });
    res.json({ success: true, data: { list: out.list, count: out.tasks.length, tasks: out.tasks, ...(out.hasMore ? { hasMore: true } : {}) } });
  } catch (err) {
    sendMicrosoftTodoError(req, res, err);
  }
}

/** POST /api/microsoft-todo/tasks — `{ list?, title, note?, due?, importance? }` */
export async function addTask(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const out = await getDeps().todo.addTask({
      list: str(body.list),
      title: str(body.title) ?? '',
      note: str(body.note),
      due: str(body.due),
      importance: str(body.importance),
    });
    logger.info('To Do task added', { list: out.list.name, id: out.task.id });
    res.json({ success: true, data: out });
  } catch (err) {
    sendMicrosoftTodoError(req, res, err);
  }
}

/** PATCH /api/microsoft-todo/tasks/:taskId — `{ list?, complete?, title?, note?, due? (null clears), importance? }` */
export async function updateTask(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const out = await getDeps().todo.updateTask({
      list: str(body.list),
      taskId: String(req.params.taskId ?? ''),
      title: str(body.title),
      note: str(body.note),
      due: body.due === null ? null : str(body.due),
      importance: str(body.importance),
      complete: typeof body.complete === 'boolean' ? body.complete : undefined,
    });
    logger.info('To Do task updated', { list: out.list.name, id: out.task.id, status: out.task.status });
    res.json({ success: true, data: out });
  } catch (err) {
    sendMicrosoftTodoError(req, res, err);
  }
}

/** DELETE /api/microsoft-todo/tasks/:taskId?list= */
export async function deleteTask(req: Request, res: Response): Promise<void> {
  try {
    const out = await getDeps().todo.deleteTask(q(req, 'list') || undefined, String(req.params.taskId ?? ''));
    logger.info('To Do task deleted', { list: out.list.name, id: out.taskId });
    res.json({ success: true, data: out });
  } catch (err) {
    sendMicrosoftTodoError(req, res, err);
  }
}
