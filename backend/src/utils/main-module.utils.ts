/**
 * Whether a script path is the backend entry file.
 *
 * @module utils/main-module
 */

/** `index.ts` / `index.js` as the last path segment, with either separator. */
const ENTRY_FILE = /(?:^|[\\/])index\.(?:ts|js)$/;

/**
 * Whether the process was started with the backend entry file as its script.
 *
 * Windows passes `process.argv[1]` with backslashes
 * (`C:\...\backend\src\index.js`). A check for a trailing `/index.js` never
 * matched there, so the server was never constructed and the process exited
 * with code 0 before it listened (Windows native smoke run, 2026-11-19).
 *
 * @param scriptPath - `process.argv[1]`
 * @returns True when it names `index.ts` or `index.js`
 *
 * @example
 * ```typescript
 * isBackendEntryScript('C:\\npm\\crewly\\dist\\backend\\backend\\src\\index.js'); // true
 * isBackendEntryScript('/usr/lib/crewly/dist/cli/cli/src/index.js'); // true
 * isBackendEntryScript('/usr/lib/jest/bin/jest.js'); // false
 * ```
 */
export function isBackendEntryScript(scriptPath: string | undefined): boolean {
	return typeof scriptPath === 'string' && ENTRY_FILE.test(scriptPath);
}
