/**
 * Backup Restore Service (P1)
 *
 * Restores a workspace archive (produced by BackupArchiveService) onto this
 * machine to resume work after a machine dies / is replaced.
 *
 * Safety model:
 *   - `preview()` is non-destructive (dry-run) — reports the plan + conflicts.
 *   - `restore()` snapshots the CURRENT CREWLY_HOME first (rollback), refuses
 *     on overlapping ids unless mode='overwrite', then applies and — on any
 *     failure — rolls back from the snapshot.
 *   - device.json is NEVER in the archive, so the target keeps its own identity.
 *   - cron `nextRunAt` is reset to null so the scheduler recomputes from
 *     `cronExpression` (no stale fires); runtime/session state is wiped so
 *     agents start clean.
 *
 * See specs/2026-06-07-workspace-backup.md.
 *
 * @module services/backup/backup-restore.service
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extract as tarExtract } from 'tar';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import {
  type BackupManifest,
  type RestoreOptions,
  type RestorePlan,
  type RestoreProjectPlan,
  type RestoreResult,
  BACKUP_SCHEMA_VERSION,
} from './backup.types.js';

/** Runtime/session state wiped on restore so agents start clean (relative to home). */
const RUNTIME_WIPE = ['runtime.json', '.orchestrator-state', 'session-state.json'];

/** Cron files whose `nextRunAt` is reset so the scheduler recomputes. */
const CRON_FILES = ['recurring-checks.json', 'one-time-checks.json'];

/** Thrown by restore() when mode='abort' and the target has overlapping data. */
export class RestoreConflictError extends Error {
  constructor(
    message: string,
    public readonly plan: RestorePlan,
  ) {
    super(message);
    this.name = 'RestoreConflictError';
  }
}

/**
 * Service that restores workspace backup archives.
 */
export class BackupRestoreService {
  private readonly logger: ComponentLogger;

  constructor(logger?: ComponentLogger) {
    this.logger = logger ?? LoggerService.getInstance().createComponentLogger('BackupRestore');
  }

