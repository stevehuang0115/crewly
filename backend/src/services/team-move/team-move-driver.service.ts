/**
 * Team move driver — the machine side of the Cloud protocol.
 *
 * Cloud tells a machine what to do with a `team_move` relay push
 * (`{moveId, role, action}`); the push is only a hint, the driver fetches the
 * move from Cloud and acts on what Cloud says. The same list is read at boot
 * and every few minutes, so a machine that was offline when the push went out
 * picks the move up when it returns. Every action is idempotent (journaled
 * steps, resumable upload/download), so a repeated push or a restart in the
 * middle is harmless.
 *
 *   target  prepare       -> make the per-move key, preflight, publish the key
 *   source  package       -> collect, scan, encrypt, upload
 *   target  import        -> download, decrypt, import, start, report `imported`
 *   source  stop_archive  -> stop the team, archive it, report `source_stopped`
 *   either  rollback      -> source: restore + start (`source_restored`);
 *                            target: stop + archive its copy (`target_stopped`).
 *                            Also "abort and clean up" after a failure.
 *
 * Before a move exists, the portal asks Cloud for a preflight and Cloud
 * pushes `{preflightId, role, action}`:
 *
 *   source  preflight     -> read the repositories, dry-run the package, report
 *   target  preflight     -> report version, disk, tools and logins
 *   source  ask_team      -> message the team lead to commit and push, report who
 *
 * Starting the driver advertises the `teamMove:1` capability to Cloud.
 *
 * @module services/team-move/team-move-driver.service
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TEAM_MOVE_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import type { IncomingMessage } from './../cloud/cloud-sync.types.js';
import { TeamMoveArchiver } from './team-move-archive.js';
import { TeamMoveCloudClient, TeamMoveCloudError, type PreflightRequest } from './team-move-cloud.client.js';
import { buildAskTeamMessage, buildMemoryNotice, pickAskRecipient } from './team-move-ask.js';
import { generateTargetKeyPair, isPublicKeyString } from './team-move-crypto.js';
import { TeamMoveBlockedError, TeamMoveExporter, buildEncryptedPackage } from './team-move-exporter.js';
import { TeamMoveImportError, TeamMoveImporter } from './team-move-importer.js';
import { MoveJournal, isMoveId, moveDirFor } from './team-move-journal.js';
import { readRepoChanges, sanitizeRemote } from './team-move-git.js';
import { hasRoomFor } from './team-move-preflight.js';
import { TeamMoveSecretScanError } from './team-move-secret-scan.js';
import type { ImportProgress, PackageRepo, SourcePreflightReport, TeamMoveAction, TeamMoveOptions, TeamMovePreflight, TeamMovePreflightRelayData, TeamMoveRelayData, TeamMoveRole, TeamMoveView } from './team-move.types.js';

const C = TEAM_MOVE_CONSTANTS;

/** Longest error text Cloud keeps. */
const MAX_ERROR_CHARS = 500;
/** How long the source waits for the team to go quiet before packaging. */
const IDLE_WAIT_MS = 10 * 60 * 1000;
/** How often the idle wait looks. */
const IDLE_POLL_MS = 15 * 1000;

let active = false;
let instance: TeamMoveDriver | null = null;

/**
 * Install the process-wide driver (composition root).
 *
 * @param driver - The driver or null
 */
export function setTeamMoveDriver(driver: TeamMoveDriver | null): void {
  instance = driver;
}

/**
 * The process-wide driver, or null before boot wired it.
 *
 * @returns The driver or null
 */
export function getTeamMoveDriver(): TeamMoveDriver | null {
  return instance;
}

/**
 * Whether the driver runs on this machine.
 *
 * @returns True once started
 */
export function isTeamMoveDriverActive(): boolean {
  return active;
}

/**
 * Capabilities to advertise to Cloud (heartbeat).
 *
 * @returns `['teamMove:1']` while the driver runs, else `[]`
 */
export function teamMoveCapabilities(): string[] {
  return active ? [C.CAPABILITY] : [];
}

/** Emitter of relay messages (CloudSyncService). */
export interface TeamMoveRelaySource {
  on(event: 'message', listener: (msg: IncomingMessage) => void): unknown;
  off(event: 'message', listener: (msg: IncomingMessage) => void): unknown;
}

