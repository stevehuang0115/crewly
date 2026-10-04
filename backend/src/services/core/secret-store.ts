/**
 * Secret store — where Crewly keeps the bearer secrets the backend and CLI
 * need at runtime, outside the plain files under CREWLY_HOME that every agent
 * (running as the same OS user) can read.
 *
 * Spec: specs/2026-10-04-agent-credential-isolation.md (layer 1 and layer 3).
 *
 * Three kinds:
 *
 * - `keychain` (macOS default): one generic-password item per secret in the
 *   login keychain, written and read with `/usr/bin/security`. The value is
 *   base64-encoded and handed to `security -i` on stdin, so it never appears
 *   on a command line (`ps` would show it to every same-user process).
 * - `file` (Linux and other platforms): one 0600 file per secret in a 0700
 *   directory OUTSIDE CREWLY_HOME (`~/.local/share/crewly/secrets/<home id>`,
 *   or `CREWLY_SECRETS_DIR`). Same OS user, so this is only "not where an
 *   agent looks"; the credential guard blocks the directory by path.
 * - `legacy`: no store; secrets stay in the plain files they always lived in.
 *   The default under Jest, and the owner's rollback switch.
 *
 * What it does NOT do (stated so nobody over-reads it):
 * - It is not a boundary against a same-user process. On macOS the item's
 *   access list trusts `/usr/bin/security` (the tool that created it), so an
 *   agent that runs `security find-generic-password -w -s crewly:…` itself
 *   gets the value without a dialog. Restricting the list to the node binary
 *   is not workable: our reads go through `security`, a native binding would
 *   be satisfied by `node -e` from an agent's shell (same binary), and a node
 *   upgrade changes the binary's signature, which turns every read into an
 *   approval dialog — a hang for an owner who is away. The credential guard
 *   (layer 2) blocks that command for runtimes with hooks; a separate OS user
 *   is the real fix.
 * - Every keychain call has a hard timeout. A call that times out (a locked
 *   keychain showing an unlock dialog) latches the keychain off for this
 *   process, so Crewly never sits behind a dialog.
 *
 * The API is synchronous on purpose: `resolveApiToken()` and the CLI are
 * synchronous, and the values are cached by their callers.
 *
 * @module services/core/secret-store
 */

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCrewlyHomeId, getCrewlyHomePath } from './crewly-home.utils.js';
import { SECRET_STORE_CONSTANTS } from '../../../../config/constants.js';

/** Where secrets live. */
export type SecretStoreKind = 'keychain' | 'file' | 'legacy';

/** Outcome of a read. `error` means "could not tell" — never treat it as missing. */
export type SecretReadResult =
	| { status: 'found'; value: string }
	| { status: 'missing' }
	| { status: 'error'; message: string };

/** A runner for `/usr/bin/security`; injectable so tests never touch a real keychain. */
export type SecurityRunner = (args: string[], input?: string) => SpawnSyncReturns<string>;

/** One store implementation. */
export interface SecretStore {
	/** Which kind this is. */
	readonly kind: SecretStoreKind;
	/** Human-readable location, for logs (never the value). */
	describe(name: string): string;
	/** Read a secret. */
	get(name: string): SecretReadResult;
	/**
	 * Write a secret. Throws on failure.
	 *
	 * With `onlyIfAbsent`, an existing secret is left alone and `exists` is
	 * returned: two processes creating the vault key at once must end up with
	 * the same key, never one overwriting the other's.
	 */
	set(name: string, value: string, options?: { onlyIfAbsent?: boolean }): 'written' | 'exists';
	/** Remove a secret. Missing is not an error. */
	delete(name: string): void;
}

/** Default runner: the real `security` binary, stdin piped, hard timeout. */
const defaultSecurityRunner: SecurityRunner = (args, input) =>
	spawnSync(SECRET_STORE_CONSTANTS.SECURITY_BIN, args, {
		input: input ?? '',
		encoding: 'utf8',
		timeout: SECRET_STORE_CONSTANTS.SECURITY_TIMEOUT_MS,
		stdio: ['pipe', 'pipe', 'pipe'],
	});

/**
 * Keychain service name for a secret (`crewly:<name>`). The account is the
 * resolved CREWLY_HOME, so two installs on one Mac never share an item.
 *
 * @param name - Secret name, e.g. `api-token`
 * @returns The service name
 */
export function keychainServiceName(name: string): string {
	return `${SECRET_STORE_CONSTANTS.KEYCHAIN_SERVICE_PREFIX}${name}`;
}

/**
 * macOS login-keychain store driven through `/usr/bin/security`.
 */
export class KeychainSecretStore implements SecretStore {
	readonly kind = 'keychain' as const;
	/** Set once a call times out: the keychain is treated as unavailable for this process. */
	private unavailableReason: string | null = null;

	/**
	 * @param account - Keychain account (the resolved CREWLY_HOME)
	 * @param run - `security` runner (tests pass a fake)
	 */
	constructor(
		private readonly account: string,
		private readonly run: SecurityRunner = defaultSecurityRunner,
	) {}

