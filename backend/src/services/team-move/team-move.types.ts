/**
 * Types of the team move feature (crewly#1189).
 *
 * The Cloud wire format (statuses, relay payload, preflight) mirrors the
 * shared contract with the Cloud service; the package layout and the import
 * report are owned by this side.
 *
 * @module services/team-move/team-move.types
 */

// ---------------------------------------------------------------------------
// Cloud contract
// ---------------------------------------------------------------------------

/** Move states; Cloud is the source of truth. */
export const TEAM_MOVE_STATUSES = [
  'requested',
  'target_ready',
  'packaging',
  'uploaded',
  'importing',
  'imported',
  'switched',
  'completed',
  'failed',
  'rolled_back',
] as const;
export type TeamMoveStatus = (typeof TEAM_MOVE_STATUSES)[number];

/** Which side of the move this machine is. */
export type TeamMoveRole = 'source' | 'target';

/** What Cloud asks a machine to do. */
export type TeamMoveAction = 'prepare' | 'package' | 'import' | 'stop_archive' | 'rollback';

/** What Cloud asks a machine to do before a move exists. */
export type TeamMovePreflightAction = 'preflight' | 'ask_team';

/** Relay push `data` of a preflight (`type: 'team_move'`, no `moveId`). */
export interface TeamMovePreflightRelayData {
  preflightId: string;
  role: TeamMoveRole;
  action: TeamMovePreflightAction;
}

/** Choices the owner made for a move (stored by Cloud on the move). */
export interface TeamMoveOptions {
  /** Move although repositories hold work that exists only on the source. */
  allowDirty?: boolean;
  /** Leave files with secrets behind instead of stopping. */
  skipFlagged?: boolean;
  /** Carry uncommitted work in the package instead of requiring a push. */
  carryChanges?: boolean;
}

/** Relay push `data` (`type: 'team_move'`). */
export interface TeamMoveRelayData {
  moveId: string;
  role: TeamMoveRole;
  action: TeamMoveAction;
}

/** Statuses a machine may report on `POST /:moveId/status`. */
export type TeamMoveReportStatus =
  | 'importing'
  | 'imported'
  | 'failed'
  | 'source_stopped'
  | 'source_restored'
  | 'target_stopped';

/** What the target tells Cloud about itself (`POST /:moveId/target-key`). */
export interface TeamMovePreflight {
  crewlyVersion: string;
  freeDiskBytes: number;
  tools: Record<string, boolean>;
  runtimes: Record<string, boolean>;
  /**
   * Whether this machine can read each remote of the moving team's repositories
   * (`git ls-remote`, never prompting). Present only when Cloud told the target
   * which remotes to test. Remotes are credential-free.
   */
  gitAccess?: Array<{ remote: string; ok: boolean; error?: string }>;
}

/** Package metadata Cloud keeps. */
export interface TeamMovePackageMeta {
  size: number;
  sha256: string;
  chunks: number;
  chunkBytes: number;
  received?: number | number[];
  verified?: boolean;
  manifest?: Record<string, unknown>;
}

/** A move as Cloud shows it to an instance or the owner. */
export interface TeamMoveView {
  moveId: string;
  teamId: string;
  teamName: string;
  source: { instanceId: string; name: string };
  target: { instanceId: string; name: string };
  status: TeamMoveStatus;
  error?: string;
  failedAt?: TeamMoveStatus;
  targetPublicKey?: string;
  /** Credential-free remotes of the team's repositories, for the target to test. */
  remotes?: string[];
  preflight?: TeamMovePreflight;
  package?: TeamMovePackageMeta;
  report?: Record<string, unknown>;
  cleanup?: { sourcePending: boolean; targetPending: boolean };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  rolledBackAt?: string;
  canRollback?: boolean;
  rollbackUntil?: string;
  /** Set on instance requests: what this instance should do now. */
  role?: TeamMoveRole;
  action?: TeamMoveAction;
  /** The owner's choices (carry changes, leave flagged files, move anyway). */
  options?: TeamMoveOptions;
}

// ---------------------------------------------------------------------------
// Preflight (before a move)
// ---------------------------------------------------------------------------

/** How a changed file differs from the last commit. */
export type RepoFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

