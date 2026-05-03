/**
 * Tests for OnboardingBootstrapService (Onboarding v3 — B1).
 *
 * Covers all four scenarios from Sam's substrate brief:
 * - Empty chat-v2 + null `firstLaunchedAt`               → enter onboarding
 * - Non-empty chat-v2 + null `firstLaunchedAt`           → no onboarding
 * - Empty chat-v2 + non-null `firstLaunchedAt`           → no onboarding
 * - Non-empty chat-v2 + non-null `firstLaunchedAt`       → no onboarding
 *
 * Plus: optional vs explicit `projectId`, idempotent marker writes,
 * fail-closed behaviour on storage errors, and the singleton accessor.
 *
 * @module services/orchestrator/onboarding-bootstrap.service.test
 */

import {
  OnboardingBootstrapService,
  type ChatMessageCounter,
  type OnboardingBootstrapDependencies,
  getOnboardingBootstrapService,
  setOnboardingBootstrapService,
  resetOnboardingBootstrapServiceForTesting,
} from './onboarding-bootstrap.service.js';
import type { StorageService } from '../core/storage.service.js';
import type { Project } from '../../types/index.js';

/**
 * Build a minimal `Project` with the fields the detector cares about.
 * Other fields are present so the type-checker is happy but irrelevant
 * to the assertions.
 */