	/** @inheritdoc */
	describe(name: string): string {
		return `login keychain item "${keychainServiceName(name)}" (account ${this.account})`;
	}

	/**
	 * Why the keychain is off for this process, or null when it is usable.
	 *
	 * @returns The reason, or null
	 */
	getUnavailableReason(): string | null {
		return this.unavailableReason;
	}

	/**
	 * Run `security`, latching the store off on a timeout.
	 *
	 * @param args - Arguments
	 * @param input - Stdin
	 * @returns The spawn result, or an error message
	 */
	private exec(args: string[], input?: string): SpawnSyncReturns<string> | string {
		if (this.unavailableReason) return this.unavailableReason;
		let res: SpawnSyncReturns<string>;
		try {
			res = this.run(args, input);
		} catch (err) {
			return `security could not run: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (res.error) {
			const code = (res.error as NodeJS.ErrnoException).code;
			const msg = code === 'ETIMEDOUT' || res.signal
				? `security timed out after ${SECRET_STORE_CONSTANTS.SECURITY_TIMEOUT_MS} ms (locked keychain?)`
				: `security could not run: ${res.error.message}`;
			if (code === 'ETIMEDOUT' || res.signal) this.unavailableReason = msg;
			return msg;
		}
		if (res.signal) {
			this.unavailableReason = `security was killed (${res.signal}) — locked keychain?`;
			return this.unavailableReason;
		}
		return res;
	}

	/** @inheritdoc */
	get(name: string): SecretReadResult {
		const res = this.exec(['find-generic-password', '-s', keychainServiceName(name), '-a', this.account, '-w']);
		if (typeof res === 'string') return { status: 'error', message: res };
		if (res.status === SECRET_STORE_CONSTANTS.SECURITY_EXIT_NOT_FOUND) return { status: 'missing' };
		if (res.status !== 0) {
			return { status: 'error', message: `security exited ${res.status}: ${(res.stderr ?? '').trim().slice(0, 200)}` };
		}
		const raw = (res.stdout ?? '').trim();
		const decoded = decodeStoredValue(raw);
		if (decoded === null) return { status: 'error', message: 'keychain item is not in the format Crewly writes' };
		return { status: 'found', value: decoded };
	}

	/** @inheritdoc */
	set(name: string, value: string, options: { onlyIfAbsent?: boolean } = {}): 'written' | 'exists' {
		// `security -i` reads commands from stdin, so the value never reaches
		// argv. Base64 keeps it free of spaces and quotes the -i parser splits on.
		// Without -U, adding an item that exists fails ("already exists").
		const update = options.onlyIfAbsent ? '' : '-U ';
		const line = `add-generic-password ${update}-s ${keychainServiceName(name)} -a ${quoteForSecurityShell(this.account)} -l ${keychainServiceName(name)} -w ${encodeStoredValue(value)}\n`;
		const res = this.exec(['-i'], line);
		if (typeof res === 'string') throw new Error(res);
		const stderr = (res.stderr ?? '').trim();
		if (options.onlyIfAbsent && /already exists/i.test(stderr)) return 'exists';
		if (res.status !== 0) throw new Error(`security exited ${res.status}: ${stderr.slice(0, 200)}`);
		// `security -i` reports a failed command on stderr but can still exit 0.
		if (stderr.length > 0) throw new Error(`security: ${stderr.slice(0, 200)}`);
		return 'written';
	}

	/** @inheritdoc */
	delete(name: string): void {
		const res = this.exec(['delete-generic-password', '-s', keychainServiceName(name), '-a', this.account]);
		if (typeof res === 'string') throw new Error(res);
		if (res.status !== 0 && res.status !== SECRET_STORE_CONSTANTS.SECURITY_EXIT_NOT_FOUND) {
			throw new Error(`security exited ${res.status}: ${(res.stderr ?? '').trim().slice(0, 200)}`);
		}
	}
}

/**
 * Quote a value for the `security -i` command parser (double quotes; the
 * parser has no escape for a double quote, so one is refused).
 *
 * @param value - Raw value
 * @returns Quoted value
 * @throws When the value holds a double quote or a newline
 */
export function quoteForSecurityShell(value: string): string {
	if (/["\n\r]/.test(value)) throw new Error('value cannot be passed to security -i');
	return `"${value}"`;
}

/**
 * Encode a value for storage (`b64:<base64>`).
 *
 * @param value - Raw value
 * @returns Encoded value
 */
export function encodeStoredValue(value: string): string {
	return `${SECRET_STORE_CONSTANTS.VALUE_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}`;
}

/**
 * Decode a stored value written by {@link encodeStoredValue}.
 *
 * @param raw - Stored value
 * @returns The original value, or null when it is not in that format
 */
export function decodeStoredValue(raw: string): string | null {
	const prefix = SECRET_STORE_CONSTANTS.VALUE_PREFIX;
	if (!raw.startsWith(prefix)) return null;
	const body = raw.slice(prefix.length);
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return null;
	return Buffer.from(body, 'base64').toString('utf8');
}

/**
 * Default directory of the `file` store: outside CREWLY_HOME, one
 * subdirectory per install.
 *
 * @param env - Environment (CREWLY_SECRETS_DIR overrides)
 * @returns Absolute directory
 */
export function getSecretsDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[SECRET_STORE_CONSTANTS.ENV.SECRETS_DIR]?.trim();
	if (override) return path.resolve(override);
	return path.join(os.homedir(), ...SECRET_STORE_CONSTANTS.FILE_STORE_DIR_SEGMENTS, getCrewlyHomeId());
}

/**
 * One 0600 file per secret in a 0700 directory outside CREWLY_HOME.
 */
export class FileSecretStore implements SecretStore {
	readonly kind = 'file' as const;

	/** @param dir - Directory that holds the secret files */
	constructor(private readonly dir: string) {}

	/**
	 * Path of a secret's file.
	 *
	 * @param name - Secret name
	 * @returns Absolute path
	 */
	pathFor(name: string): string {
		if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) throw new Error(`invalid secret name: ${name}`);
		return path.join(this.dir, name);
	}

	/** @inheritdoc */
	describe(name: string): string {
		return this.pathFor(name);
	}

	/** @inheritdoc */
	get(name: string): SecretReadResult {
		try {
			const raw = fs.readFileSync(this.pathFor(name), 'utf8').trim();
			const decoded = decodeStoredValue(raw);
			if (decoded === null) return { status: 'error', message: 'secret file is not in the format Crewly writes' };
			return { status: 'found', value: decoded };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
			return { status: 'error', message: err instanceof Error ? err.message : String(err) };
		}
	}

	/** @inheritdoc */
	set(name: string, value: string, options: { onlyIfAbsent?: boolean } = {}): 'written' | 'exists' {
		fs.mkdirSync(this.dir, { recursive: true, mode: SECRET_STORE_CONSTANTS.DIR_MODE });
		fs.chmodSync(this.dir, SECRET_STORE_CONSTANTS.DIR_MODE);
		const file = this.pathFor(name);
		const body = `${encodeStoredValue(value)}\n`;
		if (options.onlyIfAbsent) {
			try {
				fs.writeFileSync(file, body, { mode: SECRET_STORE_CONSTANTS.FILE_MODE, flag: 'wx' });
				return 'written';
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
				throw err;
			}
		}
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, body, { mode: SECRET_STORE_CONSTANTS.FILE_MODE });
		fs.chmodSync(tmp, SECRET_STORE_CONSTANTS.FILE_MODE);
		fs.renameSync(tmp, file);
		return 'written';
	}

	/** @inheritdoc */
	delete(name: string): void {
		try {
			fs.unlinkSync(this.pathFor(name));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
	}
}

/** `legacy`: nothing is stored; callers keep secrets in their plain files. */
export class LegacySecretStore implements SecretStore {
	readonly kind = 'legacy' as const;

	/** @inheritdoc */
	describe(): string {
		return 'plain file under CREWLY_HOME (legacy)';
	}

	/** @inheritdoc */
	get(): SecretReadResult {
		return { status: 'missing' };
	}

	/** @inheritdoc */
	set(): 'written' | 'exists' {
		throw new Error('legacy secret store holds nothing');
	}

	/** @inheritdoc */
	delete(): void {
		/* nothing stored */
	}
}

/**
 * Which store kind applies to this process.
 *
 * - `CREWLY_SECRET_STORE=keychain|file|legacy` wins (an unknown value is ignored).
 * - Under Jest: `legacy`, so a test can never reach a real keychain or a
 *   secrets directory in the real home. Tests construct stores explicitly.
 * - macOS: `keychain`. Other platforms: `file`.
 *
 * @param env - Environment
 * @param platform - Platform
 * @returns The kind
 */
export function resolveSecretStoreKind(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): SecretStoreKind {
	const pinned = env[SECRET_STORE_CONSTANTS.ENV.STORE]?.trim().toLowerCase();
	if (pinned === 'keychain' || pinned === 'file' || pinned === 'legacy') return pinned;
	if (env.JEST_WORKER_ID !== undefined || env.NODE_ENV === 'test') return 'legacy';
	return platform === 'darwin' ? 'keychain' : 'file';
}

/** Process-wide store, built on first use. */
let activeStore: SecretStore | null = null;

/**
 * The secret store for this process.
 *
 * @returns The store
 */
export function getSecretStore(): SecretStore {
	if (activeStore) return activeStore;
	const kind = resolveSecretStoreKind();
	if (kind === 'keychain') {
		activeStore = new KeychainSecretStore(path.resolve(getCrewlyHomePath()));
	} else if (kind === 'file') {
		activeStore = new FileSecretStore(getSecretsDir());
	} else {
		activeStore = new LegacySecretStore();
	}
	return activeStore;
}

/**
 * Replace the process-wide store (tests), or clear it so the next
 * {@link getSecretStore} rebuilds it from the environment.
 *
 * @param store - Store to use, or null to reset
 */
export function setSecretStoreForTesting(store: SecretStore | null): void {
	activeStore = store;
}
