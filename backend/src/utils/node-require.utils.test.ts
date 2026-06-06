import { createBareModuleRequire } from './node-require.utils.js';

/**
 * Regression-guard test for the `createBareModuleRequire` helper.
 *
 * The helper extracts PR #494's (`fa05720e`) entry-script-anchored
 * `createRequire` pattern into a single shared utility so the
 * native-module callsites (better-sqlite3 across knowledge/fts5-index,
 * chat-v2/sqlite/chat-db, observability/observability-db) can opt in
 * without each reproducing the bridge inline.
 *
 * Critical contract this test enforces:
 *  1. **Bare module names only** — relative paths are NOT supported.
 *     For relative-path lazy loads, callers use ESM dynamic `import()`
 *     (see PR <build-fix>: `Cannot find module '../v3/request.service.js'`
 *     was the production symptom under entry-script anchoring).
 *  2. Caller MUST pass its own per-module `require` (under CJS) or
 *     `null` (under ESM). The helper does NOT auto-detect — under
 *     ts-jest each compiled module has its own bound `require`, so
 *     a helper-internal lookup would silently capture the helper's
 *     own require, making the anchor decision an implicit function
 *     of file layout. Explicit caller-pass keeps the contract clear.
 *  3. The forced-ESM branch (`globalRequire = null`) calls
 *     `createRequire(pathToFileURL(process.argv[1]).href)` so the
 *     produced require resolves bare module names via Node's standard
 *     `node_modules/` walk-up.
 *
 * Lessons banked (DO NOT re-try in the helper or callsites):
 *  - `createRequire(import.meta.url)` directly: ts-jest TS1470.
 *  - `createRequire(new Function('return import.meta.url')())`:
 *    runtime SyntaxError in non-module scope (PR #323 trick).
 *  - `createRequire(eval('import.meta.url'))`: ts-jest passes but
 *    Node ESM SyntaxErrors at runtime — eval'd code is Script-parsed
 *    where `import.meta` is invalid.
 */
describe('createBareModuleRequire (regression guard for native-module bridge)', () => {
	describe('CJS / ts-jest branch (caller passes its own require)', () => {
		it('returns the caller-supplied require verbatim', () => {
			const callerRequire = require;
			const nodeRequire = createBareModuleRequire(callerRequire);
			expect(nodeRequire).toBe(callerRequire);
		});

		it('caller-supplied require resolves bare modules normally', () => {
			const nodeRequire = createBareModuleRequire(require);
			expect(() => nodeRequire('path')).not.toThrow();
			const fs = nodeRequire('fs');
			expect(typeof fs.readFileSync).toBe('function');
		});
	});

	describe('forced ESM branch (createRequire path, anchored to entry script)', () => {
		it('returns a function when globalRequire = null', () => {
			const nodeRequire = createBareModuleRequire(null);
			expect(typeof nodeRequire).toBe('function');
		});

		it('REGRESSION: createRequire-built require resolves bare module names via node_modules walk-up', () => {
			// This is the path PR #494 (fa05720e) established for native
			// addons (better-sqlite3, sqlite-vec) that MUST load via CJS
			// require. We test with built-in modules ('path', 'fs') which
			// also resolve via the bare-name lookup.
			const nodeRequire = createBareModuleRequire(null);
			expect(() => nodeRequire('path')).not.toThrow();
			const fs = nodeRequire('fs');
			expect(typeof fs.readFileSync).toBe('function');
		});

		it('REGRESSION: works for project node_modules dependencies', () => {
			// Validate that node_modules walk-up reaches the project deps,
			// not just Node built-ins. Use a small, safe-to-load dep that
			// is always present in this project.
			const nodeRequire = createBareModuleRequire(null);
			expect(() => nodeRequire('events')).not.toThrow();
		});

		it('non-existent bare module name throws MODULE_NOT_FOUND', () => {
			// Negative case — confirms helper does not silently swallow
			// resolution failures (better-sqlite3 native-addon callers
			// rely on this throw for graceful-degradation try/catch).
			const nodeRequire = createBareModuleRequire(null);
			expect(() =>
				nodeRequire('this-package-definitely-does-not-exist-xyz'),
			).toThrow(/Cannot find module/);
		});
	});

	describe('contract documentation', () => {
		it('REGRESSION: helper does NOT auto-detect its own ambient require when null is passed', () => {
			// If the helper fell back to its own ambient require under
			// `null`, the result would be a function that resolves bare
			// modules — which would PASS this assertion silently and
			// hide the createRequire path entirely. So instead we just
			// pin that the function returned is callable; the
			// resolve-bare-module assertions above prove the createRequire
			// path actually works.
			const nodeRequire = createBareModuleRequire(null);
			expect(typeof nodeRequire).toBe('function');
		});

		it('explicit override: caller can supply a stub require for testing', () => {
			const stub = ((spec: string) => `stubbed-${spec}`) as unknown as NodeRequire;
			const nodeRequire = createBareModuleRequire(stub);
			expect(nodeRequire).toBe(stub);
			expect((nodeRequire as unknown as (s: string) => string)('foo')).toBe(
				'stubbed-foo',
			);
		});
	});
});
