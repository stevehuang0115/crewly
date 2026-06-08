/**
 * Backup Archive Service (P0)
 *
 * Builds a portable workspace backup: a single `.tar.gz` containing a
 * top-level `manifest.json`, the captured `CREWLY_HOME` globals (under
 * `home/`), each project's `.crewly/` tree (under `projects/<id>/`), and
 * optionally `chat.db`.
 *
 * Runs locally with no Cloud dependency — `crewly backup create`. The Cloud
 * upload/park step (Pro-gated) is a later phase and consumes the archive this
 * service produces. See specs/2026-06-07-workspace-backup.md.
 *
 * @module services/backup/backup-archive.service
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { create as tarCreate } from 'tar';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { safeReadJson } from '../../utils/file-io.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import {
  BACKUP_SCHEMA_VERSION,
  type BackupFileEntry,
  type BackupManifest,
  type BackupProjectEntry,
  type CreateBackupOptions,
  type CreateBackupResult,
} from './backup.types.js';

const execFileAsync = promisify(execFile);

/**
 * Top-level CREWLY_HOME entries that are MACHINE-SPECIFIC, secret, runtime, or
 * would cause recursion — never captured. chat.db is handled separately via
 * the SQLite online backup API, so it's excluded from the generic file walk.
 */
const GLOBAL_EXCLUDE_TOPLEVEL = new Set<string>([
  'device.json',
  'cloud',
  'credentials',
  'telegram-credentials.json',
  'runtime.json',
  '.orchestrator-state',
  'session-state.json',
  'logs',
  'teams-backup.json',
  'teams-backup-history',
  'backups', // our own output dir
  'chat.db',
  'chat.db-wal',
  'chat.db-shm',
]);

/** Directory names excluded at ANY depth (runtime/session/log noise). */
const EXCLUDE_DIR_ANYWHERE = new Set<string>(['sessions', 'logs', '.orchestrator-state']);

/** True for files excluded at any depth (ephemeral session logs). */
function isExcludedFile(name: string): boolean {
  return name.endsWith('.jsonl');
}

/**
 * Service that builds workspace backup archives.
 */
export class BackupArchiveService {
  private readonly logger: ComponentLogger;

  constructor(logger?: ComponentLogger) {
    this.logger = logger ?? LoggerService.getInstance().createComponentLogger('BackupArchive');
  }

  /**
   * Build a workspace backup archive.
   *
   * Captures CREWLY_HOME globals (exclude-based, so new data domains are
   * picked up automatically), each project's `.crewly/` tree (walked from
   * projects.json) with git provenance, and chat.db (unless excluded). Stages
   * everything into a temp dir, writes the manifest, and tars it to `outPath`.
   *
   * @param options - Build options (createdAt is required — no clock in lib code)
   * @returns The archive path, manifest, and total captured bytes
   * @throws If CREWLY_HOME does not exist or the tar write fails
   */
  async createArchive(options: CreateBackupOptions): Promise<CreateBackupResult> {
    const home = options.homePath ?? getCrewlyHomePath();
    const homeStat = await fs.stat(home).catch(() => null);
    if (!homeStat?.isDirectory()) {
      throw new Error(`CREWLY_HOME not found or not a directory: ${home}`);
    }

    const outPath =
      options.outPath ??
      path.join(home, 'backups', `workspace-${options.createdAt.replace(/[:.]/g, '-')}.tar.gz`);

    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-backup-'));
    try {
      let totalBytes = 0;

      // 1) Global CREWLY_HOME files → staging/home/<rel>
      const global: BackupFileEntry[] = [];
      for (const rel of await this.collectGlobalFiles(home)) {
        const entry = await this.stageFile(home, rel, staging, path.join('home', rel));
        global.push(entry);
        totalBytes += entry.bytes;
      }

      // 2) Per-project .crewly trees → staging/projects/<id>/<rel>
      const projects = await this.collectProjects(home, staging);
      for (const p of projects) for (const f of p.files) totalBytes += f.bytes;

      // 3) chat.db via SQLite online backup → staging/chat.db
      const chatDb = options.excludeChatDb
        ? { included: false, skippedReason: 'excluded by option' }
        : await this.captureChatDb(home, staging);
      if (chatDb.bytes) totalBytes += chatDb.bytes;

      // 4) Manifest
      const manifest: BackupManifest = {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        crewlyVersion: this.readCrewlyVersion(),
        createdAt: options.createdAt,
        sourceDeviceId: options.sourceDeviceId ?? null,
        sourceDeviceName: options.sourceDeviceName ?? null,
        sourceHomePath: home,
        ownerSub: options.ownerSub ?? null,
        global,
        projects,
        chatDb,
        crypto: { mode: 'none' },
      };
      await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

      // 5) tar.gz the staging dir
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await tarCreate({ gzip: true, file: outPath, cwd: staging }, ['.']);

      this.logger.info('Workspace backup created', {
        outPath,
        globalFiles: global.length,
        projects: projects.length,
        chatDb: chatDb.included,
        totalBytes,
      });

      return { archivePath: outPath, manifest, totalBytes };
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Recursively collect capturable global files under CREWLY_HOME (relative
   * paths). Exclude-based so new data domains are captured automatically.
   *
   * @param home - CREWLY_HOME absolute path
   * @returns Relative file paths (POSIX-style) to capture
   */
  private async collectGlobalFiles(home: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (absDir: string, rel: string, isTop: boolean): Promise<void> => {
      const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (isTop && GLOBAL_EXCLUDE_TOPLEVEL.has(e.name)) continue;
        if (e.isDirectory() && EXCLUDE_DIR_ANYWHERE.has(e.name)) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(path.join(absDir, e.name), childRel, false);
        } else if (e.isFile() && !isExcludedFile(e.name)) {
          out.push(childRel);
        }
      }
    };
    await walk(home, '', true);
    return out;
  }

