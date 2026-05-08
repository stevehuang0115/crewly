/**
 * Native-binding fail-fast helpers.
 *
 * When a native Node addon (e.g. `better-sqlite3`, `node-pty`,
 * `sqlite-vec-darwin-*`) is built for the wrong CPU/ABI and Node tries
 * to `dlopen` it, the loader emits a recognisable error pattern:
 *
 * ```
 * dlopen .../foo.node, 0x0001
 * mach-o file, but is an incompatible architecture
 * (have 'x86_64', need 'arm64e' or 'arm64')
 * ```
 *
 * This module exists for one reason: those errors must NEVER be
 * silently swallowed by a try/catch wrapper at the gateway layer
 * (which used to downgrade chat-v2 to a JSON-file fallback while
 * `chat.db` quietly went stale — F-CYCLE7-1, audit 2026-05-07 §2.1).
 *
 * The contract:
 *
 *   1. {@link loadNativeAddonOrFatal} wraps `require(name)`.
 *   2. If the require throws and the error matches a known native-arch
 *      / dlopen pattern, we rethrow as {@link NativeBindingFatalError},
 *      which carries `fatal: true`.
 *   3. The boot-time wiring (`backend/src/index.ts`, the chat-v2 init
 *      try/catch) inspects caught errors with {@link isNativeBindingFatalError}
 *      and **rethrows fatal errors** rather than logging them as
 *      "non-critical". This crashes the process at boot — which is the
 *      desired behaviour: an arch-mismatched binary can be fixed by
 *      `npm rebuild <pkg> --build-from-source`, but only if the operator
 *      sees the failure.
 *
 * @module utils/native-binding.utils
 */

/**
 * Marker class for native-binding failures that MUST crash the
 * process at boot rather than be downgraded to a runtime fallback.
 *
 * Holds the original underlying error in `cause` so logs surface
 * the full dlopen trace.
 */
export class NativeBindingFatalError extends Error {
	/** Discriminator readable by `instanceof` and structural callers. */
	public readonly fatal = true as const;

	/**
	 * The npm package name that failed to load (`'better-sqlite3'`,
	 * `'node-pty'`, etc.). Used in the boot-failure log line and the
	 * remediation hint that follows it.
	 */
	public readonly moduleName: string;

	/**
	 * The original error thrown by `require(name)`. Preserved for log
	 * fidelity — the dlopen line itself is the most useful piece of
	 * context for whoever has to run the rebuild.
	 */
	public override readonly cause: unknown;

	/**
	 * Build a fatal-error wrapper.
	 *
	 * @param moduleName - The npm package that failed to load
	 * @param cause - The underlying error from the failed require
	 * @param remediation - One-line remediation hint shown in the message
	 *   (default: `npm rebuild <moduleName> --build-from-source`)
	 */
	constructor(moduleName: string, cause: unknown, remediation?: string) {
		const fix =
			remediation ??
			`Run \`npm rebuild ${moduleName} --build-from-source\` (or delete node_modules/${moduleName}/build and reinstall) to recompile for this host's arch.`;
		const causeMessage = cause instanceof Error ? cause.message : String(cause);
		super(
			`FATAL: native binding "${moduleName}" failed to load. ${fix} Original error: ${causeMessage}`,
		);
		this.name = 'NativeBindingFatalError';
		this.moduleName = moduleName;
		this.cause = cause;
		// Preserve the original stack chain when available so debuggers
		// can walk back to the dlopen frame.
		if (cause instanceof Error && cause.stack) {
			this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
		}
	}
}

/**
 * Type guard for {@link NativeBindingFatalError}. Survives realm
 * boundaries (unlike a bare `instanceof`) by also checking the
 * structural `fatal === true` + `name === 'NativeBindingFatalError'`
 * shape — useful when the same module is loaded via two different
 * resolver paths (ts-jest vs. native ESM) and `instanceof` would
 * unexpectedly miss.
 *
 * @param err - Any thrown value
 * @returns True iff the error is a fatal native-binding load failure
 */
export function isNativeBindingFatalError(
	err: unknown,
): err is NativeBindingFatalError {
	if (err instanceof NativeBindingFatalError) return true;
	if (
		err !== null &&
		typeof err === 'object' &&
		(err as { name?: unknown }).name === 'NativeBindingFatalError' &&
		(err as { fatal?: unknown }).fatal === true
	) {
		return true;
	}
	return false;
}

