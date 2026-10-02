/**
 * Every test file gets its own temp home: `os.homedir()`, HOME, USERPROFILE
 * and CREWLY_HOME all point at it, so no test writes into the real
 * ~/.crewly. (Backend tests do the same in tests/setup.ts; tests writing
 * into the owner's real home cost him his cloud login on 2026-09-24 and half
 * an hour of Slack on 2026-10-02.)
 *
 * `os.homedir` is replaced on the module object and pushed to ESM named
 * imports with `syncBuiltinESMExports()` — `import { homedir } from 'os'`
 * (cloud-config.ts) and `os.homedir()` (in-process-log-buffer.ts) both see it.
 * Setting HOME alone would not reach a worker thread's `os.homedir()`.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const nodeOs = createRequire(import.meta.url)('node:os') as { homedir: () => string };
const home = mkdtempSync(path.join(tmpdir(), 'crewly-vitest-home-'));
mkdirSync(path.join(home, '.crewly'), { recursive: true });

nodeOs.homedir = () => home;
syncBuiltinESMExports();
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CREWLY_HOME = path.join(home, '.crewly');

// Removed when the worker exits, not in afterAll: some tests leave log write
// streams open past teardown, and pulling the directory from under them
// turns into ENOENT errors.
process.once('exit', () => {
  rmSync(home, { recursive: true, force: true });
});
