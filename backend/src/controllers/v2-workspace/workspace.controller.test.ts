/**
 * V2 Workspace Controller Tests
 *
 * Tests for all 6 CRUD endpoints: list, read, create, write (CAS),
 * structured write, and delete.
 *
 * @module controllers/v2-workspace/workspace.controller.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  listWorkspaces,
  readWorkspace,
  createWorkspaceHandler,
  writeWorkspace,
  writeStructuredWorkspace,
  deleteWorkspace,
  setWorkspaceService,
} from './workspace.controller.js';
import type { WorkspaceService } from '../../services/workspace/workspace.service.js';
import type { Workspace } from '../../types/v2/workspace.types.js';
import { WorkspaceConflictError, WorkspaceAccessError } from '../../types/v2/workspace.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(opts?: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}): Request {
  return {
    params: opts?.params ?? {},
    query: opts?.query ?? {},
    body: opts?.body ?? {},
  } as unknown as Request;
}

function mockRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

const mockNext: NextFunction = vi.fn();

function createMockWorkspace(overrides?: Partial<Workspace>): Workspace {
  return {
    id: 'ws-001',
    name: 'Test Workspace',
    ownerType: 'team',
    ownerId: 'team-product',
    accessMode: 'overwrite',
    data: { key: 'value' },
    version: 1,
    allowedWriters: [],
    createdAt: '2026-04-05T12:00:00.000Z',
    updatedAt: '2026-04-05T12:00:00.000Z',
    ...overrides,
  };
}

function createMockService(): WorkspaceService {
  return {
    listAll: vi.fn().mockResolvedValue([createMockWorkspace()]),
    read: vi.fn().mockResolvedValue(createMockWorkspace()),
    create: vi.fn().mockResolvedValue(createMockWorkspace()),
    write: vi.fn().mockResolvedValue(createMockWorkspace({ version: 2 })),
    writeStructured: vi.fn().mockResolvedValue(createMockWorkspace({ version: 2 })),
    delete: vi.fn().mockResolvedValue(true),
    listIds: vi.fn().mockResolvedValue(['ws-001']),
  } as unknown as WorkspaceService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V2 WorkspaceController', () => {
  let service: WorkspaceService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = createMockService();
    setWorkspaceService(service);
  });

  // -----------------------------------------------------------------------
  // Service not initialized
  // -----------------------------------------------------------------------
  describe('service unavailable', () => {
    it.each([
      ['listWorkspaces', listWorkspaces, mockReq()],
      ['readWorkspace', readWorkspace, mockReq({ params: { id: 'ws-1' } })],
      ['createWorkspaceHandler', createWorkspaceHandler, mockReq({ body: { name: 'x', ownerType: 'team', ownerId: 'o' } })],
      ['writeWorkspace', writeWorkspace, mockReq({ params: { id: 'ws-1' }, body: { expectedVersion: 1, data: {}, writerId: 'w' } })],
      ['writeStructuredWorkspace', writeStructuredWorkspace, mockReq({ params: { id: 'ws-1' }, body: { expectedVersion: 1, path: 'a', value: 1, writerId: 'w' } })],
      ['deleteWorkspace', deleteWorkspace, mockReq({ params: { id: 'ws-1' } })],
    ])('%s returns 503 when service not initialized', async (_name, handler, req) => {
      setWorkspaceService(null as unknown as WorkspaceService);
      const res = mockRes();
      await handler(req, res, mockNext);
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/v2/workspaces
  // -----------------------------------------------------------------------
  describe('listWorkspaces', () => {
    it('returns all workspaces', async () => {
      const res = mockRes();
      await listWorkspaces(mockReq(), res, mockNext);
      expect(service.listAll).toHaveBeenCalledOnce();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: [expect.objectContaining({ id: 'ws-001' })],
      });
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/v2/workspaces/:id
  // -----------------------------------------------------------------------
  describe('readWorkspace', () => {
    it('returns workspace with data and version', async () => {
      const res = mockRes();
      await readWorkspace(mockReq({ params: { id: 'ws-001' } }), res, mockNext);
      expect(service.read).toHaveBeenCalledWith('ws-001');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({ id: 'ws-001', version: 1 }),
      });
    });

    it('returns 404 when workspace not found', async () => {
      (service.read as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const res = mockRes();
      await readWorkspace(mockReq({ params: { id: 'ws-999' } }), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/v2/workspaces
  // -----------------------------------------------------------------------
  describe('createWorkspaceHandler', () => {
    it('creates workspace with valid input', async () => {
      const res = mockRes();
      await createWorkspaceHandler(
        mockReq({ body: { name: 'New WS', ownerType: 'team', ownerId: 'team-1' } }),
        res, mockNext,
      );
      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New WS', ownerType: 'team' }),
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('returns 400 for invalid input (missing name)', async () => {
      const res = mockRes();
      await createWorkspaceHandler(
        mockReq({ body: { ownerType: 'team', ownerId: 'team-1' } }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ errors: expect.any(Array) }),
      );
    });

    it('returns 400 for invalid ownerType', async () => {
      const res = mockRes();
      await createWorkspaceHandler(
        mockReq({ body: { name: 'x', ownerType: 'invalid', ownerId: 'o' } }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  // -----------------------------------------------------------------------
  // PUT /api/v2/workspaces/:id (CAS write)
  // -----------------------------------------------------------------------
  describe('writeWorkspace', () => {
    it('writes data with valid CAS version', async () => {
      const res = mockRes();
      await writeWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { expectedVersion: 1, data: { newKey: 'newVal' }, writerId: 'agent-1' },
        }),
        res, mockNext,
      );
      expect(service.write).toHaveBeenCalledWith('ws-001', {
        expectedVersion: 1,
        data: { newKey: 'newVal' },
        writerId: 'agent-1',
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({ version: 2 }),
      });
    });

    it('returns 409 on CAS conflict', async () => {
      (service.write as ReturnType<typeof vi.fn>).mockRejectedValue(
        new WorkspaceConflictError('ws-001', 1, 3),
      );
      const res = mockRes();
      await writeWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { expectedVersion: 1, data: {}, writerId: 'agent-1' },
        }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedVersion: 1,
          actualVersion: 3,
        }),
      );
    });

    it('returns 403 on access denied', async () => {
      (service.write as ReturnType<typeof vi.fn>).mockRejectedValue(
        new WorkspaceAccessError('ws-001', 'intruder'),
      );
      const res = mockRes();
      await writeWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { expectedVersion: 1, data: {}, writerId: 'intruder' },
        }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('returns 404 when workspace not found', async () => {
      (service.write as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Workspace 'ws-999' not found"),
      );
      const res = mockRes();
      await writeWorkspace(
        mockReq({
          params: { id: 'ws-999' },
          body: { expectedVersion: 1, data: {}, writerId: 'agent-1' },
        }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 400 for invalid write input (missing expectedVersion)', async () => {
      const res = mockRes();
      await writeWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { data: {}, writerId: 'agent-1' },
        }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for invalid write input (missing writerId)', async () => {
      const res = mockRes();
      await writeWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { expectedVersion: 1, data: {} },
        }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for invalid write input (null data)', async () => {
      const res = mockRes();
      await writeWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { expectedVersion: 1, data: null, writerId: 'agent-1' },
        }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  // -----------------------------------------------------------------------
  // PUT /api/v2/workspaces/:id/structured
  // -----------------------------------------------------------------------
  describe('writeStructuredWorkspace', () => {
    it('writes to a path with valid input', async () => {
      const res = mockRes();
      await writeStructuredWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { expectedVersion: 1, path: 'results.phase1', value: 42, writerId: 'agent-1' },
        }),
        res, mockNext,
      );
      expect(service.writeStructured).toHaveBeenCalledWith('ws-001', {
        expectedVersion: 1,
        path: 'results.phase1',
        value: 42,
        writerId: 'agent-1',
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({ version: 2 }),
      });
    });

    it('returns 409 on CAS conflict', async () => {
      (service.writeStructured as ReturnType<typeof vi.fn>).mockRejectedValue(
        new WorkspaceConflictError('ws-001', 1, 5),
      );
      const res = mockRes();
      await writeStructuredWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { expectedVersion: 1, path: 'x', value: 1, writerId: 'agent-1' },
        }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ expectedVersion: 1, actualVersion: 5 }),
      );
    });

    it('returns 403 on access denied', async () => {
      (service.writeStructured as ReturnType<typeof vi.fn>).mockRejectedValue(
        new WorkspaceAccessError('ws-001', 'intruder'),
      );
      const res = mockRes();
      await writeStructuredWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { expectedVersion: 1, path: 'x', value: 1, writerId: 'intruder' },
        }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('returns 400 when workspace not in structured mode', async () => {
      (service.writeStructured as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Workspace 'ws-001' is not in structured mode"),
      );
      const res = mockRes();
      await writeStructuredWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { expectedVersion: 1, path: 'x', value: 1, writerId: 'agent-1' },
        }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for missing path', async () => {
      const res = mockRes();
      await writeStructuredWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { expectedVersion: 1, value: 1, writerId: 'agent-1' },
        }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('path') }),
      );
    });

    it('returns 400 for missing expectedVersion', async () => {
      const res = mockRes();
      await writeStructuredWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { path: 'x', value: 1, writerId: 'agent-1' },
        }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for missing writerId', async () => {
      const res = mockRes();
      await writeStructuredWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { expectedVersion: 1, path: 'x', value: 1 },
        }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  // -----------------------------------------------------------------------
  // DELETE /api/v2/workspaces/:id
  // -----------------------------------------------------------------------
  describe('deleteWorkspace', () => {
    it('deletes existing workspace', async () => {
      const res = mockRes();
      await deleteWorkspace(mockReq({ params: { id: 'ws-001' } }), res, mockNext);
      expect(service.delete).toHaveBeenCalledWith('ws-001');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    });

    it('returns 404 when workspace not found', async () => {
      (service.delete as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const res = mockRes();
      await deleteWorkspace(mockReq({ params: { id: 'ws-999' } }), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  // -----------------------------------------------------------------------
  // Error forwarding
  // -----------------------------------------------------------------------
  describe('error forwarding', () => {
    it('listWorkspaces forwards unexpected errors', async () => {
      const err = new Error('boom');
      (service.listAll as ReturnType<typeof vi.fn>).mockRejectedValue(err);
      const res = mockRes();
      await listWorkspaces(mockReq(), res, mockNext);
      expect(mockNext).toHaveBeenCalledWith(err);
    });

    it('writeWorkspace forwards unexpected errors', async () => {
      const err = new Error('something unexpected');
      (service.write as ReturnType<typeof vi.fn>).mockRejectedValue(err);
      const res = mockRes();
      await writeWorkspace(
        mockReq({
          params: { id: 'ws-001' },
          body: { expectedVersion: 1, data: {}, writerId: 'a' },
        }),
        res, mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(err);
    });
  });
});
