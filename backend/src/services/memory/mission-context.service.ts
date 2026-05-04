/**
 * Mission Context Service — auto-injectable mission card for agent prompts.
 *
 * Builds a compact (≤2KB) markdown card that summarizes the active
 * project OKR, the team's most-relevant active missions, and the team
 * sub-OKR (if any) so every agent wakes with the answer to "what
 * mission am I serving right now?".
 *
 * Per Memory Phase 1 / Fix M1: today, agents must call `recall` or
 * `get_goals` explicitly to find the mission they're serving — and per
 * the architecture audit, an agent can finish a sprint without ever
 * reading it. This service closes that gap by feeding a tiny mission
 * card into prompt assembly automatically.
 *
 * Out of scope for Phase 1 (deferred to later phases):
 *   - Narrative summarization of mission state (no LLM round-trip here)
 *   - Vector embedding / semantic recall
 *   - Memory review queue / supersession
 *
 * @module services/memory/mission-context.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { GoalTrackingService } from './goal-tracking.service.js';
import {
  type Mission,
  sortMissionsByPriority,
} from '../../types/v2/mission.types.js';
import { MEMORY_CONSTANTS } from '../../constants.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Hard upper bound on the rendered mission card. The spec calls for
 * 1-2KB; we cap at 2KB and truncate by section priority (most-recent
 * status → oldest first) when over budget.
 */
export const MISSION_CONTEXT_HARD_CAP_BYTES = 2048;

/** Maximum lines extracted from `goals.md` for the project-OKR slice. */
const GOALS_MAX_LINES = 4;

/** Maximum active missions to surface per call (sorted by priority + recency). */
const MAX_MISSIONS = 2;

/** Maximum status updates surfaced under "Recent Mission Status". */
const MAX_STATUS_UPDATES = 3;

/** Maximum lines extracted from the team sub-OKR file. */
const TEAM_SUB_OKR_MAX_LINES = 4;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Inputs accepted by `getContextForAgent`.
 *
 * `projectPath` is the absolute path to the project root (the directory
 * containing `.crewly/`). `teamSlug` is the human-readable team slug
 * used to resolve `<slug>-team-sub-okr.md`; if omitted, the team-sub-OKR
 * section is skipped.
 */
export interface MissionContextRequest {
  /** Agent session id, used for logging only. */
  agentId: string;
  /** Absolute path to the project root that owns `.crewly/`. */
  projectPath: string;
  /** Team id whose missions should be surfaced (matches `Mission.ownerTeamId`). */
  teamId: string;
  /**
   * Optional ancestor team ids whose missions should ALSO be surfaced
   * to the agent — covers the OKR hierarchy case where a sub-team agent
   * needs to see the parent team / company-level mission they ladder up
   * to. Supplied by the caller (PromptBuilderService) which has team-
   * graph access; the service does no graph traversal of its own.
   */
  ancestorTeamIds?: string[];
  /**
   * Human-readable team slug used to find `<slug>-team-sub-okr.md`
   * under `.crewly/goals/`. If omitted, the team-sub-OKR section
   * is skipped.
   */
  teamSlug?: string;
  /** Optional id (informational, not used for filtering today). */
  projectId?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Builds a small markdown card describing the agent's mission context.
 *
 * Singleton, side-effect-free reads. All file IO is fail-soft: any
 * read or parse error skips the affected section but never throws into
 * the prompt-assembly path.
 *
 * @example
 * ```ts
 * const svc = MissionContextService.getInstance();
 * const card = await svc.getContextForAgent({
 *   agentId: 'crewly-product-leo-21a5477e',
 *   projectPath: '/Users/me/projects/crewly',
 *   teamId: '28a4ac10-...',
 *   teamSlug: 'product',
 * });
 * if (card) prompt += `\n${card}`;
 * ```
 */
export class MissionContextService {
  private static instance: MissionContextService | null = null;
  private readonly logger: ComponentLogger;
  private readonly goalService: GoalTrackingService;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger(
      'MissionContextService',
    );
    this.goalService = GoalTrackingService.getInstance();
  }

  /** Get the shared singleton instance. */
  public static getInstance(): MissionContextService {
    if (!MissionContextService.instance) {
      MissionContextService.instance = new MissionContextService();
    }
    return MissionContextService.instance;
  }

