/**
 * Tests for materialize-team logic.
 *
 * Two paths:
 *   - LIVE: a `provisionTeam` is injected (default in prod is the real
 *     TemplateService + StorageService path). Asserts the team id + member
 *     count flow through, the flag flips, and NO fallback config is written.
 *   - FALLBACK: `provisionTeam` returns null (or throws). Asserts the minimal
 *     `config.json` stub is written under teamsDir/<id>/, members flow through
 *     inactive, and `provisioned:false`.
 *
 * Tests use a tmp dir per case and inject `provisionTeam` so they never touch
 * the real `~/.crewly` tree or the TemplateService/StorageService singletons.
 *
 * @module services/orchestrator/onboarding/materialize-team.test
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  materializeTeam,
  type MaterializeOptions,
  type ProvisionedTeam,
} from './materialize-team.js';
import type { TeamRecommendation } from './recommend-team.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-05-04T12:00:00.000Z');
const FIXED_UUID = '00000000-0000-4000-8000-000000000001';

/** A live team the fake provisioner returns. */
const LIVE_TEAM: ProvisionedTeam = { teamId: 'live-team-123', memberCount: 4 };

/** Options whose provisioner returns a live team (the prod-default path). */
function liveOpts(
  testRoot: string,
  provisionTeam?: MaterializeOptions['provisionTeam'],
): MaterializeOptions & { __logs: string[] } {
  const logs: string[] = [];
  return {
    teamsDir: path.join(testRoot, 'teams'),
    projectFlagPath: path.join(testRoot, 'onboarding-complete.json'),
    uuid: () => FIXED_UUID,
    now: () => FIXED_NOW,
    log: (msg: string) => { logs.push(msg); },
    provisionTeam: provisionTeam ?? (async () => LIVE_TEAM),
    __logs: logs,
  };
}

