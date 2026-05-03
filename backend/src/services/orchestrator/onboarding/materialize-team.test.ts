/**
 * Tests for materialize-team logic.
 *
 * Covers:
 *   - Team config file is created at the expected path with the expected shape.
 *   - `onboardingComplete = true` flag is persisted.
 *   - Agents in the recommendation flow through to `members[]`.
 *   - Errors propagate (caller decides how to surface).
 *   - Logger sink fires with both stub log lines.
 *
 * Tests use a tmp dir per case so they are hermetic.
 *
 * @module services/orchestrator/onboarding/materialize-team.test
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { materializeTeam, type MaterializeOptions } from './materialize-team.js';
import type { TeamRecommendation } from './recommend-team.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-05-04T12:00:00.000Z');
const FIXED_UUID = '00000000-0000-4000-8000-000000000001';

function fixedOpts(testRoot: string): MaterializeOptions {
  const logs: string[] = [];
  const opts: MaterializeOptions & { __logs: string[] } = {
    teamsDir: path.join(testRoot, 'teams'),
    projectFlagPath: path.join(testRoot, 'onboarding-complete.json'),
    uuid: () => FIXED_UUID,
    now: () => FIXED_NOW,
    log: (msg: string) => { logs.push(msg); },
    __logs: logs,
  };
  return opts;
}

const sampleRec: TeamRecommendation = {
  templateId: 'dtc-viral-content-team',
  agents: [
    {
      role: 'content-drafter',
      responsibilities: 'Drafts weekly content.',
      skillIds: ['content-drafter', 'content-calendar'],
    },
    {
      role: 'support-triage',
      responsibilities: 'Triages support and drafts replies.',
      skillIds: ['support-triage'],
    },
  ],
  reasoning: 'You named e-commerce + content + support.',
  source: 'hardcoded:ecommerce-content-support',
};

async function makeTmpRoot(label: string): Promise<string> {
  const root = path.join(os.tmpdir(), `materialize-team-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function rmTmpRoot(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('materializeTeam — happy path', () => {
  let root: string;
  beforeEach(async () => { root = await makeTmpRoot('happy'); });
  afterEach(async () => { await rmTmpRoot(root); });

  it('returns a result with onboardingComplete = true', async () => {
    const opts = fixedOpts(root);
    const result = await materializeTeam(sampleRec, opts);
    expect(result.onboardingComplete).toBe(true);
    expect(result.teamId).toBe(FIXED_UUID);
    expect(result.recommendation).toEqual(sampleRec);
  });

  it('writes a team config.json under teamsDir/<id>/', async () => {
    const opts = fixedOpts(root);
    const result = await materializeTeam(sampleRec, opts);

    const expectedPath = path.join(opts.teamsDir, FIXED_UUID, 'config.json');
    expect(result.teamConfigPath).toBe(expectedPath);

    const raw = await fs.readFile(expectedPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(FIXED_UUID);
    expect(parsed.templateId).toBe('dtc-viral-content-team');
    expect(parsed.onboardingSource).toBe('hardcoded:ecommerce-content-support');
    expect(parsed.createdBy).toBe('onboarding-v3');
    expect(parsed.createdAt).toBe(FIXED_NOW.toISOString());
  });

  it('every agent in the recommendation flows through to members[]', async () => {
    const opts = fixedOpts(root);
    await materializeTeam(sampleRec, opts);

    const raw = await fs.readFile(
      path.join(opts.teamsDir, FIXED_UUID, 'config.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw);
    expect(parsed.members.length).toBe(sampleRec.agents.length);
    for (let i = 0; i < sampleRec.agents.length; i++) {
      expect(parsed.members[i].role).toBe(sampleRec.agents[i].role);
      expect(parsed.members[i].responsibilities).toBe(
        sampleRec.agents[i].responsibilities,
      );
      expect(parsed.members[i].skillIds).toEqual([
        ...sampleRec.agents[i].skillIds,
      ]);
      expect(parsed.members[i].agentStatus).toBe('inactive');
      expect(parsed.members[i].workingStatus).toBe('idle');
    }
  });

  it('persists the project onboarding-complete flag', async () => {
    const opts = fixedOpts(root);
    const result = await materializeTeam(sampleRec, opts);

    expect(result.projectFlagPath).toBe(opts.projectFlagPath);
    const raw = await fs.readFile(opts.projectFlagPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.onboardingComplete).toBe(true);
    expect(parsed.completedAt).toBe(FIXED_NOW.toISOString());
  });

  it('emits both stub log lines when a logger is provided', async () => {
    const logs: string[] = [];
    const opts = {
      ...fixedOpts(root),
      log: (m: string) => { logs.push(m); },
    } satisfies MaterializeOptions;

    await materializeTeam(sampleRec, opts);

    expect(logs.length).toBe(2);
    expect(logs[0]).toContain('would materialize team for template');
    expect(logs[0]).toContain('dtc-viral-content-team');
    expect(logs[0]).toContain('id=' + FIXED_UUID);
    expect(logs[1]).toContain('flipped onboardingComplete');
  });

  it('humanises the template id into the team name', async () => {
    const opts = fixedOpts(root);
    await materializeTeam(sampleRec, opts);
    const parsed = JSON.parse(
      await fs.readFile(path.join(opts.teamsDir, FIXED_UUID, 'config.json'), 'utf8'),
    );
    expect(parsed.name).toBe('Dtc Viral Content Team');
  });
});

describe('materializeTeam — defaults & resilience', () => {
  let root: string;
  beforeEach(async () => { root = await makeTmpRoot('defaults'); });
  afterEach(async () => { await rmTmpRoot(root); });

  it('falls back to a real UUID when no uuid generator is provided', async () => {
    // No injected uuid → real randomUUID — should be a valid v4 shape.
    const result = await materializeTeam(sampleRec, {
      teamsDir: path.join(root, 'teams'),
      projectFlagPath: path.join(root, 'flag.json'),
    });
    expect(result.teamId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.onboardingComplete).toBe(true);
  });

  it('falls back to wall-clock time when no clock is provided', async () => {
    const before = new Date().toISOString();
    const result = await materializeTeam(sampleRec, {
      teamsDir: path.join(root, 'teams'),
      projectFlagPath: path.join(root, 'flag.json'),
    });
    const after = new Date().toISOString();
    const raw = await fs.readFile(result.teamConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    // createdAt is a real ISO string between before and after.
    expect(parsed.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    expect(parsed.createdAt >= before).toBe(true);
    expect(parsed.createdAt <= after).toBe(true);
  });

  it('creates teamsDir if it does not exist', async () => {
    const opts = fixedOpts(root);
    // teamsDir doesn't exist yet — materialize must create it.
    await expect(fs.access(opts.teamsDir)).rejects.toThrow();
    await materializeTeam(sampleRec, opts);
    await expect(fs.access(opts.teamsDir)).resolves.toBeUndefined();
  });
});

describe('materializeTeam — error handling', () => {
  it('rejects when teamsDir cannot be created (parent path is a file)', async () => {
    const root = await makeTmpRoot('err');
    try {
      // Make a file at the path we'll try to use as a directory parent.
      const blocker = path.join(root, 'blocker');
      await fs.writeFile(blocker, 'not-a-dir', 'utf8');
      const opts: MaterializeOptions = {
        teamsDir: path.join(blocker, 'teams'),
        projectFlagPath: path.join(root, 'flag.json'),
        uuid: () => FIXED_UUID,
        now: () => FIXED_NOW,
      };
      await expect(materializeTeam(sampleRec, opts)).rejects.toThrow();
    } finally {
      await rmTmpRoot(root);
    }
  });
});