  /** Reset for tests. */
  public static clearInstance(): void {
    MissionContextService.instance = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Build the mission-context card for an agent.
   *
   * Returns the empty string when no signals are available — callers
   * should treat empty output as "skip the section entirely" rather
   * than rendering an empty heading.
   *
   * @param req - Request inputs
   * @returns A ≤2KB markdown card, or `''` when nothing is worth showing
   */
  public async getContextForAgent(req: MissionContextRequest): Promise<string> {
    const goalsLines = await this.loadProjectGoalsSlice(req.projectPath);
    // Filter accepts the agent's own team plus any ancestors (parent OKRs).
    // De-duped at the call site; service treats the resulting set as the
    // authoritative match list.
    const teamScope = uniqueNonEmpty([req.teamId, ...(req.ancestorTeamIds ?? [])]);
    const missions = await this.loadActiveTeamMissions(
      req.projectPath,
      teamScope,
    );
    const teamSubOkrLines = await this.loadTeamSubOkrSlice(
      req.projectPath,
      req.teamSlug,
    );
    const statusUpdates = collectRecentStatusUpdates(missions);

    if (
      goalsLines.length === 0 &&
      missions.length === 0 &&
      teamSubOkrLines.length === 0 &&
      statusUpdates.length === 0
    ) {
      this.logger.debug('No mission signals — emitting empty card', {
        agentId: req.agentId,
        teamId: req.teamId,
      });
      return '';
    }

    const card = renderMissionCard({
      goalsLines,
      missions: missions.slice(0, MAX_MISSIONS),
      teamSubOkrLines,
      statusUpdates: statusUpdates.slice(0, MAX_STATUS_UPDATES),
    });

    const capped = enforceHardCap(card, MISSION_CONTEXT_HARD_CAP_BYTES);
    this.logger.debug('Mission card built', {
      agentId: req.agentId,
      teamId: req.teamId,
      bytes: Buffer.byteLength(capped, 'utf-8'),
      missionCount: missions.length,
    });
    return capped;
  }

  // -------------------------------------------------------------------------
  // Internal readers (each one fail-soft — never throws)
  // -------------------------------------------------------------------------

  /**
   * Read up to `GOALS_MAX_LINES` non-empty, non-comment lines from
   * the project's `goals.md`. Returns `[]` when the file is missing.
   */
  private async loadProjectGoalsSlice(projectPath: string): Promise<string[]> {
    try {
      const raw = await this.goalService.getGoals(projectPath);
      if (!raw) return [];
      return extractMeaningfulLines(raw, GOALS_MAX_LINES);
    } catch (err) {
      this.logger.warn('Failed to load project goals.md', {
        projectPath,
        error: errMsg(err),
      });
      return [];
    }
  }

  /**
   * Read all `*.json` files under `<projectPath>/.crewly/missions/`,
   * filter to active missions whose `ownerTeamId` is in the supplied
   * `teamScope` (own team + any ancestor teams the caller passed in),
   * and sort by priority + recency. Returns `[]` on any error.
   */
  private async loadActiveTeamMissions(
    projectPath: string,
    teamScope: string[],
  ): Promise<Mission[]> {
    if (teamScope.length === 0) return [];
    const dir = path.join(projectPath, '.crewly', 'missions');
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      // Directory missing == no missions == empty section. Not an error.
      return [];
    }

    const scope = new Set(teamScope);
    const missions: Mission[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf-8');
        const parsed = JSON.parse(raw) as Mission;
        if (parsed.status === 'active' && scope.has(parsed.ownerTeamId)) {
          missions.push(parsed);
        }
      } catch (err) {
        this.logger.debug('Skipping unreadable mission file', {
          file,
          error: errMsg(err),
        });
      }
    }
    return sortMissionsByPriority(missions);
  }

  /**
   * Read the team sub-OKR file at
   * `<projectPath>/.crewly/goals/<teamSlug>-team-sub-okr.md`. Returns
   * `[]` when no slug, no file, or any read error.
   */
  private async loadTeamSubOkrSlice(
    projectPath: string,
    teamSlug: string | undefined,
  ): Promise<string[]> {
    if (!teamSlug) return [];
    const filePath = path.join(
      projectPath,
      '.crewly',
      MEMORY_CONSTANTS.PATHS.GOALS_DIR,
      `${teamSlug}-team-sub-okr.md`,
    );
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return extractMeaningfulLines(raw, TEAM_SUB_OKR_MAX_LINES);
    } catch {
      // Missing file is the common case — skip silently.
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Recent mission status entry — pulled from `mission.lastReviewSummary`,
 * ordered by `lastReviewAt` desc.
 */
export interface RecentMissionStatus {
  missionId: string;
  objective: string;
  summary: string;
  reviewedAt?: string;
}

/**
 * Collect the most recent status updates across the supplied missions.
 * A mission contributes at most one entry. Missions with no
 * `lastReviewSummary` are skipped. Result is sorted by `lastReviewAt`
 * descending; missions with no `lastReviewAt` sort last.
 */
export function collectRecentStatusUpdates(
  missions: Mission[],
): RecentMissionStatus[] {
  const updates: RecentMissionStatus[] = [];
  for (const m of missions) {
    if (!m.lastReviewSummary) continue;
    updates.push({
      missionId: m.id,
      objective: m.objective,
      summary: m.lastReviewSummary,
      reviewedAt: m.lastReviewAt,
    });
  }
  updates.sort((a, b) => {
    const ta = a.reviewedAt ? Date.parse(a.reviewedAt) : 0;
    const tb = b.reviewedAt ? Date.parse(b.reviewedAt) : 0;
    return tb - ta;
  });
  return updates;
}

/**
 * Extract up to `maxLines` "meaningful" lines from a markdown blob.
 *
 * Rules:
 *   - skip empty lines
 *   - skip standalone HTML/MD comments
 *   - keep headings, prose, list items
 *   - trim trailing whitespace
 *   - de-duplicate consecutive identical lines
 */
export function extractMeaningfulLines(
  raw: string,
  maxLines: number,
): string[] {
  const out: string[] = [];
  let lastPushed = '';
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (/^\s*<!--.*-->\s*$/.test(line)) continue;
    if (line === lastPushed) continue;
    out.push(line);
    lastPushed = line;
    if (out.length >= maxLines) break;
  }
  return out;
}