/** One repository of the team as the preflight sees it. */
export interface RepoPreflight {
  projectId: string;
  projectName: string;
  path: string;
  /** False for a plain folder (its files travel in the package). */
  isRepo: boolean;
  branch: string | null;
  /** `host/owner/repo` of origin (credentials and scheme removed). */
  remote: string | null;
  /** The remote URL without credentials, so the target can test it. */
  remoteUrl?: string;
  /** The target cannot read the remote (it has no credentials for it); the repository is carried instead. */
  remoteUnreachable?: boolean;
  noRemote: boolean;
  /** Tracked files with uncommitted changes. */
  modified: number;
  /** Untracked files that are not ignored. */
  untracked: number;
  /** Local commits the remote does not have. */
  unpushed: number;
  /** The first few changed files, modified before untracked. */
  topFiles: Array<{ path: string; status: RepoFileStatus }>;
  filesTruncated: boolean;
  /** Whether the changes can travel in the package ("Carry uncommitted changes"). */
  carry: { possible: boolean; files: number; bytes: number; flattenedCommits: number; reason?: string } | null;
  /**
   * The repository travels in the package as a git bundle (no remote, or local
   * commits the remote lacks) instead of being cloned. Null when it is cloned.
   */
  bundle?: {
    mode: 'full' | 'unpushed';
    /** Estimated size (exact for the real package); null when it cannot be known beforehand. */
    bytes: number | null;
    possible: boolean;
    /** Why it cannot be carried (over the cap, no commits, ...). */
    reason?: string;
    /** One line for the owner, e.g. "no remote — will be carried in the package (0.8 GB)". */
    message: string;
  } | null;
}

/** A file the secret scan flagged. */
export interface PreflightFinding {
  /** Where it lives, in the owner's words (`Project/path`). */
  file: string;
  matches: number;
  /** "Leave flagged files behind" can drop it (otherwise it is part of the team's own records). */
  removable: boolean;
}

/** What the source machine finds out about a team before it moves. */
export interface SourcePreflightReport {
  checkedAt: string;
  teamId: string;
  teamName: string;
  crewlyVersion: string;
  members: number;
  repos: RepoPreflight[];
  /** Null when the package was not dry-run (a quick refresh without cached results). */
  scan: { filesScanned: number; findings: PreflightFinding[] } | null;
  /** Uncompressed size of the package (null as above). */
  sizeBytes: number | null;
  requiredTools: string[];
  requiredRuntimes: string[];
  requiredConnectors: string[];
  /** Whether carrying was requested for this run (it changes the scan). */
  carryRequested: boolean;
}

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

/** One file in the package. */
export interface PackageFileEntry {
  /** POSIX path inside the package. */
  path: string;
  sha256: string;
  bytes: number;
}

/** A git repository a project of the team lives in. */
export interface PackageRepo {
  projectId: string;
  projectName: string;
  /** Absolute path on the source machine. */
  path: string;
  /** `origin` as configured (not rewritten by `url.*.insteadOf`), or null. */
  remoteUrl: string | null;
  branch: string | null;
  headSha: string | null;
  /** Uncommitted changes in the working tree. */
  dirty: boolean;
  /** Commits on the branch that the remote does not have yet. */
  unpushed: number;
  /** Why the state could not be read (not a repo, no remote, ...). */
  note?: string;
  /** Uncommitted work that travels in the package instead of being pushed. */
  carry?: PackageCarry;
  /** Why uncommitted work could not be carried (asked for, but too big, ...). */
  carryError?: string;
  /** The repository itself travels in the package as a git bundle (see {@link PackageBundle}). */
  bundle?: PackageBundle;
  /** Size of the repository's object store (bytes); scales the clone time limit on the target. */
  sizeBytes?: number;
}

/** A repository carried as a `git bundle` inside the package. */
export interface PackageBundle {
  /** `full`: every branch and tag (the repository has no remote); `unpushed`: only the commits the remote lacks. */
  mode: 'full' | 'unpushed';
  /** Package path, `projects/<id>/bundle/repo.bundle`; absent in a dry run. */
  file?: string;
  /** Size in bytes (an estimate in a dry run). */
  bytes: number;
  sha256?: string;
  /** Refs in the bundle. */
  refs?: number;
  /** Why a repository that has a remote travels whole: the target cannot read that remote. */
  why?: 'remote_unreachable';
}

