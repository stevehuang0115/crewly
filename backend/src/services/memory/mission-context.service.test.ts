/**
 * Tests for `MissionContextService`.
 *
 * Uses a per-test temp project root so file-system reads exercise the
 * real `.crewly/...` layout the production service consumes.
 *
 * @module services/memory/mission-context.service.test
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  MissionContextService,
  MISSION_CONTEXT_HARD_CAP_BYTES,
  collectRecentStatusUpdates,
  enforceHardCap,
  extractMeaningfulLines,
  renderMissionCard,
} from './mission-context.service.js';
import { GoalTrackingService } from './goal-tracking.service.js';
import type { Mission } from '../../types/v2/mission.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid Mission for tests. Pass overrides for any field
 * the test cares about.
 */
function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: overrides.id ?? `mission-${Math.random().toString(36).slice(2)}`,
    objective: overrides.objective ?? 'Ship feature X',
    ownerTeamId: overrides.ownerTeamId ?? 'team-A',
    successCriteria: overrides.successCriteria ?? ['done by Friday'],
    currentStrategy: overrides.currentStrategy ?? 'incremental',
    activeProjectTaskIds: overrides.activeProjectTaskIds ?? [],
    cadence: overrides.cadence ?? 'weekly',
    // policy is required by the type but not exercised here — cast through
    policy: overrides.policy ?? ({} as Mission['policy']),
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00Z',
    learnings: overrides.learnings ?? [],
    ...overrides,
  };
}

/**
 * Create a temp project root with `.crewly/` skeleton for a test.
 * Returns the absolute path. Caller is responsible for `fs.rm`.
 */
async function makeTempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-ctx-'));
  await fs.mkdir(path.join(root, '.crewly', 'goals'), { recursive: true });
  await fs.mkdir(path.join(root, '.crewly', 'missions'), { recursive: true });
  return root;
}

/** Write `goals.md` for a temp project. */
async function writeGoals(projectPath: string, body: string): Promise<void> {
  await fs.writeFile(
    path.join(projectPath, '.crewly', 'goals', 'goals.md'),
    body,
    'utf-8',
  );
}

/** Write a team sub-OKR md file for a temp project. */
async function writeTeamSubOkr(
  projectPath: string,
  teamSlug: string,
  body: string,
): Promise<void> {
  await fs.writeFile(
    path.join(
      projectPath,
      '.crewly',
      'goals',
      `${teamSlug}-team-sub-okr.md`,
    ),
    body,
    'utf-8',
  );
}

