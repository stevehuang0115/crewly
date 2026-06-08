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
import { BackupArchiveService } from '../../../backend/src/services/backup/backup-archive.service.js';
import { BackupRestoreService, RestoreConflictError } from '../../../backend/src/services/backup/backup-restore.service.js';
import { getCrewlyHomePath } from '../../../backend/src/services/core/crewly-home.utils.js';

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
    case 'pull':
    case 'list':
      console.log(chalk.yellow(`'crewly backup ${action}' is not available yet (coming in a later phase).`));
      console.log(chalk.gray('Available now: crewly backup create | crewly backup restore <file>'));
      break;
    default:
      console.log(chalk.red(`Unknown backup action: ${action}`));
      console.log(chalk.gray('Usage: crewly backup create [--out <file>] [--no-chat-db]'));
      console.log(chalk.gray('       crewly backup restore <file> [--mode overwrite] [--map OLD=NEW] [--apply]'));
      process.exitCode = 1;
  }
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
  const { archivePath, manifest, totalBytes } = await svc.createArchive({
    homePath: home,
    outPath: options.out,
    excludeChatDb,
    createdAt,
    sourceDeviceId: readDeviceId(home),
    sourceDeviceName: os.hostname(),
  });

  const archiveBytes = fs.statSync(archivePath).size;
  console.log(chalk.green('\n✓ Backup created'));
  console.log(`  ${chalk.bold('Archive')}    ${archivePath}`);
  console.log(`  ${chalk.bold('Size')}       ${humanBytes(archiveBytes)} compressed (${humanBytes(totalBytes)} raw)`);
  console.log(`  ${chalk.bold('Globals')}    ${manifest.global.length} files`);
  console.log(`  ${chalk.bold('Projects')}   ${manifest.projects.length}`);
  console.log(
    `  ${chalk.bold('chat.db')}    ${manifest.chatDb.included ? `included (${humanBytes(manifest.chatDb.bytes ?? 0)})` : `excluded${manifest.chatDb.skippedReason ? ` — ${manifest.chatDb.skippedReason}` : ''}`}`,
  );
  console.log(chalk.gray('\n  Restore on another machine with: crewly backup restore <file>'));
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
  const restoreOpts = { archivePath: target, homePath: home, mode: mode as 'abort' | 'overwrite', pathMap, now: new Date().toISOString() };

  // Always show the plan first.
  const plan = await svc.preview(restoreOpts);
  console.log(chalk.cyan('\nRestore plan'));
  console.log(`  ${chalk.bold('From backup')} taken ${plan.manifestCreatedAt} (source home ${plan.sourceHomePath})`);
  console.log(`  ${chalk.bold('Into')}        ${home}`);
  console.log(`  ${chalk.bold('Globals')}     ${plan.globalFileCount} files · ${chalk.bold('chat.db')} ${plan.chatDbIncluded ? 'yes' : 'no'}`);
  console.log(`  ${chalk.bold('Projects')}`);
  for (const p of plan.projects) {
    const tgt = p.targetPath ? p.targetPath + (p.targetExists ? '' : ' (will be created)') : chalk.yellow('UNRESOLVED — pass --map');
    console.log(`    • ${p.name} → ${tgt}`);
  }
  if (plan.conflicts.teams.length || plan.conflicts.projects.length) {
    console.log(chalk.yellow(`  Conflicts: ${plan.conflicts.teams.length} team(s), ${plan.conflicts.projects.length} project(s) already on this machine`));
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
    console.log(`  ${chalk.bold('chat.db')}    ${res.chatDbRestored ? 'restored' : 'not in backup'}`);
    console.log(`  ${chalk.bold('Rollback')}   ${res.rollbackSnapshotPath}`);
    console.log(chalk.gray('\n  Restart Crewly so agents pick up the restored workspace.'));
  } catch (err) {
    if (err instanceof RestoreConflictError) {
      console.log(chalk.red('\n✗ Restore aborted — conflicts present. Re-run with --mode overwrite to replace them.'));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
