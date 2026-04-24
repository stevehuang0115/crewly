import '@testing-library/jest-dom';
import { vi } from 'vitest';

/**
 * Shared vitest setup for @crewly/chat-ui tests.
 *
 * Mirrors the OSS frontend's setup so devs jumping between the two see
 * the same patterns. We intentionally keep mocks minimal — each test
 * mocks what it needs.
 */

// Ensure `fetch` exists in the jsdom env (some hooks rely on it even in
// tests that provide their own client).
if (typeof global.fetch === 'undefined') {
  global.fetch = vi.fn();
}

// Polyfill scrollIntoView for MessageThread's auto-scroll effect.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {
    /* no-op */
  };
}

// Stub WebSocket so HttpChatApiClient.subscribeToChannel doesn't blow up
// in tests that never override the ws impl.
if (typeof global.WebSocket === 'undefined') {
  class StubSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    OPEN = 1;
    CONNECTING = 0;
    readyState = 1;
    addEventListener(): void {
      /* no-op */
    }
    removeEventListener(): void {
      /* no-op */
    }
    close(): void {
      /* no-op */
    }
  }
  (global as unknown as { WebSocket: typeof StubSocket }).WebSocket = StubSocket;
}
