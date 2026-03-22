/**
 * Tests for the CLI cloud command group.
 *
 * Validates login (direct token + OAuth flow), status display,
 * logout, and error handling for all three subcommands.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../constants.js', () => ({
  DEFAULT_WEB_PORT: 3000,
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

const mockAxiosPost = jest.fn<any>();
const mockAxiosGet = jest.fn<any>();
const mockIsAxiosError = jest.fn<any>();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (...args: any[]) => mockAxiosPost(...args),
    get: (...args: any[]) => mockAxiosGet(...args),
    isAxiosError: (e: any) => mockIsAxiosError(e),
  },
}));

const mockExec = jest.fn<any>();
jest.mock('child_process', () => ({
  exec: (...args: any[]) => mockExec(...args),
}));

const mockExistsSync = jest.fn<any>();
const mockMkdirSync = jest.fn<any>();
const mockWriteFileSync = jest.fn<any>();
const mockReadFileSync = jest.fn<any>();

jest.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
}));

jest.mock('http', () => {
  const actualHttp = jest.requireActual('http') as any;
  return {
    ...actualHttp,
    createServer: jest.fn(),
  };
});

import {
  loginCommand,
  statusCommand,
  logoutCommand,
  saveCloudCredentials,
  loadCloudCredentials,
  openBrowser,
} from './cloud.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
let processExitSpy: jest.SpiedFunction<typeof process.exit>;

beforeEach(() => {
  jest.clearAllMocks();
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as never);
  mockIsAxiosError.mockReturnValue(false);
  mockExistsSync.mockReturnValue(true);
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  processExitSpy.mockRestore();
});

/**
 * Helper to collect all console.log output as a single string.
 */
function getOutput(): string {
  return consoleLogSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
}

// ---------------------------------------------------------------------------
// saveCloudCredentials
// ---------------------------------------------------------------------------

describe('saveCloudCredentials', () => {
  it('creates directory and writes credentials when dir does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    saveCloudCredentials('tok-123', 'ref-456');

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.crewly/cloud'),
      { recursive: true },
    );
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(written.token).toBe('tok-123');
    expect(written.refreshToken).toBe('ref-456');
    expect(written.savedAt).toBeDefined();
  });

  it('skips mkdir when directory already exists', () => {
    mockExistsSync.mockReturnValue(true);

    saveCloudCredentials('tok-abc');

    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// loadCloudCredentials
// ---------------------------------------------------------------------------

describe('loadCloudCredentials', () => {
  it('returns parsed credentials from config file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      token: 'saved-tok',
      refreshToken: 'saved-ref',
      savedAt: '2026-01-01T00:00:00.000Z',
    }));

    const creds = loadCloudCredentials();
    expect(creds).not.toBeNull();
    expect(creds!.token).toBe('saved-tok');
    expect(creds!.refreshToken).toBe('saved-ref');
  });

  it('returns null when config file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const creds = loadCloudCredentials();
    expect(creds).toBeNull();
  });

  it('returns null when config file contains invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not-json');

    const creds = loadCloudCredentials();
    expect(creds).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// openBrowser
// ---------------------------------------------------------------------------

describe('openBrowser', () => {
  it('calls exec with a URL', () => {
    openBrowser('https://example.com');
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec.mock.calls[0][0]).toContain('https://example.com');
  });
});

// ---------------------------------------------------------------------------
// loginCommand — direct token
// ---------------------------------------------------------------------------

describe('loginCommand — direct token', () => {
  it('connects with provided token and shows tier', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: true, data: { tier: 'pro' } },
    });

    await loginCommand({ token: 'my-token' });

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [url, body] = mockAxiosPost.mock.calls[0] as any[];
    expect(url).toContain('/api/cloud/connect');
    expect(body.token).toBe('my-token');

    const output = getOutput();
    expect(output).toContain('Connected to CrewlyAI Cloud');
    expect(output).toContain('pro');
  });

  it('saves credentials on successful login', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: true, data: { tier: 'free' } },
    });

    await loginCommand({ token: 'save-me' });

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(written.token).toBe('save-me');
  });

  it('exits on connect failure response', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: false, error: 'invalid token' },
    });

    await expect(loginCommand({ token: 'bad-token' })).rejects.toThrow('process.exit');
    expect(processExitSpy).toHaveBeenCalledWith(1);

    const output = getOutput();
    expect(output).toContain('invalid token');
  });

  it('handles ECONNREFUSED (backend not running)', async () => {
    const axiosErr = new Error('ECONNREFUSED');
    (axiosErr as any).code = 'ECONNREFUSED';
    mockAxiosPost.mockRejectedValue(axiosErr);
    mockIsAxiosError.mockReturnValue(true);

    await expect(loginCommand({ token: 'tok' })).rejects.toThrow('process.exit');

    const output = getOutput();
    expect(output).toContain('not running');
  });

  it('handles server error responses', async () => {
    const axiosErr = new Error('Request failed');
    (axiosErr as any).response = {
      data: { error: 'unauthorized' },
      statusText: 'Unauthorized',
    };
    mockAxiosPost.mockRejectedValue(axiosErr);
    mockIsAxiosError.mockReturnValue(true);

    await expect(loginCommand({ token: 'tok' })).rejects.toThrow('process.exit');

    const output = getOutput();
    expect(output).toContain('unauthorized');
  });
});

