/**
 * Ticket autopilot — the project's goal and open experiments for the goal
 * replan (specs/2026-10-04-autopilot-goal-replan.md), and the milestones
 * the daily retro reviews: experiment cards closed and OKRs completed on
 * the reviewed day (#985, specs/2026-10-03-autopilot-experiments.md §4).
 *
 * The goal comes from the two places project goals live today:
 * - the goals log `<project>/.crewly/goals/goals.md` (`set_goal` writes it,
 *   `get_goals` and the mission card read it): its entries of the last 30
 *   days, newest first (the log is append-only, so older ones are history);
 *   an entry whose heading carries a closed status word (`REACHED`,
 *   `SUPERSEDED`, `CANCELLED`, see `MEMORY_CONSTANTS.GOAL_STATUSES`) is not
 *   active, and a `REACHED` entry is a milestone of its day;
 * - active project OKRs: missions with `status: active`, this project's id,
 *   and approval absent or approved.
 *
 * The parsing is pure (unit-tested); {@link readProjectGoal} does the reads
 * and never throws (a read failure is "no goal").
 *
 * @module services/project-tickets/ticket-autopilot-goal
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { MEMORY_CONSTANTS, TICKET_AUTOPILOT_CONSTANTS } from '../../constants.js';
import { sortMissionsByPriority, type Mission } from '../../types/v2/mission.types.js';
import type { Experiment, ExperimentProcessSummary } from '../../types/experiment.types.js';
import { resolveProjectDataDir } from '../core/crewly-home.utils.js';
import { getMissionsDir } from '../v3/mission-paths.js';
import { localDateKey } from './ticket-autopilot-decision.js';

/** A project's active goal, as the replan brief quotes it. */
export interface ProjectGoal {
  /** Goal text (markdown, already capped) */
  text: string;
  /** Where it came from */
  sources: Array<'goals_log' | 'okr'>;
}

/** An open experiment card, as the replan brief lists it. */
export interface ReplanExperiment {
  id: string;
  title: string;
  hypothesis: string;
  status: string;
  /** When its result can be measured */
  dueAt?: string;
}

/** The part of a project the goal reader needs. */
export interface GoalProject {
  id: string;
  name: string;
  path: string;
}

/**
 * A milestone the daily retro reviews (#985): an experiment card of the
 * project closed (measured or cancelled), or a project OKR completed, on
 * the reviewed day.
 */
export interface RetroMilestone {
  kind: 'experiment_closed' | 'goal_completed';
  /** EXP-n, or the mission id */
  id: string;
  title: string;
  /** `done` / `cancelled` for a card, `completed` for a goal */
  status: string;
  /** When it closed (ISO) */
  closedAt: string;
  hypothesis?: string;
  verdict?: string;
  verdictReason?: string;
  /** The card's primary metric: what was measured and the window totals, baseline → result */
  outcome?: { metric: string; baseline: number | null; result: number | null };
  /** Process numbers of an autopilot card over its windows */
  process?: { baseline?: ExperimentProcessSummary; result?: ExperimentProcessSummary };
  /** Success criteria of a completed goal */
  criteria?: string[];
}

/** Local day of an ISO timestamp (the retro reviews local days). */
export type LocalDayOf = (iso: string) => string;

/** One `### …` entry of a goals log, parsed. */
export interface GoalsLogEntry {
  /** Heading timestamp (ISO as written), or null when the heading has none */
  at: string | null;
  /** Status word of the heading, lower-cased (`active` when absent) */
  status: string;
  /** Rest of the heading after the timestamp and status (`Set by owner`) */
  label: string;
  /** Entry body, trimmed */
  text: string;
}

/**
 * Entry heading: `[<iso>] <STATUS> — <rest>`; the status word and the dash
 * are optional. Hand-written synonyms of reached are accepted.
 */
