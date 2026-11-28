/**
 * Team move exporter (source machine).
 *
 * Collects everything Crewly owns about ONE team into a staging directory,
 * writes a manifest with a hash for every file, runs the secret scan, and (in
 * {@link buildEncryptedPackage}) turns the staging directory into an encrypted
 * `tar.gz` stream.
 *
 * Package layout (POSIX paths):
 *
 *   manifest.json
 *   team/**                 the team's folder: config, prompts, norms, SOPs,
 *                           wiki vault, cron tasks
 *   agents/<session>/**     agent memory, standing answers, session summaries
 *   handover/<file>         newest handover notes per agent
 *   transcripts/<session>/  each member's latest Claude Code conversation,
 *                           resumed on the target (crewly#1344)
 *   records/*.json          task-pool items, decisions, chat channels and
 *                           rooms (with the Slack room's recent messages),
 *                           Slack channel mapping, scheduled messages
 *   projects/<id>/data/**   `<project>/.crewly/**` (or the package-tree stores)
 *
 * Not in it: credentials, tokens, runtime logins, logs, node_modules/build
 * output and repository working trees (the repo list in the manifest lets
 * the target clone them).
 *
 * @module services/team-move/team-move-exporter
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { create as tarCreate } from 'tar';
import { TEAM_MOVE_CONSTANTS } from '../../constants.js';
import type { Project, ScheduledMessage, Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TaskClaim } from '../../types/v2/claim.types.js';
import { safeReadJson } from '../../utils/file-io.utils.js';
import { collectSecretEnvValues, type SecretEnvValue } from '../../utils/secret-env.js';
import { PACKAGE_TREE_STORES, getCrewlyHomePath, isInsidePackageTree, resolveProjectDataDir } from '../core/crewly-home.utils.js';
import { readTeamChat } from './team-move-chat.js';
import { selectAdhocMappings } from './team-move-select.js';
import { collectAgentTranscripts } from './team-move-transcripts.js';
import { createEncryptStream, createHashTap } from './team-move-crypto.js';
import { StagingArea, walkFiles } from './team-move-fs.js';
import { collectCarry, describeLeft, resolveCarryLimits, type CarryLimits, type CollectCarryResult, type CollectedCarry } from './team-move-carry.js';
import { createBundle, estimateRepoBytes, formatBytes, resolveBundleLimits, type BundleLimits, type BundleMode } from './team-move-bundle.js';
import { describeBlockingRepos, displayRemote, inspectRepo as defaultInspectRepo, readRepoChanges, sanitizeRemote } from './team-move-git.js';
import {
  memoryStoreOf,
  TeamMoveSecretScanError,
  isRedactableFinding,
  isSkippableFinding,
  isRedactableRecord,
  redactRecordInStaging,
  redactTranscriptInStaging,
  scanStaging,
  type SecretFinding,
} from './team-move-secret-scan.js';
import {
  identityOf,
  resetWorkItemForTarget,
  selectDecisions,
  selectPoolItems,
  selectScheduledMessages,
  type DecisionLike,
  type TeamIdentity,
} from './team-move-select.js';
import type {
  CarryIndex,
  CloudManifestSummary,
  PackageFileEntry,
  PackageMember,
  PackageProject,
  PackageRepo,
  PreflightFinding,
  RepoPreflight,
  SkippedFile,
  SourcePreflightReport,
  TeamMoveManifest,
} from './team-move.types.js';

const C = TEAM_MOVE_CONSTANTS;

/** First path segments of a project's `.crewly` that are Crewly state, packaged before anything else. */
const CORE_PROJECT_DIRS: ReadonlySet<string> = new Set([
  'tickets',
  'missions',
  'requests',
  'triggers',
  'knowledge',
  'wiki',
  'goals',
  'tasks',
  'task-records',
  'escalations',
  'specs',
  'memory',
  'prompts',
  'agents-index.json',
]);

/** Folders of a project's `.crewly` that are scratch space, never packaged. */
const PROJECT_SCRATCH_DIRS: ReadonlySet<string> = new Set(['worktrees', 'tmp', 'cache']);

/** Connectors whose connection does not travel; found by name in the team's words. */
const CONNECTOR_HINTS: Readonly<Record<string, RegExp>> = {
  Google: /\bgoogle (?:drive|docs|sheets|slides|calendar)\b|\bgmail\b/,
  Zoho: /\bzoho\b/,
  Canva: /\bcanva\b/,
  WhatsApp: /\bwhatsapp\b/,
};

/** Thrown when a repository holds work that exists only on the source. */
export class TeamMoveBlockedError extends Error {
  constructor(readonly lines: string[]) {
    super(`Push this work before moving the team: ${lines.join('; ')}`);
    this.name = 'TeamMoveBlockedError';
  }
}

/** Collaborators of the exporter. */
export interface ExportDeps {
  /** Crewly home of this machine. */
  home?: string;
  getTeams: () => Promise<Team[]>;
  getProjects: () => Promise<Project[]>;
  crewlyVersion: string;
  source: { instanceId: string | null; deviceName: string | null };
  /** Exact secret values this machine holds (env, settings). */
  knownSecrets?: () => Promise<SecretEnvValue[]>;
  inspectRepo?: typeof defaultInspectRepo;
  now?: () => string;
  /** Caps for the working files of non-git projects; default from constants / env. */
  workLimits?: WorkFileLimits;
  /** Caps for carried uncommitted changes; default from constants / env. */
  carryLimits?: CarryLimits;
  /** Caps for repositories carried as git bundles; default from constants / env. */
  bundleLimits?: BundleLimits;
  /** Caps for project-local `.crewly` files; default from constants / env. */
  projectLimits?: ProjectFileLimits;
  /** Claude homes the members' transcripts may be under (tests); default: the default login and the accounts under the Crewly home. */
  claudeHomes?: readonly string[];
}

/** Size caps for project-local `.crewly` files. */
export interface ProjectFileLimits {
  /** All projects together. */
  totalBytes: number;
  /** One file. */
  fileBytes: number;
}

/**
 * The caps for project `.crewly` files: constants, overridable in megabytes by
 * `CREWLY_TEAM_MOVE_PROJECT_FILES_MAX_MB` and `CREWLY_TEAM_MOVE_PROJECT_FILE_MAX_MB`.
 *
 * @param env - Environment to read overrides from
 * @returns The caps in bytes
 */
export function resolveProjectFileLimits(env: NodeJS.ProcessEnv = process.env): ProjectFileLimits {
  const mb = (name: string, fallback: number): number => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n * 1024 * 1024) : fallback;
  };
  return { totalBytes: mb(C.PROJECT_FILES_MAX_MB_ENV, C.PROJECT_FILES_MAX_BYTES), fileBytes: mb(C.PROJECT_FILE_MAX_MB_ENV, C.PROJECT_FILE_MAX_BYTES) };
}

