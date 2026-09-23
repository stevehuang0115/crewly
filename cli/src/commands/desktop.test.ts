/**
 * Tests for `crewly desktop remote`.
 */

jest.mock('chalk', () => {
  const id = (s: string) => s;
  return { __esModule: true, default: { red: id, green: id, yellow: id } };
});

import { desktopCommand } from './desktop.js';

describe('desktopCommand', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as unknown as Response;

  it('switches remote control on through the local backend', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply({ success: true, data: { enabled: true } }));
    expect(await desktopCommand('remote', 'on', fetchImpl)).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/desktop\/remote$/);
    expect(init).toMatchObject({ method: 'PUT', body: JSON.stringify({ enabled: true }) });
  });

  it('reports status without changing anything', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply({ success: true, data: { enabled: false } }));
    expect(await desktopCommand('remote', 'status', fetchImpl)).toBe(0);
    expect(fetchImpl.mock.calls[0][1]).toBeUndefined();
  });

  it('rejects anything else, and says so when Crewly is not running', async () => {
    expect(await desktopCommand('screen', 'on', jest.fn())).toBe(1);
    expect(await desktopCommand('remote', 'maybe', jest.fn())).toBe(1);
    expect(await desktopCommand('remote', 'on', jest.fn().mockRejectedValue(new Error('ECONNREFUSED')))).toBe(1);
  });
});
