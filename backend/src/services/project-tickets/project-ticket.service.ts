/**
 * Project ticket store — list / get / create / update / transition the
 * markdown tickets of one project (specs/2026-09-28-project-tickets.md).
 *
 * Storage is the project folder itself (`<project>/.crewly/tickets/`), which
 * is tracked in git and edited by humans too. So:
 * - every read goes through a cheap mtime/size-keyed cache (one `readdir` +
 *   `stat` per list), which is how edits made by hand or by a `git pull` are
 *   picked up — no long-lived watcher to leak or miss events;
 * - every write re-reads the file under the folder lock, applies only the
 *   owned-field / Log changes ({@link applyTicketChanges}) and writes
 *   atomically;
 * - files that are not valid tickets are skipped with a warning and reported
 *   in `invalid[]`, never fatal.
 *
 * This layer knows nothing about teams, agents or WorkItems — permissions and
 * the WorkItem link live in `ProjectTicketWorkflowService`.
 *
 * @module services/project-tickets/project-ticket.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { PROJECT_TICKET_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { resolveProjectDataDir } from '../core/crewly-home.utils.js';
import { atomicWriteFile } from '../../utils/file-io.utils.js';
import {
  isValidProjectTicketTransition,
  normalizeProjectTicketPriority,
  type InvalidTicketFile,
  type ProjectTicket,
  type ProjectTicketCriterion,
  type ProjectTicketFields,
  type ProjectTicketList,
  type ProjectTicketPriority,
  type ProjectTicketStatus,
} from '../../types/project-ticket.types.js';
import {
  applyTicketChanges,
  formatLogLine,
  parseTicketFile,
  renderNewTicketFile,
  slugifyTitle,
  type ParseTicketResult,
  type TicketChanges,
} from './ticket-file.js';
import { allocateTicketId, withTicketFolderLock } from './ticket-folder-lock.js';
import { ensureTicketsTracked, type TicketTrackingOutcome } from './ticket-tracking.js';
import { traceProjectTicketCreated } from '../trace/trace-recorder.js';

/** An error with the HTTP status the API should answer with. */
export class ProjectTicketError extends Error {
  /**
   * @param status - HTTP status (400 bad input, 403 not allowed, 404 missing, 409 conflict)
   * @param message - Human-readable reason
   */
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ProjectTicketError';
  }
}

/** Input for {@link ProjectTicketService.create}. */
export interface CreateProjectTicketInput {
  title: string;
  description?: string;
  /** Criteria as text lines or `{ text, done }` */
  acceptance?: Array<string | ProjectTicketCriterion>;
  priority?: string;
  labels?: string[];
  team?: string | null;
  status?: ProjectTicketStatus;
  ownerReview?: boolean;
  requestId?: string | null;
  source?: string | null;
  assignee?: string | null;
  migratedFrom?: string | null;
  /** Creation time (the migration keeps the original file's) */
  createdAt?: string;
}

/** Field changes accepted by {@link ProjectTicketService.update}. */
export interface UpdateProjectTicketInput {
  title?: string;
  priority?: string;
  labels?: string[];
  team?: string | null;
  ownerReview?: boolean;
  requestId?: string | null;
  description?: string;
  acceptance?: Array<string | ProjectTicketCriterion>;
}

/**
 * A mutation computed from the current ticket. Return null for "no change".
 * `fields` are merged with `updatedAt`; `log` lines are formatted with the
 * actor and time.
 */
export interface TicketMutation {
  fields?: Partial<ProjectTicketFields>;
  description?: string;
  acceptance?: ProjectTicketCriterion[];
  log?: string[];
}

/** Dependencies (injectable for tests). */
export interface ProjectTicketServiceDeps {
  logger?: ComponentLogger;
  /** Clock */
  now?: () => string;
  /** Git tracking check, run once per project on its first write */
  ensureTracked?: (projectPath: string) => Promise<TicketTrackingOutcome>;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  result: ParseTicketResult;
}