  /**
   * Non-destructive restore plan (dry-run): what would be created/overwritten,
   * id conflicts, resolved project paths, and what's regenerated/discarded.
   *
   * @param options - Restore options (mode/pathMap affect conflict + path resolution)
   * @returns The plan; never writes to disk
   */
  async preview(options: RestoreOptions): Promise<RestorePlan> {
    const home = options.homePath ?? getCrewlyHomePath();
    const temp = await this.extract(options.archivePath);
    try {
      const manifest = await this.readManifest(temp);
      return await this.buildPlan(manifest, home, options);
    } finally {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Restore the archive onto this machine.
   *
   * @param options - Restore options
   * @returns Summary of what was restored
   * @throws RestoreConflictError when mode='abort' and ids overlap
   * @throws Error on integrity failure or unsupported schema (no changes applied)
   */
  async restore(options: RestoreOptions): Promise<RestoreResult> {
    const home = options.homePath ?? getCrewlyHomePath();
    const mode = options.mode ?? 'abort';
    const temp = await this.extract(options.archivePath);

    try {
      const manifest = await this.readManifest(temp);
      if (manifest.schemaVersion > BACKUP_SCHEMA_VERSION) {
        throw new Error(
          `Backup schemaVersion ${manifest.schemaVersion} is newer than supported ${BACKUP_SCHEMA_VERSION}; upgrade Crewly to restore it`,
        );
      }
      await this.verifyChecksums(temp, manifest);

      const plan = await this.buildPlan(manifest, home, options);
      if (mode === 'abort' && (plan.conflicts.teams.length > 0 || plan.conflicts.projects.length > 0)) {
        throw new RestoreConflictError(
          `Restore aborted: target already has ${plan.conflicts.teams.length} team(s) and ${plan.conflicts.projects.length} project(s) from this backup. Re-run with mode='overwrite' to replace them.`,
          plan,
        );
      }

      // 1) Snapshot current home for rollback (best-effort full copy, sans backups/).
      const rollbackSnapshotPath = path.join(home, 'backups', `pre-restore-${options.now.replace(/[:.]/g, '-')}`);
      await fs.mkdir(home, { recursive: true });
      await this.copyTree(home, rollbackSnapshotPath, new Set(['backups']));

      try {
        // 2) Apply
        const restoredGlobalFiles = await this.applyGlobals(temp, home);
        const restoredProjects = await this.applyProjects(temp, manifest, plan);
        const chatDbRestored = await this.applyChatDb(temp, home, manifest);
        await this.rewriteProjectsJson(home, plan);
        await this.resetCron(home);
        await this.wipeRuntime(home);

        this.logger.info('Workspace restore applied', {
          restoredGlobalFiles,
          restoredProjects,
          chatDbRestored,
          rollbackSnapshotPath,
        });
        return { restoredGlobalFiles, restoredProjects, chatDbRestored, rollbackSnapshotPath, warnings: plan.warnings };
      } catch (applyErr) {
        // 3) Rollback from the pre-restore snapshot.
        this.logger.error('Restore failed mid-apply — rolling back', {
          error: applyErr instanceof Error ? applyErr.message : String(applyErr),
        });
        await this.copyTree(rollbackSnapshotPath, home, new Set(['backups'])).catch(() => undefined);
        throw applyErr;
      }
    } finally {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Extract the archive to a fresh temp dir; returns its path. */
  private async extract(archivePath: string): Promise<string> {
    if (!(await fs.stat(archivePath).catch(() => null))?.isFile()) {
      throw new Error(`Backup archive not found: ${archivePath}`);
    }
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-restore-'));
    await tarExtract({ file: archivePath, cwd: temp });
    return temp;
  }

  /** Read + minimally validate the manifest from an extracted archive. */
  private async readManifest(temp: string): Promise<BackupManifest> {
    const raw = await fs.readFile(path.join(temp, 'manifest.json'), 'utf8').catch(() => null);
    if (!raw) throw new Error('Invalid backup: manifest.json missing');
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(raw) as BackupManifest;
    } catch {
      throw new Error('Invalid backup: manifest.json is not valid JSON');
    }
    if (typeof manifest.schemaVersion !== 'number' || !Array.isArray(manifest.global)) {
      throw new Error('Invalid backup: manifest is missing required fields');
    }
    return manifest;
  }

  /** Verify every recorded file's sha256 against the extracted bytes. */
  private async verifyChecksums(temp: string, manifest: BackupManifest): Promise<void> {
    const entries: Array<{ path: string; sha256: string }> = [
      ...manifest.global,
      ...manifest.projects.flatMap((p) => p.files),
    ];
    if (manifest.chatDb.included && manifest.chatDb.sha256) {
      entries.push({ path: 'chat.db', sha256: manifest.chatDb.sha256 });
    }
    for (const e of entries) {
      const abs = path.join(temp, ...e.path.split('/'));
      const actual = await sha256File(abs).catch(() => null);
      if (actual !== e.sha256) {
        throw new Error(`Backup integrity check failed for ${e.path} (checksum mismatch or missing)`);
      }
    }
  }

  /** Build the dry-run plan (conflicts, resolved project paths, warnings). */
  private async buildPlan(manifest: BackupManifest, home: string, options: RestoreOptions): Promise<RestorePlan> {
    const warnings: string[] = [];

    // Teams present in the backup (ids parsed from home/teams/<id>/...).
    const backupTeamIds = new Set<string>();
    for (const g of manifest.global) {
      const m = g.path.match(/^home\/teams\/([^/]+)\//);
      if (m && m[1] !== 'orchestrator') backupTeamIds.add(m[1]);
    }
    const targetTeamIds = new Set(
      (await fs.readdir(path.join(home, 'teams'), { withFileTypes: true }).catch(() => []))
        .filter((d) => d.isDirectory() && d.name !== 'orchestrator')
        .map((d) => d.name),
    );
    const conflictTeams = [...backupTeamIds].filter((id) => targetTeamIds.has(id));

    const targetProjectIds = new Set(
      (await this.readJson<Array<{ id: string }>>(path.join(home, 'projects.json'), [])).map((p) => p.id),
    );
    const conflictProjects = manifest.projects.map((p) => p.id).filter((id) => targetProjectIds.has(id));

    const projects: RestoreProjectPlan[] = [];
    for (const p of manifest.projects) {
      const mapped = options.pathMap?.[p.sourcePath];
      let targetPath: string | null = null;
      if (mapped) targetPath = mapped;
      else if (await this.pathExists(p.sourcePath)) targetPath = p.sourcePath;

      const targetExists = targetPath ? await this.pathExists(targetPath) : false;
      if (!targetPath) {
        warnings.push(
          `Project "${p.name}" (${p.sourcePath}) has no target path on this machine — re-clone ${p.git.remote ?? 'the repo'} and pass --map ${p.sourcePath}=<new-path> to restore its .crewly data.`,
        );
      } else if (!targetExists) {
        warnings.push(`Project "${p.name}" target path ${targetPath} does not exist yet — its .crewly will be created there.`);
      }
      projects.push({ id: p.id, name: p.name, sourcePath: p.sourcePath, targetPath, git: p.git, targetExists });
    }

    return {
      ok: !(options.mode !== 'overwrite' && (conflictTeams.length > 0 || conflictProjects.length > 0)),
      manifestCreatedAt: manifest.createdAt,
      sourceHomePath: manifest.sourceHomePath,
      conflicts: { teams: conflictTeams, projects: conflictProjects },
      globalFileCount: manifest.global.length,
      projects,
      chatDbIncluded: manifest.chatDb.included,
      regenerated: ['device.json (kept this machine\'s identity — not in backup)'],
      discarded: [...RUNTIME_WIPE, 'in-flight cron nextRunAt (recomputed)'],
      warnings,
    };
  }

  /** Copy every manifest global file from temp/home/* into CREWLY_HOME. */
  private async applyGlobals(temp: string, home: string): Promise<number> {
    let n = 0;
    for (const g of (await this.readManifest(temp)).global) {
      // g.path = 'home/<rel>'
      const rel = g.path.replace(/^home\//, '');
      const src = path.join(temp, ...g.path.split('/'));
      const dest = path.join(home, ...rel.split('/'));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      n += 1;
    }
    return n;
  }

  /** Copy each resolved project's `.crewly/` from the archive to its target path. */
  private async applyProjects(temp: string, manifest: BackupManifest, plan: RestorePlan): Promise<number> {
    let n = 0;
    const planById = new Map(plan.projects.map((p) => [p.id, p]));
    for (const proj of manifest.projects) {
      const target = planById.get(proj.id)?.targetPath;
      if (!target) continue; // unresolved — warned in the plan
      for (const f of proj.files) {
        // f.path = 'projects/<id>/.crewly/<rel>' → dest = <target>/.crewly/<rel>
        const rel = f.path.replace(new RegExp(`^projects/${proj.id}/`), '');
        const src = path.join(temp, ...f.path.split('/'));
        const dest = path.join(target, ...rel.split('/'));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest);
      }
      n += 1;
    }
    return n;
  }

  /** Atomically swap chat.db into place (temp copy → rename). */
  private async applyChatDb(temp: string, home: string, manifest: BackupManifest): Promise<boolean> {
    if (!manifest.chatDb.included) return false;
    const src = path.join(temp, 'chat.db');
    const finalDest = path.join(home, 'chat.db');
    const tmpDest = path.join(home, `chat.db.restore-${Date.now()}.tmp`);
    await fs.mkdir(home, { recursive: true });
    await fs.copyFile(src, tmpDest);
    await fs.rename(tmpDest, finalDest);
    // Drop stale WAL/SHM sidecars so SQLite reopens cleanly from the restored db.
    for (const sidecar of ['chat.db-wal', 'chat.db-shm']) {
      await fs.rm(path.join(home, sidecar), { force: true }).catch(() => undefined);
    }
    return true;
  }

  /** Rewrite projects.json `path` entries using the resolved plan mapping. */
  private async rewriteProjectsJson(home: string, plan: RestorePlan): Promise<void> {
    const file = path.join(home, 'projects.json');
    const projects = await this.readJson<Array<{ id: string; path: string }>>(file, []);
    if (projects.length === 0) return;
    const targetById = new Map(plan.projects.map((p) => [p.id, p.targetPath]));
    let changed = false;
    for (const proj of projects) {
      const target = targetById.get(proj.id);
      if (target && target !== proj.path) {
        proj.path = target;
        changed = true;
      }
    }
    if (changed) await fs.writeFile(file, JSON.stringify(projects, null, 2), 'utf8');
  }

  /** Reset cron `nextRunAt` so the scheduler recomputes from cronExpression. */
  private async resetCron(home: string): Promise<void> {
    for (const name of CRON_FILES) {
      const file = path.join(home, name);
      const items = await this.readJson<Array<Record<string, unknown>>>(file, []);
      if (!Array.isArray(items) || items.length === 0) continue;
      let changed = false;
      for (const item of items) {
        if ('nextRunAt' in item) {
          item.nextRunAt = null;
          changed = true;
        }
      }
      if (changed) await fs.writeFile(file, JSON.stringify(items, null, 2), 'utf8');
    }
  }

  /** Remove runtime/session state so agents start clean on the restored machine. */
  private async wipeRuntime(home: string): Promise<void> {
    for (const name of RUNTIME_WIPE) {
      await fs.rm(path.join(home, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ---- small fs helpers ----

  /** Recursively copy a directory tree, skipping top-level names in `skipTop`. */
  private async copyTree(srcDir: string, destDir: string, skipTop: Set<string>): Promise<void> {
    const entries = await fs.readdir(srcDir, { withFileTypes: true }).catch(() => []);
    await fs.mkdir(destDir, { recursive: true });
    for (const e of entries) {
      if (skipTop.has(e.name)) continue;
      const s = path.join(srcDir, e.name);
      const d = path.join(destDir, e.name);
      if (e.isDirectory()) await this.copyTreeRec(s, d);
      else if (e.isFile()) await fs.copyFile(s, d);
    }
  }

  /** Recursive copy without the top-level skip filter. */
  private async copyTreeRec(srcDir: string, destDir: string): Promise<void> {
    await fs.mkdir(destDir, { recursive: true });
    for (const e of await fs.readdir(srcDir, { withFileTypes: true })) {
      const s = path.join(srcDir, e.name);
      const d = path.join(destDir, e.name);
      if (e.isDirectory()) await this.copyTreeRec(s, d);
      else if (e.isFile()) await fs.copyFile(s, d);
    }
  }

  private async pathExists(p: string): Promise<boolean> {
    return !!(await fs.stat(p).catch(() => null));
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }
}

/** Stream a file through SHA-256 → hex digest. */
async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
