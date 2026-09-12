/**
 * Tests for the browser services registry — the synchronous, ESM-safe way
 * the bridge and the proxy reach each other's singleton.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  registerProxyAccessor,
  registerBridgeAccessor,
  getRegisteredProxy,
  getRegisteredBridge,
  resetBrowserServicesRegistryForTests,
} from './browser-services.registry.js';
import type { BrowserBridgeService } from './browser-bridge.service.js';
import type { BrowserProxyService } from './browser-proxy.service.js';

describe('browser-services.registry', () => {
  beforeEach(() => {
    resetBrowserServicesRegistryForTests();
  });

  // The old `require()` resolver returned null when it failed; callers were
  // written against that, so "nothing registered" must read the same way.
  it('returns null for both sides before anything registers', () => {
    expect(getRegisteredProxy()).toBeNull();
    expect(getRegisteredBridge()).toBeNull();
  });

  it('returns whatever the registered accessor returns', () => {
    const proxy = { isAvailable: () => true } as unknown as BrowserProxyService;
    const bridge = { handleTabRemoved: () => undefined } as unknown as BrowserBridgeService;
    registerProxyAccessor(() => proxy);
    registerBridgeAccessor(() => bridge);

    expect(getRegisteredProxy()).toBe(proxy);
    expect(getRegisteredBridge()).toBe(bridge);
  });

  // Accessors, not instances: a service that resets its singleton must not
  // leave the other side holding the old object.
  it('reads through the accessor on every call, so a replaced singleton is seen', () => {
    let current = { id: 1 } as unknown as BrowserProxyService;
    registerProxyAccessor(() => current);
    expect(getRegisteredProxy()).toBe(current);

    current = { id: 2 } as unknown as BrowserProxyService;
    expect(getRegisteredProxy()).toBe(current);
  });

  it('lets a later registration replace an earlier one', () => {
    const first = { id: 'a' } as unknown as BrowserBridgeService;
    const second = { id: 'b' } as unknown as BrowserBridgeService;
    registerBridgeAccessor(() => first);
    registerBridgeAccessor(() => second);

    expect(getRegisteredBridge()).toBe(second);
  });

  it('resetForTests clears both sides', () => {
    registerProxyAccessor(() => ({}) as unknown as BrowserProxyService);
    registerBridgeAccessor(() => ({}) as unknown as BrowserBridgeService);

    resetBrowserServicesRegistryForTests();

    expect(getRegisteredProxy()).toBeNull();
    expect(getRegisteredBridge()).toBeNull();
  });

  // Guard against the bug this module exists to fix. The bridge and the proxy
  // used to reach each other with a bare `require()`, which throws in the ESM
  // build and was swallowed into a silent null — jest (CJS) and tsx never
  // noticed. Both must now go through the registry.
  it('neither browser service resolves its peer with a bare require()', () => {
    // __dirname: ts-jest runs CJS (import.meta.url is TS1470 there).
    const here = __dirname;
    for (const file of ['browser-bridge.service.ts', 'browser-proxy.service.ts']) {
      const src = readFileSync(join(here, file), 'utf8');
      const bareRequireCalls = src
        .split('\n')
        .filter((line) => /\brequire\(/.test(line) && !/^\s*(\/\/|\*)/.test(line));
      expect({ file, bareRequireCalls }).toEqual({ file, bareRequireCalls: [] });
    }
  });
});
