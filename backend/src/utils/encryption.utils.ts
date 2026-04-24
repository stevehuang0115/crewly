/**
 * Credential Encryption Utilities
 *
 * AES-256-GCM encryption with scrypt-derived keys for credential payloads.
 * Uses a per-install master.key file (mode 0600) as the base key material.
 *
 * File format:
 *   [1 byte: version=1] [12 bytes: IV] [16 bytes: auth tag] [N bytes: ciphertext]
 *
 * Threat model:
 * - Primary defense: file exfiltration via backup / cloud sync / screen capture
 * - NOT a defense against a compromised local user account or malicious code
 *   running as the user (both can read master.key and derive the same key)
 *
 * @module utils/encryption.utils
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/** File-format version byte — bump if layout changes. */
const FORMAT_VERSION = 1;
/** AES-256-GCM uses 12-byte (96-bit) IVs per NIST recommendation. */
const IV_LENGTH = 12;
/** AES-GCM produces 16-byte (128-bit) auth tags. */
const AUTH_TAG_LENGTH = 16;
/** AES-256 key size. */
const KEY_LENGTH = 32;
/** scrypt N (iteration count). 2^15 = 32768. */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/**
 * scrypt memory cap. Default in Node is 32MB which is right at the edge for
 * our parameters; give explicit headroom so derivation never fails.
 */
const SCRYPT_MAX_MEM = 128 * 1024 * 1024;
/** Fixed salt — changing invalidates all previously encrypted credentials. */
const SCRYPT_SALT = Buffer.from('crewly-credentials-v1', 'utf8');

/**
 * Module-level cache of derived keys, keyed by master.key path. scrypt is
 * intentionally expensive (~100ms per call), so we run it once per master
 * key path per process. Concurrent callers share the in-flight promise.
 */
const derivedKeyCache = new Map<string, Promise<Buffer>>();

/**
 * Derive the AES key from the master.key file contents via scrypt. Results
 * are cached by master-key path for the lifetime of the process.
 *
 * @param masterKeyPath - Absolute path to the master.key file
 * @returns A 32-byte derived key
 */
async function deriveKey(masterKeyPath: string): Promise<Buffer> {
  const cached = derivedKeyCache.get(masterKeyPath);
  if (cached) return cached;

  const promise = deriveKeyUncached(masterKeyPath).catch((err) => {
    // On failure, remove the rejected promise so the next call retries.
    derivedKeyCache.delete(masterKeyPath);
    throw err;
  });
  derivedKeyCache.set(masterKeyPath, promise);
  return promise;
}

async function deriveKeyUncached(masterKeyPath: string): Promise<Buffer> {
  const masterKey = await fs.readFile(masterKeyPath);
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      masterKey,
      SCRYPT_SALT,
      KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEM },
      (err, derivedKey) => (err ? reject(err) : resolve(derivedKey)),
    );
  });
}

/**
 * Clear the derived-key cache. Primarily for tests — production code should
 * not need this as master.key is assumed stable for the process lifetime.
 */
export function _resetDerivedKeyCache(): void {
  derivedKeyCache.clear();
}

/**
 * Ensure a master.key file exists at the given path. If absent, generate
 * a cryptographically random 32-byte key and write it with mode 0600.
 *
 * Idempotent: if the file already exists, does nothing.
 *
 * @param masterKeyPath - Absolute path to the master.key file
 */
export async function ensureMasterKey(masterKeyPath: string): Promise<void> {
  try {
    await fs.access(masterKeyPath);
    return;
  } catch {
    // File doesn't exist — create it.
  }
  await fs.mkdir(path.dirname(masterKeyPath), { recursive: true });
  const key = crypto.randomBytes(32);
  await fs.writeFile(masterKeyPath, key, { mode: 0o600 });
}

/**
 * Encrypt a UTF-8 string using AES-256-GCM.
 *
 * @param plaintext - The string to encrypt (caller typically JSON-serializes first)
 * @param masterKeyPath - Absolute path to the master.key file
 * @returns Buffer in the format `[version][iv][tag][ciphertext]`
 */
export async function encrypt(
  plaintext: string,
  masterKeyPath: string,
): Promise<Buffer> {
  const key = await deriveKey(masterKeyPath);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([
    Buffer.from([FORMAT_VERSION]),
    iv,
    authTag,
    ciphertext,
  ]);
}

/**
 * Decrypt a buffer produced by `encrypt()`.
 *
 * @param encrypted - Buffer in the `[version][iv][tag][ciphertext]` format
 * @param masterKeyPath - Absolute path to the master.key file
 * @returns The decrypted UTF-8 string
 * @throws Error if the buffer is malformed, the version is unsupported,
 *         or the auth tag does not match (tampering or wrong key)
 */
export async function decrypt(
  encrypted: Buffer,
  masterKeyPath: string,
): Promise<string> {
  if (encrypted.length < 1 + IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('Encrypted buffer is too short to be valid');
  }

  const version = encrypted[0];
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported encryption format version: ${version}`);
  }

  const iv = encrypted.subarray(1, 1 + IV_LENGTH);
  const authTag = encrypted.subarray(
    1 + IV_LENGTH,
    1 + IV_LENGTH + AUTH_TAG_LENGTH,
  );
  const ciphertext = encrypted.subarray(1 + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = await deriveKey(masterKeyPath);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/**
 * Default credentials directory: `~/.crewly/credentials/`.
 */
export function defaultCredentialsDir(): string {
  return path.join(os.homedir(), '.crewly', 'credentials');
}

/**
 * Default master.key path: `~/.crewly/credentials/master.key`.
 */
export function defaultMasterKeyPath(): string {
  return path.join(defaultCredentialsDir(), 'master.key');
}
