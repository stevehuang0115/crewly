/**
 * Install-time native toolchain preflight (finding 11).
 *
 * Wired into `package.json` `preinstall` (before node-pty's node-gyp step
 * runs) and `postinstall` (after the rebuild attempts). Prints ONE clear
 * message naming the missing build tool(s) and the package-manager command
 * instead of the raw node-gyp trace. Always exits 0 — it must never turn a
 * working install into a failing one — and depends on nothing outside node
 * builtins because at `preinstall` time no dependency exists yet.
 *
 * @module cli/scripts/check-native-toolchain
 */

import { resolve } from 'path';
import { checkNativeToolchain } from '../utils/native-toolchain.js';

/**
 * Run the preflight against a package root and print the message, if any.
 *
 * @param packageRoot - Directory containing `node_modules/` (npm sets cwd to it for lifecycle scripts)
 * @param log - Sink for the message (stderr by default so it survives `2>/dev/null`-free pipelines)
 * @returns true when the toolchain is fine or node-pty is already usable
 */
export function runToolchainCheck(
	packageRoot: string = process.cwd(),
	log: (message: string) => void = (m) => console.error(m),
): boolean {
	const result = checkNativeToolchain({ packageRoot });
	if (!result.ok) {
		log(result.message);
	}
	return result.ok;
}

/* c8 ignore start — lifecycle entry, exercised by npm not by unit tests */
const invokedDirectly =
	process.argv[1] !== undefined && process.argv[1].endsWith('check-native-toolchain.js');

if (invokedDirectly) {
	try {
		runToolchainCheck(resolve(process.cwd()));
	} catch {
		// Never fail an install because the preflight itself broke.
	}
}
/* c8 ignore stop */