/** How one repository travels, decided before anything is built. */
interface RepoPlan {
  /** Uncommitted work (and, without a bundle, local commits flattened into patches) that travels as patches and files. */
  carry?: CollectedCarry;
  /** Raw outcome of collecting that work (preflight reports it even when carrying is not requested). */
  carryRes?: CollectCarryResult;
  /** Why the repository cannot be carried. */
  carryError?: string;
  /** The repository itself travels as a git bundle. */
  bundle?: { mode: BundleMode; estimate: number | null; possible: boolean; reason?: string; /** The remote exists but the target cannot read it. */ unreachable?: boolean };
  /** The move is not blocked by this repository. */
  resolved: boolean;
}

/** Size caps for the working files of projects that are not git repositories. */
export interface WorkFileLimits {
  /** All such projects together. */
  totalBytes: number;
  /** One file. */
  fileBytes: number;
}

/**
 * The caps for non-git project files: constants, overridable in megabytes by
 * `CREWLY_TEAM_MOVE_WORK_MAX_MB` and `CREWLY_TEAM_MOVE_WORK_FILE_MAX_MB`.
 *
 * @param env - Environment to read overrides from
 * @returns The caps in bytes
 */
export function resolveWorkFileLimits(env: NodeJS.ProcessEnv = process.env): WorkFileLimits {
  const mb = (name: string, fallback: number): number => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n * 1024 * 1024) : fallback;
  };
  return { totalBytes: mb(C.WORK_FILES_MAX_MB_ENV, C.WORK_FILES_MAX_BYTES), fileBytes: mb(C.WORK_FILE_MAX_MB_ENV, C.WORK_FILE_MAX_BYTES) };
}

/** Whether a repo record says the folder is not a git repository (its files travel instead of being cloned). */
export function isPlainFolder(repo: PackageRepo): boolean {
  return !!repo.note?.startsWith('not a git repository');
}

/** Options of one export. */
export interface ExportOptions {
  teamId: string;
  moveId: string;
  /** Directory the package is assembled in (created). */
  stagingDir: string;
  /** Move although a repository has uncommitted or unpushed work. */
  allowDirty?: boolean;
  /** Leave files with secrets out of the package instead of aborting (only free-form notes and project files). */
  skipFlagged?: boolean;
  /** Take uncommitted and unpushed work of git projects along (as patches) instead of requiring a push. */
  carryChanges?: boolean;
  /** Build and scan the package but never throw for secrets; report every finding (preflight). */
  dryRun?: boolean;
  /** Remotes the target machine cannot read (its `git ls-remote` failed): those repositories travel whole as a git bundle. */
  unreachableRemotes?: readonly string[];
}

/** A secret-scan finding with its owner-facing name. */
export interface LabelledFinding extends SecretFinding {
  label: string;
  /** "Leave flagged files behind" may drop it. */
  removable: boolean;
}

/** What an export produced. */
export interface ExportResult {
  manifest: TeamMoveManifest;
  staging: StagingArea;
  /** What Cloud receives with `package/init`. */
  summary: CloudManifestSummary;
  /** Lines describing uncommitted/unpushed work that was allowed through. */
  dirtyRepos: string[];
  /** Every file the secret scan flagged (also those dropped by `skipFlagged`). */
  scanFindings: LabelledFinding[];
}

/**
 * Prepare a team config for another machine: nothing is running there yet.
 *
 * @param raw - Parsed `config.json`
 * @returns Copy with runtime state cleared
 */
export function sanitizeTeamForMove(raw: Record<string, unknown>): Record<string, unknown> {
  const team: Record<string, unknown> = { ...raw };
  delete team['archived'];
  delete team['archivedAt'];
  delete team['movedTo'];
  const members = Array.isArray(team['members']) ? (team['members'] as Array<Record<string, unknown>>) : [];
  team['members'] = members.map((m) => {
    const next: Record<string, unknown> = { ...m, agentStatus: 'inactive', workingStatus: 'idle' };
    for (const key of ['readyAt', 'lastStartError', 'dropoutReason', 'lastActivityCheck', 'runtimeFallback']) delete next[key];
    return next;
  });
  return team;
}

/**
 * What the owner reads about a repository that travels in the package.
 *
 * @param repo - The repository record
 * @param bundle - Its bundle plan
 * @returns One line, e.g. `no remote — will be carried in the package (0.8 GB)`
 */
export function bundleMessage(repo: Pick<PackageRepo, 'remoteUrl' | 'unpushed'>, bundle: { mode: BundleMode; estimate: number | null; unreachable?: boolean }, targetName?: string): string {
  const size = bundle.estimate !== null ? ` (${formatBytes(bundle.estimate)})` : '';
  if (bundle.mode === 'full' && bundle.unreachable) {
    return `${targetName ?? 'the target machine'} can't reach this private repo; it will be carried in the package${size}. Log in to GitHub on ${targetName ?? 'that machine'} later to push/pull.`;
  }
  if (bundle.mode === 'full') return `no remote — will be carried in the package${size}`;
  return `${repo.unpushed} commit${repo.unpushed === 1 ? '' : 's'} not pushed — will be carried in the package as a git bundle${size}`;
}

/** Escape a string for use in a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The exporter. */
export class TeamMoveExporter {
  private readonly home: string;
  private readonly now: () => string;
  private readonly inspect: typeof defaultInspectRepo;

  constructor(private readonly deps: ExportDeps) {
    this.home = deps.home ?? getCrewlyHomePath();
    this.now = deps.now ?? (() => new Date().toISOString());
    this.inspect = deps.inspectRepo ?? defaultInspectRepo;
  }

  /** Whether a repo record is a git repository with at least one commit. */
  private hasCommits(r: PackageRepo): boolean {
    return !!r.headSha && !r.note?.startsWith('not a git repository') && !r.note?.startsWith('project folder does not exist');
  }

  /** Whether a repository holds work the remote (if any) lacks. */
  private needsWork(r: PackageRepo): boolean {
    return r.dirty || r.unpushed > 0;
  }

  private async planBundle(mode: BundleMode, repoPath: string, limits: BundleLimits): Promise<NonNullable<RepoPlan['bundle']>> {
    // A full bundle is about the size of the object store; the size of an
    // unpushed-commits bundle cannot be known cheaply and is checked once built.
    const estimate = mode === 'full' ? await estimateRepoBytes(repoPath) : null;
    if (estimate !== null && estimate > limits.repoBytes) {
      return { mode, estimate, possible: false, reason: `the repository is about ${formatBytes(estimate)}, over the ${formatBytes(limits.repoBytes)} limit for carrying it (raise ${C.BUNDLE_REPO_MAX_MB_ENV} to allow it)` };
    }
    return { mode, estimate, possible: true };
  }

