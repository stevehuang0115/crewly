/**
 * Tests for native-binding fail-fast helpers.
 *
 * Verifies:
 *   - Pattern detection across real-world error shapes (Mach-O,
 *     glibc, Node ABI, Windows).
 *   - {@link loadNativeAddonOrFatal} rethrows arch-mismatch failures
 *     as {@link NativeBindingFatalError} (carrying `fatal: true` and
 *     a remediation hint).
 *   - Non-native errors (e.g. `Cannot find module`) bubble up
 *     unchanged so existing soft-error paths keep working.
 *   - The fatal error survives realm boundaries via
 *     {@link isNativeBindingFatalError}'s structural check.
 *
 * @module utils/native-binding.utils.test
 */

import {
	NativeBindingFatalError,
	isNativeArchMismatchError,
	isNativeBindingFatalError,
	loadNativeAddonOrFatal,
} from './native-binding.utils.js';

describe('isNativeArchMismatchError', () => {
	it('matches the macOS Mach-O dlopen arch-mismatch line', () => {
		const err = new Error(
			"dlopen /node_modules/better-sqlite3/build/Release/better_sqlite3.node, 0x0001\nmach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64e' or 'arm64')",
		);
		expect(isNativeArchMismatchError(err)).toBe(true);
	});

	it('matches the glibc ELF-class mismatch line', () => {
		const err = new Error(
			'/usr/lib/.../foo.node: wrong ELF class: ELFCLASS64',
		);
		expect(isNativeArchMismatchError(err)).toBe(true);
	});

	it('matches the glibc cannot-open-shared-object line', () => {
		const err = new Error(
			'/usr/lib/.../foo.node: cannot open shared object file: No such file or directory',
		);
		expect(isNativeArchMismatchError(err)).toBe(true);
	});

	it('matches the NODE_MODULE_VERSION ABI line', () => {
		const err = new Error(
			'The module ... was compiled against a different Node.js version using NODE_MODULE_VERSION 108. This version of Node.js requires NODE_MODULE_VERSION 115.',
		);
		expect(isNativeArchMismatchError(err)).toBe(true);
	});

	it('matches the "Module did not self-register" line', () => {
		const err = new Error(
			'Module did not self-register: foo.node',
		);
		expect(isNativeArchMismatchError(err)).toBe(true);
	});

	it('matches a Windows-style mismatch line', () => {
		const err = new Error(
			'\\\\?\\C:\\foo\\bar.node is not a valid Win32 application.',
		);
		expect(isNativeArchMismatchError(err)).toBe(true);
	});

	it('matches errors that carry code=ERR_DLOPEN_FAILED', () => {
		const err = Object.assign(new Error('something'), {
			code: 'ERR_DLOPEN_FAILED',
		});
		expect(isNativeArchMismatchError(err)).toBe(true);
	});

	it('returns false for "Cannot find module" (package simply not installed)', () => {
		const err = new Error("Cannot find module 'better-sqlite3'");
		expect(isNativeArchMismatchError(err)).toBe(false);
	});

	it('returns false for a non-native runtime error from inside the addon', () => {
		const err = new Error('SqliteError: no such table: foo');
		expect(isNativeArchMismatchError(err)).toBe(false);
	});

	it('returns false for null / undefined / empty messages', () => {
		expect(isNativeArchMismatchError(null)).toBe(false);
		expect(isNativeArchMismatchError(undefined)).toBe(false);
		expect(isNativeArchMismatchError(new Error(''))).toBe(false);
	});
});

describe('NativeBindingFatalError', () => {
	it('exposes fatal=true and the original cause', () => {
		const cause = new Error('dlopen ... incompatible architecture');
		const err = new NativeBindingFatalError('better-sqlite3', cause);
		expect(err.fatal).toBe(true);
		expect(err.moduleName).toBe('better-sqlite3');
		expect(err.cause).toBe(cause);
		expect(err.name).toBe('NativeBindingFatalError');
		expect(err.message).toContain('better-sqlite3');
		expect(err.message).toContain('npm rebuild better-sqlite3');
		expect(err.message).toContain('incompatible architecture');
	});

	it('honours an explicit remediation hint', () => {
		const cause = new Error('boom');
		const err = new NativeBindingFatalError(
			'foo-pkg',
			cause,
			'Run `make rebuild-foo` instead.',
		);
		expect(err.message).toContain('Run `make rebuild-foo` instead.');
	});

	it('appends the cause stack to its own stack when present', () => {
		const cause = new Error('dlopen ... incompatible architecture');
		// Force a known stack so the assertion is deterministic.
		cause.stack = 'Error: dlopen ... incompatible architecture\n    at <native>';
		const err = new NativeBindingFatalError('better-sqlite3', cause);
		expect(err.stack).toContain('Caused by:');
		expect(err.stack).toContain('at <native>');
	});

	it('handles non-Error causes without throwing', () => {
		expect(
			() => new NativeBindingFatalError('foo', 'string-cause'),
		).not.toThrow();
		const err = new NativeBindingFatalError('foo', 'string-cause');
		expect(err.message).toContain('string-cause');
	});
});