/** Uncommitted work of a repository that travels in the package. */
export interface PackageCarry {
  /** A commit the remote has; the target checks it out and applies the changes on top. */
  baseSha: string;
  /** Tracked files whose changes (edits, deletions, binary files) travel as patches. */
  patches: number;
  /** Untracked, not-ignored files that travel as they are. */
  untracked: number;
  bytes: number;
  /** Local commits the remote does not have; their changes are part of the patches (uncommitted on the target). */
  flattenedCommits: number;
  /** Changes left on the source because the secret scan flagged them (repository-relative paths). */
  leftBehind: string[];
}

/** `projects/<id>/carry/carry.json`: how to apply a repository's carried changes. */
export interface CarryIndex {
  version: 1;
  baseSha: string;
  branch: string | null;
  flattenedCommits: number;
  /** One `git apply` patch per changed tracked file. */
  patches: Array<{ path: string; file: string; deleted: boolean }>;
  untracked: Array<{ path: string; file: string; executable: boolean }>;
  leftBehind: string[];
}

/** A project-local file left out of the package. */
export interface SkippedFile {
  path: string;
  bytes: number;
  reason: 'too_large' | 'size_cap' | 'secret_scan' | 'unreadable';
}

/** A project of the team and its `.crewly` data in the package. */
export interface PackageProject {
  id: string;
  name: string;
  /** Absolute path on the source machine. */
  sourcePath: string;
  /** Where the project's Crewly data lives on the source (`<path>/.crewly` or CREWLY_HOME). */
  dataDir: string;
  files: number;
  bytes: number;
  skipped: SkippedFile[];
  /**
   * Working files of a project that is not a git repository (the code itself
   * travels in the package; git projects are cloned instead). Stored under
   * `projects/<id>/files/`.
   */
  work?: { files: number; bytes: number; skipped: SkippedFile[] };
  /** Other teams that also use this project (their data stays on the source). */
  sharedWithTeams: string[];
}

/** A member in the manifest (no prompts). */
export interface PackageMember {
  id: string;
  name: string;
  role: string;
  sessionName: string;
  runtimeType: string;
}

/**
 * A member's latest Claude Code conversation in the package (crewly#1344):
 * `transcripts/<session>/<id>.jsonl` plus its sidecar folder, resumed on the
 * target. `skipped` names why it was left behind (the agent then starts fresh).
 */
export interface PackageConversation {
  sessionName: string;
  /** Claude Code conversation id (`--resume <id>`) */
  sessionId: string;
  /** The member's cwd on the source (the transcript is keyed on it there) */
  cwd: string;
  bytes: number;
  /** Package path of the transcript, when it travels */
  file?: string;
  /** Files staged (transcript plus sidecar files) */
  files?: number;
  skipped?: 'too_large' | 'not_found' | 'unreadable';
}

/** The full manifest, `manifest.json` at the root of the package. */
export interface TeamMoveManifest {
  kind: 'crewly-team-move';
  schemaVersion: number;
  moveId: string;
  createdAt: string;
  crewlyVersion: string;
  source: { instanceId: string | null; deviceName: string | null; homePath: string; platform: string };
  team: { id: string; name: string; members: PackageMember[]; projectIds: string[] };
  /** What is in the package, by kind. */
  counts: Record<string, number>;
  projects: PackageProject[];
  /** The members' latest Claude Code conversations (absent in packages from before crewly#1344). */
  conversations?: PackageConversation[];
  repos: PackageRepo[];
  /** Tools the team's prompts, norms and SOPs mention. */
  requiredTools: string[];
  /** Runtimes the members use. */
  requiredRuntimes: string[];
  /** Connectors (Google, Zoho, ...) the team's words mention; connections are not moved. */
  requiredConnectors?: string[];
  /** Every file of the package with its hash. */
  files: PackageFileEntry[];
  /** Total uncompressed bytes. */
  totalBytes: number;
  /** Always true: the secret scan passed (a package is never built otherwise). */
  noSecrets: true;
  /**
   * `redactedFiles`: files whose secrets were masked in the package copy;
   * `masked` names each with its number of redactions (never a value).
   */
  secretScan: { filesScanned: number; knownValuesChecked: number; findings: 0; excludedFiles: number; redactedFiles?: number; masked?: Array<{ path: string; redactions: number }> };
  /** Source things that are deliberately not moved (shown to the owner). */
  notMoved: string[];
}

