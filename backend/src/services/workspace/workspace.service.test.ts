/**
 * Tests for WorkspaceService
 *
 * Uses an in-memory storage mock to test CAS logic, access control,
 * and write modes without filesystem dependencies.
 *
 * @module services/workspace/workspace.service.test
 */

import { WorkspaceService } from './workspace.service.js';
import type { WorkspaceStorage } from './workspace.service.js';
import {
  createWorkspace,
  WorkspaceConflictError,
  WorkspaceAccessError,
} from '../../types/v2/index.js';
import type { Workspace } from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// In-Memory Storage Mock
// ---------------------------------------------------------------------------

class InMemoryStorage implements WorkspaceStorage {
  private store = new Map<string, Workspace>();

  async read(id: string): Promise<Workspace | null> {
    const ws = this.store.get(id);
    return ws ? JSON.parse(JSON.stringify(ws)) : null; // deep copy
  }

  async write(workspace: Workspace): Promise<void> {
    this.store.set(workspace.id, JSON.parse(JSON.stringify(workspace)));
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async listIds(): Promise<string[]> {
    return [...this.store.keys()];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkspaceService', () => {
  let service: WorkspaceService;
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    service = new WorkspaceService(storage);
  });

  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------
  describe('create', () => {
    it('should create a workspace at version 1', async () => {
      const ws = await service.create({
        name: 'Test',
        ownerType: 'team',
        ownerId: 'team-1',
      });
      expect(ws.version).toBe(1);
      expect(ws.name).toBe('Test');
      expect(ws.ownerId).toBe('team-1');
    });

    it('should persist the workspace', async () => {
      const ws = await service.create({ name: 'Test', ownerType: 'agent', ownerId: 'a-1' });
      const read = await service.read(ws.id);
      expect(read).not.toBeNull();
      expect(read!.id).toBe(ws.id);
    });

    it('should initialize with empty data by default', async () => {
      const ws = await service.create({ name: 'Test', ownerType: 'team', ownerId: 't-1' });
      expect(ws.data).toEqual({});
    });

    it('should respect initial data', async () => {
      const ws = await service.create({
        name: 'Test',
        ownerType: 'team',
        ownerId: 't-1',
        data: { key: 'value' },
      });
      expect(ws.data).toEqual({ key: 'value' });
    });
  });

  // -----------------------------------------------------------------------
  // read
  // -----------------------------------------------------------------------
  describe('read', () => {
    it('should return null for non-existent workspace', async () => {
      const ws = await service.read('nonexistent');
      expect(ws).toBeNull();
    });

    it('should return the workspace', async () => {
      const created = await service.create({ name: 'Test', ownerType: 'team', ownerId: 't-1' });
      const read = await service.read(created.id);
      expect(read!.name).toBe('Test');
    });
  });