  /**
   * Decide how each repository travels.
   *
   * - No remote: the repository is carried as a full git bundle plus its
   *   working-tree changes (always; there is nothing to clone).
   * - Remote, nothing local: cloned on the target.
   * - Remote, local work and `assess`: uncommitted work and local commits are
   *   flattened into patches when that fits; otherwise the unpushed commits
   *   travel as a git bundle and the working-tree changes as patches on top.
   *
   * @param repos - Inspected repositories
   * @param assess - Also assess carrying for repositories that have a remote
   * @returns Plan by project id
   */
  private async planRepos(repos: PackageRepo[], assess: boolean, unreachableRemotes: readonly string[] = []): Promise<Map<string, RepoPlan>> {
    const unreachable = new Set(unreachableRemotes.map(sanitizeRemote));
    const carryLimits = this.deps.carryLimits ?? resolveCarryLimits();
    const bundleLimits = this.deps.bundleLimits ?? resolveBundleLimits();
    const plans = new Map<string, RepoPlan>();
    let bundleTotal = 0;
    for (const r of repos) {
      if (!this.hasCommits(r)) {
        plans.set(r.projectId, { resolved: false });
        continue;
      }
      const cannotClone = !!r.remoteUrl && unreachable.has(sanitizeRemote(r.remoteUrl));
      if (!r.remoteUrl || cannotClone || (assess && this.needsWork(r))) {
        let plan: RepoPlan | null = null;
        if (r.remoteUrl && !cannotClone) {
          const flat = await collectCarry(r.path, carryLimits);
          if (flat.ok && flat.carry.left.length === 0) plan = { carry: flat.carry, carryRes: flat, resolved: true };
          else if (r.unpushed === 0) plan = { carryRes: flat, carryError: flat.ok ? describeLeft(flat.carry.left) : flat.reason, resolved: false };
        }
        if (!plan) {
          const mode: BundleMode = r.remoteUrl && !cannotClone ? 'unpushed' : 'full';
          const bundle = await this.planBundle(mode, r.path, bundleLimits);
          if (cannotClone) bundle.unreachable = true;
          if (bundle.possible && bundle.estimate !== null && bundleTotal + bundle.estimate > bundleLimits.totalBytes) {
            bundle.possible = false;
            bundle.reason = `the repositories to carry total about ${formatBytes(bundleTotal + bundle.estimate)}, over the ${formatBytes(bundleLimits.totalBytes)} limit (raise ${C.BUNDLES_MAX_MB_ENV} to allow it)`;
          }
          if (!bundle.possible) {
            plan = { bundle, carryError: bundle.reason, resolved: false };
          } else {
            bundleTotal += bundle.estimate ?? 0;
            const res = await collectCarry(r.path, carryLimits, { atHead: true });
            const ok = res.ok && res.carry.left.length === 0;
            plan = {
              bundle,
              carryRes: res,
              ...(res.ok && ok ? { carry: res.carry } : {}),
              ...(ok ? {} : { carryError: res.ok ? describeLeft(res.carry.left) : res.reason }),
              resolved: ok,
            };
          }
        }
        plans.set(r.projectId, plan);
      } else {
        plans.set(r.projectId, { resolved: false });
      }
    }
    return plans;
  }

  /** Record the size of each repository that will be cloned on the target, so it can scale the clone's time limit. */
  private async recordSizes(repos: PackageRepo[]): Promise<void> {
    for (const r of repos) {
      if (!r.remoteUrl || r.bundle || !r.headSha) continue;
      const bytes = await estimateRepoBytes(r.path);
      if (bytes !== null && bytes > 0) r.sizeBytes = bytes;
    }
  }

  /** Put a plan's outcome on the repo record (what `check` and the manifest show). */
  private annotate(repo: PackageRepo, plan: RepoPlan): void {
    if (plan.bundle && plan.resolved) {
      repo.bundle = { mode: plan.bundle.mode, bytes: plan.bundle.estimate ?? 0, ...(plan.bundle.unreachable ? { why: 'remote_unreachable' as const } : {}) };
      repo.note = bundleMessage(repo, plan.bundle);
    }
    if (plan.carryError) repo.carryError = plan.carryError;
  }

  /**
   * Check, before anything is built, that no repository holds work only this
   * machine has. Used by the REST entry point so the owner learns what to
   * push before a move is even requested. A repository without a remote does
   * not block: it is carried in the package as a git bundle (its record says
   * "no remote — will be carried in the package (x GB)"), unless it is over
   * the size caps.
   *
   * @param teamId - Team to move
   * @returns The repos and the lines that block the move
   */
  async checkRepos(teamId: string): Promise<{ repos: PackageRepo[]; blocking: string[] }> {
    const team = await this.requireTeam(teamId);
    const projects = await this.teamProjects(team);
    const repos = await Promise.all(projects.map((p) => this.inspect({ id: p.id, name: p.name, path: p.path })));
    // A repository without a remote travels in the package, so it does not block.
    const plans = await this.planRepos(repos, false);
    for (const r of repos) this.annotate(r, plans.get(r.projectId)!);
    return { repos, blocking: describeBlockingRepos(repos.filter((r) => !plans.get(r.projectId)!.resolved)) };
  }

  /** The heavy part of the last preflight (package dry run, secret scan), reused while nothing changed. */
  private heavy: { key: string; at: number; scan: NonNullable<SourcePreflightReport['scan']>; sizeBytes: number; requiredTools: string[]; requiredRuntimes: string[]; requiredConnectors: string[] } | null = null;

