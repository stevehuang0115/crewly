/**
 * `crewly backup` — workspace backup CLI (P0: local `create`).
 *
 * Builds a portable `.tar.gz` of this machine's workspace (CREWLY_HOME globals
 * + each project's `.crewly/` + chat.db) that can later be restored on another
 * machine. Runs fully locally and offline. Cloud push/pull/list (Pro-gated)
 * land in later phases. See specs/2026-06-07-workspace-backup.md.
 *
 * @module cli/commands/backup
 */

import chalk from 'chalk';
import os from 'os';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { BackupArchiveService } from '../../../backend/src/services/backup/backup-archive.service.js';
import {
  DEFAULT_PROJECT_FILE_EXCLUDES,
  PROJECT_FILES_SIZE_WARN_BYTES,
} from '../../../backend/src/services/backup/backup.types.js';
import { BackupRestoreService, RestoreConflictError } from '../../../backend/src/services/backup/backup-restore.service.js';
import {
  BackupCloudClient,
  BackupNotProError,
  type CloudBackupItem,
} from '../../../backend/src/services/backup/backup-cloud.client.js';
import { getCrewlyHomePath } from '../../../backend/src/services/core/crewly-home.utils.js';
import { CloudClientService } from '../../../backend/src/services/cloud/cloud-client.service.js';
import { LoggerService } from '../../../backend/src/services/core/logger.service.js';

/** Options accepted by `crewly backup`. */
export interface BackupCommandOptions {
  /** Output archive path (create). */
  out?: string;
  /** Exclude chat.db from the archive (create). commander sets chatDb=false for --no-chat-db. */
  chatDb?: boolean;
  /** Restore conflict mode: 'abort' (default) | 'overwrite'. */
  mode?: string;
  /** Restore source→target path remaps, each "OLD=NEW" (repeatable). */
  map?: string[];
  /** Actually apply the restore. Without this, restore is a dry-run preview. */
  apply?: boolean;
  /** Also archive each project's own source tree under projects/<id>/files/ (create). */
  includeProjectFiles?: boolean;
  /** Extra exclude globs for project files, added to the defaults (create, repeatable). */
  exclude?: string[];
  /** Skip the size confirmation when project files exceed the warning threshold (create). */
  yes?: boolean;
  /** Leave Slack credentials out of the restore (restore). */
  skipSlack?: boolean;
}

/** Human-readable byte size. */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * Best-effort source device id from CREWLY_HOME/device.json.
 *
 * @param home - CREWLY_HOME path
 * @returns device id or null
 */
function readDeviceId(home: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(home, 'device.json'), 'utf8');
    const parsed = JSON.parse(raw) as { id?: string; deviceId?: string };
    return parsed.id ?? parsed.deviceId ?? null;
  } catch {
    return null;
  }
}

/**
 * `crewly backup <action>` dispatcher.
 *
 * @param action - Subcommand: `create` (P0). Others are placeholders.
 * @param options - CLI options
 */
export async function backupCommand(
  action: string,
  target?: string,
  options: BackupCommandOptions = {},
): Promise<void> {
  switch (action) {
    case 'create':
      await runCreate(options);
      break;
    case 'restore':
      await runRestore(target, options);
      break;
    case 'push':
      await withCloudErrors(() => runPush(options));
      break;
    case 'pull':
      await withCloudErrors(() => runPull(target, options));
      break;
    case 'list':
      await withCloudErrors(() => runList());
      break;
    default:
      console.log(chalk.red(`Unknown backup action: ${action}`));
      console.log(chalk.gray('Usage: crewly backup create [--out <file>] [--no-chat-db] [--include-project-files] [--exclude <glob>]... [--yes]'));
      console.log(chalk.gray('       crewly backup restore <file> [--mode overwrite] [--map OLD=NEW] [--skip-slack] [--apply]'));
      process.exitCode = 1;
  }
}

