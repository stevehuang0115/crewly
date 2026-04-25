/**
 * Process-wide holder for chat-v2 realtime dependencies.
 *
 * The REST router is mounted during `configureRoutes()` — but the
 * WebSocket gateway + agent dispatcher are only available once the HTTP
 * server is up (in `start()`). Rather than reshuffling startup order,
 * the router reads deps from this holder at request time; `start()` sets
 * them after the gateway + dispatcher are ready.
 *
 * Tests can `setChatV2RealtimeDeps(null)` to clear between runs.
 *
 * @module services/chat-v2/chat-v2.realtime-holder
 */

import type { ChatV2Gateway } from '../../websocket/chat-v2.gateway.js';
import type { ChatV2DispatcherService } from './chat-v2.dispatcher.service.js';

/** Realtime deps lazily bound after HTTP server start. */
export interface ChatV2RealtimeDeps {
  gateway?: ChatV2Gateway;
  dispatcher?: ChatV2DispatcherService;
}

let _deps: ChatV2RealtimeDeps | null = null;

/** Set the live realtime deps. Call once after gateway/dispatcher init. */
export function setChatV2RealtimeDeps(deps: ChatV2RealtimeDeps | null): void {
  _deps = deps;
}

/** Retrieve the live realtime deps. Returns `{}` when unset. */
export function getChatV2RealtimeDeps(): ChatV2RealtimeDeps {
  return _deps ?? {};
}
