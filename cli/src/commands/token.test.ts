/**
 * Tests for the CLI token command.
 *
 * Validates that `crewly token` prints the same token the server resolves
 * (env → file → generated), that `--url` builds a dashboard deep link, and
 * the host selection fallback.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../constants.js', () => ({
  DEFAULT_WEB_PORT: 8787,
}));

jest.mock('chalk', () => ({
  __esModule: true,
  default: new Proxy({}, {
    get: () => {
      const fn = (s: string) => s;
      return new Proxy(fn, { get: () => fn, apply: (_t: unknown, _this: unknown, args: string[]) => args[0] });
    },
  }),
}));

import { tokenCommand, pickAdvertisedHost, buildDashboardUrl } from './token.js';
import { resetApiTokenCache } from '../../../backend/src/services/core/api-token.service.js';

describe('crewly token', () => {
  const originalEnv = { ...process.env };
  let tmpHome: string;
  let logSpy: jest.SpiedFunction<typeof console.log>;
  let errSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-cli-token-'));
    process.env.CREWLY_HOME = tmpHome;
    delete process.env.CREWLY_API_TOKEN;
    delete process.env.WEB_PORT;
    resetApiTokenCache();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetApiTokenCache();
    logSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('prints CREWLY_API_TOKEN when set', async () => {
    process.env.CREWLY_API_TOKEN = 'pinned';
    await tokenCommand();
    expect(logSpy).toHaveBeenCalledWith('pinned');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('prints the persisted token from <CREWLY_HOME>/api-token', async () => {
    fs.writeFileSync(path.join(tmpHome, 'api-token'), 'on-disk\n');
    await tokenCommand();
    expect(logSpy).toHaveBeenCalledWith('on-disk');
  });

  it('generates and persists a token on first use, telling the user on stderr', async () => {
    await tokenCommand();
    const printed = logSpy.mock.calls[0][0] as string;
    expect(printed).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(tmpHome, 'api-token'), 'utf8').trim()).toBe(printed);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('api-token'));
  });

  it('--url prints a dashboard deep link with ?token=', async () => {
    process.env.CREWLY_API_TOKEN = 'abc def';
    await tokenCommand({ url: true, host: '10.0.0.7', port: '9999' });
    expect(logSpy).toHaveBeenCalledWith('http://10.0.0.7:9999/?token=abc%20def');
  });

  it('--url falls back to WEB_PORT then the default port', async () => {
    process.env.CREWLY_API_TOKEN = 't';
    process.env.WEB_PORT = '8080';
    await tokenCommand({ url: true, host: 'h' });
    expect(logSpy).toHaveBeenCalledWith('http://h:8080/?token=t');

    logSpy.mockClear();
    delete process.env.WEB_PORT;
    await tokenCommand({ url: true, host: 'h' });
    expect(logSpy).toHaveBeenCalledWith('http://h:8787/?token=t');
  });

  it('pickAdvertisedHost prefers the first non-internal IPv4 and falls back to localhost', () => {
    const iface = (address: string, internal: boolean, family: 'IPv4' | 'IPv6'): os.NetworkInterfaceInfo =>
      ({ address, internal, family, netmask: '', mac: '', cidr: null } as unknown as os.NetworkInterfaceInfo);
    expect(
      pickAdvertisedHost({
        lo0: [iface('127.0.0.1', true, 'IPv4')],
        en0: [iface('fe80::1', false, 'IPv6'), iface('192.168.1.9', false, 'IPv4')],
      }),
    ).toBe('192.168.1.9');
    expect(pickAdvertisedHost({ lo0: [iface('127.0.0.1', true, 'IPv4')] })).toBe('localhost');
    expect(pickAdvertisedHost({})).toBe('localhost');
  });

  it('buildDashboardUrl URL-encodes the token', () => {
    expect(buildDashboardUrl('a&b', 'x', 1)).toBe('http://x:1/?token=a%26b');
  });
});
