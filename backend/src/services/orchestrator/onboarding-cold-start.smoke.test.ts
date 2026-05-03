/**
 * End-to-end smoke test for Onboarding v3 cold-start (Sun EOD prototype).
 *
 * Exercises the full signal-chain that drives the prototype demo:
 *
 *  1. Empty `~/.crewly` (zero projects, zero chat-v2 messages) →
 *     `OnboardingBootstrapService.shouldEnterOnboardingMode()` returns true.
 *  2. Once onboarding fires, `loadOnboardingPrompt()` resolves Max's
 *     production prompt (5-phase, anchor transcript, capability list).
 *  3. `loadOnboardingSkillAllowlist()` resolves Max's production allowlist
 *     and excludes destructive delegation skills.
 *  4. After bootstrap success, `markProjectAsLaunched(projectId)` flips the
 *     marker so a second boot returns false (warm-start path) — proves
 *     the cold-start fires exactly once for the demo.
 *  5. The two signals are AND-ed: if EITHER the marker exists OR chat-v2
 *     has messages, onboarding does NOT trigger. Both directions covered.
 *
 * This is the smoke transcript Mia can read to verify the prototype.
 *
 * @module services/orchestrator/onboarding-cold-start.smoke.test
 */

import {
  OnboardingBootstrapService,
  type ChatMessageCounter,
} from './onboarding-bootstrap.service.js';
import {
  loadOnboardingPrompt,
  loadOnboardingSkillAllowlist,
  _resetOnboardingModeLoaderForTesting,
} from './onboarding-mode-loader.js';
import type { StorageService } from '../core/storage.service.js';
import type { Project } from '../../types/index.js';

/**
 * Minimal storage stub that satisfies `OnboardingBootstrapService`'s
 * `Pick<StorageService, 'getProjects' | 'saveProject'>` contract via duck
 * typing. Holds projects in an in-memory map so we can assert the
 * marker round-trip end-to-end.
 */
function createStorageStub(seed: Project[] = []): StorageService {
  const projects = new Map<string, Project>(seed.map((p) => [p.id, { ...p }]));
  const stub = {
    getProjects: jest.fn(async () => Array.from(projects.values()).map((p) => ({ ...p }))),
    saveProject: jest.fn(async (project: Project) => {
      projects.set(project.id, { ...project });
    }),
  };
  return stub as unknown as StorageService;
}

/** Chat counter that returns whatever value the test stages. */
function createChatStub(initialCount = 0): ChatMessageCounter & { setCount: (n: number) => void } {
  let count = initialCount;
  return {
    countAllMessages: () => count,
    setCount: (n: number) => {
      count = n;
    },
  };
}

describe('Onboarding v3 cold-start smoke (Sun EOD prototype)', () => {
  beforeEach(() => {
    _resetOnboardingModeLoaderForTesting();
  });

  it('full happy path: empty storage + empty chat → cold-start fires + production prompt loads + marker round-trips', async () => {
    const storage = createStorageStub([]);
    const chat = createChatStub(0);
    const service = new OnboardingBootstrapService({ storage, chat });

    // (1) Cold-start probe fires.
    const cold = await service.shouldEnterOnboardingMode();
    expect(cold).toBe(true);

    // (2) Production prompt loads — Max's 5-phase onboarding prompt.
    const prompt = await loadOnboardingPrompt();
    expect(prompt.length).toBeGreaterThan(1000);
    // Anchor on Max's exact phase markers to assert the production
    // module loaded (NOT the inline fallback stub).
    expect(prompt).toContain('PHASE 1 — OPEN');
    expect(prompt).toContain('PHASE 2 — BUSINESS DISCOVERY');
    expect(prompt).toContain('PHASE 3 — FEASIBILITY JUDGMENT');
    expect(prompt).toContain('PHASE 4 — TEAM RECOMMENDATION');
    expect(prompt).toContain('PHASE 5 — CONFIRM + MATERIALIZE');

    // (3) Skill allowlist excludes destructive delegation skills, includes
    //     the onboarding-only skills.
    const allowlist = await loadOnboardingSkillAllowlist();
    expect(allowlist).toContain('recall');
    expect(allowlist).toContain('remember');
    expect(allowlist).toContain('record-learning');
    expect(allowlist).toContain('recommend-team');
    expect(allowlist).toContain('materialize-team');
    expect(allowlist).not.toContain('delegate-task');
    expect(allowlist).not.toContain('start-agent');
    expect(allowlist).not.toContain('stop-agent');

    // (4) After bootstrap succeeds, marker the project. We need a real
    //     project record to mark — seed one.
    const seededProject: Project = {
      id: 'demo-project-001',
      name: 'Demo Project',
      path: '/tmp/demo',
      teams: {},
      status: 'active',
      createdAt: new Date('2026-05-03').toISOString(),
      updatedAt: new Date('2026-05-03').toISOString(),
    };
    const storageWithProject = createStorageStub([seededProject]);
    const serviceWithProject = new OnboardingBootstrapService({
      storage: storageWithProject,
      chat,
    });
    await serviceWithProject.markProjectAsLaunched('demo-project-001');

    // (5) Re-probe — marker now set on this project, broad cold-start
    //     check sees it and returns false (warm start). This is the demo
    //     invariant: cold-start fires exactly once per install.
    const warm = await serviceWithProject.shouldEnterOnboardingMode();
    expect(warm).toBe(false);
  });

  it('AND-gate signal 1: chat has messages → cold-start does NOT fire even if no project marker', async () => {
    const storage = createStorageStub([]);
    const chatWithMessages = createChatStub(7); // user has spoken before
    const service = new OnboardingBootstrapService({ storage, chat: chatWithMessages });

    const cold = await service.shouldEnterOnboardingMode();
    expect(cold).toBe(false);
  });

  it('AND-gate signal 2: a project carries firstLaunchedAt → cold-start does NOT fire even if chat is empty', async () => {
    const launchedProject: Project = {
      id: 'old-project',
      name: 'Old Project',
      path: '/tmp/old',
      teams: {},
      status: 'active',
      createdAt: new Date('2026-04-01').toISOString(),
      updatedAt: new Date('2026-04-01').toISOString(),
      firstLaunchedAt: new Date('2026-04-01').toISOString(),
    };
    const storage = createStorageStub([launchedProject]);
    const emptyChat = createChatStub(0);
    const service = new OnboardingBootstrapService({ storage, chat: emptyChat });

    const cold = await service.shouldEnterOnboardingMode();
    expect(cold).toBe(false);
  });

  it('demo transcript: prompt content includes anchor 4-tier feasibility vocabulary', async () => {
    // Read-only smoke: confirm the production prompt contains the
    // semantic anchors Mia's spec v3 requires (Yes-today / Collaborative /
    // Roadmap / Out-of-scope). These are the discriminator for the
    // onboarding-mode prompt vs. any future swap.
    const prompt = await loadOnboardingPrompt();
    // Max's prompt phrases the four tiers as: "Yes, today" /
    // "Collaborative" / "Roadmap" / "Out of scope". Each tier appears
    // multiple times across the table + the few-shot anchor transcript.
    expect(prompt).toMatch(/Yes,\s*today/i);
    expect(prompt).toMatch(/Collaborative/i);
    expect(prompt).toMatch(/Roadmap/i);
    expect(prompt).toMatch(/Out\s*of\s*scope/i);
  });
});