/**
 * Normalise acceptance input to criteria.
 *
 * @param items - Strings or criteria
 * @returns Criteria (empty texts dropped)
 */
function toCriteria(items: Array<string | ProjectTicketCriterion>): ProjectTicketCriterion[] {
  return items
    .map((c) => (typeof c === 'string' ? { text: c, done: false } : { text: String(c.text ?? ''), done: c.done === true }))
    .map((c) => ({ ...c, text: c.text.trim() }))
    .filter((c) => c.text.length > 0);
}

/**
 * Read a priority input or fail with 400.
 *
 * @param value - Raw priority
 * @returns The priority
 * @throws ProjectTicketError(400) when unreadable
 */
function requirePriority(value: string): ProjectTicketPriority {
  const p = normalizeProjectTicketPriority(value);
  if (!p) throw new ProjectTicketError(400, 'priority must be P0, P1, P2 or P3');
  return p;
}

/**
 * Clean a labels list.
 *
 * @param labels - Raw labels
 * @returns Trimmed, non-empty, de-duplicated
 */
function cleanLabels(labels: unknown[]): string[] {
  return [...new Set(labels.map((l) => String(l).trim()).filter((l) => l.length > 0))];
}

export class ProjectTicketService {
  private static instance: ProjectTicketService | null = null;

  private readonly logger: ComponentLogger;
  private readonly now: () => string;
  private readonly ensureTracked: (projectPath: string) => Promise<TicketTrackingOutcome>;
  /** dir → fileName → parsed entry */
  private readonly cache = new Map<string, Map<string, CacheEntry>>();
  /** Invalid files already warned about (`path@mtime`) */
  private readonly warned = new Set<string>();
  /** Projects whose git tracking was checked this process */
  private readonly trackingChecked = new Set<string>();