/**
 * `crewly backup` entry used by the CLI: runs {@link backupCommand}, drains the
 * backend logger, and terminates the process with the accumulated exit code.
 *
 * The command's own promise settles when the work is done; this wrapper is the
 * safety net for item 27 ("backup create/restore never exit"): whatever handle
 * a backend service leaves behind (the logger's flush interval was the
 * culprit — now unref'd — but the next one would hang the operator's shell
 * again), the process still ends. A rejected command prints the error and
 * exits 1 instead of turning into a swallowed unhandledRejection.
 *
 * @param action - Subcommand
 * @param target - Positional target (archive path / backup id)
 * @param options - CLI options
 * @param exit - Process terminator (injectable for tests)
 */
export async function backupCommandAndExit(
  action: string,
  target?: string,
  options: BackupCommandOptions = {},
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  let code: number;
  try {
    await backupCommand(action, target, options);
    code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (err) {
    console.error(chalk.red(`\nBackup ${action} failed: ${err instanceof Error ? err.message : String(err)}`));
    code = 1;
  }
  await LoggerService.getInstance().shutdown();
  exit(code);
}

/**
 * Build a local workspace archive and print a summary.
 *
 * @param options - CLI options
 */
async function runCreate(options: BackupCommandOptions): Promise<void> {
  const home = getCrewlyHomePath();
  const createdAt = new Date().toISOString();
  const excludeChatDb = options.chatDb === false; // commander: --no-chat-db → chatDb:false

  console.log(chalk.cyan('Creating workspace backup…'));
  console.log(chalk.gray(`  CREWLY_HOME: ${home}`));

  const svc = new BackupArchiveService();
  const includeProjectFiles = options.includeProjectFiles === true;
  const projectFileExcludes = [...DEFAULT_PROJECT_FILE_EXCLUDES, ...(options.exclude ?? [])];

  if (includeProjectFiles) {
    const ok = await confirmProjectFilesSize(svc, home, projectFileExcludes, options.yes === true);
    if (!ok) {
      process.exitCode = 1;
      return;
    }
  }

  const { archivePath, manifest, totalBytes } = await svc.createArchive({
    homePath: home,
    outPath: options.out,
    excludeChatDb,
    createdAt,
    sourceDeviceId: readDeviceId(home),
    sourceDeviceName: os.hostname(),
    includeProjectFiles,
    projectFileExcludes,
  });

  const archiveBytes = fs.statSync(archivePath).size;
  console.log(chalk.green('\n✓ Backup created'));
  console.log(`  ${chalk.bold('Archive')}    ${archivePath}`);
  console.log(`  ${chalk.bold('Size')}       ${humanBytes(archiveBytes)} compressed (${humanBytes(totalBytes)} raw)`);
  console.log(`  ${chalk.bold('Globals')}    ${manifest.global.length} files`);
  console.log(`  ${chalk.bold('Projects')}   ${manifest.projects.length}`);
  if (manifest.includesProjectFiles) {
    const files = manifest.projects.reduce((n, p) => n + (p.projectFiles?.length ?? 0), 0);
    const bytes = manifest.projects.reduce((n, p) => n + (p.projectFilesBytes ?? 0), 0);
    console.log(`  ${chalk.bold('Files')}      ${files} project files (${humanBytes(bytes)}) — excludes: ${projectFileExcludes.join(', ')}`);
  } else {
    console.log(chalk.gray('  Files      project source files not included (add --include-project-files)'));
  }
  console.log(
    `  ${chalk.bold('chat.db')}    ${manifest.chatDb.included ? `included (${humanBytes(manifest.chatDb.bytes ?? 0)})` : `excluded${manifest.chatDb.skippedReason ? ` — ${manifest.chatDb.skippedReason}` : ''}`}`,
  );
  console.log(chalk.gray('\n  Restore on another machine with: crewly backup restore <file>'));
}

/**
 * Print per-project source sizes and, above {@link PROJECT_FILES_SIZE_WARN_BYTES},
 * refuse to continue unless `--yes` was passed.
 *
 * @param svc - Archive service (for the estimate)
 * @param home - CREWLY_HOME
 * @param excludes - Exclude patterns in effect
 * @param yes - Whether the operator pre-confirmed
 * @returns true to proceed with the archive
 */
async function confirmProjectFilesSize(
  svc: BackupArchiveService,
  home: string,
  excludes: string[],
  yes: boolean,
): Promise<boolean> {
  const estimates = await svc.estimateProjectFiles({ homePath: home, projectFileExcludes: excludes });
  const total = estimates.reduce((n, e) => n + e.bytes, 0);
  console.log(chalk.gray(`  Project files (excluding ${excludes.join(', ')}):`));
  for (const e of estimates) {
    console.log(chalk.gray(`    • ${e.name} (${e.path}) — ${humanBytes(e.bytes)}, ${e.fileCount} files`));
  }
  console.log(chalk.gray(`    Total ${humanBytes(total)} uncompressed`));
  if (total <= PROJECT_FILES_SIZE_WARN_BYTES || yes) return true;
  console.log(chalk.yellow(`\n⚠ Project files total ${humanBytes(total)}, above the ${humanBytes(PROJECT_FILES_SIZE_WARN_BYTES)} warning threshold.`));
  console.log(chalk.gray('  Trim with --exclude <glob> (e.g. --exclude dist --exclude "*.mp4"), or re-run with --yes to continue anyway.'));
  return false;
}

/**
 * Print the Slack ownership warning (item 29): one Slack app must be answered
 * by exactly one Crewly instance.
 */
function printSlackOwnershipWarning(): void {
  const line = '!'.repeat(72);
  console.log(chalk.yellow(`\n  ${line}`));
  console.log(chalk.yellow.bold('  !!  SLACK OWNERSHIP: this backup carries slack-credentials.json.'));
  console.log(chalk.yellow('  !!  If the source machine is still running, BOTH instances will answer the'));
  console.log(chalk.yellow('  !!  same Slack app and each message goes to whichever responds first —'));
  console.log(chalk.yellow('  !!  replies, threads and approvals become non-deterministic.'));
  console.log(chalk.yellow('  !!  Decide who owns Slack: restore with --skip-slack to keep it on the'));
  console.log(chalk.yellow('  !!  source, or stop / disconnect Slack on the source before applying.'));
  console.log(chalk.yellow(`  ${line}\n`));
}

/**
 * Restore a workspace archive. Dry-run preview by default; `--apply` to commit.
 *
 * @param target - Archive file path
 * @param options - CLI options (mode/map/apply)
 */
async function runRestore(target: string | undefined, options: BackupCommandOptions): Promise<void> {
  if (!target) {
    console.log(chalk.red('Missing archive path. Usage: crewly backup restore <file> [--apply]'));
    process.exitCode = 1;
    return;
  }
  const home = getCrewlyHomePath();
  const mode = options.mode === 'overwrite' ? 'overwrite' : 'abort';
  const pathMap: Record<string, string> = {};
  for (const m of options.map ?? []) {
    const eq = m.indexOf('=');
    if (eq <= 0) {
      console.log(chalk.red(`Invalid --map "${m}" (expected OLD=NEW)`));
      process.exitCode = 1;
      return;
    }
    pathMap[m.slice(0, eq)] = m.slice(eq + 1);
  }

  const svc = new BackupRestoreService();
  const restoreOpts = {
    archivePath: target,
    homePath: home,
    mode: mode as 'abort' | 'overwrite',
    pathMap,
    now: new Date().toISOString(),
    skipSlack: options.skipSlack === true,
  };

  // Always show the plan first.
  const plan = await svc.preview(restoreOpts);
  console.log(chalk.cyan('\nRestore plan'));
  console.log(`  ${chalk.bold('From backup')} taken ${plan.manifestCreatedAt} (source home ${plan.sourceHomePath})`);
  console.log(`  ${chalk.bold('Into')}        ${home}`);
  console.log(`  ${chalk.bold('Globals')}     ${plan.globalFileCount} files · ${chalk.bold('chat.db')} ${plan.chatDbIncluded ? 'yes' : 'no'}`);
  console.log(`  ${chalk.bold('Projects')}${plan.includesProjectFiles ? ' (archive carries project source files)' : ''}`);
  for (const p of plan.projects) {
    const tgt = p.targetPath ? p.targetPath + (p.targetExists ? '' : ' (will be created)') : chalk.yellow('UNRESOLVED — pass --map');
    const files = p.projectFileCount > 0 ? ` [${p.projectFileCount} files, ${humanBytes(p.projectFilesBytes)}${p.targetNonEmpty ? chalk.yellow(' → target NOT empty') : ''}]` : '';
    console.log(`    • ${p.name} → ${tgt}${files}`);
  }
  if (plan.conflicts.teams.length || plan.conflicts.projects.length) {
    console.log(chalk.yellow(`  Conflicts: ${plan.conflicts.teams.length} team(s), ${plan.conflicts.projects.length} project(s) already on this machine`));
  }
  if (plan.conflicts.projectFiles.length) {
    console.log(chalk.yellow(`  Conflicts: project files would overwrite ${plan.conflicts.projectFiles.length} non-empty director${plan.conflicts.projectFiles.length === 1 ? 'y' : 'ies'}`));
  }
  if (plan.hasSlackCredentials) {
    if (plan.slackSkipped) {
      console.log(chalk.gray('  Slack       credentials in backup — SKIPPED (--skip-slack); this machine will not answer the Slack app'));
    } else {
      console.log(`  ${chalk.bold('Slack')}       credentials in backup — will be restored`);
      printSlackOwnershipWarning();
    }
  }
  for (const w of plan.warnings) console.log(chalk.yellow(`  ⚠ ${w}`));
  console.log(chalk.gray(`  Discards: ${plan.discarded.join(', ')}`));

  if (!options.apply) {
    console.log(chalk.gray('\n  Dry-run only. Re-run with --apply to restore.'));
    if (!plan.ok) console.log(chalk.yellow("  Note: conflicts present — add --mode overwrite (a pre-restore snapshot is always saved)."));
    return;
  }

  try {
    console.log(chalk.cyan('\nApplying restore…'));
    const res = await svc.restore(restoreOpts);
    console.log(chalk.green('\n✓ Restore complete'));
    console.log(`  ${chalk.bold('Globals')}    ${res.restoredGlobalFiles} files`);
    console.log(`  ${chalk.bold('Projects')}   ${res.restoredProjects}`);
    if (plan.includesProjectFiles) console.log(`  ${chalk.bold('Files')}      ${res.restoredProjectFiles} project files`);
    console.log(`  ${chalk.bold('chat.db')}    ${res.chatDbRestored ? 'restored' : 'not in backup'}`);
    if (plan.hasSlackCredentials) {
      console.log(`  ${chalk.bold('Slack')}      ${res.slackSkipped ? 'credentials skipped (--skip-slack)' : 'credentials restored — make sure the source machine no longer runs Slack'}`);
    }
    console.log(`  ${chalk.bold('Rollback')}   ${res.rollbackSnapshotPath}`);
    console.log(chalk.gray('\n  Restart Crewly so agents pick up the restored workspace.'));
  } catch (err) {
    if (err instanceof RestoreConflictError) {
      console.log(chalk.red(`\n✗ ${err.message}`));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cloud (Pro): push / pull / list
// ---------------------------------------------------------------------------

/** Thrown when there's no persisted Crewly Cloud connection. */
class CloudNotConnectedError extends Error {
  constructor() {
    super('Not connected to Crewly Cloud.');
  }
}

/**
 * Resolve the Cloud API base URL + access token from the persisted config
 * (~/.crewly/cloud/config.json). Read directly (not via CloudClientService)
 * so this one-shot CLI doesn't start the singleton's relay-token refresh timer.
 *
 * @returns Cloud base URL + token + tier
 * @throws CloudNotConnectedError when not connected
 */
async function resolveCloudAuth(): Promise<{ baseUrl: string; token: string; tier: string }> {
  try {
    const raw = await fsp.readFile(CloudClientService.getConfigPath(), 'utf8');
    const cfg = JSON.parse(raw) as { cloudUrl?: string; token?: string; tier?: string };
    if (cfg.cloudUrl && cfg.token) return { baseUrl: cfg.cloudUrl, token: cfg.token, tier: cfg.tier ?? 'free' };
  } catch {
    /* fall through to not-connected */
  }
  throw new CloudNotConnectedError();
}

/** Wrap a cloud action, mapping not-Pro / not-connected to friendly messages. */
async function withCloudErrors(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof BackupNotProError) {
      console.log(chalk.yellow('\n⚠ Cloud backup is a Pro feature.'));
      console.log(chalk.gray(`  ${err.message}`));
      process.exitCode = 1;
    } else if (err instanceof CloudNotConnectedError) {
      console.log(chalk.red('\nNot connected to Crewly Cloud. Run: crewly cloud login'));
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

/** `crewly backup push` — create a local archive and upload it to the cloud. */
async function runPush(options: BackupCommandOptions): Promise<void> {
  const auth = await resolveCloudAuth();
  const home = getCrewlyHomePath();
  const deviceName = os.hostname();
  const deviceId = readDeviceId(home);

  console.log(chalk.cyan('Creating workspace backup…'));
  const svc = new BackupArchiveService();
  const { archivePath, manifest } = await svc.createArchive({
    homePath: home,
    excludeChatDb: options.chatDb === false,
    createdAt: new Date().toISOString(),
    sourceDeviceId: deviceId,
    sourceDeviceName: deviceName,
  });

  console.log(chalk.cyan('Uploading to Crewly Cloud…'));
  const client = new BackupCloudClient({ baseUrl: auth.baseUrl, token: auth.token });
  const item = await client.push(archivePath, { deviceName, deviceId: deviceId ?? undefined });

  console.log(chalk.green('\n✓ Backup pushed to cloud'));
  console.log(`  ${chalk.bold('Backup id')}  ${item.backupId}`);
  console.log(`  ${chalk.bold('Size')}       ${humanBytes(item.sizeBytes)} · chat.db ${manifest.chatDb.included ? 'yes' : 'no'}`);
  console.log(chalk.gray(`\n  Restore on another machine: crewly backup pull ${item.backupId} --apply`));
}

/** `crewly backup pull <id>` — download a cloud snapshot and restore it. */
async function runPull(backupId: string | undefined, options: BackupCommandOptions): Promise<void> {
  if (!backupId) {
    console.log(chalk.red('Missing backup id. Usage: crewly backup pull <id> [--apply]'));
    process.exitCode = 1;
    return;
  }
  const auth = await resolveCloudAuth();
  const client = new BackupCloudClient({ baseUrl: auth.baseUrl, token: auth.token });
  const dest = path.join(os.tmpdir(), `crewly-pull-${backupId.replace(/[^\w.-]/g, '_')}.tar.gz`);

  console.log(chalk.cyan(`Downloading backup ${backupId} from cloud…`));
  await client.pull(backupId, dest);
  console.log(chalk.gray(`  Saved to ${dest}`));

  // Hand off to the restore flow (dry-run by default; --apply commits).
  await runRestore(dest, options);
}

/** `crewly backup list` — show this account's cloud snapshots. */
async function runList(): Promise<void> {
  const auth = await resolveCloudAuth();
  const client = new BackupCloudClient({ baseUrl: auth.baseUrl, token: auth.token });
  const items: CloudBackupItem[] = await client.list();
  if (items.length === 0) {
    console.log(chalk.gray('No cloud backups yet. Create one with: crewly backup push'));
    return;
  }
  console.log(chalk.cyan(`\nCloud backups (${items.length})`));
  for (const it of items) {
    console.log(
      `  ${chalk.bold(it.backupId)}  ${it.createdAt}  ${humanBytes(it.sizeBytes)}  ${it.deviceName ?? ''}`,
    );
  }
  console.log(chalk.gray('\n  Restore: crewly backup pull <id> --apply'));
}
