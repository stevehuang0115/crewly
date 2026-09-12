/**
 * Browser Services Registry
 *
 * BrowserBridgeService and BrowserProxyService need to reach each other, and
 * both need to do so synchronously — `isConnected()` and `getStatus()` are
 * sync, and the relay event handlers are called from a WebSocket callback.
 * A static import in either direction is a cycle, and the previous answer,
 * a local `require()`, only worked where `require` exists: under jest (CJS)
 * and under tsx from source. The shipped backend is built as ESM
 * (`"type": "module"`), where a bare `require` throws ReferenceError. Both
 * resolvers swallowed that, so in production the bridge could never see the
 * proxy: `/api/browser/bind` answered 503 NO_BROWSER_CLIENT with a browser
 * plainly registered on the relay, and `/status` reported
 * `relayAvailable:false` beside `drivable:true` from the very same proxy.
 *
 * Each service registers an accessor to its own singleton from
 * `getInstance()`. The other side reads it here. Accessors, not instances,
 * so a test that resets a singleton never leaves a stale object behind.
 * This module imports the service types only, which erase at build time —
 * there is no runtime edge back to either service, and so no cycle.
 *
 * @module services/browser/browser-services.registry
 */

import type { BrowserBridgeService } from './browser-bridge.service.js';
import type { BrowserProxyService } from './browser-proxy.service.js';

let proxyAccessor: (() => BrowserProxyService) | null = null;
let bridgeAccessor: (() => BrowserBridgeService) | null = null;

/**
 * Register how to reach the BrowserProxyService singleton.
 *
 * Idempotent; the proxy calls this from its own `getInstance()`.
 *
 * @param accessor - Returns the live proxy singleton
 */
export function registerProxyAccessor(accessor: () => BrowserProxyService): void {
  proxyAccessor = accessor;
}

/**
 * Register how to reach the BrowserBridgeService singleton.
 *
 * Idempotent; the bridge calls this from its own `getInstance()`.
 *
 * @param accessor - Returns the live bridge singleton
 */
export function registerBridgeAccessor(accessor: () => BrowserBridgeService): void {
  bridgeAccessor = accessor;
}

/**
 * The proxy singleton, or null when the proxy module has not been
 * initialised in this process (an install that never started it, or a test
 * that only loaded the bridge). Callers already handle null — it is the same
 * outcome the old `require()` produced when it failed, minus the silent
 * failure in production.
 *
 * @returns The proxy, or null
 */
export function getRegisteredProxy(): BrowserProxyService | null {
  return proxyAccessor ? proxyAccessor() : null;
}

/**
 * The bridge singleton, or null when the bridge has not been initialised.
 *
 * @returns The bridge, or null
 */
export function getRegisteredBridge(): BrowserBridgeService | null {
  return bridgeAccessor ? bridgeAccessor() : null;
}

/**
 * Forget both accessors. For tests that need a process with "no proxy
 * wired" after another test registered one.
 */
export function resetBrowserServicesRegistryForTests(): void {
  proxyAccessor = null;
  bridgeAccessor = null;
}
