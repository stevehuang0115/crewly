/**
 * Ticket autopilot — the project's goal and open experiments for the goal
 * replan (specs/2026-10-04-autopilot-goal-replan.md).
 *
 * The goal comes from the two places project goals live today:
 * - the goals log `<project>/.crewly/goals/goals.md` (`set_goal` writes it,
 *   `get_goals` and the mission card read it): its newest entries;
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
import { TICKET_AUTOPILOT_CONSTANTS } from '../../constants.js';
import { sortMissionsByPriority, type Mission } from '../../types/v2/mission.types.js';
import type { Experiment } from '../../types/experiment.types.js';
import { GoalTrackingService } from '../memory/goal-tracking.service.js';
import { getMissionsDir } from '../v3/mission-paths.js';

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
 * The newest entries of a goals log (`goals.md`), newest first.
 *
 * Entries are `### [<iso>] Set by <who>` blocks. A file with only its
 * `# Project Goals` header (or blank) has no goal. Text without entry
 * headers is taken as one goal.
 *
 * @param raw - File contents (null = no file)
 * @param maxEntries - Most entries kept
 * @param maxChars - Most characters returned
 * @returns Goal markdown, or null when there is none
 */
export function goalFromGoalsLog(
  raw: string | null | undefined,
  maxEntries: number = TICKET_AUTOPILOT_CONSTANTS.REPLAN_GOAL_MAX_ENTRIES,
  maxChars: number = TICKET_AUTOPILOT_CONSTANTS.REPLAN_GOAL_MAX_CHARS,
): string | null {
  if (!raw) return null;
  const chunks = raw.split(/^###\s+/m);
  const entries: string[] = [];
  for (const chunk of chunks.slice(1)) {
    const [head, ...body] = chunk.split(/\r?\n/);
    const text = body.join('\n').trim();
    if (!text) continue;
    const when = /^\[([^\]]+)\]\s*(.*)$/.exec(head.trim());
    const label = when ? `${when[1].slice(0, 10)}${when[2] ? `, ${when[2].trim().toLowerCase()}` : ''}` : head.trim();
    entries.push(`${label ? `(${label}) ` : ''}${text}`);
  }
  if (entries.length === 0) {
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
 * The project's active goal: the newest goals-log entries plus its active
 * OKRs (the project's missions folder and the shared store). Never throws.
 *
 * @param project - Project id and path
 * @returns Goal, or null when the project has none
 */
export async function readProjectGoal(project: GoalProject): Promise<ProjectGoal | null> {
  let log: string | null = null;
  try {
    log = goalFromGoalsLog(await GoalTrackingService.getInstance().getGoals(project.path));
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
  const refs = new Set([project.id, project.name.toLowerCase(), path.resolve(project.path)]);
  const names = (ref: string | undefined): boolean => {
    if (!ref) return false;
    return refs.has(ref) || refs.has(ref.toLowerCase()) || (ref.startsWith('/') && refs.has(path.resolve(ref)));
  };
  return experiments
    .filter((e) => (e.status === 'planned' || e.status === 'running') && (e.autopilot?.projectId === project.id || (e.ticket?.kind === 'project' && names(e.ticket.project))))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, Math.max(0, max))
    .map((e) => ({ id: e.id, title: e.title, hypothesis: e.hypothesis, status: e.status, ...(e.dueAt ? { dueAt: e.dueAt } : {}) }));
}
