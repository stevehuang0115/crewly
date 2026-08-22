/**
 * Build-time stamper: records which commit produced the compiled output.
 *
 * Run as the last step of `npm run build:backend`. Writes
 * `build-info.json` into the backend build directory, which
 * {@link assertBuildProvenance} reads at startup to detect a `dist/` that no
 * longer matches the checked-out source.
 *
 * Failure here is non-fatal by design: a build must not break because the
 * stamp could not be written. An unstamped build degrades to a startup
 * warning, never a startup failure.
 *
 * @module backend/scripts/stamp-build
 */

import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

import { readGitHead, writeBuildInfo } from '../utils/build-provenance.js';

/**
 * Stamps the build output with the current HEAD commit.
 *
 * @param outDir - Build output directory to stamp
 * @param repoRoot - Repository root used to resolve HEAD
 * @param log - Sink for the confirmation line
 * @param warn - Sink for non-fatal problems
 * @returns true when a stamp was written, false when skipped
 */
export function stampBuild(
  outDir: string,
  repoRoot: string,
  log: (message: string) => void = (m) => console.log(m),
  warn: (message: string) => void = (m) => console.warn(m),
): boolean {
  const head = readGitHead(repoRoot);
  if (!head) {
    warn('stamp-build: HEAD unavailable (no .git or no git binary) — build left unstamped.');
    return false;
  }
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  const builtAt = new Date().toISOString();
  const written = writeBuildInfo(outDir, head, builtAt);
  log(`stamp-build: ${written} → commit ${head.slice(0, 8)} (built ${builtAt})`);
  return true;
}

/* c8 ignore start — CLI entry, exercised by the build not by unit tests */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('stamp-build.js');

if (invokedDirectly) {
  const repoRoot = process.cwd();
  stampBuild(resolve(repoRoot, 'dist', 'backend'), repoRoot);
}
/* c8 ignore stop */
