/**
 * Security Utilities Tests
 *
 * @module utils/security.test
 */

import { describe, it, expect } from 'vitest';
import {
  maskSensitiveData,
  segmentSensitiveData,
  JWT_REDACTED,
  PATH_REDACTED,
  API_KEY_REDACTED,
} from './security';

describe('maskSensitiveData', () => {
  // -------------------------------------------------------------------------
  // JWT tokens
  // -------------------------------------------------------------------------
  it('masks a standard JWT token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(maskSensitiveData(`Bearer ${jwt}`)).toBe(`Bearer ${JWT_REDACTED}`);
  });

  it('masks multiple JWT tokens in the same string', () => {
    const jwt1 = 'eyJhbGciOiJIUzI1NiJ9.eyJhIjoiMSIsInN1YiI6IjEyMyJ9.abc123def456ghi789';
    const jwt2 = 'eyJhbGciOiJSUzI1NiJ9.eyJiIjoiMiIsInN1YiI6IjQ1NiJ9.def456ghi789jkl012';
    const result = maskSensitiveData(`${jwt1} and ${jwt2}`);
    expect(result).toBe(`${JWT_REDACTED} and ${JWT_REDACTED}`);
  });

  it('does not mask text that looks like JWT but is not', () => {
    expect(maskSensitiveData('hello.world.foo')).toBe('hello.world.foo');
  });

  it('masks JWT with short (but valid) signature segments', () => {
    // Real JWTs can have shorter segments — ensure 4+ char segments are caught
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef1234';
    expect(maskSensitiveData(`token: ${jwt}`)).toBe(`token: ${JWT_REDACTED}`);
  });

  // -------------------------------------------------------------------------
  // File paths
  // -------------------------------------------------------------------------
  it('masks macOS /Users/ paths', () => {
    const result = maskSensitiveData('File at /Users/john/Desktop/secret.txt is ready');
    expect(result).toBe(`File at ${PATH_REDACTED} is ready`);
  });

  it('masks Linux /home/ paths', () => {
    const result = maskSensitiveData('Located at /home/deploy/.ssh/id_rsa');
    expect(result).toBe(`Located at ${PATH_REDACTED}`);
  });

  it('masks Windows paths', () => {
    const result = maskSensitiveData('Open C:\\Users\\admin\\secrets.txt now');
    expect(result).toBe(`Open ${PATH_REDACTED} now`);
  });

  it('masks multiple paths', () => {
    const result = maskSensitiveData('/Users/a/file and /home/b/file');
    expect(result).toBe(`${PATH_REDACTED} and ${PATH_REDACTED}`);
  });

  // -------------------------------------------------------------------------
  // API keys
  // -------------------------------------------------------------------------
  it('masks OpenAI-style API keys', () => {
    const key = 'sk-abc123def456ghi789jkl012mno';
    const result = maskSensitiveData(`Key: ${key}`);
    expect(result).toBe(`Key: ${API_KEY_REDACTED}`);
  });

  it('does not mask short sk- strings', () => {
    // Less than 20 chars after sk-
    expect(maskSensitiveData('sk-short')).toBe('sk-short');
  });

  // -------------------------------------------------------------------------
  // Mixed content
  // -------------------------------------------------------------------------
  it('masks JWT, path, and API key in the same string', () => {
    const text = 'Token eyJhbGciOiJIUzI1NiJ9.eyJhIjoiMSIsInN1YiI6IjEyMyJ9.abc123def456ghi789 at /Users/me/dir with sk-abcdefghijklmnopqrstuv';
    const result = maskSensitiveData(text);
    expect(result).toContain(JWT_REDACTED);
    expect(result).toContain(PATH_REDACTED);
    expect(result).toContain(API_KEY_REDACTED);
  });

  it('masks Anthropic API keys (sk-ant-)', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890';
    const result = maskSensitiveData(`Key: ${key}`);
    expect(result).toBe(`Key: ${API_KEY_REDACTED}`);
  });

  it('masks Google API keys (AIza)', () => {
    const key = 'AIzaSyDAbCdEfGhIjKlMnOpQrStUvWxYz012345';
    const result = maskSensitiveData(`Key: ${key}`);
    expect(result).toBe(`Key: ${API_KEY_REDACTED}`);
  });

  it('masks AWS access keys (AKIA)', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const result = maskSensitiveData(`Key: ${key}`);
    expect(result).toBe(`Key: ${API_KEY_REDACTED}`);
  });

  it('masks GitHub tokens (ghp_)', () => {
    const key = 'ghp_ABCDEFghijklmnopqrstuvwxyz0123456789';
    const result = maskSensitiveData(`Token: ${key}`);
    expect(result).toBe(`Token: ${API_KEY_REDACTED}`);
  });

  it('returns text unchanged when no sensitive data is present', () => {
    const clean = 'Hello world, this is a normal message.';
    expect(maskSensitiveData(clean)).toBe(clean);
  });

  it('handles empty string', () => {
    expect(maskSensitiveData('')).toBe('');
  });
});

describe('segmentSensitiveData', () => {
  it('returns a single text segment for clean input', () => {
    const segments = segmentSensitiveData('Hello world');
    expect(segments).toEqual([{ type: 'text', content: 'Hello world' }]);
  });

  it('splits text around a redacted JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJhIjoiMSIsInN1YiI6IjEyMyJ9.abc123def456ghi789';
    const segments = segmentSensitiveData(`before ${jwt} after`);

    expect(segments).toEqual([
      { type: 'text', content: 'before ' },
      { type: 'redacted', content: JWT_REDACTED },
      { type: 'text', content: ' after' },
    ]);
  });

  it('splits text around a redacted path', () => {
    const segments = segmentSensitiveData('file: /Users/test/file.txt end');
    expect(segments).toEqual([
      { type: 'text', content: 'file: ' },
      { type: 'redacted', content: PATH_REDACTED },
      { type: 'text', content: ' end' },
    ]);
  });

  it('handles multiple redacted segments', () => {
    const segments = segmentSensitiveData('a /Users/x/y b sk-abcdefghijklmnopqrstuv c');
    expect(segments.filter((s) => s.type === 'redacted')).toHaveLength(2);
    expect(segments.filter((s) => s.type === 'text')).toHaveLength(3);
  });

  it('handles empty string', () => {
    expect(segmentSensitiveData('')).toEqual([]);
  });
});
