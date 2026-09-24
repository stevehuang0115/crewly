/**
 * MicrosoftTodoService — Microsoft To Do over Graph v1.0 on the owner's grant.
 *
 * What agents can do: list task lists (and create one), list the tasks of a
 * list (open ones by default), add a task (note, due date, importance),
 * update a task (complete / reopen, retitle, re-date) and delete one.
 *
 * Lists are named by id or by display name (case-insensitive); no name at
 * all means the owner's default list ("Tasks", `wellknownListName:
 * defaultList`). Every call resolves the name against `GET /me/todo/lists`
 * so the answer can say which list it acted on.
 *
 * Graph failures map to stable codes: 401 refreshes the token once, 429 is
 * waited out once when `Retry-After` is short and otherwise returned as
 * `rate_limited` with the delay, 403 → `forbidden`, 404 → `not_found`.
 *
 * @module services/microsoft/microsoft-todo.service
 */

import { MICROSOFT_TODO_CONSTANTS } from '../../constants.js';
import { MicrosoftError } from './microsoft-token.service.js';

/** Token provider slice. */
export interface MicrosoftTokenProvider {
  getAccessToken(): Promise<string>;
  clearCache(): void;
}

/** Service dependencies. */
export interface MicrosoftTodoDeps {
  tokens: MicrosoftTokenProvider;
  fetchImpl?: typeof fetch;
  /** Wait before a 429 retry (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** A task list, trimmed. */
export interface TodoList {
  id: string;
  name: string;
  /** True for the owner's default list ("Tasks"). */
  isDefault?: boolean;
  isShared?: boolean;
}

/** A task, trimmed for agents. */
export interface TodoTask {
  id: string;
  title: string;
  /** `notStarted` | `inProgress` | `completed` | `waitingOnOthers` | `deferred` */
  status: string;
  /** Present when not `normal`. */
  importance?: string;
  /** `YYYY-MM-DD` */
  due?: string;
  /** Note text (plain), truncated. */
  note?: string;
  /** `YYYY-MM-DD`, completed tasks only. */
  completedAt?: string;
}

/** `listTasks` input. */
export interface TodoListTasksInput {
  /** List id or name; empty = default list. */
  list?: string;
  /** Include completed tasks (default: open only). */
  includeCompleted?: boolean;
  limit?: number;
}

/** `addTask` input. */
export interface TodoAddTaskInput {
  list?: string;
  title: string;
  note?: string;
  /** `YYYY-MM-DD` */
  due?: string;
  importance?: string;
}

/** `updateTask` input. `due: null` clears the due date. */
export interface TodoUpdateTaskInput {
  list?: string;
  taskId: string;
  title?: string;
  note?: string;
  due?: string | null;
  importance?: string;
  /** true → completed, false → reopened (notStarted). */
  complete?: boolean;
}

/** Reference to the list an operation acted on. */
export interface TodoListRef {
  id: string;
  name: string;
}

interface WireDateTimeTimeZone {
  dateTime?: string;
  timeZone?: string;
}

interface WireList {
  id?: string;
  displayName?: string;
  isShared?: boolean;
  isOwner?: boolean;
  wellknownListName?: string;
}

interface WireTask {
  id?: string;
  title?: string;
  status?: string;
  importance?: string;
  body?: { content?: string; contentType?: string };
  dueDateTime?: WireDateTimeTimeZone | null;
  completedDateTime?: WireDateTimeTimeZone | null;
}

interface WirePage<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

/** Graph's error envelope. */
interface WireError {
  error?: { code?: string; message?: string };
}

const CODES = MICROSOFT_TODO_CONSTANTS.ERROR_CODES;
/** Upper bound on `@odata.nextLink` pages followed when listing lists. */
const MAX_LIST_PAGES = 10;
const HTTP_NO_CONTENT = 204;
const MS_PER_SECOND = 1000;

/**
 * Trim a Graph `todoTaskList`.
 *
 * @param l - Wire list
 * @returns Trimmed list
 */
export function toList(l: WireList): TodoList {
  return {
    id: l.id ?? '',
    name: l.displayName ?? '',
    ...(l.wellknownListName === MICROSOFT_TODO_CONSTANTS.DEFAULT_LIST_WELLKNOWN ? { isDefault: true } : {}),
    ...(l.isShared ? { isShared: true } : {}),
  };
}

/**
 * Plain text of a task body (HTML bodies come from Outlook-created tasks).
 *
 * @param body - Wire body
 * @returns Collapsed text, truncated to the preview length, or undefined
 */
export function noteText(body: WireTask['body']): string | undefined {
  let text = body?.content ?? '';
  if ((body?.contentType ?? '').toLowerCase() === 'html') {
    text = text.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const max = MICROSOFT_TODO_CONSTANTS.NOTE_PREVIEW_LENGTH;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Trim a Graph `todoTask`.
 *
 * @param t - Wire task
 * @returns Trimmed task
 */
export function toTask(t: WireTask): TodoTask {
  const note = noteText(t.body);
  const due = t.dueDateTime?.dateTime?.slice(0, 10);
  const completedAt = t.status === 'completed' ? t.completedDateTime?.dateTime?.slice(0, 10) : undefined;
  return {
    id: t.id ?? '',
    title: t.title ?? '',
    status: t.status ?? 'notStarted',
    ...(t.importance && t.importance !== 'normal' ? { importance: t.importance } : {}),
    ...(due ? { due } : {}),
    ...(note ? { note } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
}

/**
 * Validate a `YYYY-MM-DD` date and turn it into Graph's `dueDateTime`.
 *
 * @param value - Date text
 * @returns `{ dateTime, timeZone }`
 * @throws MicrosoftError(400, validation) for a malformed or impossible date
 */
export function toDueDateTime(value: string): { dateTime: string; timeZone: string } {
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!match || !parsed || parsed.toISOString().slice(0, 10) !== text) {
    throw new MicrosoftError(400, CODES.VALIDATION, `due must be a real date as YYYY-MM-DD (got "${value}")`);
  }
  return { dateTime: `${text}T00:00:00`, timeZone: MICROSOFT_TODO_CONSTANTS.DUE_TIME_ZONE };
}

/**
 * Validate an importance value.
 *
 * @param value - Candidate
 * @returns Lower-cased importance
 * @throws MicrosoftError(400, validation) when unknown
 */
export function toImportance(value: string): string {
  const v = value.trim().toLowerCase();
  if (!MICROSOFT_TODO_CONSTANTS.IMPORTANCE_VALUES.includes(v)) {
    throw new MicrosoftError(400, CODES.VALIDATION, `importance must be one of ${MICROSOFT_TODO_CONSTANTS.IMPORTANCE_VALUES.join(', ')}`);
  }
  return v;
}

/**
 * Pick the list a reference names: exact id, then case-insensitive name,
 * then `default` (or nothing) → the default list.
 *
 * @param lists - All lists
 * @param ref - Id or name (may be empty)
 * @returns The list
 * @throws MicrosoftError(404, not_found) when nothing matches; (400, validation) when a name is ambiguous
 */
export function pickList(lists: TodoList[], ref: string | undefined): TodoList {
  const wanted = (ref ?? '').trim();
  if (wanted) {
    const byId = lists.find((l) => l.id === wanted);
    if (byId) return byId;
    const byName = lists.filter((l) => l.name.trim().toLowerCase() === wanted.toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new MicrosoftError(400, CODES.VALIDATION, `Several lists are called "${wanted}"; pass the list id instead (${byName.map((l) => l.id).join(', ')})`);
    }
    if (wanted.toLowerCase() !== 'default') {
      const names = lists.map((l) => l.name).join(', ');
      throw new MicrosoftError(404, CODES.NOT_FOUND, `No To Do list called "${wanted}". Lists: ${names || '(none)'}`);
    }
  }
  const fallback = lists.find((l) => l.isDefault) ?? lists[0];
  if (!fallback) throw new MicrosoftError(404, CODES.NOT_FOUND, 'This Microsoft account has no To Do lists.');
  return fallback;
}

/**
 * Microsoft To Do calls.
 */
export class MicrosoftTodoService {
  private readonly deps: Required<Pick<MicrosoftTodoDeps, 'fetchImpl' | 'sleep'>> & MicrosoftTodoDeps;
  private readonly base = `${MICROSOFT_TODO_CONSTANTS.GRAPH_BASE}/me/todo/lists`;

  /**
   * @param deps - Token provider, fetch, sleep
   */
  constructor(deps: MicrosoftTodoDeps) {
    this.deps = {
      ...deps,
      fetchImpl: deps.fetchImpl ?? fetch,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  /**
   * `GET /me/todo/lists` (following `@odata.nextLink`).
   *
   * @returns Every list
   */
  async listLists(): Promise<TodoList[]> {
    const out: TodoList[] = [];
    let url: string | undefined = this.base;
    for (let page = 0; url && page < MAX_LIST_PAGES; page += 1) {
      const data: WirePage<WireList> = await this.request<WirePage<WireList>>(url);
      out.push(...(data.value ?? []).map(toList));
      url = data['@odata.nextLink'];
    }
    return out;
  }

  /**
   * `POST /me/todo/lists`.
   *
   * @param name - Display name
   * @returns The new list
   * @throws MicrosoftError(400, validation) for an empty name
   */
  async createList(name: string): Promise<TodoList> {
    const displayName = (name ?? '').trim().slice(0, MICROSOFT_TODO_CONSTANTS.TITLE_MAX_LENGTH);
    if (!displayName) throw new MicrosoftError(400, CODES.VALIDATION, '"name" is required');
    return toList(await this.request<WireList>(this.base, { method: 'POST', body: { displayName } }));
  }

  /**
   * Resolve a list reference (id, name, `default`, or empty).
   *
   * @param ref - Reference
   * @returns The list
   */
  async resolveList(ref: string | undefined): Promise<TodoList> {
    return pickList(await this.listLists(), ref);
  }

  /**
   * `GET /me/todo/lists/{id}/tasks` — open tasks unless `includeCompleted`.
   *
   * @param input - List, completed flag, limit
   * @returns The list, its tasks, and whether more exist
   */
  async listTasks(input: TodoListTasksInput = {}): Promise<{ list: TodoListRef; tasks: TodoTask[]; hasMore: boolean }> {
    const list = await this.resolveList(input.list);
    const limit = Math.min(
      Math.max(1, Math.floor(input.limit ?? MICROSOFT_TODO_CONSTANTS.TASKS_DEFAULT_LIMIT) || MICROSOFT_TODO_CONSTANTS.TASKS_DEFAULT_LIMIT),
      MICROSOFT_TODO_CONSTANTS.TASKS_LIMIT_CEILING,
    );
    const url = new URL(`${this.base}/${encodeURIComponent(list.id)}/tasks`);
    url.searchParams.set('$top', String(limit));
    if (!input.includeCompleted) url.searchParams.set('$filter', "status ne 'completed'");
    const data = await this.request<WirePage<WireTask>>(url.toString());
    return { list: { id: list.id, name: list.name }, tasks: (data.value ?? []).map(toTask), hasMore: Boolean(data['@odata.nextLink']) };
  }

  /**
   * `POST /me/todo/lists/{id}/tasks`.
   *
   * @param input - List, title, note, due, importance
   * @returns The list and the new task
   * @throws MicrosoftError(400, validation) for a missing title / bad due / bad importance
   */
  async addTask(input: TodoAddTaskInput): Promise<{ list: TodoListRef; task: TodoTask }> {
    const title = (input.title ?? '').trim().slice(0, MICROSOFT_TODO_CONSTANTS.TITLE_MAX_LENGTH);
    if (!title) throw new MicrosoftError(400, CODES.VALIDATION, '"title" is required');
    const body: Record<string, unknown> = { title };
    const note = (input.note ?? '').trim();
    if (note) body.body = { content: note.slice(0, MICROSOFT_TODO_CONSTANTS.NOTE_MAX_LENGTH), contentType: 'text' };
    if (input.due?.trim()) body.dueDateTime = toDueDateTime(input.due);
    if (input.importance?.trim()) body.importance = toImportance(input.importance);
    const list = await this.resolveList(input.list);
    const task = await this.request<WireTask>(`${this.base}/${encodeURIComponent(list.id)}/tasks`, { method: 'POST', body });
    return { list: { id: list.id, name: list.name }, task: toTask(task) };
  }

  /**
   * `PATCH /me/todo/lists/{id}/tasks/{taskId}`.
   *
   * @param input - List, task id, and the fields to change
   * @returns The list and the updated task
   * @throws MicrosoftError(400, validation) when nothing is changed or a value is bad
   */
  async updateTask(input: TodoUpdateTaskInput): Promise<{ list: TodoListRef; task: TodoTask }> {
    const taskId = (input.taskId ?? '').trim();
    if (!taskId) throw new MicrosoftError(400, CODES.VALIDATION, '"taskId" is required');
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) {
      const title = input.title.trim().slice(0, MICROSOFT_TODO_CONSTANTS.TITLE_MAX_LENGTH);
      if (!title) throw new MicrosoftError(400, CODES.VALIDATION, '"title" cannot be empty');
      body.title = title;
    }
    if (input.note !== undefined) body.body = { content: input.note.trim().slice(0, MICROSOFT_TODO_CONSTANTS.NOTE_MAX_LENGTH), contentType: 'text' };
    if (input.due === null) body.dueDateTime = null;
    else if (input.due !== undefined) body.dueDateTime = toDueDateTime(input.due);
    if (input.importance !== undefined) body.importance = toImportance(input.importance);
    if (input.complete !== undefined) body.status = input.complete ? 'completed' : 'notStarted';
    if (Object.keys(body).length === 0) {
      throw new MicrosoftError(400, CODES.VALIDATION, 'nothing to change: give complete, title, note, due or importance');
    }
    const list = await this.resolveList(input.list);
    const task = await this.request<WireTask>(`${this.base}/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body });
    return { list: { id: list.id, name: list.name }, task: toTask(task) };
  }

  /**
   * `DELETE /me/todo/lists/{id}/tasks/{taskId}`.
   *
   * @param listRef - List id or name
   * @param taskId - Task id
   * @returns What was deleted
   */
  async deleteTask(listRef: string | undefined, taskId: string): Promise<{ list: TodoListRef; taskId: string; deleted: true }> {
    const id = (taskId ?? '').trim();
    if (!id) throw new MicrosoftError(400, CODES.VALIDATION, '"taskId" is required');
    const list = await this.resolveList(listRef);
    await this.request<unknown>(`${this.base}/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { list: { id: list.id, name: list.name }, taskId: id, deleted: true };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Authenticated Graph call.
   *
   * 401 → drop the cached token and retry once; still 401 → `unauthorized`.
   * 429 → wait out a short `Retry-After` once, else `rate_limited`.
   * 400 → `validation`, 403 → `forbidden`, 404 → `not_found`, others → 502.
   *
   * @param url - Absolute URL
   * @param init - Method / JSON body
   * @returns Parsed JSON (`{}` for 204)
   */
  private async request<T>(url: string, init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {}): Promise<T> {
    let retriedAuth = false;
    let retriedThrottle = false;
    for (;;) {
      const token = await this.deps.tokens.getAccessToken();
      let res: Response;
      try {
        res = await this.deps.fetchImpl(url, {
          method: init.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(MICROSOFT_TODO_CONSTANTS.REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new MicrosoftError(502, CODES.NETWORK, `Microsoft Graph unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status === HTTP_NO_CONTENT) return {} as T;
      const text = await res.text();
      if (res.ok) {
        if (!text) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new MicrosoftError(502, CODES.MICROSOFT_ERROR, 'Microsoft Graph returned a non-JSON response.');
        }
      }

      let message = `Microsoft Graph request failed (${res.status})`;
      let graphCode = '';
      try {
        const parsed = JSON.parse(text) as WireError;
        graphCode = parsed.error?.code ?? '';
        message = parsed.error?.message || graphCode || message;
      } catch {
        if (text) message = text.slice(0, 200);
      }
      const detail = graphCode && !message.includes(graphCode) ? `${graphCode}: ${message}` : message;

      if (res.status === 401) {
        this.deps.tokens.clearCache();
        if (!retriedAuth) {
          retriedAuth = true;
          continue;
        }
        throw new MicrosoftError(401, CODES.UNAUTHORIZED, `Microsoft rejected the access token: ${detail}`);
      }
      if (res.status === 429) {
        const retryAfter = Math.max(1, Number.parseInt(res.headers?.get?.('Retry-After') ?? '', 10) || 1);
        if (!retriedThrottle && retryAfter <= MICROSOFT_TODO_CONSTANTS.RETRY_AFTER_MAX_WAIT_S) {
          retriedThrottle = true;
          await this.deps.sleep(retryAfter * MS_PER_SECOND);
          continue;
        }
        throw new MicrosoftError(429, CODES.RATE_LIMITED, `Microsoft Graph is throttling requests; retry after ${retryAfter}s`, retryAfter);
      }
      if (res.status === 400) throw new MicrosoftError(400, CODES.VALIDATION, detail);
      if (res.status === 403) throw new MicrosoftError(403, CODES.FORBIDDEN, detail);
      if (res.status === 404) throw new MicrosoftError(404, CODES.NOT_FOUND, detail);
      throw new MicrosoftError(502, CODES.MICROSOFT_ERROR, detail);
    }
  }
}
