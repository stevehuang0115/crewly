/**
 * Build the process ExperimentService from the real stores (issue #986):
 * project tickets / harness tickets (ship detection, ticket notes), agent
 * predictions, the wiki experiment log and the seo-ops metric fetcher.
 *
 * specs/experiment-cards.md
 *
 * @module services/experiments/experiment.wiring
 */

import { existsSync, promises as fs } from 'fs';
import path from 'path';
import { EXPERIMENT_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { findPackageRoot } from '../../utils/package-root.js';
import { PredictionCalibrationService } from '../ai/self-improvement/prediction-calibration.service.js';
import { WikiIngestService } from '../wiki/wiki-ingest.service.js';
import { parseTicketNumber } from '../../types/v2/ticket.types.js';
import type { Experiment, ExperimentTicketLink } from '../../types/experiment.types.js';
import { ExperimentService, type ExperimentOwnerNotice, type ExperimentServiceDeps, type TicketShipState } from './experiment.service.js';
import { createSeoOpsMetricFetcher } from './seo-ops-metric.fetcher.js';

/** A project ticket as the wiring reads it. */
interface TicketLike {
  status: string;
  updatedAt: string;
  /** `## Log` lines (`<ISO> · <actor> · <message>`) */
  log?: string[];
}

/** A harness ticket (request) as the wiring reads it. */
interface RequestLike {
  status: string;
  updatedAt: string;
  completedAt?: string;
  ticketNumber?: number;
}

/** The stores the wiring needs (narrow, so tests can fake them). */
export interface ExperimentWiringStores {
  /** Project path from an id / name / path */
  resolveProjectPath(ref: string): Promise<string>;
  getProjectTicket(projectPath: string, id: string): Promise<TicketLike | null>;
  appendProjectTicketLog(projectPath: string, id: string, note: string): Promise<void>;
  getRequest(id: string): Promise<RequestLike | null>;
  listRequests(): Promise<RequestLike[]>;
}

/**
 * When a project ticket moved to `done`, from its Log: the last
 * `<from> → done` transition line, or `created (done)`. The ticket's
 * `updatedAt` is NOT a ship time: any later write (a note, an experiment's
 * own ticket note) bumps it.
 *
 * @param log - The ticket's `## Log` lines
 * @returns ISO time of the done transition, or null when the log has none
 */
export function doneTransitionAt(log: readonly string[] | undefined): string | null {
  for (let i = (log?.length ?? 0) - 1; i >= 0; i -= 1) {
    const m = /^(\d{4}-\d{2}-\d{2}T[^\s]+) · .+? · (?:[a-z_]+ → done(?:\s|$)|created \(done\))/.exec(String(log?.[i] ?? ''));
    if (m && !Number.isNaN(Date.parse(m[1]))) return new Date(m[1]).toISOString();
  }
  return null;
}

/**
 * Whether the linked ticket shipped, and when: a project ticket in `done`
 * (dated by its done transition in the Log), or a harness ticket in `done`
 * (dated by `completedAt`). `at` is null when the ticket is done but the
 * time of that is not recorded; the caller must then get an explicit ship
 * time instead of guessing one.
 *
 * @param stores - Ticket stores
 * @param link - The link
 * @returns Ship state
 */
export async function ticketShipState(stores: ExperimentWiringStores, link: ExperimentTicketLink): Promise<TicketShipState> {
  if (link.kind === 'project') {
    const projectPath = await stores.resolveProjectPath(link.project ?? '');
    const t = await stores.getProjectTicket(projectPath, link.id);
    return t && t.status === 'done' ? { done: true, at: doneTransitionAt(t.log) } : { done: false };
  }
  let r = await stores.getRequest(link.id);
  if (!r) {
    const n = parseTicketNumber(link.id);
    r = n === null ? null : (await stores.listRequests()).find((x) => x.ticketNumber === n) ?? null;
  }
  return r && r.status === 'done' ? { done: true, at: r.completedAt ?? null } : { done: false };
}

/**
 * The vault an experiment's result goes to: the project's wiki when the
 * experiment rides on a project ticket and that project has a wiki, else the
 * global wiki.
 *
 * @param stores - Ticket stores
 * @param experiment - Experiment
 * @param home - Crewly home
 * @returns Vault path, or null when no vault exists
 */
export async function experimentVault(stores: Pick<ExperimentWiringStores, 'resolveProjectPath'>, experiment: Experiment, home: string): Promise<string | null> {
  const candidates: string[] = [];
  if (experiment.ticket?.kind === 'project' && experiment.ticket.project) {
    try {
      candidates.push(path.join(await stores.resolveProjectPath(experiment.ticket.project), '.crewly', 'wiki'));
    } catch {
      /* project gone: fall back to the global wiki */
    }
  }
  candidates.push(path.join(home, 'global-wiki'));
  return candidates.find((v) => existsSync(path.join(v, 'SCHEMA.md'))) ?? null;
}

/**
 * Dependencies from the real stores.
 *
 * @param stores - Ticket stores
 * @param notifyOwner - Owner notice path (false = not sent)
 * @param overrides - Test overrides
 * @returns Service dependencies
 */
export function createExperimentDeps(
  stores: ExperimentWiringStores,
  notifyOwner: (notice: ExperimentOwnerNotice) => Promise<boolean>,
  overrides: Partial<ExperimentServiceDeps> & { home?: string; packageRoot?: string } = {},
): ExperimentServiceDeps {
  const home = overrides.home ?? getCrewlyHomePath();
  const predictions = new PredictionCalibrationService();
  return {
    storeFile: path.join(home, EXPERIMENT_CONSTANTS.STORE_FILE),
    fetchMetric: createSeoOpsMetricFetcher({ packageRoot: overrides.packageRoot ?? packageRoot() }),
    ticketShipState: (link) => ticketShipState(stores, link),
    noteOnTicket: async (link, note) => {
      if (link.kind !== 'project') return;
      await stores.appendProjectTicketLog(await stores.resolveProjectPath(link.project ?? ''), link.id, note);
    },
    predictions: {
      make: (session, statement, confidence, resolveBy) => predictions.makePrediction(session, statement, confidence, resolveBy),
      resolve: (session, id, outcome, accurate) => predictions.resolvePrediction(session, id, outcome, accurate),
    },
    writeLog: async (experiment, entry) => {
      const vaultPath = await experimentVault(stores, experiment, home);
      if (!vaultPath) return false;
      const outcome = await WikiIngestService.getInstance().ingest({
        vaultPath,
        sourceType: 'experiment',
        sourceRef: experiment.traceId,
        sourceBody: entry,
        callerSession: experiment.createdBy,
        targetRelativePath: EXPERIMENT_CONSTANTS.WIKI_LOG_PATH,
      });
      return outcome.ok;
    },
    notifyOwner,
    fileExists: async (file) => fs.access(file).then(() => true, () => false),
    ...overrides,
  };
}

/**
 * The Crewly package root (where the seo-ops skill lives).
 *
 * @returns Absolute path
 */
function packageRoot(): string {
  try {
    return findPackageRoot(__dirname);
  } catch {
    return findPackageRoot(process.cwd());
  }
}

/**
 * Build the process service from the real stores.
 *
 * @param notifyOwner - Owner notice path (boot passes the Slack owner notice)
 * @returns A new service (not installed, not started)
 */
export async function createDefaultExperimentService(notifyOwner: (notice: ExperimentOwnerNotice) => Promise<boolean>): Promise<ExperimentService> {
  const { ProjectTicketService } = await import('../project-tickets/project-ticket.service.js');
  const { projectTicketWorkflow, ticketAutopilot } = await import('../../controllers/project-tickets/project-tickets.controller.js');
  const { processSummary } = await import('../project-tickets/ticket-autopilot-stats.js');
  const { RequestService } = await import('../v3/request.service.js');
  const tickets = ProjectTicketService.getInstance();
  const stores: ExperimentWiringStores = {
    resolveProjectPath: async (ref) => (await projectTicketWorkflow().resolveProject(ref)).path,
    getProjectTicket: (projectPath, id) => tickets.get(projectPath, id),
    appendProjectTicketLog: async (projectPath, id, note) => {
      await tickets.appendLog(projectPath, id, 'experiments', note);
    },
    getRequest: (id) => RequestService.getInstance().getById(id),
    listRequests: () => RequestService.getInstance().listAll(),
  };
  return new ExperimentService(
    createExperimentDeps(stores, notifyOwner, {
      // Autopilot-scoped cards (specs/2026-10-03-autopilot-experiments.md §3):
      // process numbers come from the ticket autopilot's stats.
      autopilot: {
        resolveProject: async (ref) => {
          const p = await projectTicketWorkflow().resolveProject(ref);
          return { id: p.id, name: p.name };
        },
        process: async (projectId, label, range) => processSummary(await ticketAutopilot().statsBetween(projectId, range.start, range.end, label)),
      },
    }),
  );
}