  /**
   * Everything the owner should know before a move, read without changing
   * anything: per repository the uncommitted and unpushed work (counts and the
   * first files), whether it could be carried instead of pushed, then a dry
   * run of the package for the secret scan, its size and the tools it needs.
   * The dry run is reused for a couple of minutes while the repositories look
   * the same, so a live checklist can refresh often.
   *
   * @param input - Team, whether carrying is wanted, a scratch directory, whether to ignore the cached dry run, and whether to skip it altogether (`quick`)
   * @returns The report
   */
  async preflight(input: { teamId: string; carryChanges?: boolean; stagingDir: string; force?: boolean; ttlMs?: number; quick?: boolean; unreachableRemotes?: readonly string[]; targetName?: string }): Promise<SourcePreflightReport> {
    const team = await this.requireTeam(input.teamId);
    const projects = await this.teamProjects(team);
    const inspected = await Promise.all(projects.map((p) => this.inspect({ id: p.id, name: p.name, path: p.path })));
    const plans = await this.planRepos(inspected, true, input.unreachableRemotes);

    const repos: RepoPreflight[] = [];
    for (const r of inspected) {
      const isRepo = !r.note?.startsWith('not a git repository') && !r.note?.startsWith('project folder does not exist');
      const changes = isRepo && (r.dirty || r.unpushed > 0) ? await readRepoChanges(r.path) : { modified: 0, untracked: 0, files: [] };
      const plan = plans.get(r.projectId)!;
      let carry: RepoPreflight['carry'] = null;
      if (isRepo && (r.dirty || r.unpushed > 0)) {
        const res = plan.carryRes;
        if (!res) carry = { possible: false, files: 0, bytes: 0, flattenedCommits: 0, reason: plan.carryError ?? 'this repository cannot be carried' };
        else {
          carry = res.ok
            ? { possible: res.carry.left.length === 0, files: res.carry.patches.length + res.carry.untracked.length, bytes: res.carry.bytes, flattenedCommits: res.carry.flattenedCommits, ...(res.carry.left.length ? { reason: describeLeft(res.carry.left) } : {}) }
            : { possible: false, files: 0, bytes: 0, flattenedCommits: 0, reason: res.reason };
        }
      }
      const bundle: RepoPreflight['bundle'] = plan.bundle
        ? {
            mode: plan.bundle.mode,
            bytes: plan.bundle.estimate,
            possible: plan.bundle.possible,
            ...(plan.bundle.reason ? { reason: plan.bundle.reason } : {}),
            message: plan.bundle.possible ? bundleMessage(r, plan.bundle, input.targetName) : `${plan.bundle.unreachable ? 'the target cannot reach the remote' : r.remoteUrl ? 'commits not pushed' : 'no remote'} — cannot be carried: ${plan.bundle.reason}`,
          }
        : null;
      const top = changes.files.slice(0, C.PREFLIGHT_TOP_FILES);
      repos.push({
        projectId: r.projectId,
        projectName: r.projectName,
        path: r.path,
        isRepo,
        branch: r.branch,
        remote: displayRemote(r.remoteUrl),
        ...(r.remoteUrl ? { remoteUrl: sanitizeRemote(r.remoteUrl) } : {}),
        ...(plan.bundle?.unreachable ? { remoteUnreachable: true } : {}),
        noRemote: isRepo && !r.remoteUrl,
        modified: changes.modified,
        untracked: changes.untracked,
        // A repo that is dirty by status but whose files could not be listed still counts as one change.
        ...(r.dirty && changes.modified + changes.untracked === 0 ? { modified: 1 } : {}),
        unpushed: r.unpushed,
        topFiles: top,
        filesTruncated: changes.files.length > top.length,
        carry,
        bundle,
      });
    }

    const key = JSON.stringify([team.id, !!input.carryChanges, [...(input.unreachableRemotes ?? [])].sort(), inspected.map((r, i) => [r.path, r.headSha, r.dirty, r.unpushed, repos[i]!.modified, repos[i]!.untracked, repos[i]!.topFiles.map((f) => f.path)])]);
    const ttl = input.ttlMs ?? C.PREFLIGHT_SCAN_TTL_MS;
    let heavy = !input.force && this.heavy && this.heavy.key === key && Date.now() - this.heavy.at < ttl ? this.heavy : null;
    if (!heavy && !input.quick) {
      const staging = path.resolve(input.stagingDir);
      try {
        const result = await this.export({ teamId: team.id, moveId: `preflight-${Date.now()}`, stagingDir: staging, allowDirty: true, carryChanges: !!input.carryChanges, dryRun: true, unreachableRemotes: input.unreachableRemotes });
        const findings: PreflightFinding[] = result.scanFindings.slice(0, C.PREFLIGHT_MAX_FINDINGS).map((f) => ({ file: f.label, matches: f.matches, removable: f.removable }));
        heavy = {
          key,
          at: Date.now(),
          scan: { filesScanned: result.manifest.secretScan.filesScanned, findings },
          sizeBytes: result.manifest.totalBytes,
          requiredTools: result.manifest.requiredTools,
          requiredRuntimes: result.manifest.requiredRuntimes,
          requiredConnectors: result.manifest.requiredConnectors ?? [],
        };
        this.heavy = heavy;
      } finally {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    return {
      checkedAt: this.now(),
      teamId: team.id,
      teamName: team.name,
      crewlyVersion: this.deps.crewlyVersion,
      members: team.members.length,
      repos,
      scan: heavy?.scan ?? null,
      sizeBytes: heavy?.sizeBytes ?? null,
      requiredTools: heavy?.requiredTools ?? [],
      requiredRuntimes: heavy?.requiredRuntimes ?? [],
      requiredConnectors: heavy?.requiredConnectors ?? [],
      carryRequested: !!input.carryChanges,
    };
  }

  private async requireTeam(teamId: string): Promise<Team> {
    const team = (await this.deps.getTeams()).find((t) => t.id === teamId);
    if (!team) throw new Error(`team ${teamId} not found on this machine`);
    if (team.members.length === 0) throw new Error(`team ${team.name} has no members`);
    return team;
  }

  private async teamProjects(team: Team): Promise<Project[]> {
    const all = await this.deps.getProjects();
    return team.projectIds.map((id) => all.find((p) => p.id === id)).filter((p): p is Project => !!p);
  }

  /**
   * Collect, scan and describe the package.
   *
   * @param options - Team, move, staging directory, policy flags
   * @returns Manifest, staging area and the Cloud summary
   * @throws TeamMoveBlockedError for unpushed work; TeamMoveSecretScanError for secrets
   */
  async export(options: ExportOptions): Promise<ExportResult> {
    const team = await this.requireTeam(options.teamId);
    const projects = await this.teamProjects(team);
    const id = identityOf(team);

    const repos = await Promise.all(projects.map((p) => this.inspect({ id: p.id, name: p.name, path: p.path })));
    // Work that can travel in the package no longer blocks the move: uncommitted
    // changes, and whole repositories that have no remote (git bundle).
    const plans = await this.planRepos(repos, !!options.carryChanges, options.unreachableRemotes);
    const carried = new Map<string, CollectedCarry>();
    for (const repo of repos) {
      const plan = plans.get(repo.projectId)!;
      this.annotate(repo, plan);
      // A bundled repository with a clean working tree has nothing to patch.
      if (plan.carry && (!plan.bundle || plan.carry.patches.length + plan.carry.untracked.length > 0)) carried.set(repo.projectId, plan.carry);
    }
    await this.recordSizes(repos);
    const blocking = describeBlockingRepos(repos.filter((r) => !plans.get(r.projectId)!.resolved));
    if (blocking.length > 0 && !options.allowDirty) throw new TeamMoveBlockedError(blocking);

    const staging = new StagingArea(path.resolve(options.stagingDir));
    await staging.init();
    const carriedLost = await this.writeCarry(staging, carried);

    const counts: Record<string, number> = {};
    const bump = (key: string, n = 1): void => {
      counts[key] = (counts[key] ?? 0) + n;
    };

    // 1. The team's folder (config, prompts, norms, SOPs, wiki vault, cron tasks).
    const teamDir = path.join(this.home, 'teams', team.id);
    const rawConfig = await safeReadJson<Record<string, unknown> | null>(path.join(teamDir, 'config.json'), null);
    if (!rawConfig) throw new Error(`team ${team.name} has no config.json`);
    await staging.writeJson('team/config.json', sanitizeTeamForMove(rawConfig));
    for await (const f of walkFiles(teamDir)) {
      if (f.rel === 'config.json') continue;
      await staging.copyIn(f.abs, `team/${f.rel}`);
      const top = f.rel.split('/')[0]!;
      if (top === 'wiki') bump('wikiPages');
      else if (top === 'norms' || top === 'sops') bump('normsAndSops');
      else if (top === 'prompts') bump('prompts');
      else if (f.rel === 'cron-tasks.json') bump('cronTaskFiles');
    }
    bump('members', team.members.length);
    const cron = await safeReadJson<{ tasks?: unknown[] }>(path.join(teamDir, 'cron-tasks.json'), {});
    if (Array.isArray(cron.tasks)) counts['cronTasks'] = cron.tasks.length;
    if (Array.isArray(team.triggers)) counts['teamTriggers'] = team.triggers.length;

    // 2. Agent memory, standing answers and session summaries.
    for (const session of id.sessions) {
      for await (const f of walkFiles(path.join(this.home, 'agents', session))) {
        await staging.copyIn(f.abs, `agents/${session}/${f.rel}`);
        bump('agentFiles');
        if (f.rel.startsWith('sessions/')) bump('sessionSummaries');
      }
    }

    // 3. Newest handover notes per agent.
    const handoverDir = path.join(this.home, 'handover');
    const handoverNames = await fs.readdir(handoverDir).catch(() => [] as string[]);
    for (const session of id.sessions) {
      const own = new RegExp(`^${escapeRegExp(session)}-(?:\\d{4}-|restart-|runtime-)`);
      const matching = [];
      for (const name of handoverNames) {
        if (!own.test(name) || !name.endsWith('.md')) continue;
        const st = await fs.stat(path.join(handoverDir, name)).catch(() => null);
        if (st?.isFile()) matching.push({ name, mtime: st.mtimeMs });
      }
      matching.sort((a, b) => b.mtime - a.mtime);
      for (const h of matching.slice(0, C.HANDOVERS_PER_AGENT)) {
        await staging.copyIn(path.join(handoverDir, h.name), `handover/${h.name}`);
        bump('handoverNotes');
      }
    }

    // 3b. Each member's latest Claude Code conversation (crewly#1344): what the
    // agent remembers by. Over the cap or unreadable → listed, and the agent
    // starts on the target from its handover note as before.
    const conversations = await collectAgentTranscripts({
      home: this.home,
      members: team.members,
      copyIn: (abs, rel) => staging.copyIn(abs, rel),
      ...(this.deps.claudeHomes ? { claudeHomes: this.deps.claudeHomes } : {}),
    });
    counts['conversations'] = conversations.filter((c) => c.file).length;

    // 4. Records from the global stores.
    await this.collectRecords(staging, id, team, counts);

    // 5. Project-local Crewly data, within the size caps.
    const allTeams = await this.deps.getTeams();
    const packageProjects = await this.collectProjects(staging, projects, allTeams, team.id, counts);
    await this.collectWorkFiles(staging, repos, packageProjects, counts);

    // 6. Required tools and runtimes.
    const { tools: requiredTools, connectors: requiredConnectors } = await this.detectNeeds(staging, team);
    const requiredRuntimes = [...new Set(team.members.map((m) => m.runtimeType).filter(Boolean))].sort();

    // 7. Secret scan: nothing leaves the machine with a credential in it.
    const known = this.deps.knownSecrets ? await this.deps.knownSecrets() : collectSecretEnvValues(process.env);
    // Bundles are not text-scanned: they are binary packs (history that already lives in git), encrypted for the target.
    const scan = await scanStaging(staging, staging.files(), known, (p) => p.endsWith(`/${C.BUNDLE_FILE}`));
    // Conversation transcripts, the JSON records (chat channels, tasks,
    // decisions) and the projects' memory stores are redacted in the package
    // copy rather than stopping the move or being left out: the member resumes on the target with the keys it
    // had read masked. A transcript that still matches afterwards stays a
    // finding. Never on a dry run (the preview reports what was found).
    let redactedFiles = 0;
    if (!options.dryRun) {
      const stillFlagged: SecretFinding[] = [];
      for (const finding of scan.findings) {
        if (!isRedactableFinding(finding.path)) {
          stillFlagged.push(finding);
          continue;
        }
        const store = memoryStoreOf(finding.path);
        const bytesBefore = staging.files().find((e) => e.path === finding.path)?.bytes ?? 0;
        const wholeFile = isRedactableRecord(finding.path) || store !== null;
        const { entry, redactions, residual } = await (wholeFile ? redactRecordInStaging : redactTranscriptInStaging)(staging, finding.path, known);
        // Judged on the parsed strings: the raw JSON text of a masked quoted value still looks like a secret.
        if (residual > 0) stillFlagged.push({ path: finding.path, matches: residual });
        else {
          redactedFiles += 1;
          const project = store ? packageProjects.find((p) => p.id === store.projectId) : undefined;
          if (project && store) {
            // Named in the manifest so the target says which memory arrived masked.
            project.redacted = [...(project.redacted ?? []), { path: store.path, redactions }];
            project.bytes += entry.bytes - bytesBefore;
          }
        }
      }
      scan.findings = stillFlagged;
    }
    const scanFindings = this.labelFindings(scan.findings, projects, carried);
    let excludedFiles = 0;
    if (scan.findings.length > 0 && !options.dryRun) {
      const removable = scan.findings.filter((f) => isSkippableFinding(f.path));
      if (!options.skipFlagged || removable.length !== scan.findings.length) throw new TeamMoveSecretScanError(scan.findings);
      for (const finding of removable) {
        const bytes = staging.files().find((e) => e.path === finding.path)?.bytes ?? 0;
        await staging.remove(finding.path);
        excludedFiles += 1;
        const projectMatch = /^projects\/([^/]+)\/(data|files)\/(.*)$/.exec(finding.path);
        const project = projectMatch ? packageProjects.find((p) => p.id === projectMatch[1]) : undefined;
        if (project && projectMatch) {
          const skipped: SkippedFile = { path: projectMatch[3]!, bytes, reason: 'secret_scan' };
          if (projectMatch[2] === 'files' && project.work) {
            project.work.skipped.push(skipped);
            project.work.files -= 1;
            project.work.bytes -= bytes;
            counts['workFiles'] = Math.max(0, (counts['workFiles'] ?? 0) - 1);
          } else {
            project.skipped.push(skipped);
            project.files -= 1;
            project.bytes -= bytes;
          }
        }
      }
    }

    // 7a. Repositories carried as git bundles (written by git straight into the package).
    await this.writeBundles(staging, repos, plans, options);

    // 7b. Carried changes: the index lists what is really in the package.
    await this.writeCarryIndexes(staging, repos, carried, carriedLost);

    // 8. Manifest.
    const members: PackageMember[] = team.members.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      sessionName: m.sessionName,
      runtimeType: m.runtimeType,
    }));
    counts['repos'] = repos.length;
    counts['projects'] = packageProjects.length;
    const files = staging.files();
    const manifest: TeamMoveManifest = {
      kind: C.PACKAGE_KIND,
      schemaVersion: C.SCHEMA_VERSION,
      moveId: options.moveId,
      createdAt: this.now(),
      crewlyVersion: this.deps.crewlyVersion,
      source: { ...this.deps.source, homePath: this.home, platform: process.platform },
      team: { id: team.id, name: team.name, members, projectIds: [...team.projectIds] },
      counts,
      projects: packageProjects,
      conversations,
      repos,
      requiredTools,
      requiredRuntimes,
      requiredConnectors,
      files,
      // A dry run builds no bundle; its estimate keeps the preflight size honest.
      totalBytes: files.reduce((n, f) => n + f.bytes, 0) + (options.dryRun ? repos.reduce((n, r) => n + (r.bundle && !r.bundle.file ? r.bundle.bytes : 0), 0) : 0),
      noSecrets: true,
      secretScan: { filesScanned: scan.filesScanned, knownValuesChecked: known.length, findings: 0, excludedFiles, ...(redactedFiles > 0 ? { redactedFiles } : {}) },
      notMoved: this.notMovedList(),
    };
    await staging.writeJson('manifest.json', manifest);