const GOAL_ENTRY_HEAD = /^\[([^\]]+)\]\s*(?:(ACTIVE|REACHED|DONE|COMPLETED|MET|SUPERSEDED|CANCELLED|CANCELED)\b\s*(?:[—–:-]+\s*)?)?(.*)$/i;

/** Hand-written status words mapped onto the canonical ones. */
const GOAL_STATUS_SYNONYMS: Record<string, string> = {
  done: MEMORY_CONSTANTS.GOAL_STATUSES.REACHED,
  completed: MEMORY_CONSTANTS.GOAL_STATUSES.REACHED,
  met: MEMORY_CONSTANTS.GOAL_STATUSES.REACHED,
  canceled: MEMORY_CONSTANTS.GOAL_STATUSES.CANCELLED,
};

/** Statuses that take an entry out of the active goal. */
const CLOSED_GOAL_STATUSES: ReadonlySet<string> = new Set([
  MEMORY_CONSTANTS.GOAL_STATUSES.REACHED,
  MEMORY_CONSTANTS.GOAL_STATUSES.SUPERSEDED,
  MEMORY_CONSTANTS.GOAL_STATUSES.CANCELLED,
]);

/**
 * Parse a goals log into its `### …` entries, file order. An entry's body
 * ends at the next `###` entry or at a section heading (`## History`), so
 * a hand-kept file can group old entries under one. Entries with an empty
 * body are dropped. A file without entry headings has no entries (the
 * caller treats its text as one goal).
 *
 * @param raw - File contents
 * @returns Entries in file order
 */
