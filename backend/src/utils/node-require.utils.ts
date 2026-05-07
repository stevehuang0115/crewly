import { createRequire } from 'module';
import { pathToFileURL } from 'url';

/**
 * Make a CJS-style `require` shim **for bare module names only**
 * (`'better-sqlite3'`, `'sqlite-vec'`, `'fs'`, etc.). Anchored to the
 * entry script so Node's CJS resolver walks up to the project's
 * `node_modules/`.
 *
 * ## ⚠️ Bare module names only — DO NOT pass relative paths
 *
 * Relative paths passed to the returned require resolve from the
 * **entry script's** location (e.g. `dist/backend/backend/src/index.js`),
 * NOT from the calling file. Symptom: `Cannot find module
 * '../v3/request.service.js'`. For lazy loads of relative paths, use
 * **ESM dynamic `import()`** at the callsite — that resolves correctly
 * from the calling module:
 *
 * ```ts
 * // ✅ relative path → ESM dynamic import
 * const { RequestService } = await import('../v3/request.service.js');
 *
 * // ✅ bare module → this helper
 * const sqlite = nodeRequire('better-sqlite3');
 * ```
 *
 * ## Why this helper exists
 *
 * Most of the backend compiles to ESM (root `package.json` has
 * `"type": "module"`). In ESM the bare `require` global is undefined,
 * so lazy CJS module loads via `require('...')` throw
 * `ReferenceError: require is not defined`. This helper bridges the gap
 * for native modules (`better-sqlite3`, `sqlite-vec`) that MUST load
 * via CJS `require` because they are native addons.
 *
 * ## Lessons banked here (DO NOT re-try)
 *
 * - `createRequire(import.meta.url)` directly: blocked by ts-jest's
 *   `module: 'CommonJS'` transpile (TS1470 "import.meta only allowed
 *   under module ES2020+").
 * - `createRequire(new Function('return import.meta.url')())`
 *   (PR #323 / cb135ead): parses but `new Function(...)` body is
 *   non-module scope, where `import.meta` is a SyntaxError at runtime.
 * - `createRequire(eval('import.meta.url'))`: ts-jest passes (string
 *   is opaque to the parser) but at runtime under Node ESM, direct
 *   eval inherits the module realm yet the eval'd code is parsed under
 *   the **Script** parse goal where `import.meta` is invalid —
 *   `SyntaxError: Cannot use 'import.meta' outside a module`. Same
 *   failure mode as the PR #323 trick.
 *
 * The viable pattern (this helper) anchors to `process.argv[1]`
 * (the entry script). That URL is always inside the project tree at
 * runtime, so Node's resolver walks up to find `node_modules/`. The
 * trade-off — relative-path resolution is broken under this anchor —
 * is acceptable here BECAUSE callers of this helper restrict themselves
 * to bare module names; relative paths take the ESM-`import()` path
 * instead.
 *
 * ## Why `globalRequire` is REQUIRED, not auto-detected
 *
 * Under ts-jest CJS, every compiled module receives its own bound
 * `require` that resolves paths relative to that module. If this helper
 * read its own ambient `require`, it would return a require bound to
 * `backend/src/utils/node-require.utils.ts` — bare-module resolution
 * still works (resolver walks up), but the decision is made implicitly
 * by file location, which is brittle. Explicit caller-pass keeps the
 * contract clear.
 *
 * ## Recommended callsite pattern
 *
 * ```ts
 * import { createBareModuleRequire } from '<rel-path>/utils/node-require.utils.js';
 *
 * const nodeRequire = createBareModuleRequire(
 *   typeof require === 'function' ? require : null,
 * );
 * // ... later in the file
 * const sqlite = nodeRequire('better-sqlite3');
 * const sqliteVec = nodeRequire('sqlite-vec');
 * ```
 *
 * Under ts-jest CJS, the ternary captures the calling file's
 * per-module `require`. Under ESM the ternary returns `null` and the
 * helper falls back to `createRequire(<entry-script-URL>)` — which
 * resolves bare modules correctly via Node's standard resolver walk-up
 * to `node_modules/`.
 *
 * @param globalRequire - The calling module's `require` if the runtime
 *   provides one (CJS / ts-jest), or `null` if the caller is running
 *   under ESM. Pass `typeof require === 'function' ? require : null`
 *   from the callsite — that expression evaluates correctly under both
 *   module systems.
 * @returns A `NodeRequire`-compatible shim that resolves **bare module
 *   names only** correctly. Relative paths will be resolved from the
 *   entry script's location, not the calling file (use ESM dynamic
 *   `import()` for relative paths).
 *
 * @example
 * ```ts
 * const nodeRequire = createBareModuleRequire(
 *   typeof require === 'function' ? require : null,
 * );
 * const sqlite = nodeRequire('better-sqlite3');
 * ```
 */
export function createBareModuleRequire(
	globalRequire: NodeRequire | null,
): NodeRequire {
	if (globalRequire) return globalRequire;
	const entryScriptUrl = pathToFileURL(
		process.argv[1] || process.cwd(),
	).href;
	return createRequire(entryScriptUrl);
}
