/**
 * Tests for ProjectModel.
 *
 * Covers the constructor's defaulting behaviour and the JSON round-trip,
 * including the `firstLaunchedAt` field added for Onboarding v3 (B1).
 *
 * @module models/Project.test
 */

import { ProjectModel } from './Project.js';
import type { Project } from '../types/index.js';

describe('ProjectModel', () => {
  describe('constructor', () => {
    it('defaults missing fields and stamps timestamps', () => {
      const model = new ProjectModel({ id: 'p1', name: 'New', path: '/tmp/p1' });
      expect(model.id).toBe('p1');
      expect(model.name).toBe('New');
      expect(model.path).toBe('/tmp/p1');
      expect(model.teams).toEqual({});
      expect(model.status).toBe('stopped');
      expect(model.firstLaunchedAt).toBeUndefined();
      expect(model.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(model.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('preserves explicit firstLaunchedAt', () => {
      const stamp = '2026-04-01T12:00:00.000Z';
      const model = new ProjectModel({ id: 'p1', firstLaunchedAt: stamp });
      expect(model.firstLaunchedAt).toBe(stamp);
    });
  });

  describe('toJSON / fromJSON round-trip (Onboarding v3 — B1)', () => {
    it('omits firstLaunchedAt when not set, so legacy records stay clean', () => {
      const model = new ProjectModel({ id: 'p1', name: 'p', path: '/tmp/p' });
      const json = model.toJSON();
      // `firstLaunchedAt` must be absent (not present-as-undefined) so JSON
      // serialization doesn't emit a noisy null/undefined.
      expect('firstLaunchedAt' in json).toBe(false);
    });

    it('emits firstLaunchedAt when set, and round-trips back via fromJSON', () => {
      const stamp = '2026-04-01T12:00:00.000Z';
      const model = new ProjectModel({ id: 'p1', firstLaunchedAt: stamp });
      const json = model.toJSON();
      expect(json.firstLaunchedAt).toBe(stamp);

      const restored = ProjectModel.fromJSON(json);
      expect(restored.firstLaunchedAt).toBe(stamp);
    });

    it('round-trips a fully-populated project through JSON', () => {
      const data: Project = {
        id: 'p1',
        name: 'Full Project',
        path: '/abs/path',
        teams: { developer: ['t1'] },
        status: 'active',
        firstLaunchedAt: '2026-04-01T12:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-04-01T12:00:00.000Z',
      };
      const restored = ProjectModel.fromJSON(data).toJSON();
      expect(restored).toEqual(data);
    });
  });

  describe('team management helpers', () => {
    it('assignTeam adds a team to the role bucket and bumps updatedAt', async () => {
      const model = new ProjectModel({ id: 'p1' });
      const before = model.updatedAt;
      // Wait a tick so the timestamps differ; toISOString resolution is ms.
      await new Promise((r) => setTimeout(r, 5));
      model.assignTeam('team-1', 'developer');
      expect(model.teams.developer).toContain('team-1');
      expect(model.updatedAt).not.toBe(before);
    });

    it('assignTeam is idempotent for the same (team,role) pair', () => {
      const model = new ProjectModel({ id: 'p1' });
      model.assignTeam('team-1', 'developer');
      model.assignTeam('team-1', 'developer');
      expect(model.teams.developer).toEqual(['team-1']);
    });

    it('unassignTeam removes the team from a specific role', () => {
      const model = new ProjectModel({ id: 'p1' });
      model.assignTeam('team-1', 'developer');
      model.assignTeam('team-2', 'developer');
      model.unassignTeam('team-1', 'developer');
      expect(model.teams.developer).toEqual(['team-2']);
    });

    it('unassignTeam without role removes the team from every role and prunes empties', () => {
      const model = new ProjectModel({ id: 'p1' });
      model.assignTeam('team-1', 'developer');
      model.assignTeam('team-1', 'tester');
      model.unassignTeam('team-1');
      expect(model.teams.developer).toBeUndefined();
      expect(model.teams.tester).toBeUndefined();
    });

    it('getAssignedTeams returns the flattened set of team IDs', () => {
      const model = new ProjectModel({ id: 'p1' });
      model.assignTeam('team-1', 'developer');
      model.assignTeam('team-2', 'tester');
      expect(model.getAssignedTeams().sort()).toEqual(['team-1', 'team-2']);
    });
  });

  describe('updateStatus', () => {
    it('changes status and bumps updatedAt', async () => {
      const model = new ProjectModel({ id: 'p1', status: 'stopped' });
      const before = model.updatedAt;
      await new Promise((r) => setTimeout(r, 5));
      model.updateStatus('active');
      expect(model.status).toBe('active');
      expect(model.updatedAt).not.toBe(before);
    });
  });
});
