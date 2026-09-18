/**
 * Tests for the network exposure helpers.
 *
 * @module utils/network-exposure.utils.test
 */

import {
  isHeadlessEnvironment,
  isLoopbackBindHost,
  describeNetworkExposure,
  type NetworkExposureInput,
} from './network-exposure.utils.js';

describe('isHeadlessEnvironment', () => {
  it('honours CREWLY_HEADLESS on any platform', () => {
    expect(isHeadlessEnvironment({ CREWLY_HEADLESS: '1' }, 'darwin')).toBe(true);
    expect(isHeadlessEnvironment({ CREWLY_HEADLESS: 'true' }, 'win32')).toBe(true);
    expect(isHeadlessEnvironment({ CREWLY_HEADLESS: '0' }, 'darwin')).toBe(false);
  });

  it('treats darwin and win32 as having a display', () => {
    expect(isHeadlessEnvironment({}, 'darwin')).toBe(false);
    expect(isHeadlessEnvironment({}, 'win32')).toBe(false);
  });

  it('uses DISPLAY / WAYLAND_DISPLAY on linux', () => {
    expect(isHeadlessEnvironment({}, 'linux')).toBe(true);
    expect(isHeadlessEnvironment({ DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(isHeadlessEnvironment({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(false);
  });

  it('assumes headless on unknown platforms', () => {
    expect(isHeadlessEnvironment({}, 'freebsd')).toBe(true);
  });
});

describe('isLoopbackBindHost', () => {
  it.each(['127.0.0.1', '::1', 'localhost'])('%s is loopback', (h) => {
    expect(isLoopbackBindHost(h)).toBe(true);
  });
  it.each(['0.0.0.0', '::', '192.168.1.5'])('%s is not loopback', (h) => {
    expect(isLoopbackBindHost(h)).toBe(false);
  });
});

describe('describeNetworkExposure', () => {
  const base: NetworkExposureInput = {
    bindHost: '0.0.0.0',
    port: 8787,
    bindHostExplicit: false,
    tokenSource: 'generated',
    tokenFilePath: '/home/x/.crewly/api-token',
    headless: true,
  };

  it('warns for a headless install with defaults (unset bind host, generated token)', () => {
    const out = describeNetworkExposure(base);
    expect(out.level).toBe('warn');
    expect(out.message).toContain('reachable from the network');
    expect(out.message).toContain('CREWLY_BIND_HOST=127.0.0.1');
    expect(out.message).toContain('CREWLY_API_TOKEN');
    expect(out.message).toContain('crewly token');
    expect(out.details).toMatchObject({ bindHost: '0.0.0.0', port: 8787, loopbackOnly: false, tokenSource: 'generated' });
  });

  it('does not warn on a laptop (not headless)', () => {
    expect(describeNetworkExposure({ ...base, headless: false }).level).toBe('info');
  });

  it('does not warn when the bind host was set explicitly', () => {
    expect(describeNetworkExposure({ ...base, bindHostExplicit: true }).level).toBe('info');
  });

  it('does not warn when the token is pinned via env', () => {
    const out = describeNetworkExposure({ ...base, tokenSource: 'env' });
    expect(out.level).toBe('info');
    expect(out.message).toContain('token from CREWLY_API_TOKEN');
  });

  it('reports loopback-only binds as info and names the bound host:port', () => {
    const out = describeNetworkExposure({ ...base, bindHost: '127.0.0.1', bindHostExplicit: true });
    expect(out.level).toBe('info');
    expect(out.message).toContain('127.0.0.1:8787');
    expect(out.details.loopbackOnly).toBe(true);
  });

  it('always states the loopback rule and the knobs in the details', () => {
    const details = describeNetworkExposure({ ...base, headless: false }).details;
    expect(String(details.rule)).toContain('loopback');
    expect(String(details.configure)).toContain('CREWLY_BIND_HOST');
    expect(String(details.configure)).toContain('CREWLY_API_TOKEN');
    expect(String(details.configure)).toContain('crewly token');
  });
});
