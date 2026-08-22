/**
 * Build provenance: answer "which commit is this process actually running?"
 * and fail loudly when the compiled output is older than the checked-out
 * source it claims to serve.
 *
 * WHY THIS EXISTS (2026-08-21): five merged fixes were found not to be
 * executing. The backend was serving `dist/` built on May 5 from a process
 * started two weeks earlier, so every conclusion drawn from live behaviour
 * that day was produced by stale code. Nothing in the system said so. The
 * discipline of "always rebuild" had already been written down and it still
 * did not hold, which is the argument for a mechanical check rather than
 * another reminder.
 *
 * WHY COMMIT IDENTITY AND NOT MTIMES: `git checkout` does not preserve
 * modification times, so a fresh clone or a branch switch can make source
 * look newer than a perfectly current build. An mtime check would cry wolf,
 * get switched off, and leave us with neither the check nor the attention.
 * Comparing the stamped HEAD SHA to the current HEAD is exact, has no clock
 * or filesystem dependence, and answers the question a debugger actually
 * has.
 *
 * KNOWN LIMIT, deliberately accepted: this compares COMMITS, so uncommitted
 * edits to tracked files are invisible to it. That is the right trade —
 * flagging every dirty working tree would reintroduce exactly the false-alarm
 * problem this design avoids. It catches the case that actually bit us: HEAD
 * moved and nobody rebuilt.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/** Filename written into the build output directory at build time. */
export const BUILD_INFO_FILENAME = 'build-info.json';

/** Env var that downgrades a stale-build failure to a warning. */
export const SKIP_BUILD_CHECK_ENV = 'CREWLY_SKIP_BUILD_CHECK';

/** How many directories to walk up when locating the build stamp. */
const MAX_UPWARD_LOOKUP = 6;

/**
 * Provenance stamp written beside the compiled output.
 */
export interface BuildInfo {
  /** Full 40-char SHA of HEAD at build time. */
  commit: string;
  /** ISO8601 timestamp of the build, for humans reading the log line. */
  builtAt: string;
}

/**
 * Result of comparing the build stamp against the current checkout.
 *
 * - `ok` — the build matches HEAD.
 * - `stale` — the build is from a different commit than HEAD. This is the
 *   condition worth failing on.
 * - `unstamped` — no build stamp found (a build predating this guard).
 * - `unknown` — HEAD could not be determined (no `.git`, no `git` binary —
 *   i.e. a container or a tarball deploy). Never an error.
 */
export type ProvenanceVerdict =
  | { state: 'ok'; commit: string; builtAt: string }
  | { state: 'stale'; builtCommit: string; headCommit: string; builtAt: string }
  | { state: 'unstamped'; reason: string }
  | { state: 'unknown'; reason: string };

/**
 * Compares a build stamp against the current HEAD.
 *
 * Pure: all filesystem and git access happens in the callers, so the
 * decision logic is testable without a repository.
 *
 * @param build - Stamp read from the build output, or null if absent
 * @param headCommit - Current HEAD SHA, or null if it could not be read
 * @returns The verdict describing how build and checkout relate
 *
 * @example
 * ```typescript
 * evaluateBuildProvenance({ commit: 'abc', builtAt: t }, 'def');
 * // → { state: 'stale', builtCommit: 'abc', headCommit: 'def', builtAt: t }
 * ```
 */
export function evaluateBuildProvenance(
  build: BuildInfo | null,
  headCommit: string | null,
): ProvenanceVerdict {
  if (!build || !build.commit) {
    return {
      state: 'unstamped',
      reason: `no ${BUILD_INFO_FILENAME} beside the compiled output — rebuild to stamp it`,
    };
  }
  if (!headCommit) {
    return {
      state: 'unknown',
      reason: 'current HEAD could not be determined (no .git or no git binary)',
    };
  }
  if (build.commit === headCommit) {
    return { state: 'ok', commit: build.commit, builtAt: build.builtAt };
  }
  return {
    state: 'stale',
    builtCommit: build.commit,
    headCommit,
    builtAt: build.builtAt,
  };
}

/**
 * Renders a verdict as a single operator-readable line.
 *
 * @param verdict - Verdict from {@link evaluateBuildProvenance}
 * @returns A message naming the running commit, or what is wrong
 */
