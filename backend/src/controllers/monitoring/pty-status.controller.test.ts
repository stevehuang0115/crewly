/**
 * PTY Status Controller Tests
 *
 * @module controllers/monitoring/pty-status.controller.test
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// Mock session backend (must be before import)
const mockListSessions = jest.fn<() => string[]>();
const mockGetSession = jest.fn<(name: string) => { pid?: number; cwd?: string } | undefined>();

jest.mock('../../services/session/index.js', () => ({
  getSessionBackend: jest.fn(async () => ({
    listSessions: mockListSessions,
    getSession: mockGetSession,
  })),
}));

// Mock session state persistence
const mockGetSessionMetadata = jest.fn<(name: string) => { role?: string } | undefined>();

jest.mock('../../services/session/session-state-persistence.js', () => ({
  getSessionStatePersistence: jest.fn(() => ({
    getSessionMetadata: mockGetSessionMetadata,
  })),
}));

import { getPtyStatus } from './pty-status.controller.js';

describe('getPtyStatus', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {};
    res = {
      json: jest.fn() as any,
      status: jest.fn(() => res) as any,
    };
    next = jest.fn() as NextFunction;
  });

  it('should return empty array when no sessions exist', async () => {
    mockListSessions.mockReturnValue([]);

    await getPtyStatus(req as Request, res as Response, next);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [],
    });
  });

  it('should return PTY status entries for active sessions', async () => {
    mockListSessions.mockReturnValue(['crewly-product-sam-member-tl']);
    mockGetSession.mockReturnValue({ pid: 4821, cwd: '/tmp' });
    mockGetSessionMetadata.mockReturnValue({ role: 'team-leader' });

    await getPtyStatus(req as Request, res as Response, next);

    const result = (res.json as jest.Mock).mock.calls[0][0] as any;
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      sessionName: 'crewly-product-sam-member-tl',
      agentName: 'Sam',
      role: 'team-leader',
      agentStatus: 'active',
      ptyPid: 4821,
      fsScope: 'sandboxed',
      netScope: 'localhost',
    });
  });

  it('should handle sessions without PID as inactive', async () => {
    mockListSessions.mockReturnValue(['agent-test']);
    mockGetSession.mockReturnValue(undefined);
    mockGetSessionMetadata.mockReturnValue(undefined);

    await getPtyStatus(req as Request, res as Response, next);

    const result = (res.json as jest.Mock).mock.calls[0][0] as any;
    expect(result.data[0].agentStatus).toBe('inactive');
    expect(result.data[0].ptyPid).toBeNull();
    expect(result.data[0].role).toBe('agent');
  });

  it('should derive agent name from session name', async () => {
    mockListSessions.mockReturnValue(['crewly-product-leo-member-dev']);
    mockGetSession.mockReturnValue({ pid: 100 });
    mockGetSessionMetadata.mockReturnValue({});

    await getPtyStatus(req as Request, res as Response, next);

    const result = (res.json as jest.Mock).mock.calls[0][0] as any;
    expect(result.data[0].agentName).toBe('Leo');
  });

  it('should return multiple sessions', async () => {
    mockListSessions.mockReturnValue(['crewly-product-sam-member-tl', 'crewly-product-leo-member-dev']);
    mockGetSession.mockImplementation((name: string) =>
      name.includes('sam') ? { pid: 201 } : { pid: 202 }
    );
    mockGetSessionMetadata.mockReturnValue({});

    await getPtyStatus(req as Request, res as Response, next);

    const result = (res.json as jest.Mock).mock.calls[0][0] as any;
    expect(result.data).toHaveLength(2);
  });

  it('should call next on error', async () => {
    const { getSessionBackend } = await import('../../services/session/index.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (getSessionBackend as any).mockRejectedValueOnce(new Error('Backend unavailable'));

    await getPtyStatus(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });
});
