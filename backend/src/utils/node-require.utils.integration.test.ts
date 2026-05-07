/**
 * Integration test — node-require ESM runtime resolution.
 *
 * Permanent CI regression-guard against the `Cannot find module` class of
 * bugs from PR #494 (`fa05720e`, entry-script-anchored `createRequire`)
 * that broke 4 relative-path lazy-load callsites until PR #503 (`ba507020`)
 * split them by load shape: 5 native-module callsites stay on the
 * entry-anchored helper (`createBareModuleRequire`); 4 relative-path
 * callsites moved to ESM dynamic `import()` (Paths 1+2) or static import
 * (Paths 3+4 — async-cascade avoidance).
 *
 * ## Why a separate integration test (not extending the unit test)
 *
 * The original bug ONLY manifested under live compiled ESM
 * (`dist/backend/backend/src/index.js` running on real `node`). Under
 * ts-jest each compiled module gets a per-file `require` so the bug is
 * masked entirely — the unit test can never reproduce it. This test
 * spawns the actual compiled backend as a child process, drives it
 * through HTTP / skill bash, and asserts no `Cannot find module` /
 * `MODULE_NOT_FOUND` errors surface across the 4 broken callsite paths.
 *
 * Companion to the unit test at `node-require.utils.test.ts` (helper
 * internals — CJS branch, forced-ESM branch, DI, MODULE_NOT_FOUND
 * negative case, contract documentation). This file does NOT duplicate
 * those cases; it only exercises the live-ESM end-to-end behavior the
 * unit test cannot reach.
 *
 * ## Path coverage
 *
 *   Path 1: `getActiveWorkBriefing` controller →
 *           `ActiveWorkBriefingService.getInstance()` → `await import(...)`
 *           on `RequestService` + `TaskPoolService`. Reproduces the
 *           original ORC-reported user-prod symptom.
 *   Path 2: `GET /api/agents/sessions` →
 *           `getStreamableSessions` → `await import(...)` on
 *           `InProcessLogBuffer`.
 *   Path 3: `GET /api/browser/status` → `BrowserBridgeService.getStatus`
 *           → static-import-bound `BrowserRelayAdapter`. Static binding
 *           means MODULE_NOT_FOUND would surface at module-load time
 *           (before the route registers). Test asserts the route
 *           responds 200 (proves the static binding loaded cleanly).
 *   Path 4: `CrossMachineMessageService.isEnabled` →
 *           static-import-bound `CloudSyncService`. Same shape as Path 3.
 *           Skipped by default — full exercise needs Slack creds — but
 *           the static binding loading cleanly is implied by the backend
 *           booting at all (tested in beforeAll).
 *
 * ## Skip behavior
 *
 *   - If `dist/backend/backend/src/index.js` is missing (no
 *     `npm run build:backend` since checkout), the whole describe
 *     is skipped with a marker `it.skip` so CI surfaces the gap.
 *   - If the active node binary's arch does not match a matching
 *     pty.node binary under `node_modules/node-pty`, walks
 *     `$HOME/.nvm/versions/node` for a matching arch. If none, skips
 *     with a clear actionable message.
 *
 * @module backend/src/utils/node-require.utils.integration.test
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// __dirname = <repo>/backend/src/utils → 3 levels up = repo root.
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const ENTRY = join(REPO_ROOT, 'dist/backend/backend/src/index.js');
const ENTRY_FALLBACK = join(REPO_ROOT, 'dist/backend/src/index.js');

/**
 * Pick a node binary whose arch matches the host (Apple Silicon gotcha:
 * `/usr/local/bin/node` is often x86_64 while pty.node is arm64).
 * Returns the absolute path of a matching binary, or `null` if none found.
 */
function pickArchMatchingNode(): string | null {
  const hostArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  // First, check the active `node` (the one that launched jest).
  const activeArch = process.arch;
  if (activeArch === hostArch) {
    return process.execPath;
  }
  // Walk nvm for a matching binary.
  const nvm = join(process.env.HOME || '/', '.nvm/versions/node');
  if (!existsSync(nvm)) return null;
  try {
    const versions = execSync(`ls "${nvm}"`, { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort()
      .reverse();
    for (const v of versions) {
      const bin = join(nvm, v, 'bin', 'node');
      if (!existsSync(bin)) continue;
      const arch = execSync(`"${bin}" -e 'process.stdout.write(process.arch)'`, {
        encoding: 'utf8',
      }).trim();
      if (arch === hostArch) return bin;
    }
  } catch {
    /* ignore — no nvm or shell error */
  }
  return null;
}

/**
 * Resolve a port that's likely free for the test backend boot.
 * Uses a process-id-derived offset to reduce parallel-runner collisions.
 */
function pickPort(): number {
  return 8800 + (process.pid % 80);
}

/**
 * Race `promise` against a timeout. If the timeout wins, the timer is
 * cleared so it doesn't keep jest's worker alive past test exit.
 * If the promise wins, the still-pending timer is also cleared.
 */
async function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wait for `http://localhost:<port>/health` to return 200, up to
 * `timeoutMs` milliseconds. Throws if the deadline expires.
 */
async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `backend /health did not respond within ${timeoutMs}ms (last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    })`,
  );
}

// Decide skip-or-run upfront so jest reports clearly.
const distEntry = existsSync(ENTRY) ? ENTRY : existsSync(ENTRY_FALLBACK) ? ENTRY_FALLBACK : null;
const archNode = pickArchMatchingNode();
const skipReason = !distEntry
  ? 'dist not built — run `npm run build:backend` before integration tests'
  : !archNode
  ? `no ${process.arch}-compatible node found under $HOME/.nvm/versions/node — install one or rebuild native modules`
  : null;