export function formatVerdict(verdict: ProvenanceVerdict): string {
  switch (verdict.state) {
    case 'ok':
      return `Running commit ${verdict.commit.slice(0, 8)} (built ${verdict.builtAt}).`;
    case 'stale':
      return (
        `STALE BUILD: serving compiled output from commit ${verdict.builtCommit.slice(0, 8)} ` +
        `(built ${verdict.builtAt}) while HEAD is ${verdict.headCommit.slice(0, 8)}. ` +
        `The code running is NOT the code checked out. Run \`npm run build\` and restart. ` +
        `Set ${SKIP_BUILD_CHECK_ENV}=1 to downgrade this to a warning.`
      );
    case 'unstamped':
      return `Build provenance unknown: ${verdict.reason}.`;
    case 'unknown':
      return `Build provenance not checked: ${verdict.reason}.`;
  }
}

/**
 * Reads the current HEAD commit via the `git` binary.
 *
 * @param repoRoot - Directory to run `git` in
 * @returns The 40-char SHA, or null when git is unavailable or this is not a
 *   repository (a container or tarball deploy, where the check must not fire)
 */
export function readGitHead(repoRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const sha = out.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Locates and reads the build stamp by walking up from a starting directory.
 *
 * Walking up (rather than hardcoding a path) keeps the guard working if the
 * compiled layout shifts; a miss degrades to `unstamped`, which warns rather
 * than failing.
 *
 * @param startDir - Directory to begin the upward search from
 * @returns The parsed stamp, or null when absent or unparseable
 */
export function readBuildInfo(startDir: string): BuildInfo | null {
  let dir = startDir;
  for (let i = 0; i < MAX_UPWARD_LOOKUP; i += 1) {
    const candidate = join(dir, BUILD_INFO_FILENAME);
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as Partial<BuildInfo>;
        if (typeof parsed.commit === 'string' && typeof parsed.builtAt === 'string') {
          return { commit: parsed.commit, builtAt: parsed.builtAt };
        }
        return null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Writes the build stamp. Called once at the end of the backend build.
 *
 * @param outDir - Directory to write {@link BUILD_INFO_FILENAME} into
 * @param commit - HEAD SHA at build time
 * @param builtAt - ISO8601 build timestamp
 * @returns Absolute path of the file written
 */
export function writeBuildInfo(outDir: string, commit: string, builtAt: string): string {
  const target = join(outDir, BUILD_INFO_FILENAME);
  const payload: BuildInfo = { commit, builtAt };
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}

/**
 * Checks build provenance at startup and reports it.
 *
 * A stale build throws, because a silent stale build is the exact failure
 * this guard exists to end. Every other outcome — unstamped, no git, the
 * skip flag set — only reports, so the check can never block a legitimate
 * container deploy.
 *
 * @param options - Injection points, all defaulted for production use
 * @param options.moduleDir - Directory to search upward from for the stamp.
 *   Defaults to the backend build directory. Deliberately a parameter rather
 *   than an `import.meta.url` lookup: this module is compiled as ESM for
 *   production but as CommonJS by ts-jest, and `import.meta` is illegal in
 *   the latter — so depending on it would make the guard untestable.
 * @param options.repoRoot - Directory to resolve HEAD in
 * @param options.headCommit - Overrides HEAD resolution. Present so the
 *   stale path is testable without constructing a git repository
 * @param options.env - Environment to read the skip flag from
 * @param options.log - Sink for the informational line
 * @param options.warn - Sink for non-fatal problems
 * @returns The verdict, for callers that want to surface it elsewhere
 * @throws Error when the build is stale and the skip flag is not set
 */
export function assertBuildProvenance(options: {
  moduleDir?: string;
  repoRoot?: string;
  headCommit?: string | null;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  warn?: (message: string) => void;
} = {}): ProvenanceVerdict {
  const repoRoot = options.repoRoot ?? process.cwd();
  const moduleDir = options.moduleDir ?? join(repoRoot, 'dist', 'backend');
  const env = options.env ?? process.env;
  const log = options.log ?? ((m: string) => console.log(m));
  const warn = options.warn ?? ((m: string) => console.warn(m));

  const head =
    options.headCommit !== undefined ? options.headCommit : readGitHead(repoRoot);
  const verdict = evaluateBuildProvenance(readBuildInfo(moduleDir), head);
  const message = formatVerdict(verdict);

  if (verdict.state === 'ok') {
    log(message);
    return verdict;
  }
  if (verdict.state !== 'stale') {
    warn(message);
    return verdict;
  }
  if (env[SKIP_BUILD_CHECK_ENV]) {
    warn(message);
    return verdict;
  }
  throw new Error(message);
}
