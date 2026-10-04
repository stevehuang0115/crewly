/**
 * Credential vault — keeps the bearer secrets in Crewly's credential files
 * encrypted at rest, with the key outside the files.
 *
 * Spec: specs/2026-10-04-agent-credential-isolation.md (layer 1).
 *
 * Why not one keychain item per secret: some credential files are large and
 * nested (one Slack bot token per agent), and every keychain read is a
 * subprocess with a dialog risk. Instead there is ONE key, `vault-key`, in the
 * {@link getSecretStore secret store} (macOS login keychain; a 0600 file
 * outside CREWLY_HOME elsewhere). Each credential file keeps its non-secret
 * fields in clear and its secrets AES-256-GCM-sealed with that key:
 *
 * - JSON files: `{ ...public fields, "crewlySealed": "v1.<iv>.<tag>.<data>",
 *   "crewlySealedNote": "…" }`. The sealed blob is the JSON of the other fields.
 * - Text/binary files (`api-token`, `credentials/master.key`):
 *   `crewly-sealed:v1.<iv>.<tag>.<data>\n`.
 *
 * Readers accept both the sealed and the old plain form, so a file that was
 * never migrated (or a rollback) keeps working. When sealing is off
 * (`legacy` store, Jest, or no key could be obtained) writers write the plain
 * form exactly as before.
 *
 * Not a boundary against a same-user process (see secret-store.ts): an agent
 * that reads the key from the keychain with `security` can decrypt the files.
 * What it removes is the plain-file path — `cat`, `jq`, `grep -r`, a file
 * viewer tool — which is how the 2026-10-04 incident happened.
 *
 * @module services/core/credential-vault
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getSecretStore, type SecretStore } from './secret-store.js';
import { SECRET_STORE_CONSTANTS } from '../../../../config/constants.js';

const V = SECRET_STORE_CONSTANTS.VAULT;

/** Cached key for this process (null = looked up and not available). */
let cachedKey: Buffer | null | undefined;
/** Why the key is not available, for logs. */
let keyUnavailableReason: string | null = null;

/**
 * The vault key, creating it on first use when `create` is set.
 *
 * A read error (a locked keychain, a timeout) never creates a new key: a new
 * key would make every file sealed with the old one unreadable. Sealing is
 * then off for this process and files are read/written plain.
 *
 * @param options - `create`: generate and store a key when none exists
 * @param store - Secret store (defaults to the process store)
 * @returns The 32-byte key, or null when sealing is not possible
 */
export function getVaultKey(options: { create: boolean } = { create: false }, store: SecretStore = getSecretStore()): Buffer | null {
	if (cachedKey) return cachedKey;
	if (store.kind === 'legacy') {
		keyUnavailableReason = 'secret store is legacy (plain files)';
		return null;
	}
	if (cachedKey === null && !options.create) return null;
	const found = store.get(V.KEY_NAME);
	if (found.status === 'found') {
		const key = Buffer.from(found.value, 'base64');
		if (key.length !== V.KEY_BYTES) {
			keyUnavailableReason = `stored vault key has ${key.length} bytes, expected ${V.KEY_BYTES}`;
			cachedKey = null;
			return null;
		}
		cachedKey = key;
		keyUnavailableReason = null;
		return key;
	}
	if (found.status === 'error') {
		keyUnavailableReason = `could not read the vault key from ${store.describe(V.KEY_NAME)}: ${found.message}`;
		cachedKey = null;
		return null;
	}
	if (!options.create) {
		keyUnavailableReason = 'no vault key yet';
		cachedKey = null;
		return null;
	}
	const key = randomBytes(V.KEY_BYTES);
	try {
		// onlyIfAbsent: another process (the CLI, a second backend) may create
		// the key at the same moment; the first one wins and both use it.
		store.set(V.KEY_NAME, key.toString('base64'), { onlyIfAbsent: true });
	} catch (err) {
		keyUnavailableReason = `could not store a vault key in ${store.describe(V.KEY_NAME)}: ${err instanceof Error ? err.message : String(err)}`;
		cachedKey = null;
		return null;
	}
	// Read it back (ours, or the one another process created first): only a
	// key that round-trips through the store may seal anything.
	const check = store.get(V.KEY_NAME);
	const stored = check.status === 'found' ? Buffer.from(check.value, 'base64') : null;
	if (!stored || stored.length !== V.KEY_BYTES) {
		keyUnavailableReason = `the vault key did not read back from ${store.describe(V.KEY_NAME)}`;
		cachedKey = null;
		return null;
	}
	cachedKey = stored;
	keyUnavailableReason = null;
	return stored;
}

