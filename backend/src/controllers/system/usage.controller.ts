/**
 * Token usage stats, daily token caps and temporary boosts
 * (the Usage page, /usage).
 *
 * - `GET    /api/system/usage?days=7&groupBy=agent|team|project|workItem|runtime|model|day`
 *   — tokens and estimated API-equivalent cost (`costUsd`) over the last N local days (groupBy may be a comma list)
 * - `GET    /api/system/usage/caps?days=7` — caps, boosts and today's usage per agent / team
 * - `PUT    /api/system/usage/caps` — change caps (owner only)
 *   `{ defaultAgentCapTokens?, totalCapTokens?, agents?: { "<session>": n|null|"default" }, teams?: { "<teamId>": n|null } }`
 * - `POST   /api/system/usage/boost` — temporary boost (owner only)
 *   `{ scope: "team"|"agent"|"all", id?, extraTokens? | unlimited: true, until? }`
 * - `DELETE /api/system/usage/boost/:id` — end a boost early (owner only)
 * - `GET    /api/system/usage/claude-window?windows=five_hour,seven_day`
 *   — tokens spent inside the subscription's rolling windows, counted from
 *   every Claude Code transcript on this machine (the owner's own sessions
 *   included, which the ledger deliberately never attributes), plus the last
 *   refusal Anthropic sent. Tokens spent, not quota left: there is no
 *   endpoint for the latter. Defaults to the 5-hour window; the 7-day one is
 *   opt-in because it reads a week of transcripts.
 * - `POST   /api/system/usage/backfill` — rebuild missing ledger days from
 *   attributed Claude transcripts and ledger backups (owner only; dry run
 *   unless `dryRun: false`). `{ from, to, dryRun?, ledgerFiles? }`
 *   specs/2026-10-03-usage-ledger-durability.md
 *
 * Kept for older clients: `GET /api/system/spend` (= usage/caps),
 * `GET|PUT /api/system/spend/caps`. `POST /api/system/spend/raise` answers
 * 410 — raises are boosts now.
 *
 * Owner only: a request from an agent session gets 403 — an agent never
 * raises its own budget.
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module controllers/system/usage.controller
 */

import type { Request, Response, Router } from 'express';

import { CLAUDE_WINDOW_CONSTANTS, type ClaudeWindowId } from '../../constants.js';
import { buildClaudeWindowReport, type ClaudeWindowReport } from '../../services/usage/claude-window.service.js';
import { ensureOwnerCaller } from './system-control.controller.js';
import { getSpendCapService, SpendCapError, type SpendCapService } from '../../services/spend/spend-cap.service.js';
import { SPEND_CAP_CONSTANTS } from '../../constants.js';
import { parseGroupBy, UsageStatsService } from '../../services/usage/usage-stats.service.js';
import { TokenUsageService } from '../../services/monitoring/token-usage.service.js';
import { StorageService } from '../../services/core/storage.service.js';
import { TaskPoolService } from '../../services/task-pool/task-pool.service.js';
import { runUsageBackfill, UsageBackfillError, type UsageBackfillOptions, type UsageBackfillReport } from '../../services/usage/usage-backfill.service.js';
import { getClaudeTranscriptSync } from '../../services/monitoring/claude-transcript-sync.service.js';

/** Dependencies (tests inject fakes). */
export interface UsageControllerDeps {
  caps: () => Pick<SpendCapService, 'view' | 'getConfig' | 'setCaps' | 'boost' | 'removeBoost'> | null;
  stats: () => Pick<UsageStatsService, 'query'> | null;
  /** Ledger backfill (default: the backend's ledger and transcript cursors) */
  backfill?: (opts: UsageBackfillOptions) => Promise<UsageBackfillReport>;
  /** Subscription window report (default: read Claude Code's transcripts) */
  claudeWindow?: (windows?: ClaudeWindowId[]) => Promise<ClaudeWindowReport>;
}

/**
 * The backend's backfill: its ledger and the transcript sync's cursors.
 *
 * @param opts - Range, dry run, ledger backups
 * @returns Report
 */