    return {
      manifest,
      staging,
      summary: summarize(manifest),
      dirtyRepos: blocking,
      scanFindings,
    };
  }

  /**
   * Create the git bundle of each repository that travels as one, straight
   * into the staging directory (streamed by git; never held in memory). A dry
   * run (preflight) builds none.
   *
   * @throws TeamMoveBlockedError when a bundle cannot be made (over the caps, ...) and the move is not forced
   */
  private async writeBundles(staging: StagingArea, repos: PackageRepo[], plans: Map<string, RepoPlan>, options: ExportOptions): Promise<void> {
    if (options.dryRun) return;
    const limits = this.deps.bundleLimits ?? resolveBundleLimits();
    let remaining = limits.totalBytes;
    const failures: string[] = [];
    for (const repo of repos) {
      const plan = plans.get(repo.projectId)!;
      if (!plan.bundle || !plan.resolved) continue;
      const rel = `projects/${repo.projectId}/${C.BUNDLE_FILE}`;
      const res = await createBundle(repo.path, staging.abs(rel), plan.bundle.mode, Math.min(limits.repoBytes, remaining));
      if (!res.ok) {
        delete repo.bundle;
        repo.carryError = res.reason;
        failures.push(`${repo.projectName} (${repo.path}): ${res.reason}`);
        continue;
      }
      const entry = await staging.adopt(rel);
      remaining -= entry.bytes;
      repo.bundle = { mode: plan.bundle.mode, file: rel, bytes: entry.bytes, sha256: entry.sha256, refs: res.refs };
      if (plan.bundle.mode === 'full') repo.note = bundleMessage(repo, { ...plan.bundle, estimate: entry.bytes });
      if (plan.bundle.unreachable) repo.bundle.why = 'remote_unreachable';
    }
    if (failures.length > 0 && !options.allowDirty) throw new TeamMoveBlockedError(failures);
  }

  /**
   * Write the patches and untracked files of carried repositories into the
   * package.
   *
   * @returns Files that vanished or could not be read while copying (left behind), by project id
   */
  private async writeCarry(staging: StagingArea, carried: Map<string, CollectedCarry>): Promise<Map<string, string[]>> {
    const lost = new Map<string, string[]>();
    for (const [projectId, carry] of carried) {
      const gone: string[] = [];
      for (const [n, patch] of carry.patches.entries()) await staging.writeBytes(`projects/${projectId}/carry/patches/${n}.patch`, patch.data);
      for (const file of carry.untracked) {
        try {
          await staging.copyIn(file.abs, `projects/${projectId}/carry/files/${file.path}`);
        } catch {
          gone.push(file.path);
        }
      }
      lost.set(projectId, gone);
    }
    return lost;
  }

  /** Write `carry.json` of each carried repository from the files that are really in the package. */
  private async writeCarryIndexes(staging: StagingArea, repos: PackageRepo[], carried: Map<string, CollectedCarry>, lost: Map<string, string[]>): Promise<void> {
    for (const [projectId, carry] of carried) {
      const index: CarryIndex = {
        version: 1,
        baseSha: carry.baseSha,
        branch: carry.branch,
        flattenedCommits: carry.flattenedCommits,
        patches: [],
        untracked: [],
        leftBehind: [...(lost.get(projectId) ?? [])],
      };
      for (const [n, patch] of carry.patches.entries()) {
        if (staging.has(`projects/${projectId}/carry/patches/${n}.patch`)) index.patches.push({ path: patch.path, file: `patches/${n}.patch`, deleted: patch.deleted });
        else index.leftBehind.push(patch.path);
      }
      for (const file of carry.untracked) {
        if (staging.has(`projects/${projectId}/carry/files/${file.path}`)) index.untracked.push({ path: file.path, file: `files/${file.path}`, executable: file.executable });
        else if (!index.leftBehind.includes(file.path)) index.leftBehind.push(file.path);
      }
      await staging.writeJson(`projects/${projectId}/carry/carry.json`, index);
      const repo = repos.find((r) => r.projectId === projectId);
      if (repo) {
        repo.carry = {
          baseSha: carry.baseSha,
          patches: index.patches.length,
          untracked: index.untracked.length,
          bytes: carry.bytes,
          flattenedCommits: carry.flattenedCommits,
          leftBehind: index.leftBehind,
        };
      }
    }
  }

  /** Name flagged files the way the owner knows them (project and path), not by package path. */
  private labelFindings(findings: SecretFinding[], projects: Project[], carried: Map<string, CollectedCarry>): LabelledFinding[] {
    return findings.map((f) => {
      let label = f.path;
      const m = /^projects\/([^/]+)\/(data|files|carry)\/(.*)$/.exec(f.path);
      if (m) {
        const project = projects.find((p) => p.id === m[1]);
        const name = project?.name ?? m[1]!;
        if (m[2] === 'data') label = `${name}/.crewly/${m[3]}`;
        else if (m[2] === 'files') label = `${name}/${m[3]}`;
        else {
          const patch = /^patches\/(\d+)\.patch$/.exec(m[3]!);
          const carry = carried.get(m[1]!);
          label = patch && carry?.patches[Number(patch[1])] ? `${name}/${carry.patches[Number(patch[1])]!.path}` : `${name}/${m[3]!.replace(/^files\//, '')}`;
        }
      }
      return { ...f, label, removable: isSkippableFinding(f.path) };
    });
  }

  /** The things a move deliberately leaves out, shown to the owner. */
  private notMovedList(): string[] {
    return [
      'Credentials, API keys, OAuth/connector grants and runtime logins (Claude, Codex, ...)',
      'Slack bot tokens (Crewly Cloud re-points the agents\' Slack apps to the target)',
      'Source code of git projects that have a remote (cloned from it on the target; projects that are not git repositories, and repositories without a remote or with unpushed commits, travel in the package)',
      "Chat message history beyond the team's Slack room (channels and rooms move; the room's recent messages come along, other messages stay on the source)",
      'Running sessions, logs, build output and node_modules (each member\'s latest Claude Code conversation does come along)',
      'Short-lived agent reminders (they are set again by the agents)',
    ];
  }

  /** Global-store records of the team. */
  private async collectRecords(staging: StagingArea, id: TeamIdentity, team: Team, counts: Record<string, number>): Promise<void> {
    // Task pool: open items of the team. Claims are not moved: nothing runs on the target yet.
    const pool = await safeReadJson<{ workItems?: WorkItem[]; claims?: TaskClaim[] }>(path.join(this.home, 'task-pool', 'pool.json'), {});
    const slice = selectPoolItems(pool, id);
    await staging.writeJson('records/task-pool.json', { workItems: slice.workItems.map(resetWorkItemForTarget) });
    counts['taskPoolItems'] = slice.workItems.length;

    // Open decisions / requests to the owner.
    const decisionsFile = await safeReadJson<{ nextId?: number; decisions?: Array<DecisionLike & Record<string, unknown>> }>(
      path.join(this.home, 'owner-decisions.json'),
      {},
    );
    const decisions = selectDecisions(Array.isArray(decisionsFile.decisions) ? decisionsFile.decisions : [], id);
    await staging.writeJson('records/decisions.json', { decisions });
    counts['openDecisions'] = decisions.length;

    // Legacy owner-created scheduled messages aimed at the team.
    const scheduled = await safeReadJson<ScheduledMessage[]>(path.join(this.home, 'scheduled-messages.json'), []);
    const mine = selectScheduledMessages(Array.isArray(scheduled) ? scheduled : [], id);
    await staging.writeJson('records/scheduled-messages.json', { messages: mine });
    counts['scheduledMessages'] = mine.length;

    // The Slack channel mapping of the team, so the target reuses the same channel.
    const slackFile = await safeReadJson<{ mappings?: Array<Record<string, unknown>> }>(path.join(this.home, 'slack-team-channels.json'), {});
    const allMappings = Array.isArray(slackFile.mappings) ? slackFile.mappings : [];
    const mapping = allMappings.find((m) => m['teamId'] === team.id) ?? null;
    // Crewly channels (ad-hoc mappings, shared with other teams) the team's agents are in: the moved
    // agents are carried as members, the other teams' agents stay where they are.
    const adhocMappings = selectAdhocMappings(allMappings, id);
    await staging.writeJson('records/slack-team-channel.json', { mapping, adhocMappings });
    const mappingCount = (mapping ? 1 : 0) + adhocMappings.length;
    if (mappingCount > 0) counts['slackChannelMappings'] = mappingCount;

    // Chat channels, rooms and DMs with their membership — the room behind the
    // Slack mapping always, with its recent messages (crewly#1344).
    const adhocRoomIds = adhocMappings.map((m) => String(m['chatChannelId'])).filter((c) => c.length > 0);
    const roomId = [...(typeof mapping?.['chatChannelId'] === 'string' ? [mapping['chatChannelId'] as string] : []), ...adhocRoomIds];
    const chat = readTeamChat(this.home, id, {
      includeChannelIds: roomId,
      rosterOnlyChannelIds: adhocRoomIds,
      messages: { channelIds: roomId, perChannel: C.CHAT_MESSAGES_PER_CHANNEL, totalBytes: C.CHAT_MESSAGES_MAX_BYTES },
    });
    await staging.writeJson('records/chat-channels.json', chat);
    counts['chatChannels'] = chat.channels.length;
    if (chat.messages) counts['chatMessages'] = chat.messages.length;
  }

  /**
   * Copy each project's Crewly data under the size caps.
   *
   * @returns Manifest entries of the projects
   */
  private async collectProjects(
    staging: StagingArea,
    projects: Project[],
    allTeams: Team[],
    teamId: string,
    counts: Record<string, number>,
  ): Promise<PackageProject[]> {
    const out: PackageProject[] = [];
    const projectLimits = this.deps.projectLimits ?? resolveProjectFileLimits();
    let remaining = projectLimits.totalBytes;

    for (const project of projects) {
      const dataDir = resolveProjectDataDir(project.path);
      const inHome = isInsidePackageTree(project.path);
      const entry: PackageProject = {
        id: project.id,
        name: project.name,
        sourcePath: project.path,
        dataDir: inHome ? 'home' : '.crewly',
        files: 0,
        bytes: 0,
        skipped: [],
        sharedWithTeams: allTeams.filter((t) => t.id !== teamId && t.projectIds.includes(project.id)).map((t) => t.name),
      };

      // Candidates: every file with its package-relative path.
      const candidates: Array<{ abs: string; rel: string; size: number; priority: number }> = [];
      const roots: Array<{ dir: string; prefix: string }> = inHome
        ? PACKAGE_TREE_STORES.map((s) => ({ dir: path.join(dataDir, s), prefix: s }))
        : [{ dir: dataDir, prefix: '' }];
      for (const root of roots) {
        const single = await fs.stat(root.dir).catch(() => null);
        if (single?.isFile()) {
          candidates.push({ abs: root.dir, rel: root.prefix, size: single.size, priority: 0 });
          continue;
        }
        for await (const f of walkFiles(root.dir, PROJECT_SCRATCH_DIRS)) {
          const rel = root.prefix ? `${root.prefix}/${f.rel}` : f.rel;
          candidates.push({ abs: f.abs, rel, size: f.size, priority: CORE_PROJECT_DIRS.has(rel.split('/')[0]!) ? 0 : 1 });
        }
      }
      // Core state first, then small files before big ones, so a cap loses the biggest scratch files.
      candidates.sort((a, b) => a.priority - b.priority || a.size - b.size || (a.rel < b.rel ? -1 : 1));
      for (const c of candidates) {
        const skip = (reason: SkippedFile['reason']): void => {
          entry.skipped.push({ path: c.rel, bytes: c.size, reason });
        };
        if (c.size > projectLimits.fileBytes) skip('too_large');
        else if (c.size > remaining) skip('size_cap');
        else {
          try {
            await staging.copyIn(c.abs, `projects/${project.id}/data/${c.rel}`);
            remaining -= c.size;
            entry.files += 1;
            entry.bytes += c.size;
          } catch {
            skip('unreadable');
          }
        }
      }
      entry.skipped.sort((a, b) => b.bytes - a.bytes);
      counts['projectFiles'] = (counts['projectFiles'] ?? 0) + entry.files;
      const count = (prefix: string): number => staging.files().filter((f) => f.path.startsWith(`projects/${project.id}/data/${prefix}/`)).length;
      counts['tickets'] = (counts['tickets'] ?? 0) + staging.files().filter((f) => f.path.startsWith(`projects/${project.id}/data/tickets/`) && f.path.endsWith('.md')).length;
      counts['missionFiles'] = (counts['missionFiles'] ?? 0) + count('missions');
      counts['requestFiles'] = (counts['requestFiles'] ?? 0) + count('requests');
      counts['triggerFiles'] = (counts['triggerFiles'] ?? 0) + count('triggers');
      out.push(entry);
    }
    return out;
  }

  /**
   * Copy the working files of projects that are not git repositories (a git
   * project is cloned on the target instead). Dependencies, build output,
   * logs and `.DS_Store` stay out; the caps leave the biggest files behind
   * and every skipped file is listed in the manifest.
   */
  private async collectWorkFiles(staging: StagingArea, repos: PackageRepo[], packageProjects: PackageProject[], counts: Record<string, number>): Promise<void> {
    const limits = this.deps.workLimits ?? resolveWorkFileLimits();
    const excluded = new Set<string>(C.WORK_EXCLUDED_DIRS);
    let remaining = limits.totalBytes;
    for (const repo of repos) {
      const entry = packageProjects.find((p) => p.id === repo.projectId);
      if (!entry || !isPlainFolder(repo) || isInsidePackageTree(repo.path)) continue;
      const work = { files: 0, bytes: 0, skipped: [] as SkippedFile[] };
      entry.work = work;
      const candidates: Array<{ abs: string; rel: string; size: number }> = [];
      for await (const f of walkFiles(repo.path, excluded)) {
        if (f.rel.endsWith('.log')) continue;
        candidates.push(f);
      }
      candidates.sort((a, b) => a.size - b.size || (a.rel < b.rel ? -1 : 1));
      for (const c of candidates) {
        const skip = (reason: SkippedFile['reason']): void => {
          work.skipped.push({ path: c.rel, bytes: c.size, reason });
        };
        if (c.size > limits.fileBytes) skip('too_large');
        else if (c.size > remaining) skip('size_cap');
        else {
          try {
            await staging.copyIn(c.abs, `projects/${entry.id}/files/${c.rel}`);
            remaining -= c.size;
            work.files += 1;
            work.bytes += c.size;
          } catch {
            skip('unreadable');
          }
        }
      }
      work.skipped.sort((a, b) => b.bytes - a.bytes);
      counts['workFiles'] = (counts['workFiles'] ?? 0) + work.files;
    }
  }

  /** Tools and connectors the team's own words mention (prompts, norms, SOPs, cron tasks). */
  private async detectNeeds(staging: StagingArea, team: Team): Promise<{ tools: string[]; connectors: string[] }> {
    let text = team.members.map((m) => m.systemPrompt ?? '').join('\n');
    for (const f of staging.files()) {
      if (!/^team\/(norms|sops|prompts)\//.test(f.path) && f.path !== 'team/cron-tasks.json') continue;
      if (f.bytes > C.TEXT_FILE_MAX_BYTES) continue;
      text += `\n${await fs.readFile(staging.abs(f.path), 'utf8').catch(() => '')}`;
    }
    const lower = text.toLowerCase();
    const tools = C.KNOWN_TOOLS.filter((tool) => new RegExp(`(?:^|[^a-z0-9-])${escapeRegExp(tool)}(?:$|[^a-z0-9-])`).test(lower)).sort();
    const connectors = Object.entries(CONNECTOR_HINTS)
      .filter(([, re]) => re.test(lower))
      .map(([name]) => name)
      .sort();
    return { tools, connectors };
  }
}