  /**
   * @param deps - Optional dependencies
   */
  constructor(deps: ProjectTicketServiceDeps = {}) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('ProjectTicketService');
    this.now = deps.now ?? (() => new Date().toISOString());
    this.ensureTracked = deps.ensureTracked ?? ((p) => ensureTicketsTracked(p));
  }

  /**
   * Process-wide instance.
   *
   * @returns The singleton
   */
  static getInstance(): ProjectTicketService {
    if (!ProjectTicketService.instance) ProjectTicketService.instance = new ProjectTicketService();
    return ProjectTicketService.instance;
  }

  /** Reset the singleton (tests). */
  static resetInstance(): void {
    ProjectTicketService.instance = null;
  }

  /**
   * The tickets folder of a project.
   *
   * @param projectPath - Absolute project root
   * @returns `<project>/.crewly/tickets`
   */
  ticketsDir(projectPath: string): string {
    return path.join(resolveProjectDataDir(path.resolve(projectPath)), PROJECT_TICKET_CONSTANTS.DIR_NAME);
  }

  /**
   * Every ticket of a project (plus the files that are not valid tickets).
   * Sorted by status order, then priority, then id number.
   *
   * @param projectPath - Absolute project root
   * @returns Tickets and invalid files
   */
  async list(projectPath: string): Promise<ProjectTicketList> {
    const root = path.resolve(projectPath);
    const dir = this.ticketsDir(root);
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { tickets: [], invalid: [] };
      throw err;
    }
    const dirCache = this.cache.get(dir) ?? new Map<string, CacheEntry>();
    this.cache.set(dir, dirCache);
    for (const cached of [...dirCache.keys()]) if (!names.includes(cached)) dirCache.delete(cached);

    const tickets: ProjectTicket[] = [];
    const invalid: InvalidTicketFile[] = [];
    const seen = new Map<string, string>();
    for (const fileName of names.sort()) {
      const filePath = path.join(dir, fileName);
      const result = await this.readCached(dirCache, filePath, fileName);
      if (!result) continue;
      if (!result.ok) {
        invalid.push({ fileName, error: result.error });
        continue;
      }
      const dupOf = seen.get(result.file.fields.id);
      if (dupOf) {
        invalid.push({ fileName, error: `duplicate id ${result.file.fields.id} (also in ${dupOf})` });
        continue;
      }
      seen.set(result.file.fields.id, fileName);
      tickets.push(this.toTicket(result, fileName, filePath, root, false));
    }
    const statusOrder = PROJECT_TICKET_CONSTANTS.STATUSES as readonly string[];
    const prioOrder = PROJECT_TICKET_CONSTANTS.PRIORITIES as readonly string[];
    const num = (id: string): number => Number(id.split('-').pop());
    tickets.sort(
      (a, b) =>
        statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status) ||
        prioOrder.indexOf(a.priority) - prioOrder.indexOf(b.priority) ||
        num(a.id) - num(b.id),
    );
    return { tickets, invalid };
  }

  /**
   * One ticket by id, with its raw body.
   *
   * @param projectPath - Absolute project root
   * @param id - Ticket id (case-insensitive)
   * @returns The ticket, or null
   */
  async get(projectPath: string, id: string): Promise<ProjectTicket | null> {
    const { tickets } = await this.list(projectPath);
    const hit = tickets.find((t) => t.id.toLowerCase() === id.toLowerCase());
    if (!hit) return null;
    const result = parseTicketFile(await fs.readFile(hit.filePath, 'utf8'));
    return result.ok ? this.toTicket(result, hit.fileName, hit.filePath, hit.projectPath, true) : null;
  }

  /**
   * Create a ticket. Allocates the id under the folder lock and checks git
   * tracking on the first write into the project.
   *
   * @param projectPath - Absolute project root
   * @param projectName - Project name (id prefix on first allocation)
   * @param input - Ticket content
   * @param actor - Who creates it (`owner`, a session name, `system`)
   * @returns The new ticket
   * @throws ProjectTicketError(400) on invalid input
   */
  async create(projectPath: string, projectName: string, input: CreateProjectTicketInput, actor: string): Promise<ProjectTicket> {
    const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
    if (!title) throw new ProjectTicketError(400, 'title is required');
    const priority = input.priority ? requirePriority(input.priority) : PROJECT_TICKET_CONSTANTS.DEFAULT_PRIORITY;
    const status = input.status ?? PROJECT_TICKET_CONSTANTS.DEFAULT_STATUS;
    const root = path.resolve(projectPath);
    const dir = this.ticketsDir(root);
    const now = this.now();

    const created = await withTicketFolderLock(dir, async () => {
      const id = await allocateTicketId(dir, projectName);
      const fields: ProjectTicketFields = {
        id,
        title,
        status,
        priority,
        assignee: input.assignee ?? null,
        team: input.team ?? null,
        labels: cleanLabels(input.labels ?? []),
        ownerReview: input.ownerReview === true,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
        workItemId: null,
        requestId: input.requestId ?? null,
        source: input.source ?? null,
        migratedFrom: input.migratedFrom ?? null,
      };
      const fileName = `${id}-${slugifyTitle(title)}.md`;
      const filePath = path.join(dir, fileName);
      const content = renderNewTicketFile({
        fields,
        description: input.description ?? '',
        acceptance: toCriteria(input.acceptance ?? []),
        logLines: [formatLogLine(actor, `created (${status})`, now)],
      });
      await atomicWriteFile(filePath, content);
      return { fileName, filePath, content };
    });

    await this.checkTracking(root);
    const parsed = parseTicketFile(created.content);
    if (!parsed.ok) throw new ProjectTicketError(500, `created ticket did not parse: ${parsed.error}`);
    this.logger.info('Project ticket created', { projectPath: root, id: parsed.file.fields.id, actor });
    traceProjectTicketCreated({ id: parsed.file.fields.id, title, requestId: input.requestId, assignee: input.assignee }, actor);
    return this.toTicket(parsed, created.fileName, created.filePath, root, true);
  }

  /**
   * Apply a mutation computed from the current ticket, under the folder lock.
   * The ticket is re-read inside the lock, so the mutation always sees the
   * latest file (a human edit or another writer).
   *
   * @param projectPath - Absolute project root
   * @param id - Ticket id
   * @param actor - Who changes it (for Log lines)
   * @param compute - Current ticket → changes (null = nothing to do)
   * @returns The ticket after the change
   * @throws ProjectTicketError(404) when the ticket does not exist; whatever `compute` throws
   */
  async mutate(
    projectPath: string,
    id: string,
    actor: string,
    compute: (ticket: ProjectTicket) => TicketMutation | null | Promise<TicketMutation | null>,
  ): Promise<ProjectTicket> {
    const root = path.resolve(projectPath);
    const dir = this.ticketsDir(root);
    const result = await withTicketFolderLock(dir, async () => {
      const current = await this.get(root, id);
      if (!current) throw new ProjectTicketError(404, `Ticket not found: ${id}`);
      const mutation = await compute(current);
      if (!mutation) return current;
      const now = this.now();
      const changes: TicketChanges = {
        fields: { ...(mutation.fields ?? {}), updatedAt: now },
        description: mutation.description,
        acceptance: mutation.acceptance,
        logLines: (mutation.log ?? []).map((m) => formatLogLine(actor, m, now)),
      };
      const before = await fs.readFile(current.filePath, 'utf8');
      const after = applyTicketChanges(before, changes);
      if (after !== before) await atomicWriteFile(current.filePath, after);
      const parsed = parseTicketFile(after);
      if (!parsed.ok) throw new ProjectTicketError(500, `ticket no longer parses: ${parsed.error}`);
      return this.toTicket(parsed, current.fileName, current.filePath, root, true);
    });
    return result;
  }

  /**
   * Change editable fields / sections.
   *
   * @param projectPath - Absolute project root
   * @param id - Ticket id
   * @param input - Changes
   * @param actor - Who changes it
   * @param note - Optional Log note
   * @returns Updated ticket
   * @throws ProjectTicketError(400/404)
   */
  async update(projectPath: string, id: string, input: UpdateProjectTicketInput, actor: string, note?: string): Promise<ProjectTicket> {
    return this.mutate(projectPath, id, actor, () => {
      const fields: Partial<ProjectTicketFields> = {};
      const changed: string[] = [];
      if (input.title !== undefined) {
        const t = String(input.title).replace(/\s+/g, ' ').trim();
        if (!t) throw new ProjectTicketError(400, 'title cannot be empty');
        fields.title = t;
        changed.push('title');
      }
      if (input.priority !== undefined) {
        fields.priority = requirePriority(input.priority);
        changed.push(`priority ${fields.priority}`);
      }
      if (input.labels !== undefined) {
        fields.labels = cleanLabels(input.labels);
        changed.push('labels');
      }
      if (input.team !== undefined) {
        fields.team = input.team || null;
        changed.push('team');
      }
      if (input.ownerReview !== undefined) {
        fields.ownerReview = input.ownerReview === true;
        changed.push('ownerReview');
      }
      if (input.requestId !== undefined) {
        fields.requestId = input.requestId || null;
        changed.push('requestId');
      }
      if (input.description !== undefined) changed.push('description');
      if (input.acceptance !== undefined) changed.push('acceptance criteria');
      if (changed.length === 0 && !note) return null;
      const log = changed.length > 0 ? [`updated ${changed.join(', ')}${note ? ` — ${note}` : ''}`] : [String(note)];
      return {
        fields,
        description: input.description,
        acceptance: input.acceptance !== undefined ? toCriteria(input.acceptance) : undefined,
        log,
      };
    });
  }

  /**
   * Move a ticket to another status, enforcing the state machine.
   *
   * @param projectPath - Absolute project root
   * @param id - Ticket id
   * @param to - New status
   * @param actor - Who moves it
   * @param note - Optional reason (goes into the Log line)
   * @param extra - Other owned fields to set in the same write (assignee, workItemId…)
   * @returns Updated ticket
   * @throws ProjectTicketError(400) for an invalid transition, (404) when missing
   */
  async transition(
    projectPath: string,
    id: string,
    to: ProjectTicketStatus,
    actor: string,
    note?: string,
    extra: Partial<ProjectTicketFields> = {},
  ): Promise<ProjectTicket> {
    return this.mutate(projectPath, id, actor, (t) => {
      if (t.status === to) return null;
      if (!isValidProjectTicketTransition(t.status, to)) {
        throw new ProjectTicketError(400, `Cannot move ${t.id} from ${t.status} to ${to}`);
      }
      return { fields: { ...extra, status: to }, log: [`${t.status} → ${to}${note ? ` — ${note}` : ''}`] };
    });
  }

  /**
   * Append a note to the Log.
   *
   * @param projectPath - Absolute project root
   * @param id - Ticket id
   * @param actor - Who writes it
   * @param note - The note
   * @returns Updated ticket
   */
  async appendLog(projectPath: string, id: string, actor: string, note: string): Promise<ProjectTicket> {
    const text = String(note ?? '').trim();
    if (!text) throw new ProjectTicketError(400, 'note is required');
    return this.mutate(projectPath, id, actor, () => ({ log: [text] }));
  }

  /**
   * Read a file through the cache.
   *
   * @param dirCache - Cache of the folder
   * @param filePath - File
   * @param fileName - Name
   * @returns Parse result, or null when the file vanished / is not a file
   */
  private async readCached(dirCache: Map<string, CacheEntry>, filePath: string, fileName: string): Promise<ParseTicketResult | null> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      dirCache.delete(fileName);
      return null;
    }
    if (!stat.isFile()) return null;
    const hit = dirCache.get(fileName);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.result;
    let result: ParseTicketResult;
    try {
      result = parseTicketFile(await fs.readFile(filePath, 'utf8'));
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    dirCache.set(fileName, { mtimeMs: stat.mtimeMs, size: stat.size, result });
    if (!result.ok) {
      const key = `${filePath}@${stat.mtimeMs}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.logger.warn('Skipping invalid project ticket file', { filePath, error: result.error });
      }
    }
    return result;
  }

  /**
   * Build the API shape of a parsed file.
   *
   * @param result - Successful parse
   * @param fileName - File name
   * @param filePath - Absolute path
   * @param projectPath - Project root
   * @param withBody - Include the raw body
   * @returns Ticket
   */
  private toTicket(
    result: Extract<ParseTicketResult, { ok: true }>,
    fileName: string,
    filePath: string,
    projectPath: string,
    withBody: boolean,
  ): ProjectTicket {
    const { file } = result;
    return {
      ...file.fields,
      fileName,
      filePath,
      projectPath,
      description: file.description,
      acceptance: file.acceptance,
      log: file.log,
      extra: file.extra,
      ...(withBody ? { body: file.body } : {}),
    };
  }

  /**
   * Check git tracking once per project per process (best-effort).
   *
   * @param projectPath - Project root
   */
  private async checkTracking(projectPath: string): Promise<void> {
    if (this.trackingChecked.has(projectPath)) return;
    this.trackingChecked.add(projectPath);
    try {
      const outcome = await this.ensureTracked(projectPath);
      if (outcome === 'unignored') {
        this.logger.info('Project .gitignore updated so .crewly/tickets/ is tracked', { projectPath });
      } else if (outcome === 'still-ignored') {
        this.logger.warn('.crewly/tickets/ is ignored by git and could not be re-included', { projectPath });
      }
    } catch (err) {
      this.logger.warn('Could not check git tracking of .crewly/tickets/', {
        projectPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