/** Options whose provisioner declines (null) → exercises the fallback write. */
function fallbackOpts(testRoot: string): MaterializeOptions & { __logs: string[] } {
  const logs: string[] = [];
  return {
    teamsDir: path.join(testRoot, 'teams'),
    projectFlagPath: path.join(testRoot, 'onboarding-complete.json'),
    uuid: () => FIXED_UUID,
    now: () => FIXED_NOW,
    log: (msg: string) => { logs.push(msg); },
    provisionTeam: async () => null,
    __logs: logs,
  };
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

describe('materializeTeam — live provisioning (default path)', () => {
  let root: string;
  beforeEach(async () => { root = await makeTmpRoot('live'); });
  afterEach(async () => { await rmTmpRoot(root); });

  it('returns the live team id + member count + provisioned:true', async () => {
    const result = await materializeTeam(sampleRec, liveOpts(root));
    expect(result.onboardingComplete).toBe(true);
    expect(result.provisioned).toBe(true);
    expect(result.teamId).toBe(LIVE_TEAM.teamId);
    expect(result.memberCount).toBe(LIVE_TEAM.memberCount);
    expect(result.recommendation).toEqual(sampleRec);
  });

  it('does NOT write a fallback config.json on the live path', async () => {
    const opts = liveOpts(root);
    const result = await materializeTeam(sampleRec, opts);
    expect(result.teamConfigPath).toBe('');
    // The fallback dir keyed by FIXED_UUID must not exist.
    await expect(
      fs.access(path.join(opts.teamsDir, FIXED_UUID, 'config.json')),
    ).rejects.toThrow();
  });

  it('passes the humanised team name + ownerUserId to the provisioner', async () => {
    const calls: Array<{ rec: TeamRecommendation; name: string; owner?: string }> = [];
    const opts: MaterializeOptions = {
      ...liveOpts(root),
      ownerUserId: 'user-aaa',
      provisionTeam: async (rec, name, owner) => {
        calls.push({ rec, name, owner });
        return LIVE_TEAM;
      },
    };
    await materializeTeam(sampleRec, opts);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('Dtc Viral Content Team');
    expect(calls[0].owner).toBe('user-aaa');
    expect(calls[0].rec.templateId).toBe('dtc-viral-content-team');
  });

  it('persists the project onboarding-complete flag (with teamId)', async () => {
    const opts = liveOpts(root);
    const result = await materializeTeam(sampleRec, opts);
    expect(result.projectFlagPath).toBe(opts.projectFlagPath);
    const parsed = JSON.parse(await fs.readFile(opts.projectFlagPath, 'utf8'));
    expect(parsed.onboardingComplete).toBe(true);
    expect(parsed.completedAt).toBe(FIXED_NOW.toISOString());
    expect(parsed.teamId).toBe(LIVE_TEAM.teamId);
  });

  it('emits materialize + provisioned-LIVE + flag log lines', async () => {
    const opts = liveOpts(root);
    await materializeTeam(sampleRec, opts);
    const logs = opts.__logs;
    expect(logs.length).toBe(3);
    expect(logs[0]).toContain('materializing template');
    expect(logs[0]).toContain('dtc-viral-content-team');
    expect(logs[1]).toContain('provisioned LIVE team');
    expect(logs[1]).toContain(LIVE_TEAM.teamId);
    expect(logs[2]).toContain('flipped onboardingComplete');
  });
});

describe('materializeTeam — fallback (template not provisionable)', () => {
  let root: string;
  beforeEach(async () => { root = await makeTmpRoot('fallback'); });
  afterEach(async () => { await rmTmpRoot(root); });

  it('writes a minimal config.json under teamsDir/<id>/ with provisioned:false', async () => {
    const opts = fallbackOpts(root);
    const result = await materializeTeam(sampleRec, opts);

    expect(result.provisioned).toBe(false);
    expect(result.teamId).toBe(FIXED_UUID);
    const expectedPath = path.join(opts.teamsDir, FIXED_UUID, 'config.json');
    expect(result.teamConfigPath).toBe(expectedPath);

    const parsed = JSON.parse(await fs.readFile(expectedPath, 'utf8'));
    expect(parsed.id).toBe(FIXED_UUID);
    expect(parsed.templateId).toBe('dtc-viral-content-team');
    expect(parsed.onboardingSource).toBe('hardcoded:ecommerce-content-support');
    expect(parsed.createdBy).toBe('onboarding-v3');
    expect(parsed.createdAt).toBe(FIXED_NOW.toISOString());
    expect(parsed.name).toBe('Dtc Viral Content Team');
  });

  it('every agent in the recommendation flows through to members[] (inactive)', async () => {
    const opts = fallbackOpts(root);
    await materializeTeam(sampleRec, opts);
    const parsed = JSON.parse(
      await fs.readFile(path.join(opts.teamsDir, FIXED_UUID, 'config.json'), 'utf8'),
    );
    expect(parsed.members.length).toBe(sampleRec.agents.length);
    for (let i = 0; i < sampleRec.agents.length; i++) {
      expect(parsed.members[i].role).toBe(sampleRec.agents[i].role);
      expect(parsed.members[i].responsibilities).toBe(sampleRec.agents[i].responsibilities);
      expect(parsed.members[i].skillIds).toEqual([...sampleRec.agents[i].skillIds]);
      expect(parsed.members[i].agentStatus).toBe('inactive');
      expect(parsed.members[i].workingStatus).toBe('idle');
    }
  });

  it('still flips the onboarding flag on the fallback path', async () => {
    const opts = fallbackOpts(root);
    await materializeTeam(sampleRec, opts);
    const parsed = JSON.parse(await fs.readFile(opts.projectFlagPath, 'utf8'));
    expect(parsed.onboardingComplete).toBe(true);
  });

  it('falls back (with a warning) when the provisioner THROWS', async () => {
    const opts: MaterializeOptions & { __logs: string[] } = {
      ...fallbackOpts(root),
      provisionTeam: async () => { throw new Error('tier-gated template'); },
    };
    const result = await materializeTeam(sampleRec, opts);
    expect(result.provisioned).toBe(false);
    expect(result.teamConfigPath).not.toBe('');
    expect(opts.__logs.some((l) => l.includes('WARN live provisioning failed'))).toBe(true);
  });

  it('emits materialize + MINIMAL-fallback + flag log lines', async () => {
    const opts = fallbackOpts(root);
    await materializeTeam(sampleRec, opts);
    const logs = opts.__logs;
    expect(logs.length).toBe(3);
    expect(logs[0]).toContain('materializing template');
    expect(logs[1]).toContain('wrote MINIMAL fallback config');
    expect(logs[2]).toContain('flipped onboardingComplete');
  });
});

describe('materializeTeam — defaults & resilience (fallback path)', () => {
  let root: string;
  beforeEach(async () => { root = await makeTmpRoot('defaults'); });
  afterEach(async () => { await rmTmpRoot(root); });

  it('falls back to a real UUID when no uuid generator is provided', async () => {
    const result = await materializeTeam(sampleRec, {
      teamsDir: path.join(root, 'teams'),
      projectFlagPath: path.join(root, 'flag.json'),
      provisionTeam: async () => null,
    });
    expect(result.teamId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.onboardingComplete).toBe(true);
    expect(result.provisioned).toBe(false);
  });

  it('falls back to wall-clock time when no clock is provided', async () => {
    const before = new Date().toISOString();
    const result = await materializeTeam(sampleRec, {
      teamsDir: path.join(root, 'teams'),
      projectFlagPath: path.join(root, 'flag.json'),
      provisionTeam: async () => null,
    });
    const after = new Date().toISOString();
    const parsed = JSON.parse(await fs.readFile(result.teamConfigPath, 'utf8'));
    expect(parsed.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(parsed.createdAt >= before).toBe(true);
    expect(parsed.createdAt <= after).toBe(true);
  });

  it('creates teamsDir if it does not exist', async () => {
    const opts = fallbackOpts(root);
    await expect(fs.access(opts.teamsDir)).rejects.toThrow();
    await materializeTeam(sampleRec, opts);
    await expect(fs.access(opts.teamsDir)).resolves.toBeUndefined();
  });
});

describe('materializeTeam — error handling', () => {
  it('rejects when teamsDir cannot be created (parent path is a file)', async () => {
    const root = await makeTmpRoot('err');
    try {
      const blocker = path.join(root, 'blocker');
      await fs.writeFile(blocker, 'not-a-dir', 'utf8');
      const opts: MaterializeOptions = {
        teamsDir: path.join(blocker, 'teams'),
        projectFlagPath: path.join(root, 'flag.json'),
        uuid: () => FIXED_UUID,
        now: () => FIXED_NOW,
        provisionTeam: async () => null,
      };
      await expect(materializeTeam(sampleRec, opts)).rejects.toThrow();
    } finally {
      await rmTmpRoot(root);
    }
  });
});