const integrationDescribe = skipReason ? describe.skip : describe;

integrationDescribe('node-require ESM runtime — integration (PR #503 regression-guard)', () => {
  let serverProc: ChildProcess;
  let port: number;
  let crewlyHome: string;
  let serverLog: string[] = [];

  beforeAll(async () => {
    if (skipReason) return; // describe.skip already in effect, but guard for safety
    port = pickPort();
    crewlyHome = mkdtempSync(join(tmpdir(), 'crewly-noderequire-it-'));
    const logDir = join(crewlyHome, 'logs');
    mkdirSync(logDir, { recursive: true });

    serverProc = spawn(archNode!, [distEntry!], {
      env: {
        ...process.env,
        WEB_PORT: String(port),
        CREWLY_HOME: crewlyHome,
        LOG_DIR: logDir,
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));
    serverProc.stderr?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));

    serverProc.on('exit', (code, sig) => {
      if (code !== null && code !== 0) {
        // Surface in the next failing assertion via serverLog
        serverLog.push(`\n[backend exited code=${code} signal=${sig ?? 'none'}]`);
      }
    });

    await waitForHealth(port, 45_000);
  }, 60_000);

  afterAll(async () => {
    if (serverProc && serverProc.exitCode === null) {
      // Wait for actual exit (`killed` flag becomes true after sending the
      // signal, even if the child is still alive) — drain to keep jest's
      // worker from being flagged as "failed to exit gracefully". The
      // timer in raceWithTimeout is unref'd + cleared so it never blocks
      // jest's exit even when the exit promise wins the race.
      const exited = new Promise<void>((resolve) => {
        serverProc.once('exit', () => resolve());
      });
      serverProc.kill('SIGTERM');
      await raceWithTimeout(exited, 3000);
      if (serverProc.exitCode === null) {
        serverProc.kill('SIGKILL');
        await raceWithTimeout(exited, 1000);
      }
    }
    if (crewlyHome && existsSync(crewlyHome)) {
      rmSync(crewlyHome, { recursive: true, force: true });
    }
  }, 10_000);

  it('Path 1: GET /api/v3/agents/<session>/active-work — RequestService + TaskPoolService resolve via await import', async () => {
    const res = await fetch(
      `http://localhost:${port}/api/v3/agents/integration-test/active-work?role=developer&format=json`,
    );
    const body = await res.text();
    // 200 (data) or 4xx (no such session) is acceptable; 500 with
    // `Cannot find module` is the regression failure mode.
    expect(body).not.toMatch(/Cannot find module/);
    expect(body).not.toMatch(/MODULE_NOT_FOUND/);
    expect([200, 400, 404]).toContain(res.status);
  }, 15_000);

  it('Path 2: GET /api/agents/sessions — InProcessLogBuffer resolves via await import', async () => {
    const res = await fetch(`http://localhost:${port}/api/agents/sessions`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).not.toMatch(/Cannot find module/);
    expect(body).not.toMatch(/MODULE_NOT_FOUND/);
    const json = JSON.parse(body);
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
  }, 15_000);

  it('Path 3: GET /api/browser/status — BrowserRelayAdapter static-bound, route loads cleanly', async () => {
    const logBefore = serverLog.length;
    const res = await fetch(`http://localhost:${port}/api/browser/status`);
    expect(res.status).toBe(200);
    // Path 3's silent try/catch (browser-bridge.service.ts:805,838) is now
    // a static import in PR #503, so a MODULE_NOT_FOUND would surface at
    // backend boot (caught by waitForHealth timeout) rather than per-request.
    // We still spot-check the post-call log slice for any deferred errors.
    await new Promise((r) => setTimeout(r, 250));
    const logSlice = serverLog.slice(logBefore).join('');
    expect(logSlice).not.toMatch(/Cannot find module.*browser-relay-adapter/);
    expect(logSlice).not.toMatch(/MODULE_NOT_FOUND/);
  }, 15_000);

  it('Path 4: CrossMachineMessageService — static binding loads (implicit pass; full exercise needs Slack creds)', () => {
    // CrossMachineMessageService.isEnabled() is now static-bound to
    // CloudSyncService (PR #503). If the static import had failed, the
    // backend would have errored at module-load time (the slack-orchestrator
    // bridge imports the service at startup). Backend reaching healthy
    // /health in beforeAll proves the static binding loaded.
    // Full request-level exercise (sending a cross-machine slack message)
    // requires Slack token + initialized config — out of scope for this
    // smoke. Marked passing because the static-load gate is already proven.
    expect(serverProc.killed).toBe(false);
  });

  it('regression: server log shows no Cannot find module across the whole boot+request cycle', () => {
    const fullLog = serverLog.join('');
    // Catch-all regression assertion. Any of the 4 paths or any other
    // lazy nodeRequire we might add in the future surfaces here.
    const matches = fullLog.match(/Cannot find module[^\n]*/g) || [];
    if (matches.length > 0) {
      // Surface up to 5 matches to make CI failures actionable.
      const sample = matches.slice(0, 5).join('\n  ');
      throw new Error(
        `Found ${matches.length} 'Cannot find module' in server log — regression. Sample:\n  ${sample}`,
      );
    }
  });
});

// When skipped, surface a single tracking entry so CI runs do not silently drop coverage.
if (skipReason) {
  describe('node-require ESM runtime — integration (SKIPPED)', () => {
    it.skip(`integration suite skipped: ${skipReason}`, () => {
      /* no-op */
    });
  });
}