/** Collaborators of the driver. */
export interface TeamMoveDriverDeps {
  home?: string;
  cloud: TeamMoveCloudClient;
  source: TeamMoveRelaySource;
  identity: () => Promise<{ instanceId: string; deviceName: string }>;
  exporter: TeamMoveExporter;
  /** Built per import so each uses the current services. */
  importer: () => TeamMoveImporter;
  archiver: TeamMoveArchiver;
  preflight: (requiredTools?: readonly string[], remotes?: readonly string[]) => Promise<TeamMovePreflight>;
  /** Deliver a harness message to an agent of a team (waking it when stopped); returns false when it could not be delivered. */
  sendToAgent?: (sessionName: string, text: string) => Promise<boolean>;
  /** The teams on this machine (to find the lead to ask). */
  getTeams?: () => Promise<Array<import('../../types/index.js').Team>>;
  /** True when no member of the team is working. */
  isTeamIdle: (teamId: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  logger?: ComponentLogger;
}

/** Persisted choice made when the move was requested on this machine. */
interface Intent {
  allowDirty?: boolean;
  skipFlagged?: boolean;
  carryChanges?: boolean;
}

/** The driver. */
export class TeamMoveDriver {
  private readonly logger: ComponentLogger;
  private readonly home: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly listener = (msg: IncomingMessage): void => {
    void this.handleRelay(msg);
  };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(private readonly deps: TeamMoveDriverDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('TeamMoveDriver');
    this.home = deps.home ?? getCrewlyHomePath();
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /** Listen for pushes, resume pending moves, advertise the capability. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.source.on('message', this.listener);
    active = true;
    this.bootTimer = setTimeout(() => void this.poll(), C.BOOT_DELAY_MS);
    this.pollTimer = setInterval(() => void this.poll(), C.POLL_INTERVAL_MS);
    (this.bootTimer as { unref?: () => void }).unref?.();
    (this.pollTimer as { unref?: () => void }).unref?.();
    this.logger.info('Team move handler started');
  }

  /** Stop listening; the capability is no longer advertised. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.source.off('message', this.listener);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.pollTimer = null;
    this.bootTimer = null;
    active = false;
  }

  /**
   * Handle one relay message. Anything but a well-formed `team_move` is ignored.
   *
   * @param msg - Relay message
   * @returns True when it was a team move push that started work
   */
  async handleRelay(msg: IncomingMessage): Promise<boolean> {
    if (msg?.type !== C.RELAY_MESSAGE_TYPE) return false;
    const preflight = parsePreflightRelayData(msg.payload);
    if (preflight) {
      void this.runPreflightRequest(preflight.preflightId, preflight.role, preflight.action);
      return true;
    }
    const data = parseRelayData(msg.payload);
    if (!data) {
      this.logger.warn('Ignored a malformed team_move relay message');
      return false;
    }
    try {
      // The push is a hint: Cloud's own record says what this machine has to do.
      const view = await this.deps.cloud.get(data.moveId);
      await this.dispatch(view, data);
      return true;
    } catch (error) {
      this.logger.warn('Could not act on a team_move push', { moveId: data.moveId, error: messageOf(error) });
      return false;
    }
  }

  /** Read this machine's pending moves from Cloud and act on each. */
  async poll(): Promise<number> {
    if (!this.deps.cloud.isConnected()) return 0;
    let views: TeamMoveView[];
    try {
      views = await this.deps.cloud.list();
    } catch (error) {
      this.logger.debug('Team move poll failed', { error: messageOf(error) });
      return 0;
    }
    let started = 0;
    started += await this.pollPreflights();
    for (const view of views) {
      if (!view.role || !view.action || !isMoveId(view.moveId)) continue;
      void this.dispatch(view, { moveId: view.moveId, role: view.role, action: view.action }).catch(() => undefined);
      started += 1;
    }
    return started;
  }

  /** Run one action (one at a time per move and action). */
  private dispatch(view: TeamMoveView, hint: TeamMoveRelayData): Promise<void> {
    const role: TeamMoveRole = view.role ?? hint.role;
    const action: TeamMoveAction = view.action ?? hint.action;
    const key = `${view.moveId}:${role}:${action}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const task = this.execute(view, role, action)
      .catch((error) => this.logger.error('Team move action failed', { moveId: view.moveId, role, action, error: messageOf(error) }))
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async execute(view: TeamMoveView, role: TeamMoveRole, action: TeamMoveAction): Promise<void> {
    const journal = new MoveJournal(view.moveId, this.home, this.now);
    await journal.writeState({ role, teamId: view.teamId, teamName: view.teamName, action, phase: 'running' });
    try {
      if (action === 'prepare' && role === 'target') await this.prepare(view, journal);
      else if (action === 'package' && role === 'source') await this.packageAndUpload(view, journal);
      else if (action === 'import' && role === 'target') await this.importPackage(view, journal);
      else if (action === 'stop_archive' && role === 'source') await this.stopArchive(view);
      else if (action === 'rollback') await this.rollback(view, role);
      else this.logger.warn('Ignored a team move action that does not fit the role', { moveId: view.moveId, role, action });
      await journal.writeState({ role, phase: 'done' });
    } catch (error) {
      await journal.writeState({ role, phase: 'failed', error: messageOf(error) });
      await this.reportFailure(view.moveId, error);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // target: prepare
  // -------------------------------------------------------------------------

  private async prepare(view: TeamMoveView, journal: MoveJournal): Promise<void> {
    const keyFile = path.join(journal.dir, 'target-key.json');
    let pair = await readKey(keyFile);
    if (!pair) {
      pair = generateTargetKeyPair();
      await journal.ensure();
      await fs.writeFile(keyFile, JSON.stringify(pair), { mode: 0o600 });
    }
    // Cloud lists the remotes of the team's repositories: test now whether this machine can read them,
    // so the source carries the ones it cannot (a private repo without credentials here) in the package.
    const fresh = await this.deps.cloud.get(view.moveId).catch(() => view);
    const preflight = await this.deps.preflight(undefined, fresh.remotes ?? view.remotes ?? []);
    await this.deps.cloud.postTargetKey(view.moveId, { publicKey: pair.publicKey, preflight });
  }

  // -------------------------------------------------------------------------
  // source: package + upload
  // -------------------------------------------------------------------------

  private async packageAndUpload(view: TeamMoveView, journal: MoveJournal): Promise<void> {
    const fresh = await this.deps.cloud.get(view.moveId);
    if (!isPublicKeyString(fresh.targetPublicKey)) throw new Error('Cloud has no public key of the target yet');
    const targetKey = fresh.targetPublicKey;
    // The owner's choices: made in the portal (stored by Cloud) or locally (intent.json).
    const local = await this.readIntent(view.moveId);
    const intent: Intent = {
      allowDirty: local.allowDirty || fresh.options?.allowDirty,
      skipFlagged: local.skipFlagged || fresh.options?.skipFlagged,
      carryChanges: local.carryChanges || fresh.options?.carryChanges,
    };
    // Remotes the target said it cannot read: those repositories travel whole as a git bundle.
    const unreachableRemotes = (fresh.preflight?.gitAccess ?? []).filter((g) => !g.ok).map((g) => g.remote);
    const stagingDir = path.join(journal.dir, 'package-staging');
    const cipherFile = path.join(journal.dir, 'package.enc');

    // Work that exists only here stops the move before anything else: no waiting for the team to go quiet first.
    if (!intent.allowDirty && !(await journal.isDone('export'))) {
      const check = intent.carryChanges ? await this.carryBlockers(view.teamId, unreachableRemotes) : await this.deps.exporter.checkRepos(view.teamId);
      if (check.blocking.length > 0) throw new TeamMoveBlockedError(check.blocking);
    }

    const built = await journal.run('export', async () => {
      await this.waitForIdle(view.teamId);
      await fs.rm(stagingDir, { recursive: true, force: true });
      const result = await this.deps.exporter.export({
        teamId: view.teamId,
        moveId: view.moveId,
        stagingDir,
        allowDirty: intent.allowDirty,
        skipFlagged: intent.skipFlagged,
        carryChanges: intent.carryChanges,
        unreachableRemotes,
      });
      const enc = await buildEncryptedPackage(stagingDir, cipherFile, targetKey, view.moveId);
      await fs.rm(stagingDir, { recursive: true, force: true });
      return { size: enc.size, sha256: enc.sha256, chunks: enc.chunks, summary: result.summary };
    });

    const init = await this.deps.cloud.packageInit(view.moveId, {
      size: built.size,
      sha256: built.sha256,
      chunks: built.chunks,
      manifest: built.summary,
    });
    const have = new Set(init.received);
    const handle = await fs.open(cipherFile, 'r');
    try {
      for (let n = 0; n < built.chunks; n++) {
        if (have.has(n)) continue;
        const buf = Buffer.alloc(Math.min(C.TRANSFER_CHUNK_BYTES, built.size - n * C.TRANSFER_CHUNK_BYTES));
        await handle.read(buf, 0, buf.length, n * C.TRANSFER_CHUNK_BYTES);
        await this.deps.cloud.putChunk(view.moveId, n, buf);
      }
    } finally {
      await handle.close();
    }
    await this.deps.cloud.packageComplete(view.moveId);
    await fs.rm(cipherFile, { force: true });
  }

  private async waitForIdle(teamId: string): Promise<void> {
    const deadline = Date.now() + IDLE_WAIT_MS;
    while (Date.now() < deadline) {
      if (await this.deps.isTeamIdle(teamId).catch(() => true)) return;
      await this.sleep(IDLE_POLL_MS);
    }
    this.logger.warn('Team still busy after waiting; packaging anyway', { teamId });
  }

  // -------------------------------------------------------------------------
  // target: import
  // -------------------------------------------------------------------------

  private async importPackage(view: TeamMoveView, journal: MoveJournal): Promise<void> {
    const fresh = await this.deps.cloud.get(view.moveId);
    const pkg = fresh.package;
    if (!pkg?.size || !pkg.sha256) throw new Error('Cloud has no package for this move');
    const key = await readKey(path.join(journal.dir, 'target-key.json'));
    if (!key) throw new Error('This machine has no key for the move (prepare did not run here)');

    const preflight = await this.deps.preflight();
    const uncompressed = Number((pkg.manifest as { uncompressedBytes?: number } | undefined)?.uncompressedBytes ?? 0);
    if (preflight.freeDiskBytes > 0 && !hasRoomFor(preflight.freeDiskBytes, pkg.size, uncompressed)) {
      throw new TeamMoveImportError('not enough free disk space to import the team', 'no_space');
    }

    const packageFile = path.join(journal.dir, 'package.enc');
    if (!(await journal.isDone('download'))) {
      await this.deps.cloud.postStatus(view.moveId, { status: 'importing' });
      await this.deps.cloud.downloadPackage(view.moveId, packageFile, pkg.size);
    }
    // Progress posts go out one at a time and all land before `imported`, so Cloud never sees `importing` after it.
    let sent: Promise<void> = Promise.resolve();
    const report = await this.deps.importer().run(
      { moveId: view.moveId, packageFile, privateKey: key.privateKey, expectedSha256: pkg.sha256 },
      journal,
      { onProgress: (progress) => void (sent = sent.then(() => this.reportProgress(view.moveId, progress))) },
    );
    await sent;
    await this.deps.cloud.postStatus(view.moveId, { status: 'imported', report });
    // The package is applied and its ciphertext deleted; the private key has done its job.
    await fs.rm(path.join(journal.dir, 'target-key.json'), { force: true });
    if (report.memory) await this.tellAgentsAboutMemory(view, report.memory.warnings, report.started.ok);
  }

  /**
   * Put lost or masked memory in front of the agents who would otherwise work
   * on as if it were complete: the orchestrator, and the team's lead when the
   * team started (a team left stopped is not woken). Best effort: the report
   * carries the same sentences.
   *
   * @param view - The move
   * @param warnings - The memory sentences of the import report
   * @param started - Whether the team started here
   */
  private async tellAgentsAboutMemory(view: TeamMoveView, warnings: readonly string[], started: boolean): Promise<void> {
    if (!this.deps.sendToAgent) return;
    const recipients: string[] = [ORCHESTRATOR_SESSION_NAME];
    if (started && this.deps.getTeams) {
      const team = (await this.deps.getTeams().catch(() => [])).find((t) => t.id === view.teamId);
      const lead = team ? pickAskRecipient(team)?.sessionName : undefined;
      if (lead && !recipients.includes(lead)) recipients.push(lead);
    }
    const text = buildMemoryNotice(view.teamName, warnings);
    for (const session of recipients) {
      const delivered = await this.deps.sendToAgent(session, text).catch(() => false);
      if (!delivered) this.logger.warn('Could not tell an agent about memory that did not arrive', { moveId: view.moveId, session });
    }
  }

  /**
   * Log what the import is doing and tell Cloud, so a long clone is not a
   * silent "importing". Best effort: never fails the import.
   */
  private async reportProgress(moveId: string, progress: ImportProgress): Promise<void> {
    const parts = [
      progress.phase ? `${progress.phase}${progress.percent !== null ? ` ${progress.percent}%` : ''}` : 'starting',
      progress.objectsTotal ? `${progress.objectsDone ?? 0}/${progress.objectsTotal} objects` : null,
      progress.bytes !== null ? `${Math.round(progress.bytes / 1024 / 1024)} MiB` : null,
      progress.rate,
    ].filter(Boolean);
    this.logger.info(`Team move importing ${progress.repo}: ${parts.join(', ')} (${Math.round(progress.elapsedMs / 1000)} s)`, { moveId, ...progress });
    await this.deps.cloud.postStatus(moveId, { status: 'importing', progress }).catch((error) => this.logger.debug('Could not send import progress', { moveId, error: messageOf(error) }));
  }

  // -------------------------------------------------------------------------
  // source: stop + archive; rollback
  // -------------------------------------------------------------------------

  private async stopArchive(view: TeamMoveView): Promise<void> {
    await this.deps.archiver.archive(view.moveId, view.teamId);
    await this.deps.cloud.postStatus(view.moveId, { status: 'source_stopped' });
  }

  private async rollback(view: TeamMoveView, role: TeamMoveRole): Promise<void> {
    if (role === 'source') {
      // The source may never have heard of the move, or never archived: nothing to restore, just acknowledge.
      await this.deps.archiver.restore(view.moveId);
      await this.deps.cloud.postStatus(view.moveId, { status: 'source_restored' });
      return;
    }
    // Target: stop and archive the copy it imported (if any), then acknowledge.
    await this.deps.archiver.archive(view.moveId, view.teamId);
    await this.deps.cloud.postStatus(view.moveId, { status: 'target_stopped' });
  }

  // -------------------------------------------------------------------------
  // entry points for the dashboard / CLI / orchestrator
  // -------------------------------------------------------------------------

  /**
   * Ask Cloud to move a team from this machine to another.
   *
   * @param input - Team, target machine, flags
   * @returns The new move id
   * @throws TeamMoveBlockedError when a repository holds unpushed work (unless allowed)
   */
  async startMove(input: { teamId: string; targetInstanceId: string; allowDirty?: boolean; skipFlagged?: boolean; carryChanges?: boolean }): Promise<{ moveId: string }> {
    // With "carry changes" the work travels in the package, so only what cannot be carried blocks.
    const check = input.carryChanges ? await this.carryBlockers(input.teamId) : await this.deps.exporter.checkRepos(input.teamId);
    if (check.blocking.length > 0 && !input.allowDirty) throw new TeamMoveBlockedError(check.blocking);
    const { instanceId } = await this.deps.identity();
    const options: TeamMoveOptions = {
      ...(input.allowDirty ? { allowDirty: true } : {}),
      ...(input.skipFlagged ? { skipFlagged: true } : {}),
      ...(input.carryChanges ? { carryChanges: true } : {}),
    };
    // The remotes let the target test whether it can read each repository before the source packages.
    const inspected = await this.deps.exporter.checkRepos(input.teamId).then((c) => c.repos, () => [] as PackageRepo[]);
    const remotes = [...new Set(inspected.map((r) => r.remoteUrl).filter((u): u is string => !!u).map(sanitizeRemote))];
    const created = await this.deps.cloud.create({ teamId: input.teamId, sourceInstanceId: instanceId, targetInstanceId: input.targetInstanceId, ...(Object.keys(options).length ? { options } : {}), ...(remotes.length ? { remotes } : {}) });
    if (input.allowDirty || input.skipFlagged || input.carryChanges) {
      const journal = new MoveJournal(created.moveId, this.home, this.now);
      await journal.ensure();
      await fs.writeFile(path.join(journal.dir, 'intent.json'), JSON.stringify({ allowDirty: !!input.allowDirty, skipFlagged: !!input.skipFlagged, carryChanges: !!input.carryChanges } satisfies Intent));
    }
    return created;
  }

  /** Blocking lines when uncommitted work would be carried: only repositories that cannot be carried. */
  private async carryBlockers(teamId: string, unreachableRemotes?: readonly string[]): Promise<{ blocking: string[] }> {
    const report = await this.sourcePreflight({ teamId, carryChanges: true, quick: true, unreachableRemotes });
    const blocking = report.repos
      .filter((r) => r.isRepo && (r.modified > 0 || r.untracked > 0 || r.unpushed > 0 || !!r.bundle) && !(r.bundle ? r.bundle.possible && (r.carry === null || r.carry.possible) : r.carry?.possible))
      .map((r) => `${r.projectName} (${r.path}): ${r.bundle && !r.bundle.possible ? r.bundle.message : (r.carry?.reason ?? 'uncommitted changes (commit and push them)')}`);
    return { blocking };
  }

  /**
   * The preflight report of a team on this machine (also served by the local
   * REST API and, over Cloud, to the portal).
   *
   * @param input - Team, whether carrying is wanted, whether to skip the package dry run, whether to ignore its cache
   * @returns The report
   */
  async sourcePreflight(input: { teamId: string; carryChanges?: boolean; quick?: boolean; force?: boolean; unreachableRemotes?: readonly string[]; targetName?: string }): Promise<SourcePreflightReport> {
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-team-move-preflight-'));
    try {
      return await this.deps.exporter.preflight({ teamId: input.teamId, carryChanges: input.carryChanges, stagingDir, force: input.force, quick: input.quick, unreachableRemotes: input.unreachableRemotes, targetName: input.targetName });
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // preflight requests (before a move exists)
  // -------------------------------------------------------------------------

  /** Answer the preflight requests Cloud is holding for this machine. */
  private async pollPreflights(): Promise<number> {
    let requests: PreflightRequest[] = [];
    try {
      requests = await this.deps.cloud.listPreflights();
    } catch (error) {
      this.logger.debug('Preflight poll failed', { error: messageOf(error) });
      return 0;
    }
    for (const r of requests) void this.runPreflightRequest(r.preflightId, r.role, r.action);
    return requests.length;
  }

  /** Run one preflight request (one at a time per request and action). */
  private runPreflightRequest(preflightId: string, role: TeamMoveRole, action: TeamMovePreflightRelayData['action']): Promise<void> {
    const key = `preflight:${preflightId}:${role}:${action}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const task = this.answerPreflight(preflightId, role, action)
      .catch((error) => this.logger.warn('Team move preflight failed', { preflightId, role, action, error: messageOf(error) }))
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async answerPreflight(preflightId: string, role: TeamMoveRole, action: TeamMovePreflightRelayData['action']): Promise<void> {
    const request = await this.deps.cloud.getPreflight(preflightId);
    // Cloud's record says what this machine has to do; the push is only a hint.
    const effectiveRole = request.role ?? role;
    const effectiveAction = request.action ?? action;
    try {
      if (effectiveRole === 'target') {
        await this.deps.cloud.postPreflightResult(preflightId, { report: await this.deps.preflight(undefined, request.remotes ?? []) });
      } else if (effectiveAction === 'ask_team') {
        await this.deps.cloud.postPreflightResult(preflightId, { ask: await this.askTeam(request) });
      } else {
        const report = await this.sourcePreflight({ teamId: request.teamId, carryChanges: request.options?.carryChanges, force: request.force, unreachableRemotes: request.unreachableRemotes, targetName: request.targetName });
        await this.deps.cloud.postPreflightResult(preflightId, { report });
      }
    } catch (error) {
      if (error instanceof TeamMoveCloudError && error.retryable) throw error;
      // Tell the portal why instead of leaving the checklist spinning.
      await this.deps.cloud.postPreflightResult(preflightId, { error: friendlyError(error).slice(0, MAX_ERROR_CHARS) }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Message the team lead about the work that blocks the move.
   *
   * @param request - The preflight request
   * @returns Who was asked, and whether it worked
   */
  private async askTeam(request: PreflightRequest): Promise<{ ok: boolean; agents: string[]; error?: string }> {
    if (!this.deps.sendToAgent || !this.deps.getTeams) return { ok: false, agents: [], error: 'this machine cannot message its agents' };
    const team = (await this.deps.getTeams()).find((t) => t.id === request.teamId);
    if (!team) return { ok: false, agents: [], error: 'the team is not on this machine' };
    const recipient = pickAskRecipient(team);
    if (!recipient?.sessionName) return { ok: false, agents: [], error: 'the team has no agent to ask' };
    const report = await this.sourcePreflight({ teamId: request.teamId, carryChanges: false, force: true });
    // The report names a few files; the agent gets a longer list.
    const repos = await Promise.all(
      report.repos.map(async (r) => {
        if (!r.isRepo || (r.modified === 0 && r.untracked === 0)) return r;
        const changes = await readRepoChanges(r.path);
        return { ...r, topFiles: changes.files.slice(0, 25), filesTruncated: changes.files.length > 25 };
      }),
    );
    const text = buildAskTeamMessage({ teamName: team.name, targetName: request.targetName ?? 'another machine', repos, findings: report.scan?.findings ?? [] });
    if (!text) return { ok: true, agents: [] };
    const delivered = await this.deps.sendToAgent(recipient.sessionName, text);
    return delivered ? { ok: true, agents: [recipient.name] } : { ok: false, agents: [recipient.name], error: `could not reach ${recipient.name}` };
  }

  /**
   * What would stop a move of a team: repositories with unpushed or uncommitted work.
   *
   * @param teamId - Team id
   * @returns Repo states and the blocking lines
   */
  async checkRepos(teamId: string): Promise<{ repos: PackageRepo[]; blocking: string[] }> {
    return this.deps.exporter.checkRepos(teamId);
  }

  /**
   * Dry run: build the package here exactly as a move would, encrypt it with a
   * throwaway key to measure it, and report. Nothing is sent anywhere.
   *
   * @param input - Team and a scratch directory
   * @returns Manifest highlights and sizes
   */
  async preview(input: { teamId: string; stagingDir: string; allowDirty?: boolean; skipFlagged?: boolean }): Promise<Record<string, unknown>> {
    const moveId = `preview-${Date.now()}`;
    const result = await this.deps.exporter.export({ ...input, moveId });
    const throwaway = generateTargetKeyPair();
    const enc = await buildEncryptedPackage(input.stagingDir, path.join(input.stagingDir, '..', `${path.basename(input.stagingDir)}.enc`), throwaway.publicKey, moveId);
    await fs.rm(enc.file, { force: true });
    const m = result.manifest;
    return {
      team: m.team.name,
      members: m.team.members.length,
      counts: m.counts,
      files: m.files.length,
      uncompressedBytes: m.totalBytes,
      encryptedBytes: enc.size,
      chunks: enc.chunks,
      repos: m.repos.map((r) => ({ name: r.projectName, remote: r.remoteUrl, branch: r.branch, headSha: r.headSha, dirty: r.dirty, unpushed: r.unpushed, note: r.note })),
      dirtyRepos: result.dirtyRepos,
      projects: m.projects.map((p) => ({ name: p.name, files: p.files, bytes: p.bytes, skipped: p.skipped.length, skippedBytes: p.skipped.reduce((n, f) => n + f.bytes, 0) })),
      requiredTools: m.requiredTools,
      requiredRuntimes: m.requiredRuntimes,
      requiredConnectors: m.requiredConnectors,
      secretScan: m.secretScan,
      cloudSummaryBytes: Buffer.byteLength(JSON.stringify(result.summary)),
      notMoved: m.notMoved,
    };
  }

  /**
   * Moves known to Cloud plus what this machine remembers of each.
   *
   * @returns Moves, newest first
   */
  async listMoves(): Promise<Array<TeamMoveView & { local?: { phase: string; action: string | null; error?: string } }>> {
    const views = this.deps.cloud.isConnected() ? await this.deps.cloud.listRecent() : [];
    const out = [];
    for (const v of views) {
      const state = isMoveId(v.moveId) ? await new MoveJournal(v.moveId, this.home).readState() : null;
      out.push(state ? { ...v, local: { phase: state.phase, action: state.action, ...(state.error ? { error: state.error } : {}) } } : v);
    }
    return out;
  }

  /**
   * One move with its local progress.
   *
   * @param moveId - Move id
   * @returns Cloud's view plus the local journal
   */
  async getMove(moveId: string): Promise<{ move: TeamMoveView; journal: Array<{ step: string; state: string; at: string }> }> {
    const move = await this.deps.cloud.get(moveId);
    const entries = isMoveId(moveId) ? await new MoveJournal(moveId, this.home).list() : [];
    return { move, journal: entries.map((e) => ({ step: e.step, state: e.state, at: e.at })) };
  }

  /**
   * Owner rollback.
   *
   * @param moveId - Move id
   */
  async rollbackMove(moveId: string): Promise<void> {
    await this.deps.cloud.rollback(moveId);
    void this.poll();
  }

  /**
   * Housekeeping at boot and daily: purge expired archives.
   *
   * @returns Purged move ids
   */
  async housekeeping(): Promise<string[]> {
    return this.deps.archiver.purgeExpired();
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private async readIntent(moveId: string): Promise<Intent> {
    const raw = await fs.readFile(path.join(moveDirFor(moveId, this.home), 'intent.json'), 'utf8').catch(() => null);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Intent;
    } catch {
      return {};
    }
  }

  /** Tell Cloud an action failed, with text the owner can act on. */
  private async reportFailure(moveId: string, error: unknown): Promise<void> {
    // Network trouble is retried by the next poll, not reported as the move's failure.
    if (error instanceof TeamMoveCloudError && error.retryable) return;
    const text = friendlyError(error).slice(0, MAX_ERROR_CHARS);
    try {
      await this.deps.cloud.postStatus(moveId, { status: 'failed', error: text, ...(failureReport(error) ? { report: failureReport(error) } : {}) });
    } catch (err) {
      this.logger.warn('Could not report a team move failure', { moveId, error: messageOf(err) });
    }
  }
}

/**
 * Turn an error into the sentence the owner sees.
 *
 * @param error - Thrown value
 * @returns Message
 */
export function friendlyError(error: unknown): string {
  if (error instanceof TeamMoveBlockedError || error instanceof TeamMoveSecretScanError || error instanceof TeamMoveImportError) return error.message;
  return messageOf(error);
}

/**
 * Machine-readable detail of a failure, so the portal can word it (and offer
 * the right fix) in the owner's language.
 *
 * @param error - Thrown value
 * @returns `{failure: {code, ...}}` for the failures the portal knows, else undefined
 */
export function failureReport(error: unknown): { failure: Record<string, unknown> } | undefined {
  if (error instanceof TeamMoveBlockedError) return { failure: { code: 'unpushed_work', repos: error.lines.slice(0, 20) } };
  if (error instanceof TeamMoveSecretScanError) return { failure: { code: 'secrets_found', files: error.findings.slice(0, 30).map((f) => f.path) } };
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readKey(file: string): Promise<{ publicKey: string; privateKey: string } | null> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { publicKey?: string; privateKey?: string };
    return parsed.publicKey && parsed.privateKey ? { publicKey: parsed.publicKey, privateKey: parsed.privateKey } : null;
  } catch {
    return null;
  }
}

/**
 * Parse the data of a `team_move` push that belongs to a preflight (it names a
 * `preflightId` instead of a `moveId`).
 *
 * @param payload - Relay payload
 * @returns Parsed data, or null when it is not a preflight push
 */
export function parsePreflightRelayData(payload: unknown): TeamMovePreflightRelayData | null {
  const raw = (payload && typeof payload === 'object' ? ((payload as { data?: unknown }).data ?? payload) : null) as Record<string, unknown> | null;
  if (!raw) return null;
  const { preflightId, role, action } = raw;
  if (typeof preflightId !== 'string' || !isMoveId(preflightId)) return null;
  if (role !== 'source' && role !== 'target') return null;
  if (!(C.PREFLIGHT_ACTIONS as readonly string[]).includes(String(action))) return null;
  return { preflightId, role, action: action as TeamMovePreflightRelayData['action'] };
}

/**
 * Parse the data of a `team_move` push.
 *
 * @param payload - Relay payload
 * @returns Parsed data, or null when malformed
 */
export function parseRelayData(payload: unknown): TeamMoveRelayData | null {
  const raw = (payload && typeof payload === 'object' ? ((payload as { data?: unknown }).data ?? payload) : null) as Record<string, unknown> | null;
  if (!raw) return null;
  const { moveId, role, action } = raw;
  if (!isMoveId(moveId)) return null;
  if (role !== 'source' && role !== 'target') return null;
  if (!['prepare', 'package', 'import', 'stop_archive', 'rollback'].includes(String(action))) return null;
  return { moveId, role, action: action as TeamMoveAction };
}