describe('isNativeBindingFatalError', () => {
	it('matches an instanceof NativeBindingFatalError', () => {
		const err = new NativeBindingFatalError('x', new Error('y'));
		expect(isNativeBindingFatalError(err)).toBe(true);
	});

	it('matches structurally across realm boundaries (duck-typed shape)', () => {
		// Simulate an error caught from a different module realm where
		// `instanceof NativeBindingFatalError` would return false.
		const ductTyped = {
			name: 'NativeBindingFatalError',
			fatal: true,
			message: 'realm-boundary case',
		};
		expect(isNativeBindingFatalError(ductTyped)).toBe(true);
	});

	it('rejects ordinary errors', () => {
		expect(isNativeBindingFatalError(new Error('boom'))).toBe(false);
		expect(isNativeBindingFatalError(null)).toBe(false);
		expect(isNativeBindingFatalError({ name: 'NativeBindingFatalError' })).toBe(
			false, // missing fatal=true
		);
	});
});

describe('loadNativeAddonOrFatal', () => {
	it('returns the loaded module on success', () => {
		const fakeModule = { hello: 'world' };
		const fakeRequire = ((_name: string) => fakeModule) as unknown as NodeRequire;
		expect(loadNativeAddonOrFatal('foo', fakeRequire)).toBe(fakeModule);
	});

	it('throws NativeBindingFatalError when the require fails with a dlopen-arch error', () => {
		const cause = new Error(
			"dlopen .../better_sqlite3.node, 0x0001\nmach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64')",
		);
		const fakeRequire = ((_name: string) => {
			throw cause;
		}) as unknown as NodeRequire;

		let caught: unknown = null;
		try {
			loadNativeAddonOrFatal('better-sqlite3', fakeRequire);
		} catch (e) {
			caught = e;
		}
		expect(isNativeBindingFatalError(caught)).toBe(true);
		expect((caught as NativeBindingFatalError).moduleName).toBe('better-sqlite3');
		expect((caught as NativeBindingFatalError).cause).toBe(cause);
	});

	it('throws NativeBindingFatalError for ABI mismatches (NODE_MODULE_VERSION)', () => {
		const cause = new Error(
			'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 108',
		);
		const fakeRequire = ((_name: string) => {
			throw cause;
		}) as unknown as NodeRequire;

		expect(() => loadNativeAddonOrFatal('node-pty', fakeRequire)).toThrow(
			NativeBindingFatalError,
		);
	});

	it('rethrows non-native errors (Cannot find module) unchanged', () => {
		const cause = new Error("Cannot find module 'absent-pkg'");
		const fakeRequire = ((_name: string) => {
			throw cause;
		}) as unknown as NodeRequire;

		let caught: unknown = null;
		try {
			loadNativeAddonOrFatal('absent-pkg', fakeRequire);
		} catch (e) {
			caught = e;
		}
		// Same identity — caller's existing soft-error handling still fires.
		expect(caught).toBe(cause);
		expect(isNativeBindingFatalError(caught)).toBe(false);
	});

	it('caches nothing — call twice with a failing require, throws twice', () => {
		// Documents intentional non-caching: callers (chat-db / observability-db)
		// own the module-level cache; this helper is stateless. Two failures
		// in a row both surface as fatal, which matters if a caller retries
		// after a partial recovery.
		let calls = 0;
		const fakeRequire = ((_name: string) => {
			calls += 1;
			throw new Error('dlopen ... incompatible architecture');
		}) as unknown as NodeRequire;

		expect(() => loadNativeAddonOrFatal('foo', fakeRequire)).toThrow(
			NativeBindingFatalError,
		);
		expect(() => loadNativeAddonOrFatal('foo', fakeRequire)).toThrow(
			NativeBindingFatalError,
		);
		expect(calls).toBe(2);
	});
});