/**
 * Patterns that identify a dlopen / arch-mismatch / ABI-version
 * failure. Match any one and we treat the require failure as a fatal
 * native-binding error.
 *
 * Sourced from real Node.js loader output across:
 *   - macOS Mach-O (`mach-o file, but is an incompatible architecture`,
 *     `have 'x86_64', need 'arm64'`, `dlopen` prefix)
 *   - glibc Linux (`wrong ELF class`, `cannot open shared object file`)
 *   - Node ABI mismatch (`NODE_MODULE_VERSION` mismatch after Node
 *     upgrade, `was compiled against a different Node.js version`)
 *   - Windows (`is not a valid Win32 application`)
 *   - Generic native-addon loader (`Module did not self-register`,
 *     which happens when a `.node` file is loaded by a Node ABI it
 *     does not match)
 *
 * Each pattern is anchored case-insensitively against the error
 * message string. Tested in `native-binding.utils.test.ts`.
 */
const FATAL_NATIVE_PATTERNS: readonly RegExp[] = [
	// macOS Mach-O dlopen + arch mismatch ----------------------------
	/dlopen[\s\S]*incompatible architecture/i,
	/mach-o file, but is an incompatible architecture/i,
	/have '[^']+', need '[^']+'/i,
	// glibc Linux ELF mismatch ---------------------------------------
	/wrong ELF class/i,
	/cannot open shared object file/i,
	// Node ABI mismatch ----------------------------------------------
	/NODE_MODULE_VERSION/i,
	/was compiled against a different Node\.js version/i,
	/Module did not self-register/i,
	// Windows --------------------------------------------------------
	/is not a valid Win32 application/i,
];

/**
 * Decide whether the given error indicates a native-addon arch / ABI
 * mismatch (vs. a benign "package not installed" error or a runtime
 * SQL bug from inside the addon).
 *
 * Stable, narrow behaviour — only matches the patterns in
 * {@link FATAL_NATIVE_PATTERNS}. Callers can refine further by
 * inspecting `err.code === 'ERR_DLOPEN_FAILED'` (Node ≥ 16 emits this
 * for any failed `dlopen`, including arch mismatches) before calling
 * this helper if they want a broader net.
 *
 * @param err - Any thrown value
 * @returns True iff the error message matches a known native-mismatch pattern
 */
export function isNativeArchMismatchError(err: unknown): boolean {
	if (err === null || err === undefined) return false;
	const message = err instanceof Error ? err.message : String(err);
	if (typeof message !== 'string' || message.length === 0) return false;
	// `code` is a stronger signal than message-pattern when present.
	const code = (err as { code?: unknown }).code;
	if (code === 'ERR_DLOPEN_FAILED') return true;
	return FATAL_NATIVE_PATTERNS.some((re) => re.test(message));
}

/**
 * Load a native Node addon by name, escalating arch / ABI mismatches
 * to {@link NativeBindingFatalError}.
 *
 * Behaviour:
 *   - On success: returns the require'd module unchanged.
 *   - On failure that matches {@link isNativeArchMismatchError}:
 *     throws {@link NativeBindingFatalError}.
 *   - On any other failure (e.g. `Cannot find module 'foo'` because
 *     the package isn't installed at all): rethrows the original
 *     error unchanged, so callers can keep their existing
 *     "package missing → soft error" semantics.
 *
 * @param moduleName - Package name (`'better-sqlite3'`, `'node-pty'`)
 * @param requireFn - The CJS-style require to use (typically the result
 *   of `createBareModuleRequire(...)` from `node-require.utils.ts`)
 * @param remediation - Optional override for the remediation hint shown
 *   in the wrapped error message
 * @returns The loaded module
 *
 * @throws {NativeBindingFatalError} when the require fails with a
 *   recognised native-arch / ABI / dlopen pattern.
 *
 * @example
 * ```ts
 * import { loadNativeAddonOrFatal } from '../../utils/native-binding.utils.js';
 *
 * const Database = loadNativeAddonOrFatal<typeof import('better-sqlite3')>(
 *   'better-sqlite3',
 *   nodeRequire,
 * );
 * ```
 */
export function loadNativeAddonOrFatal<T = unknown>(
	moduleName: string,
	requireFn: NodeRequire,
	remediation?: string,
): T {
	try {
		return requireFn(moduleName) as T;
	} catch (err) {
		if (isNativeArchMismatchError(err)) {
			throw new NativeBindingFatalError(moduleName, err, remediation);
		}
		throw err;
	}
}
