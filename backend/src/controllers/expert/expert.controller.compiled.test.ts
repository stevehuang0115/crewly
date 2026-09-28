/**
 * Expert Controller: compiled-layout regression tests
 *
 * The unit tests in expert.controller.test.ts run the controller the way
 * ts-jest does: as CommonJS, from backend/src/, where `__dirname` exists and
 * sits four directories below the package root. Production does not look like
 * that. The published package runs the controller as ESM (package.json
 * `"type": "module"`), from dist/backend/backend/src/controllers/expert/, six
 * directories below the root. There `__dirname` is not defined at all, and
 * GET /api/experts returned 500 with `ReferenceError: __dirname is not defined`.
 *
 * These tests reproduce production instead of assuming it. They transpile the
 * real controller source to ESM, lay it out the way `npm pack` ships it, and
 * call it from a separate `node` process whose entry script is the compiled
 * backend entry, just as `crewly start` spawns it.
 *
 * @module controllers/expert/expert.controller.compiled.test
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

/** Backend source root (backend/src) in this checkout */
const BACKEND_SRC = path.resolve(__dirname, '..', '..');

/** Upper bound for one child `node` run, so a hung child fails the test instead of the run */
const CHILD_TIMEOUT_MS = 20_000;

/** Result the probe script prints for one listExperts call */
interface ProbeResult {
  /** HTTP status the controller sent (200 when it never called res.status) */
  status: number;
  /** JSON body the controller sent */
  body: unknown;
  /** resolveExpertsDir([compiled controller dir]), or null when the export is missing */
  resolvedFromCompiledDir: string | null;
  /** Messages the controller logged at error level */
  errors: string[];
}

/**
 * Transpiles one backend TypeScript source file to an ES module.
 *
 * @param relativePath - Path under backend/src, e.g. 'utils/package-root.ts'
 * @returns The compiled JavaScript
 */
function compileToEsm(relativePath: string): string {
  const source = readFileSync(path.join(BACKEND_SRC, relativePath), 'utf-8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}

/**
 * Writes a file, creating its parent directories.
 *
 * @param filePath - Absolute path to write
 * @param content - File content
 */
function writeFileDeep(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/** Logger stand-in: the real LoggerService pulls in config and file sinks */
const LOGGER_STUB = `
const sink = { errors: [] };
globalThis.__expertLogSink = sink;
const logger = {
  info() {}, debug() {}, warn() {},
  error(message, context) { sink.errors.push(message + ' ' + JSON.stringify(context ?? {})); },
};
export const LoggerService = { getInstance: () => ({ createComponentLogger: () => logger }) };
`;

/** Entry script: calls the compiled controller once and prints a ProbeResult */
const PROBE_ENTRY = `
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as controller from './controllers/expert/expert.controller.js';

const controllerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'controllers', 'expert');
const res = {
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
};
await controller.listExperts({}, res);
const resolvedFromCompiledDir = typeof controller.resolveExpertsDir === 'function'
  ? controller.resolveExpertsDir([controllerDir])
  : null;
process.stdout.write(JSON.stringify({
  status: res.statusCode,
  body: res.body,
  resolvedFromCompiledDir,
  errors: globalThis.__expertLogSink.errors,
}));
`;

describe('expert.controller in the compiled ESM package layout', () => {
  let tmpRoot: string;
  let pkgRoot: string;
  let entry: string;

  beforeEach(() => {
    // realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var), and
    // the controller resolves the entry script's real path
    tmpRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'crewly-experts-esm-')));
    pkgRoot = path.join(tmpRoot, 'node_modules', 'crewly');
    const compiledSrc = path.join(pkgRoot, 'dist', 'backend', 'backend', 'src');

    writeFileDeep(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'crewly', type: 'module' }));
    writeFileDeep(
      path.join(compiledSrc, 'controllers', 'expert', 'expert.controller.js'),
      compileToEsm('controllers/expert/expert.controller.ts'),
    );
    writeFileDeep(path.join(compiledSrc, 'utils', 'package-root.js'), compileToEsm('utils/package-root.ts'));
    writeFileDeep(path.join(compiledSrc, 'services', 'core', 'logger.service.js'), LOGGER_STUB);
    entry = path.join(compiledSrc, 'index.js');
    writeFileDeep(entry, PROBE_ENTRY);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Runs the compiled entry in a fresh `node` process. The working directory is
   * outside the package, so only the entry script can lead to the package root.
   *
   * @returns What the controller answered
   */
  function runProbe(): ProbeResult {
    const stdout = execFileSync(process.execPath, [entry], {
      cwd: tmpRoot,
      encoding: 'utf-8',
      timeout: CHILD_TIMEOUT_MS,
    });
    return JSON.parse(stdout) as ProbeResult;
  }

  it('resolves <package root>/config/experts from dist/backend/backend/src/controllers/expert', () => {
    const result = runProbe();

    expect({ resolvedFromCompiledDir: result.resolvedFromCompiledDir, errors: result.errors }).toEqual({
      resolvedFromCompiledDir: path.join(pkgRoot, 'config', 'experts'),
      errors: [],
    });
  });

  it('returns 200 and the installed experts (and still skips EXAMPLE.json)', () => {
    writeFileDeep(path.join(pkgRoot, 'config', 'experts', 'EXAMPLE.json'), '{"id":"example-expert"}');
    writeFileDeep(
      path.join(pkgRoot, 'config', 'experts', 'installed-expert', 'expert.json'),
      JSON.stringify({
        id: 'installed-expert',
        version: '1.0.0',
        name: 'Installed Expert',
        category: 'Strategy',
        intensity: 0.5,
        baseRoles: ['generalist'],
        tags: ['fixture'],
        distillationDate: '2026-09-24',
        teacherModel: 'none',
      }),
    );

    const result = runProbe();

    expect({ status: result.status, body: result.body, errors: result.errors }).toEqual({
      status: 200,
      body: {
        success: true,
        data: [
          {
            id: 'installed-expert',
            name: 'Installed Expert',
            category: 'Strategy',
            tags: ['fixture'],
            baseRoles: ['generalist'],
          },
        ],
      },
      errors: [],
    });
  });

  it('returns 200 with an empty list, never 500, when config/experts is missing', () => {
    const result = runProbe();

    expect({ status: result.status, body: result.body, errors: result.errors }).toEqual({
      status: 200,
      body: { success: true, data: [] },
      errors: [],
    });
  });
});
