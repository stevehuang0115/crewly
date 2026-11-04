import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import { openProjectInFinder } from './project.controller.js';
import type { ApiContext } from '../types.js';

// Only what the open-in-Finder handler touches is real: path and util stay real so
// the argv the handler builds is exactly what would reach `open` (CREW-967).
jest.mock('../../services/index.js');
jest.mock('../../models/index.js');
jest.mock('../utils/file-utils.js');
jest.mock('fs/promises');
jest.mock('child_process');
jest.mock('node-pty', () => ({ spawn: jest.fn() }));

const execFileMock = execFile as unknown as jest.Mock<any>;

describe('openProjectInFinder (CREW-967: no shell)', () => {
  let res: { status: jest.Mock<any>; json: jest.Mock<any> };
  let ctx: ApiContext;

  const call = (projectPath: string) => {
    ctx = {
      storageService: { getProjects: jest.fn<any>().mockResolvedValue([{ id: 'p1', name: 'P', path: projectPath }]) },
    } as unknown as ApiContext;
    return openProjectInFinder.call(ctx, { params: { id: 'p1' } } as unknown as Request, res as unknown as Response);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    res = { status: jest.fn<any>().mockReturnThis(), json: jest.fn<any>().mockReturnThis() };
    (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
    // promisify(execFile) calls the mock with a trailing node-style callback.
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: Error | null, out?: string, err?: string) => void;
      cb(null, '', '');
    });
  });

  it('runs `open` with the path as a single argv entry', async () => {
    await call('/Users/me/proj');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe('open');
    expect(execFileMock.mock.calls[0][1]).toEqual(['/Users/me/proj']);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it.each([
    '/tmp/x"; touch /tmp/pwned; echo "',
    '/tmp/$(touch /tmp/pwned)',
    '/tmp/`touch /tmp/pwned`',
  ])('keeps the shell syntax in %j literal inside the one argv entry', async (evil) => {
    await call(evil);

    expect(execFileMock.mock.calls[0][0]).toBe('open');
    expect(execFileMock.mock.calls[0][1]).toEqual([evil]);
  });
});
