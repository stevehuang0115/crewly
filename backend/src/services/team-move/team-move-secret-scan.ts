/**
 * Secret scan of a package before it leaves the machine.
 *
 * Runs the same detectors as the session-log redactor (token shapes such as
 * Slack, OpenAI/Anthropic, GitHub, Google keys, JWTs, bearer headers, private
 * key blocks, connection strings and `SECRET_NAME=value` assignments) plus the
 * exact secret values this machine holds in its environment and settings. It
 * reports file paths and pattern counts only, never a matched value.
 *
 * @module services/team-move/team-move-secret-scan
 */

import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { redactSecretsWithCount } from '../../utils/secret-redactor.js';
import type { SecretEnvValue } from '../../utils/secret-env.js';
import { looksLikeText } from './team-move-fs.js';
import type { PackageFileEntry } from './team-move.types.js';
import type { StagingArea } from './team-move-fs.js';

/** Window read at a time (text is scanned in overlapping windows). */
const WINDOW_BYTES = 1024 * 1024;
/** Overlap between windows so a secret cut by a boundary is still seen. */
const OVERLAP_BYTES = 1024;

/** One file that holds secrets. */
export interface SecretFinding {
  /** Package path. */
  path: string;
  /** Number of secret matches (values are never returned). */
  matches: number;
}

/** Result of a scan. */
export interface SecretScanResult {
  filesScanned: number;
  findings: SecretFinding[];
}

/** Thrown when a package would carry secrets. */
export class TeamMoveSecretScanError extends Error {
  constructor(readonly findings: SecretFinding[]) {
    super(
      `The secret scan found credentials in ${findings.length} file${findings.length === 1 ? '' : 's'}; nothing was sent. ` +
        `Remove them from: ${findings.slice(0, 10).map((f) => f.path).join(', ')}${findings.length > 10 ? ', ...' : ''}`,
    );
    this.name = 'TeamMoveSecretScanError';
  }
}

/**
 * Count secrets in one file.
 *
 * @param abs - Absolute file path
 * @param known - Exact secret values to look for
 * @returns Number of matches, 0 for binary files
 */
async function scanFile(abs: string, known: readonly SecretEnvValue[]): Promise<{ matches: number; scanned: boolean }> {
  const handle = await fs.open(abs, 'r');
  try {
    const stat = await handle.stat();
    const head = Buffer.alloc(Math.min(8192, stat.size));
    await handle.read(head, 0, head.length, 0);
    if (!looksLikeText(head)) return { matches: 0, scanned: false };
    let matches = 0;
    let position = 0;
    const buf = Buffer.alloc(WINDOW_BYTES + OVERLAP_BYTES);
    // Matches inside the overlap are seen by two windows; counting the first
    // window's tail once is enough, we only need "any", so double counts are fine.
    while (position < stat.size) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      matches += redactSecretsWithCount(buf.subarray(0, bytesRead).toString('utf8'), known).count;
      position += WINDOW_BYTES;
    }
    return { matches, scanned: true };
  } finally {
    await handle.close();
  }
}

/**
 * Scan every file of a staging area.
 *
 * @param staging - The package being built
 * @param files - Its files
 * @param known - Exact secret values (env, settings) to look for
 * @param skip - Package paths that are not scanned (git bundles: binary packs, encrypted for the target)
 * @returns Files scanned and the findings
 */
export async function scanStaging(
  staging: StagingArea,
  files: readonly PackageFileEntry[],
  known: readonly SecretEnvValue[] = [],
  skip: (packagePath: string) => boolean = () => false,
): Promise<SecretScanResult> {
  const findings: SecretFinding[] = [];
  let filesScanned = 0;
  for (const f of files) {
    if (skip(f.path)) continue;
    const { matches, scanned } = await scanFile(staging.abs(f.path), known);
    if (scanned) filesScanned += 1;
    if (matches > 0) findings.push({ path: f.path, matches });
  }
  return { filesScanned, findings };
}

/** Package paths of conversation transcripts (JSON Lines, one per member). */
const TRANSCRIPT_PREFIX = 'transcripts/';

/**
 * Whether a flagged file is a conversation transcript, which is redacted in
 * the package copy instead of stopping the move.
 *
 * @param packagePath - Package path of the flagged file
 * @returns True for a transcript
 */
export function isRedactableFinding(packagePath: string): boolean {
  return packagePath.startsWith(TRANSCRIPT_PREFIX) && packagePath.endsWith('.jsonl');
}

/**
 * Redact every string inside a parsed JSON value.
 *
 * @param value - Any JSON value
 * @param known - Exact secret values to look for
 * @param tally - Receives the number of redactions
 * @returns The value with secrets masked in its strings (and in its keys)
 */
function redactJsonValue(value: unknown, known: readonly SecretEnvValue[], tally: { count: number }): unknown {
  if (typeof value === 'string') {
    const out = redactSecretsWithCount(value, known);
    tally.count += out.count;
    return out.text;
  }
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, known, tally));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[String(redactJsonValue(key, known, tally))] = redactJsonValue(item, known, tally);
    }
    return result;
  }
  return value;
}

/**
 * Mask the secrets in a conversation transcript inside the package, leaving
 * the file on the machine untouched.
 *
 * A transcript is what lets a member resume its conversation on the target
 * machine, and agents routinely read keys while they work, so a secret in one
 * is the normal case: stopping the whole move over it (2026-11-20: four
 * Google keys in one member's transcript, "nothing was sent") leaves the owner
 * to hand-edit a 4 MB log. Each line is parsed and only its strings are
 * redacted, so the file stays valid JSON Lines; a line that does not parse is
 * redacted as text.
 *
 * @param staging - The package being built
 * @param packagePath - A transcript in it
 * @param known - Exact secret values to look for
 * @returns The new file entry and the number of redactions
 */
export async function redactTranscriptInStaging(
  staging: StagingArea,
  packagePath: string,
  known: readonly SecretEnvValue[] = [],
): Promise<{ entry: PackageFileEntry; redactions: number }> {
  const source = staging.abs(packagePath);
  const temp = `${source}.redacting`;
  const tally = { count: 0 };
  const out = createWriteStream(temp, { encoding: 'utf8' });
  const lines = createInterface({ input: createReadStream(source, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    let written: string;
    if (line.trim().length === 0) {
      written = line;
    } else {
      try {
        written = JSON.stringify(redactJsonValue(JSON.parse(line), known, tally));
      } catch {
        const raw = redactSecretsWithCount(line, known);
        tally.count += raw.count;
        written = raw.text;
      }
    }
    if (!out.write(`${written}\n`)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  await fs.rename(temp, source);
  return { entry: await staging.adopt(packagePath), redactions: tally.count };
}

/**
 * Whether a flagged file may be left out of the package instead of aborting.
 * Core records (the team config, task pool, decisions, chat records) can never
 * be skipped; free-form notes and project files can.
 *
 * @param packagePath - Package path of the flagged file
 * @returns True when skipping is allowed
 */
export function isSkippableFinding(packagePath: string): boolean {
  return (
    packagePath.startsWith('projects/') ||
    packagePath.startsWith('handover/') ||
    /^agents\/[^/]+\/sessions\//.test(packagePath) ||
    /^team\/(wiki|norms|sops)\//.test(packagePath)
  );
}