/**
 * The small summary Cloud receives (kept far below its 64 KB limit).
 *
 * @param manifest - Full manifest
 * @returns Summary without file names
 */
export function summarize(manifest: TeamMoveManifest): CloudManifestSummary {
  return {
    kind: manifest.kind,
    schemaVersion: manifest.schemaVersion,
    crewlyVersion: manifest.crewlyVersion,
    team: { id: manifest.team.id, name: manifest.team.name, members: manifest.team.members.length },
    counts: manifest.counts,
    repos: manifest.repos.length,
    reposDirty: manifest.repos.filter((r) => r.dirty || r.unpushed > 0).length,
    requiredTools: manifest.requiredTools,
    requiredRuntimes: manifest.requiredRuntimes,
    totalBytes: manifest.totalBytes,
    uncompressedBytes: manifest.totalBytes,
    noSecrets: true,
  };
}

/** Result of {@link buildEncryptedPackage}. */
export interface EncryptedPackage {
  /** Absolute path of the ciphertext file. */
  file: string;
  /** Ciphertext size in bytes. */
  size: number;
  /** Hex SHA-256 of the ciphertext. */
  sha256: string;
  /** Upload chunks (8 MiB each, the last shorter). */
  chunks: number;
}

/**
 * Tar+gzip a staging directory and encrypt it for the target.
 *
 * @param stagingDir - Directory built by {@link TeamMoveExporter.export}
 * @param outFile - Where the ciphertext is written
 * @param recipientPublicKey - Target's base64 X25519 public key
 * @param moveId - Move id (bound into the encryption)
 * @returns File, size, hash and chunk count of the ciphertext
 */
export async function buildEncryptedPackage(stagingDir: string, outFile: string, recipientPublicKey: string, moveId: string): Promise<EncryptedPackage> {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const tap = createHashTap();
  const tarStream = tarCreate({ gzip: true, cwd: stagingDir, portable: true, noMtime: true }, ['.']);
  await pipeline(tarStream, createEncryptStream({ recipientPublicKey, moveId }), tap, createWriteStream(outFile, { mode: 0o600 }));
  return {
    file: outFile,
    size: tap.bytes,
    sha256: tap.digest(),
    chunks: Math.max(1, Math.ceil(tap.bytes / C.TRANSFER_CHUNK_BYTES)),
  };
}

/**
 * Package entries sorted for stable comparisons in tests.
 *
 * @param files - Manifest file entries
 * @returns Paths
 */
export function packagePaths(files: readonly PackageFileEntry[]): string[] {
  return files.map((f) => f.path).sort();
}