/**
 * Why the last key lookup gave no key (null when a key is cached).
 *
 * @returns Reason or null
 */
export function getVaultKeyUnavailableReason(): string | null {
	return cachedKey ? null : keyUnavailableReason;
}

/** Drop the cached key (tests, or after the store changed). */
export function resetVaultKeyCache(): void {
	cachedKey = undefined;
	keyUnavailableReason = null;
}

/**
 * Seal a string.
 *
 * @param plain - Plain text
 * @param key - 32-byte key
 * @returns `v1.<iv>.<tag>.<data>` (base64 parts)
 */
export function sealString(plain: string, key: Buffer): string {
	const iv = randomBytes(V.IV_BYTES);
	const cipher = createCipheriv(V.CIPHER, key, iv);
	const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [V.FORMAT_VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join('.');
}

/**
 * Open a value sealed by {@link sealString}.
 *
 * @param sealed - Sealed value
 * @param key - 32-byte key
 * @returns Plain text
 * @throws When the format is wrong or the key does not match
 */
export function unsealString(sealed: string, key: Buffer): string {
	const parts = sealed.trim().split('.');
	if (parts.length !== 4 || parts[0] !== V.FORMAT_VERSION) throw new Error('not a sealed Crewly value');
	const [, ivB64, tagB64, dataB64] = parts;
	const decipher = createDecipheriv(V.CIPHER, key, Buffer.from(ivB64, 'base64'));
	decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
	return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Whether file contents are the sealed text form.
 *
 * @param raw - File contents
 * @returns True for `crewly-sealed:…`
 */
export function isSealedText(raw: string | Buffer): boolean {
	const head = Buffer.isBuffer(raw) ? raw.subarray(0, V.TEXT_PREFIX.length).toString('latin1') : raw.slice(0, V.TEXT_PREFIX.length);
	return head === V.TEXT_PREFIX;
}

/**
 * Whether a parsed JSON value is the sealed JSON form.
 *
 * @param value - Parsed JSON
 * @returns True when it carries `crewlySealed`
 */
export function isSealedJson(value: unknown): value is Record<string, unknown> & { crewlySealed: string } {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
		&& typeof (value as Record<string, unknown>)[V.JSON_FIELD] === 'string';
}

/** Result of reading a credential file. */
export type VaultRead<T> =
	| { status: 'ok'; value: T; sealed: boolean }
	| { status: 'missing' }
	| { status: 'locked'; message: string };

/**
 * Read a text or binary credential file, unsealing it when needed.
 *
 * @param filePath - File
 * @returns The raw bytes (plain), missing, or locked (sealed and no key)
 */
export function readSecretBytes(filePath: string): VaultRead<Buffer> {
	let raw: Buffer;
	try {
		raw = fs.readFileSync(filePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
		return { status: 'locked', message: err instanceof Error ? err.message : String(err) };
	}
	if (!isSealedText(raw)) return { status: 'ok', value: raw, sealed: false };
	const key = getVaultKey({ create: false });
	if (!key) return { status: 'locked', message: getVaultKeyUnavailableReason() ?? 'vault key unavailable' };
	try {
		const inner = unsealString(raw.toString('utf8').slice(V.TEXT_PREFIX.length), key);
		return { status: 'ok', value: Buffer.from(inner, 'base64'), sealed: true };
	} catch (err) {
		return { status: 'locked', message: `could not unseal ${filePath}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/**
 * Read a text credential file (UTF-8), unsealing it when needed.
 *
 * @param filePath - File
 * @returns The text, missing, or locked
 */
export function readSecretText(filePath: string): VaultRead<string> {
	const res = readSecretBytes(filePath);
	if (res.status !== 'ok') return res;
	return { status: 'ok', value: res.value.toString('utf8'), sealed: res.sealed };
}

/**
 * Atomically write a file with a mode.
 *
 * @param filePath - File
 * @param data - Contents
 * @param mode - POSIX mode
 */
function atomicWrite(filePath: string, data: string | Buffer, mode: number): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	fs.writeFileSync(tmp, data, { mode });
	fs.chmodSync(tmp, mode);
	fs.renameSync(tmp, filePath);
}

/**
 * Write a text or binary credential file, sealed when a key is available.
 *
 * @param filePath - File
 * @param value - Plain bytes or text
 * @param mode - POSIX mode (default 0600)
 * @returns Whether the file was sealed
 */
export function writeSecretBytes(filePath: string, value: Buffer | string, mode: number = V.FILE_MODE): boolean {
	const buf = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
	const key = getVaultKey({ create: true });
	if (!key) {
		atomicWrite(filePath, buf, mode);
		return false;
	}
	atomicWrite(filePath, `${V.TEXT_PREFIX}${sealString(buf.toString('base64'), key)}\n`, mode);
	return true;
}

/**
 * Read a JSON credential file, unsealing its secret fields when needed.
 *
 * @param filePath - File
 * @returns The full object (public + secret fields), missing, or locked
 * @throws SyntaxError when the file is not JSON (the caller's existing handling applies)
 */
export function readSecretJson<T = Record<string, unknown>>(filePath: string): VaultRead<T> {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
		return { status: 'locked', message: err instanceof Error ? err.message : String(err) };
	}
	const parsed = JSON.parse(raw) as unknown;
	if (!isSealedJson(parsed)) return { status: 'ok', value: parsed as T, sealed: false };
	const key = getVaultKey({ create: false });
	if (!key) return { status: 'locked', message: getVaultKeyUnavailableReason() ?? 'vault key unavailable' };
	try {
		const secret = JSON.parse(unsealString(parsed[V.JSON_FIELD], key)) as Record<string, unknown>;
		const { [V.JSON_FIELD]: _s, [V.JSON_NOTE_FIELD]: _n, ...publicFields } = parsed;
		return { status: 'ok', value: { ...publicFields, ...secret } as T, sealed: true };
	} catch (err) {
		return { status: 'locked', message: `could not unseal ${filePath}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/**
 * Write a JSON credential file: the fields named in `publicFields` stay in
 * clear, every other field is sealed when a key is available.
 *
 * @param filePath - File
 * @param value - Full object
 * @param publicFields - Top-level fields that are not secret
 * @param mode - POSIX mode (default 0600)
 * @returns Whether the file was sealed
 */
export function writeSecretJson(
	filePath: string,
	value: Record<string, unknown>,
	publicFields: readonly string[] = [],
	mode: number = V.FILE_MODE,
): boolean {
	const key = getVaultKey({ create: true });
	if (!key) {
		atomicWrite(filePath, JSON.stringify(value, null, 2), mode);
		return false;
	}
	const pub: Record<string, unknown> = {};
	const secret: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		if (publicFields.includes(k)) pub[k] = v;
		else secret[k] = v;
	}
	const out = { ...pub, [V.JSON_FIELD]: sealString(JSON.stringify(secret), key), [V.JSON_NOTE_FIELD]: V.JSON_NOTE };
	atomicWrite(filePath, JSON.stringify(out, null, 2), mode);
	return true;
}

/**
 * Unseal file contents for export (backup): a sealed file becomes the plain
 * form it had before sealing, anything else is returned unchanged. A sealed
 * file that cannot be opened (no key) is returned unchanged too.
 *
 * @param raw - File contents
 * @returns Plain contents and whether they were unsealed
 */
export function unsealForExport(raw: Buffer): { data: Buffer; unsealed: boolean } {
	const key = getVaultKey({ create: false });
	if (!key) return { data: raw, unsealed: false };
	try {
		if (isSealedText(raw)) {
			const inner = unsealString(raw.toString('utf8').slice(V.TEXT_PREFIX.length), key);
			return { data: Buffer.from(inner, 'base64'), unsealed: true };
		}
		const text = raw.toString('utf8');
		if (!text.includes(`"${V.JSON_FIELD}"`)) return { data: raw, unsealed: false };
		const parsed = JSON.parse(text) as unknown;
		if (!isSealedJson(parsed)) return { data: raw, unsealed: false };
		const secret = JSON.parse(unsealString(parsed[V.JSON_FIELD], key)) as Record<string, unknown>;
		const { [V.JSON_FIELD]: _s, [V.JSON_NOTE_FIELD]: _n, ...publicFields } = parsed;
		return { data: Buffer.from(JSON.stringify({ ...publicFields, ...secret }, null, 2), 'utf8'), unsealed: true };
	} catch {
		return { data: raw, unsealed: false };
	}
}

/**
 * {@link readSecretJson} with a fallback for the cases a caller treats as
 * "nothing stored": a missing file, a sealed file that cannot be opened right
 * now, or a file that is not JSON. `onProblem` hears about the last two.
 *
 * @param filePath - File
 * @param fallback - Value when there is nothing usable
 * @param onProblem - Told why the file could not be used (never the contents)
 * @returns The object or the fallback
 */
export function readSecretJsonOr<T>(filePath: string, fallback: T, onProblem?: (message: string) => void): T {
	try {
		const res = readSecretJson<T>(filePath);
		if (res.status === 'ok') return res.value;
		if (res.status === 'locked') onProblem?.(res.message);
		return fallback;
	} catch (err) {
		onProblem?.(`${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
		return fallback;
	}
}

/** A sealed credential file whose vault key cannot be read right now. */
export class CredentialVaultLockedError extends Error {
	/** Error code. */
	readonly code = 'CREDENTIAL_VAULT_LOCKED';

	/** @param message - Why */
	constructor(message: string) {
		super(message);
		this.name = 'CredentialVaultLockedError';
	}
}

/**
 * The object to write for a JSON credential file, for callers that keep
 * their own atomic write (atomicWriteJson): public fields in clear, the rest
 * sealed — or `value` unchanged when no vault key can be had.
 *
 * @param value - Full object
 * @param publicFields - Top-level fields that are not secret
 * @returns Object to serialise
 */
export function sealJsonForWrite<T extends object>(value: T, publicFields: readonly string[] = []): Record<string, unknown> {
	const key = getVaultKey({ create: true });
	if (!key) return { ...(value as Record<string, unknown>) };
	const pub: Record<string, unknown> = {};
	const secret: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (publicFields.includes(k)) pub[k] = v;
		else secret[k] = v;
	}
	return { ...pub, [V.JSON_FIELD]: sealString(JSON.stringify(secret), key), [V.JSON_NOTE_FIELD]: V.JSON_NOTE };
}

/**
 * Open a parsed JSON credential file, for callers that keep their own read
 * (safeReadJson). A plain value is returned unchanged.
 *
 * @param parsed - Parsed file contents
 * @returns The full object
 * @throws CredentialVaultLockedError when it is sealed and cannot be opened now
 */
export function openSealedJson<T>(parsed: T): T {
	if (!isSealedJson(parsed)) return parsed;
	const key = getVaultKey({ create: false });
	if (!key) throw new CredentialVaultLockedError(getVaultKeyUnavailableReason() ?? 'vault key unavailable');
	try {
		const secret = JSON.parse(unsealString(parsed[V.JSON_FIELD], key)) as Record<string, unknown>;
		const { [V.JSON_FIELD]: _s, [V.JSON_NOTE_FIELD]: _n, ...publicFields } = parsed;
		return { ...publicFields, ...secret } as T;
	} catch (err) {
		throw new CredentialVaultLockedError(`could not unseal: ${err instanceof Error ? err.message : String(err)}`);
	}
}
