/**
 * Tests for the shared chat-ui backend-resolution helpers.
 *
 * @module utils/chat-backend.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveChatMode, resolveBackendURL } from './chat-backend';

describe('resolveChatMode', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to "real" when VITE_CHAT_MODE is unset', () => {
    vi.stubEnv('VITE_CHAT_MODE', '');
    expect(resolveChatMode()).toBe('real');
  });

  it('returns "mock" only when explicitly set to "mock" (case-insensitive)', () => {
    vi.stubEnv('VITE_CHAT_MODE', 'MOCK');
    expect(resolveChatMode()).toBe('mock');
  });

  it('treats any non-"mock" value as "real"', () => {
    vi.stubEnv('VITE_CHAT_MODE', 'real');
    expect(resolveChatMode()).toBe('real');
    vi.stubEnv('VITE_CHAT_MODE', 'something-else');
    expect(resolveChatMode()).toBe('real');
  });
});

describe('resolveBackendURL', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to window.location.origin when no override is set', () => {
    vi.stubEnv('VITE_CHAT_BACKEND_URL', '');
    // jsdom default origin
    expect(resolveBackendURL()).toBe(window.location.origin);
  });

  it('prefers VITE_CHAT_BACKEND_URL over the window origin', () => {
    vi.stubEnv('VITE_CHAT_BACKEND_URL', 'https://chat.example.com');
    expect(resolveBackendURL()).toBe('https://chat.example.com');
  });

  it('strips trailing slashes from the override', () => {
    vi.stubEnv('VITE_CHAT_BACKEND_URL', 'https://chat.example.com///');
    expect(resolveBackendURL()).toBe('https://chat.example.com');
  });
});
