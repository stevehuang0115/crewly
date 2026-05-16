/**
 * Runtime-validity smoke test for `scripts/cleanup-stale-pool.ts`.
 *
 * Issue #478: the script's `import { DEFAULT_KEEP_IDS, ... } from
 * './cleanup-stale-pool.lib.js'` resolved to a CJS-namespace-as-default
 * shape under tsx + Node 22 ESM and threw SyntaxError at module-
 * instantiation time. The error fired BEFORE any flag parsing — even
 * `--help` was broken. The lib's unit tests passed (jest's resolver
 * papers over the interop quirk) — only a runtime-validity test would
 * have caught the regression.
 *
 * This test lives in `backend/src/scripts/` (covered by jest's test
 * roots) rather than next to the script under `scripts/` (which is
 * not). It runs `npx tsx scripts/cleanup-stale-pool.ts --help` via
 * child_process and asserts:
 *   1. exit code 0 (no SyntaxError; module loaded cleanly)
 *   2. stdout contains a recognizable help string
 *
 * It does NOT hit the backend — `--help` prints and exits before any
 * fetch runs. Total wall time on a warm tsx cache is ~1.5s.
 */
import { execFileSync } from 'child_process';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'cleanup-stale-pool.ts');

describe('scripts/cleanup-stale-pool.ts — runtime module-load smoke', () => {
  it('loads via tsx and runs --help without throwing (issue #478 regression gate)', () => {
    let output: string;
    try {
      output = execFileSync('npx', ['tsx', SCRIPT_PATH, '--help'], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      // Surface stderr in the test report so the next regression is
      // easy to diagnose — without this the only signal is "exit !== 0".
      throw new Error(
        `cleanup-stale-pool.ts failed to load: exit=${e.status}\n` +
          `stdout:\n${e.stdout ?? ''}\n` +
          `stderr:\n${e.stderr ?? ''}`,
      );
    }
    expect(output).toMatch(/Usage|usage|--apply|--dry-run/);
  }, 60_000);
});