  /**
   * Walk projects.json and capture each project's `.crewly/` tree + git
   * provenance into staging/projects/<id>/.
   *
   * @param home - CREWLY_HOME absolute path
   * @param staging - staging dir root
   * @returns Project entries for the manifest
   */
  private async collectProjects(home: string, staging: string): Promise<BackupProjectEntry[]> {
    const projects = await safeReadJson<Array<{ id: string; name: string; path: string }>>(
      path.join(home, 'projects.json'),
      [],
    );
    const result: BackupProjectEntry[] = [];
    for (const proj of projects) {
      const crewlyDir = path.join(proj.path, '.crewly');
      const dirStat = await fs.stat(crewlyDir).catch(() => null);
      if (!dirStat?.isDirectory()) continue; // project gone / never initialized

      const files: BackupFileEntry[] = [];
      const walk = async (absDir: string, rel: string): Promise<void> => {
        const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (e.isDirectory() && EXCLUDE_DIR_ANYWHERE.has(e.name)) continue;
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(path.join(absDir, e.name), childRel);
          else if (e.isFile() && !isExcludedFile(e.name)) {
            const archivePath = `projects/${proj.id}/.crewly/${childRel}`;
            files.push(await this.stageFile(crewlyDir, childRel, staging, archivePath));
          }
        }
      };
      await walk(crewlyDir, '');

      result.push({
        id: proj.id,
        name: proj.name,
        sourcePath: proj.path,
        git: await this.readGitProvenance(proj.path),
        files,
      });
    }
    return result;
  }

  /**
   * Read `origin` remote + HEAD commit for a project dir (best-effort).
   *
   * @param projectPath - Absolute project path
   * @returns Git provenance (nulls when not a repo / unavailable)
   */
  private async readGitProvenance(projectPath: string): Promise<{ remote: string | null; commit: string | null }> {
    const run = async (args: string[]): Promise<string | null> => {
      try {
        const { stdout } = await execFileAsync('git', ['-C', projectPath, ...args], { timeout: 5000 });
        const v = stdout.trim();
        return v.length > 0 ? v : null;
      } catch {
        return null;
      }
    };
    return {
      remote: await run(['remote', 'get-url', 'origin']),
      commit: await run(['rev-parse', 'HEAD']),
    };
  }

  /**
   * Capture chat.db via the SQLite online backup API (consistent snapshot of a
   * possibly-live DB). Degrades gracefully when chat.db is absent or the native
   * module can't load — the backup just omits it with a recorded reason.
   *
   * @param home - CREWLY_HOME absolute path
   * @param staging - staging dir root
   * @returns chat.db manifest record
   */
  private async captureChatDb(
    home: string,
    staging: string,
  ): Promise<{ included: boolean; sha256?: string; bytes?: number; skippedReason?: string }> {
    const dbPath = path.join(home, 'chat.db');
    if (!(await fs.stat(dbPath).catch(() => null))?.isFile()) {
      return { included: false, skippedReason: 'chat.db not present' };
    }
    const dest = path.join(staging, 'chat.db');
    try {
      const mod = (await import('better-sqlite3')) as unknown as {
        default: new (p: string, opts?: Record<string, unknown>) => { backup: (p: string) => Promise<unknown>; close: () => void };
      };
      const Database = mod.default;
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        await db.backup(dest);
      } finally {
        db.close();
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn('chat.db capture skipped', { reason });
      return { included: false, skippedReason: `sqlite backup failed: ${reason}` };
    }
    const { sha256, bytes } = await hashAndSize(dest);
    return { included: true, sha256, bytes };
  }

  /**
   * Copy a source file into the staging archive layout, returning its manifest
   * entry (archive-relative path + sha256 + size).
   *
   * @param srcRoot - Root the relative path is resolved against
   * @param rel - Source path relative to srcRoot (POSIX-style)
   * @param staging - staging dir root
   * @param archivePath - Destination path inside the archive
   * @returns Manifest file entry
   */
  private async stageFile(srcRoot: string, rel: string, staging: string, archivePath: string): Promise<BackupFileEntry> {
    const src = path.join(srcRoot, ...rel.split('/'));
    const dest = path.join(staging, ...archivePath.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    const { sha256, bytes } = await hashAndSize(dest);
    return { path: archivePath, sha256, bytes };
  }

  /**
   * Read the running Crewly version (best-effort). Uses npm_package_version —
   * the same source as tracing.service.ts — which works under both the ESM
   * runtime and the CJS test runner (no import.meta / __dirname).
   *
   * @returns Version string or 'unknown'
   */
  private readCrewlyVersion(): string {
    return process.env.npm_package_version ?? 'unknown';
  }
}

/**
 * Stream a file through SHA-256 and return the hex digest + byte size.
 *
 * @param filePath - File to hash
 * @returns sha256 (hex) and byte size
 */
async function hashAndSize(filePath: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
}
