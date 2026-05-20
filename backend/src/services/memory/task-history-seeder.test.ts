/**
 * Unit tests for TaskHistorySeeder.
 *
 * @module services/memory/task-history-seeder.test
 */

import {
  pickCanonicalCapabilities,
  seedDeclaredCapabilities,
} from './task-history-seeder.js';
import type { IProjectMemoryService } from './project-memory.service.js';
import { TaskHistoryEntry } from '../../types/memory.types.js';

class StubProjectMemory {
  public writes: Array<{ projectPath: string; entry: TaskHistoryEntry }> = [];
  public throwOnNext = false;

  async addTaskHistory(projectPath: string, entry: TaskHistoryEntry): Promise<string> {
    if (this.throwOnNext) {
      this.throwOnNext = false;
      throw new Error('disk full (simulated)');
    }
    this.writes.push({ projectPath, entry });
    return entry.id;
  }
  async getTaskHistory(): Promise<TaskHistoryEntry[]> {
    return this.writes.map((w) => w.entry);
  }
}

describe('pickCanonicalCapabilities', () => {
  it('keeps strings of the form <cat>:<res>', () => {
    expect(pickCanonicalCapabilities(['gmail:read', 'oauth:gmail'])).toEqual(
      expect.arrayContaining(['gmail:read', 'oauth:gmail']),
    );
  });

  it('drops free-form strings without a colon', () => {
    expect(pickCanonicalCapabilities(['anything', 'plain-text'])).toEqual([]);
  });

  it('drops entries with empty halves like "a:" or ":b"', () => {
    expect(pickCanonicalCapabilities(['a:', ':b', 'good:value'])).toEqual(['good:value']);
  });

  it('dedupes', () => {
    expect(pickCanonicalCapabilities(['x:y', 'x:y', 'a:b'])).toEqual(
      expect.arrayContaining(['x:y', 'a:b']),
    );
    expect(pickCanonicalCapabilities(['x:y', 'x:y']).length).toBe(1);
  });

  it('returns [] for undefined / empty', () => {
    expect(pickCanonicalCapabilities(undefined)).toEqual([]);
    expect(pickCanonicalCapabilities([])).toEqual([]);
  });

  it('ignores non-string entries (defensive)', () => {
    const arr = ['gmail:read', 42 as unknown as string, null as unknown as string];
    expect(pickCanonicalCapabilities(arr)).toEqual(['gmail:read']);
  });
});

describe('seedDeclaredCapabilities', () => {
  const fakeClock = () => new Date('2026-05-19T00:00:00Z');

  it('writes a single declared entry with outcome=declared', async () => {
    const projectMemory = new StubProjectMemory();
    const id = await seedDeclaredCapabilities({
      projectPath: '/tmp/proj',
      member: {
        sessionName: 'crewly-product-ella',
        role: 'fullstack-dev',
        teamId: 'team-mit',
        capabilities: ['gmail:read', 'oauth:gmail'],
      },
      projectMemory: projectMemory as unknown as IProjectMemoryService,
      now: fakeClock,
    });

    expect(id).toBe('th-declared-crewly-product-ella');
    expect(projectMemory.writes).toHaveLength(1);
    const entry = projectMemory.writes[0]!.entry;
    expect(entry.task.outcome).toBe('declared');
    expect(entry.capabilities.sort()).toEqual(['gmail:read', 'oauth:gmail'].sort());
    expect(entry.agent.sessionName).toBe('crewly-product-ella');
    expect(entry.agent.teamId).toBe('team-mit');
    expect(entry.completedAt).toBe('2026-05-19T00:00:00.000Z');
  });

  it('uses a stable id keyed by sessionName so re-registration dedups', async () => {
    const projectMemory = new StubProjectMemory();
    await seedDeclaredCapabilities({
      projectPath: '/tmp/proj',
      member: {
        sessionName: 'crewly-orc',
        role: 'orchestrator',
        capabilities: ['code:read'],
      },
      projectMemory: projectMemory as unknown as IProjectMemoryService,
    });
    await seedDeclaredCapabilities({
      projectPath: '/tmp/proj',
      member: {
        sessionName: 'crewly-orc',
        role: 'orchestrator',
        capabilities: ['code:read'],
      },
      projectMemory: projectMemory as unknown as IProjectMemoryService,
    });
    // Stub does append both; production dedup happens inside
    // ProjectMemoryService.addTaskHistory. The stable id is the
    // contract that production relies on.
    expect(projectMemory.writes[0]!.entry.id).toBe('th-declared-crewly-orc');
    expect(projectMemory.writes[1]!.entry.id).toBe('th-declared-crewly-orc');
  });

  it('skips entirely when member declares no canonical capabilities', async () => {
    const projectMemory = new StubProjectMemory();
    const id = await seedDeclaredCapabilities({
      projectPath: '/tmp/proj',
      member: {
        sessionName: 's',
        role: 'r',
        capabilities: ['free-form-string'],
      },
      projectMemory: projectMemory as unknown as IProjectMemoryService,
    });
    expect(id).toBeNull();
    expect(projectMemory.writes).toHaveLength(0);
  });

  it('skips when capabilities is undefined', async () => {
    const projectMemory = new StubProjectMemory();
    const id = await seedDeclaredCapabilities({
      projectPath: '/tmp/proj',
      member: { sessionName: 's', role: 'r' },
      projectMemory: projectMemory as unknown as IProjectMemoryService,
    });
    expect(id).toBeNull();
    expect(projectMemory.writes).toHaveLength(0);
  });

  it('swallows ProjectMemoryService errors (registration must not fail)', async () => {
    const projectMemory = new StubProjectMemory();
    projectMemory.throwOnNext = true;
    const id = await seedDeclaredCapabilities({
      projectPath: '/tmp/proj',
      member: {
        sessionName: 's',
        role: 'r',
        capabilities: ['gmail:read'],
      },
      projectMemory: projectMemory as unknown as IProjectMemoryService,
    });
    expect(id).toBeNull();
    expect(projectMemory.writes).toHaveLength(0);
  });
});
