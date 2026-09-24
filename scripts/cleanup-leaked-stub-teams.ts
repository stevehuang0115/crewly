#!/usr/bin/env node
/**
 * Find (and optionally quarantine) the stub teams leaked by issue #729.
 *
 * A 2026-06-12 verification run of the autonomous-harness P0 wrote three
 * "Dtc Viral Content Team" stubs (Vee/Ace/Coco, never launched) into a real
 * `~/.crewly/teams`. This script finds copies by the FULL incident
 * fingerprint — see `backend/src/scripts/leaked-stub-teams.lib.ts` — and
 * never deletes: `--apply` moves matches into a backup directory.
 *
 * Stop the Crewly backend before `--apply` so it does not re-save a team it
 * still holds in memory.
 *
 * Usage:
 *   tsx scripts/cleanup-leaked-stub-teams.ts                  # dry run (default)
 *   tsx scripts/cleanup-leaked-stub-teams.ts --apply          # move matches to backup
 *   tsx scripts/cleanup-leaked-stub-teams.ts --teams-dir <dir> --backup-dir <dir>
 *
 * Defaults: teams dir `$CREWLY_HOME/teams` (else `~/.crewly/teams`); backup
 * dir `<crewly home>/cleanup-backup-<YYYY-MM-DD>-leaked-stub-teams`.
 *
 * Exit codes: 0 success, 2 some matches failed to move, 3 invalid arguments.
 *
 * @module scripts/cleanup-leaked-stub-teams
 */

import * as os from 'node:os';
import * as path from 'node:path';

// Issue #478: named exports are bundled into `default` when tsx transpiles for
// this `"type": "module"` package, so import the namespace and destructure.
import libDefault from '../backend/src/scripts/leaked-stub-teams.lib.js';

const { quarantineLeakedStubTeams } = libDefault as unknown as {
  quarantineLeakedStubTeams: typeof import('../backend/src/scripts/leaked-stub-teams.lib.js').quarantineLeakedStubTeams;
};

/** Exit code when at least one match could not be moved. */
const EXIT_MOVE_FAILED = 2;
/** Exit code for unknown or incomplete arguments. */
const EXIT_BAD_ARGS = 3;

/**
 * Write one line to stdout.
 *
 * @param line - Text to print.
 */
function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Parse argv into options.
 *
 * @param argv - Arguments after the script path.
 * @returns Parsed options, or an error message.
 */
function parseArgs(
  argv: string[],
): { apply: boolean; teamsDir?: string; backupDir?: string } | { error: string } {
  const out: { apply: boolean; teamsDir?: string; backupDir?: string } = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--dry-run') out.apply = false;
    else if (arg === '--teams-dir' || arg === '--backup-dir') {
      const value = argv[i + 1];
      if (!value) return { error: `${arg} needs a value` };
      if (arg === '--teams-dir') out.teamsDir = value;
      else out.backupDir = value;
      i += 1;
    } else return { error: `unknown argument: ${arg}` };
  }
  return out;
}

/**
 * Entry point.
 *
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return EXIT_BAD_ARGS;
  }

  const crewlyHome = process.env.CREWLY_HOME || path.join(os.homedir(), '.crewly');
  const teamsDir = path.resolve(parsed.teamsDir ?? path.join(crewlyHome, 'teams'));
  const stamp = new Date().toISOString().slice(0, 10);
  const backupDir = path.resolve(
    parsed.backupDir ?? path.join(crewlyHome, `cleanup-backup-${stamp}-leaked-stub-teams`),
  );

  const report = await quarantineLeakedStubTeams({ teamsDir, backupDir, apply: parsed.apply });

  print(`teams dir: ${teamsDir}`);
  print(`mode:      ${report.dryRun ? 'dry run (nothing moved; pass --apply to move)' : `apply → ${backupDir}`}`);
  print(`matched:   ${report.matched.length}`);
  for (const id of report.matched) print(`  - ${id}`);
  if (report.nearMisses.length > 0) {
    print(`kept (same template, not the leaked stubs): ${report.nearMisses.length}`);
    for (const n of report.nearMisses) print(`  - ${n.dirName}: ${n.reasons.join('; ')}`);
  }
  if (!report.dryRun) {
    print(`moved:     ${report.moved.length}`);
    for (const f of report.failed) print(`  ! ${f.dirName}: ${f.error}`);
  }
  return report.failed.length > 0 ? EXIT_MOVE_FAILED : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
