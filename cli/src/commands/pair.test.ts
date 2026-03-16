/**
 * Tests for the CLI pair command.
 *
 * Validates cloud pairing flow, disconnect, device listing,
 * error handling, and pairing code generation.
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

jest.mock('readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (answer: string) => void) => cb('test-secret'),
    close: jest.fn(),
  }),
}));

import { pairCommand, generatePairingCode } from './pair.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;
let processExitSpy: jest.SpiedFunction<typeof process.exit>;

beforeEach(() => {
  jest.clearAllMocks();
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as never);
  mockIsAxiosError.mockReturnValue(false);
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  processExitSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// generatePairingCode
// ---------------------------------------------------------------------------

describe('generatePairingCode', () => {
  it('returns a code in XXX-XXX format', () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[A-F0-9]{3}-[A-F0-9]{3}$/);
  });

  it('generates different codes on successive calls', () => {
    const codes = new Set(Array.from({ length: 10 }, () => generatePairingCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// pairCommand — no method specified
// ---------------------------------------------------------------------------

describe('pairCommand — no method specified', () => {
  it('exits with error when no --cloud flag is provided', async () => {
    await expect(pairCommand({})).rejects.toThrow('process.exit');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// pairCommand — --cloud (orchestrator flow)
// ---------------------------------------------------------------------------

describe('pairCommand — cloud orchestrator flow', () => {
  it('generates a pairing code and connects to backend', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: true, sessionId: 'sess-123' },
    });

    await pairCommand({ cloud: true, secret: 'my-secret' });

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [url, body] = (mockAxiosPost.mock.calls[0] as any[]);
    expect(url).toContain('/api/relay/connect');
    expect(body.role).toBe('orchestrator');
    expect(body.pairingCode).toMatch(/^[A-F0-9]{3}-[A-F0-9]{3}$/);
    expect(body.sharedSecret).toBe('my-secret');
  });

  it('displays session ID on successful connect', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: true, sessionId: 'sess-456' },
    });

    await pairCommand({ cloud: true, secret: 'my-secret' });

    const output = consoleLogSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(output).toContain('sess-456');
    expect(output).toContain('Connected to Cloud Relay');
  });
});

// ---------------------------------------------------------------------------
// pairCommand — --cloud --code (agent flow)
// ---------------------------------------------------------------------------

describe('pairCommand — cloud agent flow', () => {
  it('uses the provided code and connects as agent', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: true },
    });

    await pairCommand({ cloud: true, code: 'ABC-123', secret: 'shared' });

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [, body] = (mockAxiosPost.mock.calls[0] as any[]);
    expect(body.pairingCode).toBe('ABC-123');
    expect(body.role).toBe('agent');
    expect(body.sharedSecret).toBe('shared');
  });
});

// ---------------------------------------------------------------------------
// pairCommand — --cloud with role override
// ---------------------------------------------------------------------------

describe('pairCommand — role override', () => {
  it('uses the provided --role option', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: true },
    });

    await pairCommand({ cloud: true, code: 'ABC-123', role: 'orchestrator', secret: 'x' });

    const [, body] = (mockAxiosPost.mock.calls[0] as any[]);
    expect(body.role).toBe('orchestrator');
  });
});

// ---------------------------------------------------------------------------
// pairCommand — --cloud connect failure
// ---------------------------------------------------------------------------

describe('pairCommand — connect failure', () => {
  it('exits on unsuccessful API response', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: false, error: 'invalid token' },
    });

    await expect(
      pairCommand({ cloud: true, code: 'ABC-123', secret: 'x' }),
    ).rejects.toThrow('process.exit');

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('handles ECONNREFUSED (backend not running)', async () => {
    const axiosErr = new Error('ECONNREFUSED');
    (axiosErr as unknown as Record<string, unknown>).code = 'ECONNREFUSED';
    mockAxiosPost.mockRejectedValue(axiosErr);
    mockIsAxiosError.mockReturnValue(true);

    await expect(
      pairCommand({ cloud: true, code: 'ABC-123', secret: 'x' }),
    ).rejects.toThrow('process.exit');

    const output = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('not running');
  });

  it('handles server error responses', async () => {
    const axiosErr = new Error('Request failed');
    (axiosErr as unknown as Record<string, unknown>).response = {
      data: { error: 'unauthorized' },
      statusText: 'Unauthorized',
    };
    mockAxiosPost.mockRejectedValue(axiosErr);
    mockIsAxiosError.mockReturnValue(true);

    await expect(
      pairCommand({ cloud: true, code: 'ABC-123', secret: 'x' }),
    ).rejects.toThrow('process.exit');
  });
});

// ---------------------------------------------------------------------------
// pairCommand — --disconnect
// ---------------------------------------------------------------------------

describe('pairCommand — disconnect', () => {
  it('calls the disconnect endpoint', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: true },
    });

    await pairCommand({ disconnect: true });

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [url] = mockAxiosPost.mock.calls[0];
    expect(url).toContain('/api/relay/disconnect');
  });

  it('shows message when no active session', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: false },
    });

    await pairCommand({ disconnect: true });

    const output = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('No active relay session');
  });
});

// ---------------------------------------------------------------------------
// pairCommand — --devices
// ---------------------------------------------------------------------------

describe('pairCommand — devices', () => {
  it('lists paired devices', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        success: true,
        devices: [
          { sessionId: 's1', role: 'orchestrator', state: 'paired', registeredAt: '2026-01-01' },
        ],
      },
    });

    await pairCommand({ devices: true });

    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    const [url] = mockAxiosGet.mock.calls[0];
    expect(url).toContain('/api/relay/devices');

    const output = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('orchestrator');
  });

  it('shows message when no devices', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { success: true, devices: [] },
    });

    await pairCommand({ devices: true });

    const output = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('No devices currently paired');
  });
});

// ---------------------------------------------------------------------------
// pairCommand — prompts for secret when not provided
// ---------------------------------------------------------------------------

describe('pairCommand — secret prompt', () => {
  it('uses readline to prompt for secret when not given via option', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { success: true },
    });

    // readline mock returns 'test-secret'
    await pairCommand({ cloud: true, code: 'ABC-123' });

    const [, body] = (mockAxiosPost.mock.calls[0] as any[]);
    expect(body.sharedSecret).toBe('test-secret');
  });
});
