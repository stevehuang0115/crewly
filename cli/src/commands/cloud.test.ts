/**
 * Tests for the CLI cloud command group.
 *
 * Validates login (direct token + OAuth flow), status display,
 * logout, and error handling for all three subcommands.
 */



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

const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
const mockIsAxiosError = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (...args: any[]) => mockAxiosPost(...args),
    get: (...args: any[]) => mockAxiosGet(...args),
    isAxiosError: (e: any) => mockIsAxiosError(e),
  },
}));

const mockExec = jest.fn();
jest.mock('child_process', () => ({
  exec: (...args: any[]) => mockExec(...args),
}));

const mockExistsSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockReadFileSync = jest.fn();

jest.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
}));

jest.mock('http', async () => {
  const actualHttp = await jest.requireActual('http') as any;
  return {
    ...actualHttp,
    createServer: jest.fn(),
  };
});

const mockRlQuestion = jest.fn();
const mockRlClose = jest.fn();

jest.mock('readline', () => {
  const mockCreateInterface = jest.fn(() => ({
    question: mockRlQuestion,
    close: mockRlClose,
  }));
  return {
    default: { createInterface: mockCreateInterface },
    createInterface: mockCreateInterface,
  };
});

import { join } from 'path';
import {
  loginCommand,
  getCloudConfigFile,
  type LoginDeps,
  statusCommand,
  logoutCommand,
  saveCloudCredentials,
  loadCloudCredentials,
  openBrowser,
  canOpenBrowser,
  promptForToken,
} from './cloud.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let consoleLogSpy: ReturnType<typeof jest.spyOn>;
let processExitSpy: ReturnType<typeof jest.spyOn>;

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

    // $CREWLY_HOME/cloud — the jest setup points CREWLY_HOME at a temp dir,
    // so this also proves the real ~/.crewly is never touched.
    expect(mockMkdirSync).toHaveBeenCalledWith(
      join(process.env.CREWLY_HOME as string, 'cloud'),
      { recursive: true },
    );
    expect(mockWriteFileSync.mock.calls[0][0]).toBe(join(process.env.CREWLY_HOME as string, 'cloud', 'config.json'));
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(written.token).toBe('tok-123');
    expect(written.refreshToken).toBe('ref-456');
    expect(written.connectedAt).toBeDefined();
    expect(written.cloudUrl).toBeDefined();
    expect(written.tier).toBeDefined();
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

  it('shows warning on connect failure response but saves credentials', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: false, error: 'invalid token' },
    });

    await loginCommand({ token: 'bad-token' });

    const output = getOutput();
    expect(output).toContain('invalid token');
    // Credentials are still saved for retry on next start
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('saves credentials even when backend is not running (ECONNREFUSED)', async () => {
    const axiosErr = new Error('ECONNREFUSED');
    (axiosErr as any).code = 'ECONNREFUSED';
    mockAxiosPost.mockRejectedValue(axiosErr);
    mockIsAxiosError.mockReturnValue(true);

    await loginCommand({ token: 'tok' });

    const output = getOutput();
    expect(output).toContain('Credentials saved');
    expect(output).toContain('next crewly start');
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('saves credentials on server error and shows warning', async () => {
    const axiosErr = new Error('Request failed');
    (axiosErr as any).response = {
      data: { error: 'unauthorized' },
      statusText: 'Unauthorized',
    };
    mockAxiosPost.mockRejectedValue(axiosErr);
    mockIsAxiosError.mockReturnValue(true);

    await loginCommand({ token: 'tok' });

    const output = getOutput();
    expect(output).toContain('Credentials saved');
    expect(mockWriteFileSync).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// loginCommand — no-browser (mobile) flow
// ---------------------------------------------------------------------------

describe('loginCommand — --paste (copy-paste) flow', () => {
  it('prints a login URL and connects with pasted token', async () => {
    // Simulate user pasting a token
    mockRlQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => cb('pasted-token-123'));

    mockAxiosPost.mockResolvedValue({
      data: { success: true, data: { tier: 'pro' } },
    });

    await loginCommand({ paste: true });

    const output = getOutput();
    // Should show the OAuth URL with cli-token redirect
    expect(output).toContain('Mobile');
    expect(output).toContain('Open this URL');
    expect(output).toContain('/api/cloud/google/start');
    expect(output).toContain('cli-token');

    // Should connect with pasted token
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [url, body] = mockAxiosPost.mock.calls[0] as any[];
    expect(url).toContain('/api/cloud/connect');
    expect(body.token).toBe('pasted-token-123');
  });

  it('asks for the refresh token too and stores it (an access token alone expires within the hour)', async () => {
    const answers = ['pasted-token-123', 'pasted-refresh-456'];
    mockRlQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => cb(answers.shift() ?? ''));
    mockAxiosPost.mockResolvedValue({ data: { success: true, data: { tier: 'pro' } } });

    await loginCommand({ paste: true });

    const prompts = mockRlQuestion.mock.calls.map((c) => String(c[0]));
    expect(prompts[1]).toContain('refresh token');
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(written.token).toBe('pasted-token-123');
    expect(written.refreshToken).toBe('pasted-refresh-456');
    expect(getOutput()).not.toContain('No refresh token');
  });

  it('warns when the refresh token is skipped', async () => {
    const answers = ['pasted-token-123', ''];
    mockRlQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => cb(answers.shift() ?? ''));
    mockAxiosPost.mockResolvedValue({ data: { success: true, data: { tier: 'pro' } } });
    await loginCommand({ paste: true });
    expect(getOutput()).toContain('No refresh token');
  });

  it('exits when no token is pasted', async () => {
    mockRlQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => cb(''));

    await expect(loginCommand({ paste: true })).rejects.toThrow('process.exit');

    const output = getOutput();
    expect(output).toContain('No token provided');
  });

  it('saves credentials even when backend is down', async () => {
    mockRlQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => cb('offline-token'));

    const axiosErr = new Error('ECONNREFUSED');
    (axiosErr as any).code = 'ECONNREFUSED';
    mockAxiosPost.mockRejectedValue(axiosErr);
    mockIsAxiosError.mockReturnValue(true);

    await loginCommand({ paste: true });

    const output = getOutput();
    expect(output).toContain('Credentials saved');
    expect(mockWriteFileSync).toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// loginCommand — device pairing (default)
// ---------------------------------------------------------------------------

describe('loginCommand — device pairing (default)', () => {
  const started = {
    deviceCode: 'device-secret',
    userCode: 'ABCD-2345',
    verificationUrl: 'https://crewlyai.com/cloud/pair?code=ABCD-2345',
    verificationUri: 'https://crewlyai.com/cloud/pair',
    expiresIn: 900,
    interval: 5,
  };

  function deps(outcome: Awaited<ReturnType<LoginDeps['waitForApproval']>>): LoginDeps & { startPairing: jest.Mock; waitForApproval: jest.Mock } {
    return {
      startPairing: jest.fn().mockResolvedValue(started),
      waitForApproval: jest.fn().mockResolvedValue(outcome),
    };
  }

  it('prints the link and code, waits, then saves and connects with the approved tokens', async () => {
    mockAxiosPost.mockResolvedValue({ data: { success: true, data: { tier: 'solo' } } });
    const d = deps({ status: 'approved', credentials: { token: 'access-x', refreshToken: 'refresh-x', tier: 'solo', email: 'o@example.test' } });

    await loginCommand({ browser: false }, d);

    expect(d.startPairing).toHaveBeenCalledWith(expect.stringMatching(/^https?:\/\//), expect.objectContaining({ purpose: 'cli', deviceName: expect.any(String) }));
    expect(d.waitForApproval).toHaveBeenCalledWith(expect.objectContaining({ start: started }));
    const output = getOutput();
    expect(output).toContain('https://crewlyai.com/cloud/pair?code=ABCD-2345');
    expect(output).toContain('ABCD-2345');
    expect(output).toContain('Waiting for approval');
    expect(output).not.toContain('device-secret');
    expect(output).not.toContain('access-x');
    // --no-browser: nothing opened locally
    expect(mockExec).not.toHaveBeenCalled();

    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(written).toMatchObject({ token: 'access-x', refreshToken: 'refresh-x' });
    expect(mockWriteFileSync.mock.calls[0][0]).toBe(getCloudConfigFile());
    const [url, body] = mockAxiosPost.mock.calls[0] as any[];
    expect(url).toContain('/api/cloud/connect');
    expect(body).toEqual({ token: 'access-x', refreshToken: 'refresh-x' });
    expect(output).toContain('Connected to CrewlyAI Cloud');
  });

  it.each([
    ['denied', 'denied'],
    ['expired', 'expired'],
    ['cancelled', 'cancelled'],
  ] as const)('exits with a message when the pairing is %s', async (status, text) => {
    await expect(loginCommand({ browser: false }, deps({ status }))).rejects.toThrow('process.exit');
    expect(getOutput()).toContain(text);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('exits and points at the other flows when the Cloud refuses to start', async () => {
    const d = deps({ status: 'expired' });
    d.startPairing.mockRejectedValue(new Error('Too many pairing requests'));
    await expect(loginCommand({ browser: false }, d)).rejects.toThrow('process.exit');
    expect(getOutput()).toContain('Too many pairing requests');
    expect(getOutput()).toContain('--paste');
  });

  it('exits when polling fails for good', async () => {
    const d = deps({ status: 'expired' });
    d.waitForApproval.mockRejectedValue(new Error('Crewly Cloud unreachable'));
    await expect(loginCommand({ browser: false }, d)).rejects.toThrow('process.exit');
    expect(getOutput()).toContain('Crewly Cloud unreachable');
  });

  it('--web refuses to run without a browser', async () => {
    await expect(loginCommand({ web: true, browser: false })).rejects.toThrow('process.exit');
    expect(getOutput()).toContain('--web needs a browser');
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

// ---------------------------------------------------------------------------
// canOpenBrowser
// ---------------------------------------------------------------------------

describe('canOpenBrowser', () => {
  const envBackup: Record<string, string | undefined> = {};
  const envKeys = ['SSH_CLIENT', 'SSH_TTY', 'SSH_CONNECTION', 'CI', 'GITHUB_ACTIONS', 'JENKINS_URL', 'DISPLAY', 'WAYLAND_DISPLAY'];

  beforeEach(() => {
    for (const key of envKeys) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (envBackup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envBackup[key];
      }
    }
  });

  it('returns false when SSH_CLIENT is set', () => {
    process.env['SSH_CLIENT'] = '192.168.1.1 12345 22';
    expect(canOpenBrowser()).toBe(false);
  });

  it('returns false when SSH_TTY is set', () => {
    process.env['SSH_TTY'] = '/dev/pts/0';
    expect(canOpenBrowser()).toBe(false);
  });

  it('returns false when CI is set', () => {
    process.env['CI'] = 'true';
    expect(canOpenBrowser()).toBe(false);
  });

  it('returns true when no headless indicators are present and display is available', () => {
    // Ensure DISPLAY is set so Linux check passes too
    process.env['DISPLAY'] = ':0';
    // Override the global mockExistsSync so /.dockerenv returns false
    mockExistsSync.mockImplementation((p: string) => !p.includes('.dockerenv'));
    expect(canOpenBrowser()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loginCommand — auto-detection fallback
// ---------------------------------------------------------------------------

describe('loginCommand — auto-detection headless fallback', () => {
  const origSSH = process.env['SSH_CLIENT'];

  afterEach(() => {
    if (origSSH === undefined) {
      delete process.env['SSH_CLIENT'];
    } else {
      process.env['SSH_CLIENT'] = origSSH;
    }
  });

  it('over SSH the default device flow just prints the link (no local browser, no paste)', async () => {
    process.env['SSH_CLIENT'] = '192.168.1.1 12345 22';
    mockAxiosPost.mockResolvedValue({ data: { success: true, data: { tier: 'pro' } } });
    const d: LoginDeps = {
      startPairing: jest.fn().mockResolvedValue({
        deviceCode: 'dc',
        userCode: 'WXYZ-6789',
        verificationUrl: 'https://crewlyai.com/cloud/pair?code=WXYZ-6789',
        expiresIn: 900,
        interval: 5,
      }),
      waitForApproval: jest.fn().mockResolvedValue({ status: 'approved', credentials: { token: 'ssh-token', refreshToken: 'ssh-refresh', tier: 'pro' } }),
    };

    // Empty options (no --no-browser flag): headless is detected, nothing is opened.
    await loginCommand({}, d);

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockRlQuestion).not.toHaveBeenCalled();
    expect(getOutput()).toContain('https://crewlyai.com/cloud/pair?code=WXYZ-6789');
    const [, body] = mockAxiosPost.mock.calls[0] as any[];
    expect(body.token).toBe('ssh-token');
  });
});