/** Persist a Mission as `<id>.json` under `.crewly/missions/`. */
async function writeMission(
  projectPath: string,
  mission: Mission,
): Promise<void> {
  await fs.writeFile(
    path.join(projectPath, '.crewly', 'missions', `${mission.id}.json`),
    JSON.stringify(mission, null, 2),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// Pure-helper tests (no IO)
// ---------------------------------------------------------------------------

describe('extractMeaningfulLines', () => {
  it('skips blank lines and HTML comments', () => {
    const md = `# Heading\n\n<!-- TODO drop this -->\nLine A\n   \nLine B`;
    expect(extractMeaningfulLines(md, 10)).toEqual([
      '# Heading',
      'Line A',
      'Line B',
    ]);
  });

  it('caps at maxLines', () => {
    const md = ['a', 'b', 'c', 'd', 'e'].join('\n');
    expect(extractMeaningfulLines(md, 3)).toEqual(['a', 'b', 'c']);
  });

  it('de-duplicates consecutive identical lines', () => {
    expect(extractMeaningfulLines('x\nx\ny', 10)).toEqual(['x', 'y']);
  });
});

describe('collectRecentStatusUpdates', () => {
  it('returns empty when no missions have a lastReviewSummary', () => {
    expect(collectRecentStatusUpdates([makeMission()])).toEqual([]);
  });

  it('orders by lastReviewAt descending; missing dates sort last', () => {
    const m1 = makeMission({
      id: 'm1',
      objective: 'A',
      lastReviewSummary: 'sum-A',
      lastReviewAt: '2026-04-01T00:00:00Z',
    });
    const m2 = makeMission({
      id: 'm2',
      objective: 'B',
      lastReviewSummary: 'sum-B',
      lastReviewAt: '2026-04-15T00:00:00Z',
    });
    const m3 = makeMission({
      id: 'm3',
      objective: 'C',
      lastReviewSummary: 'sum-C',
      // no lastReviewAt
    });
    const out = collectRecentStatusUpdates([m1, m2, m3]);
    expect(out.map((u) => u.missionId)).toEqual(['m2', 'm1', 'm3']);
  });
});

describe('renderMissionCard', () => {
  it('emits headings only for sections with data', () => {
    const card = renderMissionCard({
      goalsLines: ['Goal A'],
      missions: [],
      teamSubOkrLines: [],
      statusUpdates: [],
    });
    expect(card).toContain('## Current Mission Context');
    expect(card).toContain('Active Project OKR');
    expect(card).not.toContain('Current Active Missions');
    expect(card).not.toContain("Your Team's Sub-OKR");
  });

  it('renders all sections with the spec template ordering', () => {
    const card = renderMissionCard({
      goalsLines: ['Project OKR line'],
      missions: [
        makeMission({
          objective: 'Mission Foo',
          priority: 'high',
          successCriteria: ['ship by EOQ'],
        }),
      ],
      teamSubOkrLines: ['Team sub-OKR line'],
      statusUpdates: [
        {
          missionId: 'm1',
          objective: 'Mission Foo',
          summary: 'on track',
          reviewedAt: '2026-04-01T00:00:00Z',
        },
      ],
    });
    const idxOkr = card.indexOf('Active Project OKR');
    const idxMissions = card.indexOf('Current Active Missions');
    const idxSub = card.indexOf("Your Team's Sub-OKR");
    const idxStatus = card.indexOf('Recent Mission Status');
    expect(idxOkr).toBeGreaterThan(0);
    expect(idxMissions).toBeGreaterThan(idxOkr);
    expect(idxSub).toBeGreaterThan(idxMissions);
    expect(idxStatus).toBeGreaterThan(idxSub);
    expect(card).toContain('[high] Mission Foo — ship by EOQ');
    expect(card).toContain('2026-04-01: Mission Foo — on track');
  });
});

describe('enforceHardCap', () => {
  it('passes through cards already under the cap', () => {
    const small = '## tiny\nhello';
    expect(enforceHardCap(small, 1024)).toBe(small);
  });

  it('truncates oversized cards and appends an ellipsis', () => {
    const big = ['## hdr', ...Array.from({ length: 200 }).map((_, i) => `line-${i}`)].join('\n');
    const out = enforceHardCap(big, 256);
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(256);
    expect(out).toContain('… (truncated to fit 2KB cap)');
  });
});

// ---------------------------------------------------------------------------
// Service-level tests (real fs roundtrip)
// ---------------------------------------------------------------------------

describe('MissionContextService.getContextForAgent', () => {
  let projectPath: string;
  let svc: MissionContextService;

  beforeEach(async () => {
    GoalTrackingService.clearInstance();
    MissionContextService.clearInstance();
    projectPath = await makeTempProject();
    svc = MissionContextService.getInstance();
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
    GoalTrackingService.clearInstance();
    MissionContextService.clearInstance();
  });

  it('returns empty string when no signals are present', async () => {
    const out = await svc.getContextForAgent({
      agentId: 'leo',
      projectPath,
      teamId: 'team-A',
    });
    expect(out).toBe('');
  });

  it('emits only the goals slice when only goals.md exists', async () => {
    await writeGoals(projectPath, '# Project OKR\n\nShip Crewly Pro alpha by 6/1');
    const out = await svc.getContextForAgent({
      agentId: 'leo',
      projectPath,
      teamId: 'team-A',
    });
    expect(out).toContain('## Current Mission Context');
    expect(out).toContain('Active Project OKR');
    expect(out).toContain('Ship Crewly Pro alpha');
    expect(out).not.toContain('Current Active Missions');
    expect(out).not.toContain("Your Team's Sub-OKR");
  });

  it('filters missions by teamId and active status', async () => {
    await writeMission(
      projectPath,
      makeMission({
        id: 'm-mine-active',
        objective: 'Mine, active',
        ownerTeamId: 'team-A',
        status: 'active',
      }),
    );
    await writeMission(
      projectPath,
      makeMission({
        id: 'm-mine-paused',
        objective: 'Mine, paused',
        ownerTeamId: 'team-A',
        status: 'paused',
      }),
    );
    await writeMission(
      projectPath,
      makeMission({
        id: 'm-other-active',
        objective: 'Other team, active',
        ownerTeamId: 'team-B',
        status: 'active',
      }),
    );
    const out = await svc.getContextForAgent({
      agentId: 'leo',
      projectPath,
      teamId: 'team-A',
    });
    expect(out).toContain('Mine, active');
    expect(out).not.toContain('Mine, paused');
    expect(out).not.toContain('Other team, active');
  });

  it('caps the surfaced mission count at 2 and respects priority order', async () => {
    await writeMission(
      projectPath,
      makeMission({
        id: 'm-low',
        objective: 'Low-priority mission',
        ownerTeamId: 'team-A',
        priority: 'low',
      }),
    );
    await writeMission(
      projectPath,
      makeMission({
        id: 'm-crit',
        objective: 'Critical mission',
        ownerTeamId: 'team-A',
        priority: 'critical',
      }),
    );
    await writeMission(
      projectPath,
      makeMission({
        id: 'm-high',
        objective: 'High-priority mission',
        ownerTeamId: 'team-A',
        priority: 'high',
      }),
    );
    await writeMission(
      projectPath,
      makeMission({
        id: 'm-med',
        objective: 'Medium-priority mission',
        ownerTeamId: 'team-A',
        priority: 'medium',
      }),
    );
    const out = await svc.getContextForAgent({
      agentId: 'leo',
      projectPath,
      teamId: 'team-A',
    });
    // Top two priorities should appear; bottom two should not.
    expect(out).toContain('Critical mission');
    expect(out).toContain('High-priority mission');
    expect(out).not.toContain('Medium-priority mission');
    expect(out).not.toContain('Low-priority mission');
  });

  it('includes the team sub-OKR slice when teamSlug + file are present', async () => {
    await writeTeamSubOkr(
      projectPath,
      'product',
      '## Product Sub-OKR\nDeliver 3 design reviews per sprint',
    );
    const out = await svc.getContextForAgent({
      agentId: 'leo',
      projectPath,
      teamId: 'team-A',
      teamSlug: 'product',
    });
    expect(out).toContain("Your Team's Sub-OKR");
    expect(out).toContain('Deliver 3 design reviews per sprint');
  });

  it('skips the team sub-OKR slice when no teamSlug is provided', async () => {
    await writeTeamSubOkr(projectPath, 'product', 'Should not appear');
    const out = await svc.getContextForAgent({
      agentId: 'leo',
      projectPath,
      teamId: 'team-A',
    });
    expect(out).not.toContain('Should not appear');
    expect(out).not.toContain("Your Team's Sub-OKR");
  });

  it('renders the recent-status section from mission.lastReviewSummary', async () => {
    await writeMission(
      projectPath,
      makeMission({
        id: 'm1',
        objective: 'Mission Alpha',
        ownerTeamId: 'team-A',
        priority: 'high',
        lastReviewSummary: 'KR-2 trending green',
        lastReviewAt: '2026-05-01T00:00:00Z',
      }),
    );
    const out = await svc.getContextForAgent({
      agentId: 'leo',
      projectPath,
      teamId: 'team-A',
    });
    expect(out).toContain('Recent Mission Status');
    expect(out).toContain('2026-05-01: Mission Alpha — KR-2 trending green');
  });

  it('respects the 2KB hard cap', async () => {
    // Stuff goals.md with a very large body so the renderer wants to overflow.
    const huge = Array.from({ length: 1000 })
      .map((_, i) => `Goal-line-${i}-${'x'.repeat(50)}`)
      .join('\n');
    await writeGoals(projectPath, huge);
    const out = await svc.getContextForAgent({
      agentId: 'leo',
      projectPath,
      teamId: 'team-A',
    });
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(
      MISSION_CONTEXT_HARD_CAP_BYTES,
    );
  });

  it('treats corrupt mission JSON as a missing mission, not a failure', async () => {
    // Valid mission alongside a corrupt sibling.
    await writeMission(
      projectPath,
      makeMission({
        id: 'm-good',
        objective: 'Healthy mission',
        ownerTeamId: 'team-A',
      }),
    );
    await fs.writeFile(
      path.join(projectPath, '.crewly', 'missions', 'broken.json'),
      '{not valid json',
      'utf-8',
    );
    const out = await svc.getContextForAgent({
      agentId: 'leo',
      projectPath,
      teamId: 'team-A',
    });
    expect(out).toContain('Healthy mission');
  });

  it('returns empty when projectPath does not exist', async () => {
    const ghost = path.join(os.tmpdir(), 'definitely-not-a-project-' + Date.now());
    const out = await svc.getContextForAgent({
      agentId: 'leo',
      projectPath: ghost,
      teamId: 'team-A',
    });
    expect(out).toBe('');
  });
});