  // -----------------------------------------------------------------------
  // write — CAS (Compare-And-Swap)
  // -----------------------------------------------------------------------
  describe('write — CAS', () => {
    it('should succeed with correct expectedVersion', async () => {
      const ws = await service.create({ name: 'Test', ownerType: 'team', ownerId: 'owner-1' });

      const updated = await service.write(ws.id, {
        expectedVersion: 1,
        data: { result: 'done' },
        writerId: 'owner-1',
      });

      expect(updated.version).toBe(2);
      expect(updated.data).toEqual({ result: 'done' });
    });

    it('should throw WorkspaceConflictError on version mismatch', async () => {
      const ws = await service.create({ name: 'Test', ownerType: 'team', ownerId: 'owner-1' });

      // First write succeeds
      await service.write(ws.id, { expectedVersion: 1, data: { a: 1 }, writerId: 'owner-1' });

      // Second write with stale version
      await expect(
        service.write(ws.id, { expectedVersion: 1, data: { b: 2 }, writerId: 'owner-1' }),
      ).rejects.toThrow(WorkspaceConflictError);
    });

    it('should include version details in conflict error', async () => {
      const ws = await service.create({ name: 'Test', ownerType: 'team', ownerId: 'owner-1' });
      await service.write(ws.id, { expectedVersion: 1, data: {}, writerId: 'owner-1' });

      try {
        await service.write(ws.id, { expectedVersion: 1, data: {}, writerId: 'owner-1' });
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceConflictError);
        const conflict = err as WorkspaceConflictError;
        expect(conflict.expectedVersion).toBe(1);
        expect(conflict.actualVersion).toBe(2);
      }
    });

    it('should throw Error for non-existent workspace', async () => {
      await expect(
        service.write('nonexistent', { expectedVersion: 1, data: {}, writerId: 'a' }),
      ).rejects.toThrow('not found');
    });

    it('should increment version on each write', async () => {
      const ws = await service.create({ name: 'Test', ownerType: 'team', ownerId: 'o' });
      const v2 = await service.write(ws.id, { expectedVersion: 1, data: { step: 1 }, writerId: 'o' });
      const v3 = await service.write(ws.id, { expectedVersion: 2, data: { step: 2 }, writerId: 'o' });
      const v4 = await service.write(ws.id, { expectedVersion: 3, data: { step: 3 }, writerId: 'o' });
      expect(v4.version).toBe(4);
    });

    it('should set lastWrittenBy', async () => {
      const ws = await service.create({
        name: 'Test',
        ownerType: 'team',
        ownerId: 'o',
        allowedWriters: ['agent-leo'],
      });
      const updated = await service.write(ws.id, {
        expectedVersion: 1,
        data: {},
        writerId: 'agent-leo',
      });
      expect(updated.lastWrittenBy).toBe('agent-leo');
    });
  });

  // -----------------------------------------------------------------------
  // write — Access Control
  // -----------------------------------------------------------------------
  describe('write — access control', () => {
    it('should allow owner to write', async () => {
      const ws = await service.create({ name: 'Test', ownerType: 'team', ownerId: 'owner-1' });
      const updated = await service.write(ws.id, {
        expectedVersion: 1,
        data: { x: 1 },
        writerId: 'owner-1',
      });
      expect(updated.lastWrittenBy).toBe('owner-1');
    });

    it('should allow writer in allowedWriters', async () => {
      const ws = await service.create({
        name: 'Test',
        ownerType: 'team',
        ownerId: 'owner-1',
        allowedWriters: ['agent-leo', 'agent-max'],
      });
      const updated = await service.write(ws.id, {
        expectedVersion: 1,
        data: { x: 1 },
        writerId: 'agent-leo',
      });
      expect(updated.lastWrittenBy).toBe('agent-leo');
    });

    it('should deny unauthorized writer', async () => {
      const ws = await service.create({ name: 'Test', ownerType: 'team', ownerId: 'owner-1' });
      await expect(
        service.write(ws.id, { expectedVersion: 1, data: {}, writerId: 'agent-rogue' }),
      ).rejects.toThrow(WorkspaceAccessError);
    });

    it('should deny writer not in allowedWriters list', async () => {
      const ws = await service.create({
        name: 'Test',
        ownerType: 'team',
        ownerId: 'owner-1',
        allowedWriters: ['agent-leo'],
      });
      await expect(
        service.write(ws.id, { expectedVersion: 1, data: {}, writerId: 'agent-rogue' }),
      ).rejects.toThrow(WorkspaceAccessError);
    });
  });

  // -----------------------------------------------------------------------
  // write — Access Modes
  // -----------------------------------------------------------------------
  describe('write — access modes', () => {
    it('should overwrite data in overwrite mode', async () => {
      const ws = await service.create({
        name: 'Test',
        ownerType: 'team',
        ownerId: 'o',
        data: { old: 'data', keep: 'this' },
      });
      const updated = await service.write(ws.id, {
        expectedVersion: 1,
        data: { new: 'data' },
        writerId: 'o',
      });
      expect(updated.data).toEqual({ new: 'data' });
      expect(updated.data).not.toHaveProperty('old');
    });

    it('should merge data in append mode', async () => {
      const ws = await service.create({
        name: 'Test',
        ownerType: 'team',
        ownerId: 'o',
        accessMode: 'append',
        data: { existing: 'value', count: 1 },
      });
      const updated = await service.write(ws.id, {
        expectedVersion: 1,
        data: { new: 'field', count: 2 },
        writerId: 'o',
      });
      expect(updated.data).toEqual({ existing: 'value', new: 'field', count: 2 });
    });
  });

  // -----------------------------------------------------------------------
  // writeStructured
  // -----------------------------------------------------------------------
  describe('writeStructured', () => {
    it('should write to a specific path', async () => {
      const ws = await service.create({
        name: 'Test',
        ownerType: 'team',
        ownerId: 'o',
        accessMode: 'structured',
      });
      const updated = await service.writeStructured(ws.id, {
        expectedVersion: 1,
        path: 'results.phase1',
        value: { score: 95 },
        writerId: 'o',
      });
      expect((updated.data as any).results.phase1).toEqual({ score: 95 });
    });

    it('should create intermediate objects', async () => {
      const ws = await service.create({
        name: 'Test',
        ownerType: 'team',
        ownerId: 'o',
        accessMode: 'structured',
      });
      const updated = await service.writeStructured(ws.id, {
        expectedVersion: 1,
        path: 'a.b.c',
        value: 42,
        writerId: 'o',
      });
      expect((updated.data as any).a.b.c).toBe(42);
    });

    it('should reject if not in structured mode', async () => {
      const ws = await service.create({
        name: 'Test',
        ownerType: 'team',
        ownerId: 'o',
        accessMode: 'overwrite',
      });
      await expect(
        service.writeStructured(ws.id, {
          expectedVersion: 1,
          path: 'x',
          value: 1,
          writerId: 'o',
        }),
      ).rejects.toThrow('not in structured mode');
    });

    it('should enforce CAS on structured writes', async () => {
      const ws = await service.create({
        name: 'Test',
        ownerType: 'team',
        ownerId: 'o',
        accessMode: 'structured',
      });
      await service.writeStructured(ws.id, {
        expectedVersion: 1,
        path: 'x',
        value: 1,
        writerId: 'o',
      });
      await expect(
        service.writeStructured(ws.id, {
          expectedVersion: 1, // stale
          path: 'y',
          value: 2,
          writerId: 'o',
        }),
      ).rejects.toThrow(WorkspaceConflictError);
    });

    it('should enforce access control on structured writes', async () => {
      const ws = await service.create({
        name: 'Test',
        ownerType: 'team',
        ownerId: 'o',
        accessMode: 'structured',
      });
      await expect(
        service.writeStructured(ws.id, {
          expectedVersion: 1,
          path: 'x',
          value: 1,
          writerId: 'rogue',
        }),
      ).rejects.toThrow(WorkspaceAccessError);
    });

    it('should preserve existing data at other paths', async () => {
      const ws = await service.create({
        name: 'Test',
        ownerType: 'team',
        ownerId: 'o',
        accessMode: 'structured',
        data: { existing: 'keep' },
      });
      const updated = await service.writeStructured(ws.id, {
        expectedVersion: 1,
        path: 'new',
        value: 'added',
        writerId: 'o',
      });
      expect(updated.data).toEqual({ existing: 'keep', new: 'added' });
    });
  });

  // -----------------------------------------------------------------------
  // delete
  // -----------------------------------------------------------------------
  describe('delete', () => {
    it('should delete existing workspace', async () => {
      const ws = await service.create({ name: 'Test', ownerType: 'team', ownerId: 'o' });
      const deleted = await service.delete(ws.id);
      expect(deleted).toBe(true);
      expect(await service.read(ws.id)).toBeNull();
    });

    it('should return false for non-existent workspace', async () => {
      const deleted = await service.delete('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // listIds / listAll
  // -----------------------------------------------------------------------
  describe('listIds', () => {
    it('should return empty array initially', async () => {
      expect(await service.listIds()).toEqual([]);
    });

    it('should return all workspace IDs', async () => {
      const ws1 = await service.create({ name: 'A', ownerType: 'team', ownerId: 'o' });
      const ws2 = await service.create({ name: 'B', ownerType: 'team', ownerId: 'o' });
      const ids = await service.listIds();
      expect(ids).toContain(ws1.id);
      expect(ids).toContain(ws2.id);
    });
  });

  describe('listAll', () => {
    it('should return all workspaces with data', async () => {
      await service.create({ name: 'A', ownerType: 'team', ownerId: 'o' });
      await service.create({ name: 'B', ownerType: 'team', ownerId: 'o' });
      const all = await service.listAll();
      expect(all).toHaveLength(2);
      expect(all[0].name).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent write simulation
  // -----------------------------------------------------------------------
  describe('concurrent writes', () => {
    it('should only allow one of two concurrent writes to succeed', async () => {
      const ws = await service.create({ name: 'Test', ownerType: 'team', ownerId: 'o' });

      // Simulate two concurrent reads
      const read1 = await service.read(ws.id);
      const read2 = await service.read(ws.id);

      // First write succeeds
      await service.write(ws.id, {
        expectedVersion: read1!.version,
        data: { writer: 'first' },
        writerId: 'o',
      });

      // Second write should fail (stale version)
      await expect(
        service.write(ws.id, {
          expectedVersion: read2!.version,
          data: { writer: 'second' },
          writerId: 'o',
        }),
      ).rejects.toThrow(WorkspaceConflictError);

      // Verify first write won
      const final = await service.read(ws.id);
      expect(final!.data).toEqual({ writer: 'first' });
      expect(final!.version).toBe(2);
    });
  });
});