function makeProject(overrides: Partial<Project>): Project {
  return {
    id: overrides.id ?? 'p-default',
    name: overrides.name ?? 'Test Project',
    path: overrides.path ?? '/tmp/test-project',
    teams: overrides.teams ?? {},
    status: overrides.status ?? 'active',
    firstLaunchedAt: overrides.firstLaunchedAt,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Build a fake StorageService whose `getProjects` returns the supplied
 * snapshot and whose `saveProject` mutates the snapshot in place. We
 * don't need the rest of the surface for B1 tests.
 */
function makeFakeStorage(initialProjects: Project[] = []): {
  storage: StorageService;
  saveCalls: Project[];
  store: Project[];
} {
  const store: Project[] = [...initialProjects];
  const saveCalls: Project[] = [];
  const storage = {
    getProjects: jest.fn(async () => [...store]),
    saveProject: jest.fn(async (project: Project) => {
      saveCalls.push(project);
      const idx = store.findIndex((p) => p.id === project.id);
      if (idx >= 0) {
        store[idx] = project;
      } else {
        store.push(project);
      }
    }),
  } as unknown as StorageService;
  return { storage, saveCalls, store };
}

/** Build a fake chat counter that returns a constant. */
function makeChat(count: number): ChatMessageCounter {
  return { countAllMessages: () => count };
}

/** Build a chat counter that throws — simulates a sqlite hiccup. */
function makeBrokenChat(): ChatMessageCounter {
  return {
    countAllMessages: () => {
      throw new Error('chat-v2 sqlite handle exploded');
    },
  };
}

function makeService(deps: OnboardingBootstrapDependencies): OnboardingBootstrapService {
  return new OnboardingBootstrapService(deps);
}

describe('OnboardingBootstrapService (Onboarding v3 — B1)', () => {
  describe('shouldEnterOnboardingMode — Sam\'s 4 substrate cases', () => {
    it('empty chat + null firstLaunchedAt → returns true (cold start)', async () => {
      const { storage } = makeFakeStorage([]);
      const service = makeService({ storage, chat: makeChat(0) });
      await expect(service.shouldEnterOnboardingMode()).resolves.toBe(true);
    });

    it('non-empty chat + null firstLaunchedAt → returns false (chat wiped manually edge case)', async () => {
      // Steve's substrate edge case: existing user whose project record
      // was deleted but chat-v2 still has prior messages — must NOT
      // false-trigger onboarding.
      const { storage } = makeFakeStorage([]);
      const service = makeService({ storage, chat: makeChat(1) });
      await expect(service.shouldEnterOnboardingMode()).resolves.toBe(false);
    });

    it('empty chat + non-null firstLaunchedAt → returns false (chat wiped manually)', async () => {
      // The other side of the same edge case: chat-v2 deleted by hand,
      // but the per-project marker survives — onboarding must not fire.
      const { storage } = makeFakeStorage([
        makeProject({ id: 'p1', firstLaunchedAt: '2026-04-01T00:00:00.000Z' }),
      ]);
      const service = makeService({ storage, chat: makeChat(0) });
      await expect(service.shouldEnterOnboardingMode('p1')).resolves.toBe(false);
    });

    it('non-empty chat + non-null firstLaunchedAt → returns false (normal user)', async () => {
      const { storage } = makeFakeStorage([
        makeProject({ id: 'p1', firstLaunchedAt: '2026-04-01T00:00:00.000Z' }),
      ]);
      const service = makeService({ storage, chat: makeChat(42) });
      await expect(service.shouldEnterOnboardingMode('p1')).resolves.toBe(false);
    });
  });

  describe('shouldEnterOnboardingMode — projectId scoping', () => {
    it('without projectId, broadens marker check to "any project has marker"', async () => {
      // Three projects, one launched. With no projectId, the broad check
      // sees the launched marker and short-circuits.
      const { storage } = makeFakeStorage([
        makeProject({ id: 'p1' }),
        makeProject({ id: 'p2', firstLaunchedAt: '2026-04-01T00:00:00.000Z' }),
        makeProject({ id: 'p3' }),
      ]);
      const service = makeService({ storage, chat: makeChat(0) });
      await expect(service.shouldEnterOnboardingMode()).resolves.toBe(false);
    });

    it('with projectId pointing at an unlaunched project, ignores other projects\' markers', async () => {
      // p2 is launched, but the caller is asking about p1 specifically.
      const { storage } = makeFakeStorage([
        makeProject({ id: 'p1' }), // unlaunched
        makeProject({ id: 'p2', firstLaunchedAt: '2026-04-01T00:00:00.000Z' }),
      ]);
      const service = makeService({ storage, chat: makeChat(0) });
      await expect(service.shouldEnterOnboardingMode('p1')).resolves.toBe(true);
    });

    it('with projectId that does not exist, treats as cold (project deleted under us)', async () => {
      const { storage } = makeFakeStorage([makeProject({ id: 'p2' })]);
      const service = makeService({ storage, chat: makeChat(0) });
      await expect(service.shouldEnterOnboardingMode('does-not-exist')).resolves.toBe(true);
    });

    it('without projectId and zero projects records → cold start (very fresh install)', async () => {
      const { storage } = makeFakeStorage([]);
      const service = makeService({ storage, chat: makeChat(0) });
      await expect(service.shouldEnterOnboardingMode()).resolves.toBe(true);
    });
  });

  describe('shouldEnterOnboardingMode — fail-closed semantics', () => {
    it('returns false when storage.getProjects throws', async () => {
      const storage = {
        getProjects: jest.fn(async () => {
          throw new Error('projects.json corrupt');
        }),
        saveProject: jest.fn(),
      } as unknown as StorageService;
      const service = makeService({ storage, chat: makeChat(0) });
      await expect(service.shouldEnterOnboardingMode()).resolves.toBe(false);
    });

    it('returns false when chat counter throws', async () => {
      const { storage } = makeFakeStorage([]);
      const service = makeService({ storage, chat: makeBrokenChat() });
      await expect(service.shouldEnterOnboardingMode()).resolves.toBe(false);
    });
  });

  describe('markProjectAsLaunched', () => {
    it('writes firstLaunchedAt as an ISO timestamp on a fresh project', async () => {
      const { storage, saveCalls, store } = makeFakeStorage([makeProject({ id: 'p1' })]);
      const service = makeService({ storage, chat: makeChat(0) });

      await service.markProjectAsLaunched('p1');

      expect(saveCalls).toHaveLength(1);
      const saved = saveCalls[0];
      expect(saved.id).toBe('p1');
      expect(typeof saved.firstLaunchedAt).toBe('string');
      // ISO 8601 with milliseconds + Z suffix
      expect(saved.firstLaunchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(store[0].firstLaunchedAt).toBe(saved.firstLaunchedAt);
    });

    it('is idempotent — preserves the original timestamp on second call', async () => {
      const original = '2026-04-01T12:00:00.000Z';
      const { storage, saveCalls } = makeFakeStorage([
        makeProject({ id: 'p1', firstLaunchedAt: original }),
      ]);
      const service = makeService({ storage, chat: makeChat(0) });

      await service.markProjectAsLaunched('p1');
      await service.markProjectAsLaunched('p1');

      expect(saveCalls).toHaveLength(0); // never wrote
    });

    it('is a no-op (with warning) when the project does not exist', async () => {
      const { storage, saveCalls } = makeFakeStorage([makeProject({ id: 'p1' })]);
      const service = makeService({ storage, chat: makeChat(0) });

      await service.markProjectAsLaunched('does-not-exist');

      expect(saveCalls).toHaveLength(0);
    });

    it('does not throw when storage.saveProject fails — logs and swallows', async () => {
      const storage = {
        getProjects: jest.fn(async () => [makeProject({ id: 'p1' })]),
        saveProject: jest.fn(async () => {
          throw new Error('disk full');
        }),
      } as unknown as StorageService;
      const service = makeService({ storage, chat: makeChat(0) });

      await expect(service.markProjectAsLaunched('p1')).resolves.toBeUndefined();
    });

    it('updates the project\'s updatedAt timestamp alongside firstLaunchedAt', async () => {
      const { storage, saveCalls } = makeFakeStorage([
        makeProject({
          id: 'p1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ]);
      const service = makeService({ storage, chat: makeChat(0) });

      await service.markProjectAsLaunched('p1');

      const saved = saveCalls[0];
      expect(saved.updatedAt).toBe(saved.firstLaunchedAt);
      expect(saved.createdAt).toBe('2026-01-01T00:00:00.000Z'); // unchanged
    });
  });

  describe('singleton accessor', () => {
    afterEach(() => {
      resetOnboardingBootstrapServiceForTesting();
    });

    it('returns null before wiring', () => {
      expect(getOnboardingBootstrapService()).toBeNull();
    });

    it('returns the wired instance after setOnboardingBootstrapService', () => {
      const { storage } = makeFakeStorage([]);
      const service = makeService({ storage, chat: makeChat(0) });
      setOnboardingBootstrapService(service);
      expect(getOnboardingBootstrapService()).toBe(service);
    });

    it('reset returns to null', () => {
      const { storage } = makeFakeStorage([]);
      setOnboardingBootstrapService(makeService({ storage, chat: makeChat(0) }));
      resetOnboardingBootstrapServiceForTesting();
      expect(getOnboardingBootstrapService()).toBeNull();
    });
  });
});