/**
 * Render the final mission card as markdown using the spec template.
 * Sections with no data are omitted entirely (no empty headings).
 */
export function renderMissionCard(args: {
  goalsLines: string[];
  missions: Mission[];
  teamSubOkrLines: string[];
  statusUpdates: RecentMissionStatus[];
}): string {
  const { goalsLines, missions, teamSubOkrLines, statusUpdates } = args;
  const sections: string[] = ['## Current Mission Context', ''];

  if (goalsLines.length > 0) {
    sections.push('Active Project OKR (90-day):');
    for (const line of goalsLines) sections.push(line);
    sections.push('');
  }

  if (missions.length > 0) {
    sections.push('Current Active Missions:');
    for (const m of missions) {
      sections.push(`- ${formatMissionLine(m)}`);
    }
    sections.push('');
  }

  if (teamSubOkrLines.length > 0) {
    sections.push("Your Team's Sub-OKR:");
    for (const line of teamSubOkrLines) sections.push(line);
    sections.push('');
  }

  if (statusUpdates.length > 0) {
    sections.push('Recent Mission Status:');
    for (const u of statusUpdates) {
      sections.push(`- ${formatStatusLine(u)}`);
    }
    sections.push('');
  }

  // Trim trailing blank line for tidiness
  while (sections.length > 0 && sections[sections.length - 1] === '') {
    sections.pop();
  }
  return sections.join('\n');
}

/**
 * Format one mission as a single line: priority + objective +
 * top-of-success-criteria summary.
 */
function formatMissionLine(m: Mission): string {
  const priority = m.priority ?? 'medium';
  const tail =
    m.successCriteria?.length > 0 ? ` — ${m.successCriteria[0]}` : '';
  return `[${priority}] ${m.objective}${tail}`;
}

/** Format one status update as a single bullet. */
function formatStatusLine(u: RecentMissionStatus): string {
  const date = u.reviewedAt ? u.reviewedAt.slice(0, 10) : '—';
  return `${date}: ${u.objective} — ${u.summary}`;
}

/**
 * Enforce the hard byte cap. If `card` already fits, returns it
 * unchanged. Otherwise truncates line-by-line from the bottom until
 * it fits, then appends a single ellipsis line so the card is
 * obviously truncated.
 */
export function enforceHardCap(card: string, maxBytes: number): string {
  if (Buffer.byteLength(card, 'utf-8') <= maxBytes) return card;
  const lines = card.split('\n');
  const ellipsis = '… (truncated to fit 2KB cap)';
  while (lines.length > 0) {
    lines.pop();
    const candidate = `${lines.join('\n')}\n${ellipsis}`;
    if (Buffer.byteLength(candidate, 'utf-8') <= maxBytes) {
      return candidate;
    }
  }
  // Even the heading didn't fit — return just the ellipsis.
  return ellipsis;
}

/** Stringify an unknown error for log fields. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Return the input array de-duplicated and stripped of empty / falsy
 * entries while preserving first-seen order.
 */
function uniqueNonEmpty(values: ReadonlyArray<string | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Module-level convenience: get the singleton in one call.
 */
export const getMissionContextService = (): MissionContextService =>
  MissionContextService.getInstance();