/** Compact summary sent to Cloud with `package/init` (kept under 64 KB, no names of files). */
export interface CloudManifestSummary {
  kind: 'crewly-team-move';
  schemaVersion: number;
  crewlyVersion: string;
  team: { id: string; name: string; members: number };
  counts: Record<string, number>;
  repos: number;
  reposDirty: number;
  requiredTools: string[];
  requiredRuntimes: string[];
  totalBytes: number;
  /** Cloud checks it against the target's free disk. */
  uncompressedBytes: number;
  noSecrets: true;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Import report
// ---------------------------------------------------------------------------

/** A credential or login the owner has to reconnect on the target. */
export interface ReconnectItem {
  /** Short label, e.g. "Claude Code login". */
  label: string;
  /** `runtime` | `connector` | `slack` | `ssh` | `other` */
  kind: string;
  /** Tap-to-fix link when Crewly has a card for it. */
  url?: string;
  detail?: string;
}

/** A member that runs on a stand-in runtime because its own is not available on the target. */
export interface RuntimeStandIn {
  member: string;
  /** Configured runtime, as a label ("Antigravity"). */
  configured: string;
  /** Runtime it runs on now ("Claude Code"). */
  runningOn: string;
}

/** What starting the team on the target came to. */
export interface TeamMoveStartResult {
  requested: boolean;
  ok: boolean;
  error?: string;
  /** Start attempts made (more than one when the first ones failed). */
  attempts?: number;
  /** Members running on a stand-in runtime until their own is installed / signed in here. */
  fallbacks?: RuntimeStandIn[];
}

/** The target's import report (owner-facing). */
export interface TeamMoveImportReport {
  /** Moved counts by kind; Cloud shows these. */
  moved: Record<string, number>;
  repos: {
    cloned: Array<{ name: string; path: string; branch: string | null; headSha: string | null; viaBundle?: boolean; remoteUnreachable?: boolean; remote?: string }>;
    /** A repository that could not be put in place; the team still starts. `needsLogin`: the target has no git credentials for `remote`. */
    failed: Array<{ name: string; reason: string; remote?: string; needsLogin?: boolean }>;
    /** Uncommitted work carried from the source and applied on top of the clone. */
    carried?: Array<{ name: string; applied: number; untracked: number; failed: Array<{ path: string; reason: string }>; flattenedCommits: number; leftBehind: number }>;
  };
  missingTools: string[];
  /** Runtimes the team uses that are not logged in here. */
  runtimesNotLoggedIn: string[];
  reconnect: ReconnectItem[];
  /** Projects placed on a different path than on the source. */
  paths: Array<{ projectId: string; name: string; from: string; to: string }>;
  /** Team start result. */
  started: TeamMoveStartResult;
  /** Warnings that need no action. */
  warnings: string[];
  /** Things not moved (copied from the manifest). */
  notMoved: string[];
  crewlyVersion: string;
  importedAt: string;
}

// ---------------------------------------------------------------------------
// Journal and local move state
// ---------------------------------------------------------------------------

/** A step of the import; each is idempotent and recorded in the journal. */
export const IMPORT_STEPS = [
  'download',
  'decrypt',
  'validate',
  'projects',
  'repos',
  'data',
  'records',
  'team',
  'start',
  'report',
] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

/** A step of the export. */
export const EXPORT_STEPS = ['collect', 'scan', 'encrypt', 'upload'] as const;
export type ExportStep = (typeof EXPORT_STEPS)[number];

/** One journal entry. */
export interface JournalEntry {
  step: string;
  state: 'started' | 'done' | 'failed';
  at: string;
  detail?: unknown;
  error?: string;
}

/** Persisted state of one move on this machine (`state.json`). */
export interface LocalMoveState {
  moveId: string;
  role: TeamMoveRole;
  teamId: string;
  teamName: string;
  /** Last action Cloud asked for and what happened to it. */
  action: TeamMoveAction | null;
  phase: 'idle' | 'running' | 'done' | 'failed';
  error?: string;
  updatedAt: string;
}

/** What an import is doing right now (sent to Cloud and logged about every 30 s). */
export interface ImportProgress {
  step: 'repos';
  /** The repository being fetched. */
  repo: string;
  /** Git's phase ("Receiving objects"); null before git printed anything. */
  phase: string | null;
  percent: number | null;
  objectsDone: number | null;
  objectsTotal: number | null;
  /** Bytes received so far, when git reports them. */
  bytes: number | null;
  /** Transfer speed as git prints it. */
  rate: string | null;
  elapsedMs: number;
}
