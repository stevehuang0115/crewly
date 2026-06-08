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
import { getCrewlyHomePath } from '../../../backend/src/services/core/crewly-home.utils.js';

/** Options accepted by `crewly backup`. */
export interface BackupCommandOptions {
  /** Output archive path (create). */
  out?: string;
  /** Exclude chat.db from the archive (create). commander sets chatDb=false for --no-chat-db. */
  chatDb?: boolean;
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
export async function backupCommand(action: string, options: BackupCommandOptions = {}): Promise<void> {
  switch (action) {
    case 'create':
      await runCreate(options);
      break;
    case 'restore':
    case 'push':
    case 'pull':
    case 'list':
      console.log(chalk.yellow(`'crewly backup ${action}' is not available yet (coming in a later phase).`));
      console.log(chalk.gray('Available now: crewly backup create'));
      break;
    default:
      console.log(chalk.red(`Unknown backup action: ${action}`));
      console.log(chalk.gray('Usage: crewly backup create [--out <file>] [--no-chat-db]'));
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
  console.log(chalk.gray('\n  Restore on another machine with: crewly backup restore <file>  (coming soon)'));
}