export function defaultUsageBackfill(opts: UsageBackfillOptions): Promise<UsageBackfillReport> {
  return runUsageBackfill(
    { ledger: TokenUsageService.getInstance(), transcripts: () => getClaudeTranscriptSync().attributedTranscripts() },
    opts,
  );
}

const NOT_READY = 'Usage tracking is not ready yet — Crewly is still starting.';

let defaultStats: UsageStatsService | null = null;

/**
 * The backend's stats service, built from the process singletons.
 *
 * @returns Service
 */
export function getUsageStatsService(): UsageStatsService {
  if (!defaultStats) {
    defaultStats = new UsageStatsService({
      ledger: TokenUsageService.getInstance(),
      teams: async () =>
        (await StorageService.getInstance().getTeams()).map((t) => ({
          id: t.id,
          name: t.name,
          projectIds: t.projectIds ?? [],
          members: (t.members ?? []).map((m) => ({ session: m.sessionName, name: m.name })),
        })),
      projects: async () => (await StorageService.getInstance().getProjects()).map((p) => ({ id: p.id, name: p.name })),
      workItems: async () => TaskPoolService.getInstance().getAllItems(),
    });
  }
  return defaultStats;
}

/**
 * Send an error.
 *
 * @param res - Response
 * @param err - Error
 */
function fail(res: Response, err: unknown): void {
  const status = err instanceof SpendCapError ? err.status : 500;
  res.status(status).json({ success: false, error: err instanceof Error ? err.message : String(err) });
}

/**
 * Days query value.
 *
 * @param req - Request
 * @returns Days
 */
function daysOf(req: Request): number {
  const raw = Number(req.query.days ?? SPEND_CAP_CONSTANTS.DEFAULT_DAYS);
  return Number.isFinite(raw) ? raw : SPEND_CAP_CONSTANTS.DEFAULT_DAYS;
}

/**
 * Windows asked for, from `?windows=five_hour,seven_day`.
 *
 * Unknown names are dropped rather than rejected: a newer front end asking
 * for a window this build does not know should still get the ones it does.
 *
 * @param req - Request
 * @returns Window ids, or undefined to take the service default
 */
function windowsOf(req: Request): ClaudeWindowId[] | undefined {
  const raw = typeof req.query.windows === 'string' ? req.query.windows : '';
  const known = CLAUDE_WINDOW_CONSTANTS.WINDOWS.map((window) => window.id) as readonly string[];
  const asked = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is ClaudeWindowId => known.includes(value));
  return asked.length > 0 ? asked : undefined;
}

/**
 * The backend's own report: Claude Code's transcripts on this machine.
 *
 * @param windows - Windows asked for
 * @returns The report
 */
export function defaultClaudeWindow(windows?: ClaudeWindowId[]): Promise<ClaudeWindowReport> {
  return buildClaudeWindowReport({ windows });
}

/** Last report per window selection, with the time it was built. */
const windowCache = new Map<string, { at: number; report: Promise<ClaudeWindowReport> }>();

/** Forget every cached report (tests, and a settings change that moves the data directory). */
export function clearClaudeWindowCache(): void {
  windowCache.clear();
}

/**
 * Build the window report, at most once per {@link CLAUDE_WINDOW_CONSTANTS.CACHE_TTL_MS}.
 *
 * The 5-hour report costs ~180 ms and the 7-day one over a second; the
 * dashboard polls, so without a cache it would spend most of its time
 * re-reading the same transcripts.
 *
 * @param build - Report builder
 * @param windows - Windows asked for
 * @returns The report
 */
async function claudeWindow(
  build: (windows?: ClaudeWindowId[]) => Promise<ClaudeWindowReport>,
  windows: ClaudeWindowId[] | undefined,
): Promise<ClaudeWindowReport> {
  const key = (windows ?? []).join(',');
  const cached = windowCache.get(key);
  if (cached && Date.now() - cached.at < CLAUDE_WINDOW_CONSTANTS.CACHE_TTL_MS) return cached.report;

  const report = build(windows).catch((err: unknown) => {
    // a failed build must not be cached, or the next 30 s all fail with it
    windowCache.delete(key);
    throw err;
  });
  windowCache.set(key, { at: Date.now(), report });
  return report;
}