// ---------------------------------------------------------------------------
// statusCommand
// ---------------------------------------------------------------------------

describe('statusCommand', () => {
  it('displays connected status in green context', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        success: true,
        data: {
          connectionStatus: 'connected',
          tier: 'pro',
          cloudUrl: 'https://cloud.crewlyai.com',
          lastSyncAt: '2026-03-22T00:00:00Z',
        },
      },
    });

    await statusCommand();

    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    const [url] = mockAxiosGet.mock.calls[0] as any[];
    expect(url).toContain('/api/cloud/status');

    const output = getOutput();
    expect(output).toContain('connected');
    expect(output).toContain('pro');
    expect(output).toContain('https://cloud.crewlyai.com');
    expect(output).toContain('2026-03-22T00:00:00Z');
  });

  it('displays token_expired status', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        success: true,
        data: {
          connectionStatus: 'token_expired',
          tier: 'free',
        },
      },
    });

    await statusCommand();

    const output = getOutput();
    expect(output).toContain('token_expired');
    expect(output).toContain('free');
  });

  it('displays disconnected status', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        success: true,
        data: {
          connectionStatus: 'disconnected',
        },
      },
    });

    await statusCommand();

    const output = getOutput();
    expect(output).toContain('disconnected');
  });

  it('shows fallback when data is empty', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { success: true, data: {} },
    });

    await statusCommand();

    const output = getOutput();
    expect(output).toContain('unknown');
    expect(output).toContain('none');
    expect(output).toContain('N/A');
    expect(output).toContain('never');
  });

  it('shows warning on unsuccessful response', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { success: false },
    });

    await statusCommand();

    const output = getOutput();
    expect(output).toContain('Could not retrieve cloud status');
  });

  it('handles ECONNREFUSED', async () => {
    const axiosErr = new Error('ECONNREFUSED');
    (axiosErr as any).code = 'ECONNREFUSED';
    mockAxiosGet.mockRejectedValue(axiosErr);
    mockIsAxiosError.mockReturnValue(true);

    await expect(statusCommand()).rejects.toThrow('process.exit');

    const output = getOutput();
    expect(output).toContain('not running');
  });
});

// ---------------------------------------------------------------------------
// logoutCommand
// ---------------------------------------------------------------------------

describe('logoutCommand', () => {
  it('calls disconnect endpoint and shows success', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: true },
    });

    await logoutCommand();

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [url] = mockAxiosPost.mock.calls[0] as any[];
    expect(url).toContain('/api/cloud/disconnect');

    const output = getOutput();
    expect(output).toContain('Disconnected from CrewlyAI Cloud');
  });

  it('shows message when no active session', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: false },
    });

    await logoutCommand();

    const output = getOutput();
    expect(output).toContain('No active cloud session');
  });

  it('handles ECONNREFUSED', async () => {
    const axiosErr = new Error('ECONNREFUSED');
    (axiosErr as any).code = 'ECONNREFUSED';
    mockAxiosPost.mockRejectedValue(axiosErr);
    mockIsAxiosError.mockReturnValue(true);

    await expect(logoutCommand()).rejects.toThrow('process.exit');

    const output = getOutput();
    expect(output).toContain('not running');
  });

  it('handles server error responses', async () => {
    const axiosErr = new Error('Request failed');
    (axiosErr as any).response = {
      data: { error: 'server error' },
      statusText: 'Internal Server Error',
    };
    mockAxiosPost.mockRejectedValue(axiosErr);
    mockIsAxiosError.mockReturnValue(true);

    await expect(logoutCommand()).rejects.toThrow('process.exit');

    const output = getOutput();
    expect(output).toContain('server error');
  });
});