export function parseGoalsLog(raw: string): GoalsLogEntry[] {
  const chunks = raw.split(/^###\s+/m);
  const out: GoalsLogEntry[] = [];
  for (const chunk of chunks.slice(1)) {
    const [head, ...body] = chunk.split(/\r?\n/);
    const section = body.findIndex((l) => /^##\s/.test(l));
    const text = (section >= 0 ? body.slice(0, section) : body).join('\n').trim();
    if (!text) continue;
    const m = GOAL_ENTRY_HEAD.exec(head.trim());
    if (!m) {
      out.push({ at: null, status: MEMORY_CONSTANTS.GOAL_STATUSES.ACTIVE, label: head.trim(), text });
      continue;
    }
    const word = (m[2] ?? '').toLowerCase();
    const status = word ? (GOAL_STATUS_SYNONYMS[word] ?? word) : MEMORY_CONSTANTS.GOAL_STATUSES.ACTIVE;
    out.push({ at: m[1], status, label: (m[3] ?? '').trim(), text });
  }
  return out;
}

/**
 * The retro's local-day function: {@link localDateKey} of the parsed
 * timestamp; an unparsable one maps to '' (matches no day).
 *
 * @param iso - ISO timestamp
 * @returns YYYY-MM-DD (local), or ''
 */
export function localDayOf(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? localDateKey(new Date(ms)) : '';
}

/**
 * Cap text at a number of characters.
 *
 * @param text - Text
 * @param max - Max characters
 * @returns Text, cut with an ellipsis when longer
 */
function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}

/**
 * The newest active entries of a goals log (`goals.md`), newest first.
 *
 * Entries are `### [<iso>] Set by <who>` blocks, optionally with a status
 * word after the timestamp (`### [<iso>] REACHED — Set by <who>`); an entry
 * with a closed status (reached, superseded, cancelled) is history, not the
 * goal. A file with only its `# Project Goals` header (or blank) has no
 * goal. Text without entry headers is taken as one goal.
 *
 * The log is append-only, so with a `window` only entries from the last
 * {@link TICKET_AUTOPILOT_CONSTANTS.REPLAN_GOAL_ACTIVE_DAYS} days count as
 * active; an entry (or a header-less file) without a readable date uses the
 * file's modification time, and is kept when that is unknown too.
 *
 * @param raw - File contents (null = no file)
 * @param maxEntries - Most entries kept
 * @param maxChars - Most characters returned
 * @param window - Clock, the file's mtime, and the active window (days)
 * @returns Goal markdown, or null when there is none
 */
export function goalFromGoalsLog(
  raw: string | null | undefined,
  maxEntries: number = TICKET_AUTOPILOT_CONSTANTS.REPLAN_GOAL_MAX_ENTRIES,
  maxChars: number = TICKET_AUTOPILOT_CONSTANTS.REPLAN_GOAL_MAX_CHARS,
  window?: { now: number; fileMtimeMs?: number | null; activeDays?: number },
): string | null {
  if (!raw) return null;
  const since = window ? window.now - (window.activeDays ?? TICKET_AUTOPILOT_CONSTANTS.REPLAN_GOAL_ACTIVE_DAYS) * 24 * 60 * 60 * 1000 : null;
  const active = (atMs: number | null): boolean => {
    if (since === null) return true;
    const t = atMs ?? window?.fileMtimeMs ?? null;
    return t === null || t >= since;
  };
  const chunks = raw.split(/^###\s+/m);
  const entries: string[] = [];
  for (const entry of parseGoalsLog(raw)) {
    if (CLOSED_GOAL_STATUSES.has(entry.status)) continue;
    const stamp = entry.at ? Date.parse(entry.at) : NaN;
    if (!active(Number.isFinite(stamp) ? stamp : null)) continue;
    const label = entry.at ? `${entry.at.slice(0, 10)}${entry.label ? `, ${entry.label.toLowerCase()}` : ''}` : entry.label;
    entries.push(`${label ? `(${label}) ` : ''}${entry.text}`);
  }
  if (entries.length === 0) {
    // Entries, but none active: no goal.
    if (chunks.length > 1) return null;
    if (!active(null)) return null;
    // No entry headers: the file itself (minus a leading `# …` title) is the goal.
    const text = chunks[0]
      .split(/\r?\n/)
      .filter((l, i) => !(i === 0 && /^#\s/.test(l)) && !/^\s*<!--.*-->\s*$/.test(l))
      .join('\n')
      .replace(/^#\s+Project Goals\s*$/im, '')
      .trim();
    return text ? cap(text, maxChars) : null;
  }
  const newest = entries.reverse().slice(0, Math.max(1, maxEntries));
  return cap(newest.join('\n\n'), maxChars);
}

/**
 * The active OKRs of a project: active missions with its id whose approval
 * is absent or approved, highest priority (then newest) first.
 *
 * @param missions - Missions read from the store(s)
 * @param projectId - Project id
 * @returns Active project missions
 */
export function activeProjectMissions(missions: Mission[], projectId: string): Mission[] {
  const seen = new Set<string>();
  return sortMissionsByPriority(
    missions.filter((m) => {
      if (!m || typeof m !== 'object' || typeof m.objective !== 'string' || seen.has(m.id)) return false;
      seen.add(m.id);
      return m.status === 'active' && m.projectId === projectId && (m.approval === undefined || m.approval?.state === 'approved');
    }),
  );
}

/**
 * Missions as goal text: the objective and its success criteria.
 *
 * @param missions - Active project missions
 * @param maxChars - Most characters
 * @returns Markdown, or null with none
 */
export function goalFromMissions(missions: Mission[], maxChars: number = TICKET_AUTOPILOT_CONSTANTS.REPLAN_GOAL_MAX_CHARS): string | null {
  if (missions.length === 0) return null;
  const blocks = missions.map((m) => {
    const lines = [`OKR: ${m.objective.trim()}`];
    for (const c of m.successCriteria ?? []) if (c && c.trim()) lines.push(`- ${c.trim()}`);
    return lines.join('\n');
  });
  return cap(blocks.join('\n\n'), maxChars);
}

/**
 * Combine the goals log and the OKRs into one goal.
 *
 * @param log - Goal text from goals.md
 * @param okr - Goal text from the missions
 * @returns Goal, or null when neither has one
 */
export function combineGoal(log: string | null, okr: string | null): ProjectGoal | null {
  const sources: ProjectGoal['sources'] = [];
  const parts: string[] = [];
  if (log) {
    sources.push('goals_log');
    parts.push(log);
  }
  if (okr) {
    sources.push('okr');
    parts.push(okr);
  }
  if (parts.length === 0) return null;
  return { text: cap(parts.join('\n\n'), TICKET_AUTOPILOT_CONSTANTS.REPLAN_GOAL_MAX_CHARS * 2), sources };
}

/**
 * Read every mission JSON file in a folder (missing folder = none).
 *
 * @param dir - Missions folder
 * @returns Parsed missions
 */
async function readMissionsDir(dir: string): Promise<Mission[]> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Mission[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8')) as Mission);
    } catch {
      // An unreadable mission file is skipped.
    }
  }
  return out;
}

/**
 * The project's goals log path (where GoalTrackingService writes it).
 *
 * @param projectPath - Project root
 * @returns `<project data dir>/goals/goals.md`
 */
function goalsLogPath(projectPath: string): string {
  return path.join(resolveProjectDataDir(projectPath), MEMORY_CONSTANTS.PATHS.GOALS_DIR, MEMORY_CONSTANTS.PATHS.GOALS_FILE);
}

/**
 * Modification time of a file or folder, or null.
 *
 * @param p - Path
 * @returns Epoch ms or null
 */
async function mtimeOf(p: string): Promise<number | null> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * When the project's goal last changed, from file times only (no reads):
 * the goals log, and the missions folders (a mission written or replaced
 * renames into its folder). Lifts a replan backoff. A change to another
 * project's mission in the shared store also counts: that only lifts a
 * backoff early, never holds one.
 *
 * @param project - Project path
 * @returns Epoch ms, or null when nothing exists
 */
export async function goalChangedAt(project: Pick<GoalProject, 'path'>): Promise<number | null> {
  const dirs = [...new Set([getMissionsDir(project.path), getMissionsDir()])];
  const times = (await Promise.all([goalsLogPath(project.path), ...dirs].map(mtimeOf))).filter((t): t is number => t !== null);
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * The project's active goal: the goals-log entries of the last
 * REPLAN_GOAL_ACTIVE_DAYS days (newest first) plus its active OKRs (the
 * project's missions folder and the shared store; their own status
 * decides). Never throws.
 *
 * @param project - Project id and path
 * @param now - Clock
 * @returns Goal, or null when the project has none
 */
export async function readProjectGoal(project: GoalProject, now: Date = new Date()): Promise<ProjectGoal | null> {
  let log: string | null = null;
  try {
    const file = goalsLogPath(project.path);
    const raw = await fs.readFile(file, 'utf-8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    log = goalFromGoalsLog(raw, undefined, undefined, { now: now.getTime(), fileMtimeMs: raw === null ? null : await mtimeOf(file) });
  } catch {
    log = null;
  }
  let okr: string | null = null;
  try {
    const dirs = [...new Set([getMissionsDir(project.path), getMissionsDir()])];
    const missions = (await Promise.all(dirs.map(readMissionsDir))).flat();
    okr = goalFromMissions(activeProjectMissions(missions, project.id));
  } catch {
    okr = null;
  }
  return combineGoal(log, okr);
}

/**
 * Open experiment cards (planned or running) of a project: its autopilot
 * scope is the project, or its ticket link names the project (id, name or
 * path).
 *
 * @param experiments - Every experiment
 * @param project - Project
 * @param max - Most returned
 * @returns Cards for the replan brief, newest first
 */
export function openExperimentsOf(
  experiments: Experiment[],
  project: GoalProject,
  max: number = TICKET_AUTOPILOT_CONSTANTS.REPLAN_MAX_EXPERIMENTS,
): ReplanExperiment[] {
  const ofProject = experimentOfProject(project);
  return experiments
    .filter((e) => (e.status === 'planned' || e.status === 'running') && ofProject(e))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, Math.max(0, max))
    .map((e) => ({ id: e.id, title: e.title, hypothesis: e.hypothesis, status: e.status, ...(e.dueAt ? { dueAt: e.dueAt } : {}) }));
}

/**
 * Whether an experiment card belongs to a project: its autopilot scope is
 * the project, or its ticket link names the project (id, name or path).
 *
 * @param project - Project
 * @returns Predicate over cards
 */
function experimentOfProject(project: GoalProject): (e: Experiment) => boolean {
  const refs = new Set([project.id, project.name.toLowerCase(), path.resolve(project.path)]);
  const names = (ref: string | undefined): boolean => {
    if (!ref) return false;
    return refs.has(ref) || refs.has(ref.toLowerCase()) || (ref.startsWith('/') && refs.has(path.resolve(ref)));
  };
  return (e) => e.autopilot?.projectId === project.id || (e.ticket?.kind === 'project' && names(e.ticket.project));
}

/**
 * When a closed card closed: its last `measured` / `cancelled` timeline
 * event, else `updatedAt`.
 *
 * @param e - Card
 * @returns ISO timestamp, or null when the card records none
 */
export function experimentClosedAt(e: Experiment): string | null {
  const events = Array.isArray(e.timeline) ? e.timeline : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && (ev.event === 'measured' || ev.event === 'cancelled') && ev.at) return ev.at;
  }
  return e.updatedAt || null;
}

/**
 * The project's experiment cards closed (measured or cancelled) on a local
 * day, oldest first — the retro's experiment milestones (#985).
 *
 * @param experiments - Every experiment
 * @param project - Project
 * @param day - Reviewed local day (YYYY-MM-DD)
 * @param localDay - Local day of a timestamp
 * @returns Milestones
 */
export function experimentsClosedOn(experiments: Experiment[], project: GoalProject, day: string, localDay: LocalDayOf = localDayOf): RetroMilestone[] {
  const ofProject = experimentOfProject(project);
  const closed: Array<{ e: Experiment; at: string }> = [];
  for (const e of experiments) {
    if (!e || (e.status !== 'done' && e.status !== 'cancelled') || !ofProject(e)) continue;
    const at = experimentClosedAt(e);
    if (at && localDay(at) === day) closed.push({ e, at });
  }
  closed.sort((a, b) => a.at.localeCompare(b.at));
  return closed.map(({ e, at }) => {
    const metric = [e.metric?.source, e.metric?.measure].filter(Boolean).join(':') + (e.metric?.page ? ` ${e.metric.page}` : '');
    const hasOutcome = e.baseline !== undefined || e.result !== undefined;
    const hasProcess = !!(e.autopilot?.processBaseline || e.autopilot?.processResult);
    return {
      kind: 'experiment_closed',
      id: e.id,
      title: e.title,
      status: e.status,
      closedAt: at,
      ...(e.hypothesis ? { hypothesis: e.hypothesis } : {}),
      ...(e.verdict ? { verdict: e.verdict } : {}),
      ...(e.verdictReason ? { verdictReason: e.verdictReason } : {}),
      ...(hasOutcome && metric ? { outcome: { metric, baseline: e.baseline?.total ?? null, result: e.result?.total ?? null } } : {}),
      ...(hasProcess
        ? {
            process: {
              ...(e.autopilot?.processBaseline ? { baseline: e.autopilot.processBaseline } : {}),
              ...(e.autopilot?.processResult ? { result: e.autopilot.processResult } : {}),
            },
          }
        : {}),
    };
  });
}

/**
 * The project's OKRs completed on a local day (a mission is `completed`
 * and was last updated that day — completion is its final write), oldest
 * first — the retro's goal milestones (#985).
 *
 * @param missions - Missions read from the store(s)
 * @param projectId - Project id
 * @param day - Reviewed local day
 * @param localDay - Local day of a timestamp
 * @returns Milestones
 */
export function goalsCompletedOn(missions: Mission[], projectId: string, day: string, localDay: LocalDayOf = localDayOf): RetroMilestone[] {
  const seen = new Set<string>();
  const out: RetroMilestone[] = [];
  for (const m of missions) {
    if (!m || typeof m !== 'object' || typeof m.objective !== 'string' || seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.status !== 'completed' || m.projectId !== projectId || !m.updatedAt || localDay(m.updatedAt) !== day) continue;
    const criteria = (m.successCriteria ?? []).filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim());
    out.push({ kind: 'goal_completed', id: m.id, title: m.objective.trim(), status: 'completed', closedAt: m.updatedAt, ...(criteria.length ? { criteria } : {}) });
  }
  return out.sort((a, b) => a.closedAt.localeCompare(b.closedAt));
}

/**
 * The goals-log entries marked reached on a local day — the retro's goal
 * milestones from `goals.md` (#985). The heading's timestamp is the day;
 * the body's first line is the goal, its `- ` lines the criteria or
 * evidence. Entries without a timestamp never match a day.
 *
 * @param raw - File contents (null = no file)
 * @param day - Reviewed local day
 * @param localDay - Local day of a timestamp
 * @returns Milestones, oldest first
 */
export function goalsReachedInLog(raw: string | null | undefined, day: string, localDay: LocalDayOf = localDayOf): RetroMilestone[] {
  if (!raw) return [];
  const out: RetroMilestone[] = [];
  for (const entry of parseGoalsLog(raw)) {
    if (entry.status !== MEMORY_CONSTANTS.GOAL_STATUSES.REACHED || !entry.at || localDay(entry.at) !== day) continue;
    const lines = entry.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const title = lines.find((l) => !/^[-*]\s/.test(l)) ?? lines[0];
    const criteria = lines.filter((l) => /^[-*]\s/.test(l)).map((l) => l.replace(/^[-*]\s+/, '').trim()).filter(Boolean);
    out.push({
      kind: 'goal_completed',
      id: `goal:${entry.at}`,
      title: cap(title, TICKET_AUTOPILOT_CONSTANTS.REPLAN_GOAL_MAX_CHARS),
      status: MEMORY_CONSTANTS.GOAL_STATUSES.REACHED,
      closedAt: entry.at,
      ...(criteria.length ? { criteria } : {}),
    });
  }
  return out.sort((a, b) => a.closedAt.localeCompare(b.closedAt));
}

/**
 * The milestones of a project's reviewed day: its experiment cards closed
 * that day, then its OKRs completed that day (the project's missions
 * folder and the shared store), then the goals its goals log marks reached
 * that day. Never throws; a read failure leaves that source out.
 *
 * @param project - Project id, name and path
 * @param day - Reviewed local day
 * @param experiments - Every experiment card
 * @param max - Most milestones returned
 * @returns Milestones, at most `max`
 */
export async function readRetroMilestones(
  project: GoalProject,
  day: string,
  experiments: Experiment[],
  max: number = TICKET_AUTOPILOT_CONSTANTS.RETRO_MAX_MILESTONES,
): Promise<RetroMilestone[]> {
  const cards = experimentsClosedOn(experiments, project, day);
  let goals: RetroMilestone[] = [];
  try {
    const dirs = [...new Set([getMissionsDir(project.path), getMissionsDir()])];
    const missions = (await Promise.all(dirs.map(readMissionsDir))).flat();
    goals = goalsCompletedOn(missions, project.id, day);
  } catch {
    goals = [];
  }
  let reached: RetroMilestone[] = [];
  try {
    const raw = await fs.readFile(goalsLogPath(project.path), 'utf-8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    reached = goalsReachedInLog(raw, day);
  } catch {
    reached = [];
  }
  return [...cards, ...goals, ...reached].slice(0, Math.max(0, max));
}