/**
 * Register the routes.
 *
 * @param router - The /api router
 * @param deps - Dependencies (default: the backend's)
 */
export function registerUsageRoutes(
  router: Router,
  deps: UsageControllerDeps = { caps: getSpendCapService, stats: getUsageStatsService, backfill: defaultUsageBackfill },
): void {
  router.get('/system/usage/claude-window', async (req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await claudeWindow(deps.claudeWindow ?? defaultClaudeWindow, windowsOf(req)) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/system/usage', async (req: Request, res: Response) => {
    const stats = deps.stats();
    if (!stats) {
      res.status(503).json({ success: false, error: NOT_READY });
      return;
    }
    try {
      res.json({ success: true, data: await stats.query(daysOf(req), parseGroupBy(req.query.groupBy)) });
    } catch (err) {
      fail(res, err);
    }
  });

  const capsView = async (req: Request, res: Response): Promise<void> => {
    const caps = deps.caps();
    if (!caps) {
      res.status(503).json({ success: false, error: NOT_READY });
      return;
    }
    try {
      res.json({ success: true, data: await caps.view(daysOf(req)) });
    } catch (err) {
      fail(res, err);
    }
  };
  router.get('/system/usage/caps', capsView);
  router.get('/system/spend', capsView);

  router.get('/system/spend/caps', (_req: Request, res: Response) => {
    const caps = deps.caps();
    if (!caps) {
      res.status(503).json({ success: false, error: NOT_READY });
      return;
    }
    res.json({ success: true, data: caps.getConfig() });
  });

  const setCaps = async (req: Request, res: Response): Promise<void> => {
    if (!ensureOwnerCaller(req, res, 'token cap change')) return;
    const caps = deps.caps();
    if (!caps) {
      res.status(503).json({ success: false, error: NOT_READY });
      return;
    }
    try {
      res.json({ success: true, data: await caps.setCaps(req.body ?? {}) });
    } catch (err) {
      fail(res, err);
    }
  };
  router.put('/system/usage/caps', setCaps);
  router.put('/system/spend/caps', setCaps);

  router.post('/system/usage/boost', async (req: Request, res: Response) => {
    if (!ensureOwnerCaller(req, res, 'usage boost')) return;
    const caps = deps.caps();
    if (!caps) {
      res.status(503).json({ success: false, error: NOT_READY });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const boost = await caps.boost({
        scope: b.scope as 'team' | 'agent' | 'all',
        id: typeof b.id === 'string' ? b.id : undefined,
        extraTokens: b.extraTokens,
        unlimited: b.unlimited === true,
        until: typeof b.until === 'string' ? b.until : undefined,
        by: 'owner',
      });
      res.json({ success: true, data: boost });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/system/usage/boost/:id', async (req: Request, res: Response) => {
    if (!ensureOwnerCaller(req, res, 'usage boost removal')) return;
    const caps = deps.caps();
    if (!caps) {
      res.status(503).json({ success: false, error: NOT_READY });
      return;
    }
    try {
      const removed = await caps.removeBoost(req.params.id);
      res.status(removed ? 200 : 404).json(removed ? { success: true, data: { id: req.params.id } } : { success: false, error: 'No such boost' });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/system/usage/backfill', async (req: Request, res: Response) => {
    if (!ensureOwnerCaller(req, res, 'usage backfill')) return;
    const backfill = deps.backfill ?? defaultUsageBackfill;
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const report = await backfill({
        from: String(b.from ?? ''),
        to: String(b.to ?? ''),
        dryRun: b.dryRun !== false,
        ledgerFiles: Array.isArray(b.ledgerFiles) ? (b.ledgerFiles as unknown[]).map(String) : undefined,
      });
      res.json({ success: true, data: report });
    } catch (err) {
      const status = err instanceof UsageBackfillError ? err.status : 500;
      res.status(status).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/system/spend/raise', (req: Request, res: Response) => {
    if (!ensureOwnerCaller(req, res, 'spend cap raise')) return;
    res.status(410).json({ success: false, error: 'Caps are in tokens now; raise one for today with POST /api/system/usage/boost { scope, id, extraTokens | unlimited }' });
  });
}
