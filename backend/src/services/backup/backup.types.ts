/**
 * Types for the Workspace Backup feature.
 *
 * A backup is a single `.tar.gz` archive containing a top-level
 * `manifest.json` plus the captured `CREWLY_HOME` globals, each project's
 * `.crewly/` tree, and (optionally) `chat.db`. See
 * specs/2026-06-07-workspace-backup.md.
 *
 * @module services/backup/backup.types
 */

/** Manifest schema version — bump on any breaking layout/field change. */
export const BACKUP_SCHEMA_VERSION = 1;

/** A single captured file recorded in the manifest for integrity + listing. */
export interface BackupFileEntry {
  /** Path inside the archive, relative to the archive root. */
  path: string;
  /** SHA-256 of the file content (hex). */
  sha256: string;
  /** Size in bytes. */
  bytes: number;
}

/** Git provenance for a captured project so restore can re-clone the source tree. */
export interface BackupProjectGit {
  /** `origin` remote URL, or null when not a git repo / no origin. */
  remote: string | null;
  /** HEAD commit sha, or null when unavailable. */
  commit: string | null;
}

/** One project's captured `.crewly/` data + provenance. */
export interface BackupProjectEntry {
  /** Stable project id (from projects.json). */
  id: string;
  /** Human-readable project name. */
  name: string;
  /** Absolute path on the SOURCE machine (used for restore path-rewriting). */
  sourcePath: string;
  /** Git provenance for re-clone on restore. */
  git: BackupProjectGit;
  /** Captured files under `projects/<id>/` in the archive. */
  files: BackupFileEntry[];
}

/** chat.db capture record. */
export interface BackupChatDb {
  /** Whether chat.db was included (false when excluded or the native module is absent). */
  included: boolean;
  /** SHA-256 of the captured db, when included. */
  sha256?: string;
  /** Size in bytes, when included. */
  bytes?: number;
  /** Reason it was skipped, when not included. */
  skippedReason?: string;
}

/** Encryption envelope descriptor. v1 archives are unencrypted on disk; Cloud adds SSE. */
export interface BackupCrypto {
  /** `none` for v1 local archives. `sse` once parked in the cloud. */
  mode: 'none' | 'sse';
}

/** Top-level archive manifest. */
export interface BackupManifest {
  schemaVersion: number;
  crewlyVersion: string;
  /** ISO timestamp — the logical point-in-time of the snapshot. */
  createdAt: string;
  /** Source device id (observability only; NEVER restored). */
  sourceDeviceId: string | null;
  sourceDeviceName: string | null;
  /** Source `CREWLY_HOME` absolute path — restore uses it for path rewriting. */
  sourceHomePath: string;
  /** Owner account (JWT `sub`/googleId). Null for local-only archives; stamped by Cloud on upload. */
  ownerSub: string | null;
  /** Captured CREWLY_HOME global files (relative to `home/` in the archive). */
  global: BackupFileEntry[];
  /** Captured per-project `.crewly/` data. */
  projects: BackupProjectEntry[];
  chatDb: BackupChatDb;
  crypto: BackupCrypto;
}

/** Options for building an archive. */
export interface CreateBackupOptions {
  /** Output archive path. Defaults to `CREWLY_HOME/backups/workspace-<ts>.tar.gz`. */
  outPath?: string;
  /** Exclude chat.db (smaller archive, avoids SQLite capture). Default false. */
  excludeChatDb?: boolean;
  /** Override CREWLY_HOME (tests). Defaults to getCrewlyHomePath(). */
  homePath?: string;
  /** ISO timestamp for the snapshot point. Defaults to caller-supplied now (no Date in lib). */
  createdAt: string;
  /** Owner sub to stamp (usually null locally; Cloud stamps on upload). */
  ownerSub?: string | null;
  /** Source device id/name for the manifest (observability). */
  sourceDeviceId?: string | null;
  sourceDeviceName?: string | null;
}

/** Result of a successful archive build. */
export interface CreateBackupResult {
  archivePath: string;
  manifest: BackupManifest;
  /** Total uncompressed bytes captured (for quota/UX). */
  totalBytes: number;
}

// ---------------------------------------------------------------------------
// Restore (P1)
// ---------------------------------------------------------------------------

/** How to handle a target that already has overlapping data. */
export type RestoreMode = 'abort' | 'overwrite';

/** Options for restoring an archive onto this machine. */
export interface RestoreOptions {
  /** Archive (.tar.gz) to restore. */
  archivePath: string;
  /** Target CREWLY_HOME. Defaults to getCrewlyHomePath(). */
  homePath?: string;
  /** Conflict policy. Default 'abort'. */
  mode?: RestoreMode;
  /**
   * Source→target absolute path remap for projects, e.g.
   * `{ '/Users/alice/web': '/Users/bob/web' }`. When a source path isn't
   * mapped, restore reuses it if it exists on the target, else records a
   * warning and skips that project's `.crewly/` write.
   */
  pathMap?: Record<string, string>;
  /** ISO timestamp used to name the pre-restore rollback snapshot. */
  now: string;
}

/** One project's restore plan entry. */
export interface RestoreProjectPlan {
  id: string;
  name: string;
  sourcePath: string;
  /** Resolved target path (pathMap → existing sourcePath → null when unresolved). */
  targetPath: string | null;
  git: { remote: string | null; commit: string | null };
  /** Whether the resolved target path currently exists on this machine. */
  targetExists: boolean;
}

/** Non-destructive restore plan (dry-run). */
export interface RestorePlan {
  /** False when mode='abort' and conflicts exist (apply would refuse). */
  ok: boolean;
  manifestCreatedAt: string;
  sourceHomePath: string;
  /** Stable ids present on BOTH the backup and this machine (would be overwritten). */
  conflicts: { teams: string[]; projects: string[] };
  globalFileCount: number;
  projects: RestoreProjectPlan[];
  chatDbIncluded: boolean;
  /** Things to regenerate (device identity) / discard (runtime/session). */
  regenerated: string[];
  discarded: string[];
  warnings: string[];
}

/** Result of an applied restore. */
export interface RestoreResult {
  restoredGlobalFiles: number;
  restoredProjects: number;
  chatDbRestored: boolean;
  /** Where the pre-restore snapshot of the current CREWLY_HOME was saved. */
  rollbackSnapshotPath: string;
  warnings: string[];
}
