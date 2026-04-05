/**
 * Tests for V2 Workspace Type Definitions
 *
 * @module types/v2/workspace.types.test
 */

import {
  WORKSPACE_ACCESS_MODES,
  WORKSPACE_OWNER_TYPES,
  isValidWorkspaceAccessMode,
  isValidWorkspaceOwnerType,
  isWorkspace,
  validateCreateWorkspaceInput,
  validateWriteWorkspaceInput,
  createWorkspace,
  WorkspaceConflictError,
  WorkspaceAccessError,
} from './workspace.types.js';
import type { CreateWorkspaceInput, WriteWorkspaceInput } from './workspace.types.js';

describe('Workspace Types', () => {
  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  describe('WORKSPACE_ACCESS_MODES', () => {
    it('should contain 3 modes', () => {
      expect(WORKSPACE_ACCESS_MODES).toEqual(['overwrite', 'append', 'structured']);
    });
  });

  describe('WORKSPACE_OWNER_TYPES', () => {
    it('should contain 4 types', () => {
      expect(WORKSPACE_OWNER_TYPES).toEqual(['agent', 'team', 'mission', 'system']);
    });
  });

  // -----------------------------------------------------------------------
  // Type Guards
  // -----------------------------------------------------------------------
  describe('isValidWorkspaceAccessMode', () => {
    it('should accept valid modes', () => {
      for (const m of WORKSPACE_ACCESS_MODES) {
        expect(isValidWorkspaceAccessMode(m)).toBe(true);
      }
    });
    it('should reject invalid', () => {
      expect(isValidWorkspaceAccessMode('readonly')).toBe(false);
    });
  });

  describe('isValidWorkspaceOwnerType', () => {
    it('should accept valid types', () => {
      for (const t of WORKSPACE_OWNER_TYPES) {
        expect(isValidWorkspaceOwnerType(t)).toBe(true);
      }
    });
    it('should reject invalid', () => {
      expect(isValidWorkspaceOwnerType('user')).toBe(false);
    });
  });

  describe('isWorkspace', () => {
    it('should accept valid workspace', () => {
      const ws = createWorkspace({ name: 'Test', ownerType: 'team', ownerId: 't-1' });
      expect(isWorkspace(ws)).toBe(true);
    });
    it('should reject null', () => {
      expect(isWorkspace(null)).toBe(false);
    });
    it('should reject invalid ownerType', () => {
      const ws = createWorkspace({ name: 'Test', ownerType: 'team', ownerId: 't-1' });
      expect(isWorkspace({ ...ws, ownerType: 'invalid' })).toBe(false);
    });
    it('should reject version < 1', () => {
      const ws = createWorkspace({ name: 'Test', ownerType: 'team', ownerId: 't-1' });
      expect(isWorkspace({ ...ws, version: 0 })).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Error Classes
  // -----------------------------------------------------------------------
  describe('WorkspaceConflictError', () => {
    it('should contain conflict details', () => {
      const err = new WorkspaceConflictError('ws-1', 3, 5);
      expect(err.name).toBe('WorkspaceConflictError');
      expect(err.workspaceId).toBe('ws-1');
      expect(err.expectedVersion).toBe(3);
      expect(err.actualVersion).toBe(5);
      expect(err.message).toContain('3');
      expect(err.message).toContain('5');
    });
    it('should be instanceof Error', () => {
      const err = new WorkspaceConflictError('ws-1', 1, 2);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('WorkspaceAccessError', () => {
    it('should contain access details', () => {
      const err = new WorkspaceAccessError('ws-1', 'agent-rogue');
      expect(err.name).toBe('WorkspaceAccessError');
      expect(err.workspaceId).toBe('ws-1');
      expect(err.writerId).toBe('agent-rogue');
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------
  describe('validateCreateWorkspaceInput', () => {
    const valid: CreateWorkspaceInput = { name: 'Test', ownerType: 'team', ownerId: 't-1' };

    it('should return empty for valid input', () => {
      expect(validateCreateWorkspaceInput(valid)).toEqual([]);
    });
    it('should error on empty name', () => {
      expect(validateCreateWorkspaceInput({ ...valid, name: '' }).length).toBeGreaterThan(0);
    });
    it('should error on invalid ownerType', () => {
      expect(validateCreateWorkspaceInput({ ...valid, ownerType: 'x' as 'team' }).length).toBeGreaterThan(0);
    });
    it('should error on empty ownerId', () => {
      expect(validateCreateWorkspaceInput({ ...valid, ownerId: '' }).length).toBeGreaterThan(0);
    });
    it('should error on invalid accessMode', () => {
      expect(validateCreateWorkspaceInput({ ...valid, accessMode: 'x' as 'overwrite' }).length).toBeGreaterThan(0);
    });
  });

  describe('validateWriteWorkspaceInput', () => {
    const valid: WriteWorkspaceInput = { expectedVersion: 1, data: { key: 'val' }, writerId: 'agent-1' };

    it('should return empty for valid input', () => {
      expect(validateWriteWorkspaceInput(valid)).toEqual([]);
    });
    it('should error on zero expectedVersion', () => {
      expect(validateWriteWorkspaceInput({ ...valid, expectedVersion: 0 }).length).toBeGreaterThan(0);
    });
    it('should error on null data', () => {
      expect(validateWriteWorkspaceInput({ ...valid, data: null as unknown as Record<string, unknown> }).length).toBeGreaterThan(0);
    });
    it('should error on empty writerId', () => {
      expect(validateWriteWorkspaceInput({ ...valid, writerId: '' }).length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------
  describe('createWorkspace', () => {
    const input: CreateWorkspaceInput = { name: 'Sprint Results', ownerType: 'team', ownerId: 'team-product' };

    it('should create workspace at version 1', () => {
      const ws = createWorkspace(input);
      expect(ws.version).toBe(1);
    });
    it('should generate UUID id', () => {
      expect(createWorkspace(input).id).toMatch(/^[0-9a-f]{8}-/);
    });
    it('should default accessMode to overwrite', () => {
      expect(createWorkspace(input).accessMode).toBe('overwrite');
    });
    it('should default data to empty object', () => {
      expect(createWorkspace(input).data).toEqual({});
    });
    it('should default allowedWriters to empty array', () => {
      expect(createWorkspace(input).allowedWriters).toEqual([]);
    });
    it('should respect custom accessMode', () => {
      expect(createWorkspace({ ...input, accessMode: 'append' }).accessMode).toBe('append');
    });
    it('should respect initial data', () => {
      const ws = createWorkspace({ ...input, data: { phase1: 'done' } });
      expect(ws.data).toEqual({ phase1: 'done' });
    });
    it('should respect allowedWriters', () => {
      const ws = createWorkspace({ ...input, allowedWriters: ['agent-1', 'agent-2'] });
      expect(ws.allowedWriters).toEqual(['agent-1', 'agent-2']);
    });
    it('should set ISO8601 timestamps', () => {
      const ws = createWorkspace(input);
      expect(() => new Date(ws.createdAt)).not.toThrow();
      expect(ws.createdAt).toBe(ws.updatedAt);
    });
  });
});
