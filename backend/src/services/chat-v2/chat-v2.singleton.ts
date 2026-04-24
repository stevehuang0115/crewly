/**
 * Process-wide singleton accessor for `ChatV2Service`.
 *
 * The server wiring layer calls `getChatV2Service()` once and holds the
 * reference; tests can `resetChatV2Service()` to start fresh.
 *
 * @module services/chat-v2/chat-v2.singleton
 */

import { ChatV2Service, type ChatV2ServiceOptions } from './chat-v2.service.js';
import { loadChatV2Config } from './config.js';

let _instance: ChatV2Service | null = null;

/**
 * Return the process-wide `ChatV2Service`, constructing it on first call.
 *
 * @param overrides - Optional overrides passed when first constructed.
 *   Ignored on subsequent calls.
 * @returns The shared service instance
 */
export function getChatV2Service(overrides?: Partial<ChatV2ServiceOptions>): ChatV2Service {
  if (!_instance) {
    const config = overrides?.config ?? loadChatV2Config();
    _instance = new ChatV2Service({
      config,
      db: overrides?.db,
      getPresence: overrides?.getPresence,
      now: overrides?.now,
    });
  }
  return _instance;
}

/**
 * Replace the process-wide instance. Intended for tests and graceful
 * shutdown paths; do not call from request handlers.
 *
 * @param next - Optional replacement; when omitted, the singleton is cleared
 */
export function setChatV2ServiceForTesting(next: ChatV2Service | null): void {
  if (_instance && _instance !== next) {
    try {
      _instance.close();
    } catch {
      // ignore — already closed
    }
  }
  _instance = next;
}

/** Close the current instance (if any) and clear the singleton. */
export function resetChatV2Service(): void {
  setChatV2ServiceForTesting(null);
}
