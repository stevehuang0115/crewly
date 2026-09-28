/**
 * Integration smoke for materialize-team's REAL provisioning path (P0).
 *
 * Unlike materialize-team.test.ts (which injects a fake provisionTeam), this
 * exercises the DEFAULT `defaultProvisionTeam` against the real
 * TemplateService + StorageService singletons, proving that a confirmed
 * recommendation becomes a live, persisted, template-backed team with real
 * members — the core P0 capability (orc goal → live team, no human
 * provisioning).
 *
 * Hermetic via CREWLY_HOME → a tmp dir (set BEFORE any import that constructs
 * the StorageService singleton). The roles-format template this test needs
 * is written to its OWN tmp templates dir and the TemplateService singleton
 * is pointed at it directly — NOT the repo's real config/templates/, which
 * (since 2026-09-28, #816: the only OSS roles-format examples were paid
 * templates that moved to crewly-pro) may have zero roles-format templates
 * of its own. Depending on "whatever happens to be in config/templates/"
 * was already fragile; this decouples the test from that entirely.
 *
 * @module services/orchestrator/onboarding/materialize-team.integration.test
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Point the storage singleton at a tmp CREWLY_HOME before importing anything
// that reads it. Each member with a non-empty prompt / hierarchy proves the
// template was really instantiated (not the empty-prompt stub).
const TMP_HOME = path.join(
  os.tmpdir(),
  `materialize-int-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
process.env.CREWLY_HOME = TMP_HOME;

import { materializeTeam } from './materialize-team.js';
import type { TeamRecommendation } from './recommend-team.js';
import { StorageService } from '../../core/storage.service.js';
import { TemplateService } from '../../template/template.service.js';

/** A minimal roles-format template (team-lead + developer, hierarchical) — this test's own fixture, not a real shipped template. */
const ROLES_FORMAT_FIXTURE = {
  id: 'test-roles-format-dev-team',
  name: 'Test Roles-Format Dev Team',
  description: 'Integration-test fixture proving the roles-format loading path (#816).',
  version: '1.0.0',
  category: 'development',
  hierarchical: true,
  roles: [
    {
      role: 'team-lead',
      label: 'Team Lead',
      defaultName: 'Lead',
      count: 1,
      hierarchyLevel: 1,
      canDelegate: true,
      defaultSkills: ['decompose-goal', 'delegate-task'],
    },
    {
      role: 'developer',
      label: 'Developer',
      defaultName: 'Dev',
      count: 1,
      hierarchyLevel: 2,
      reportsTo: 'team-lead',
      defaultSkills: ['complete-task', 'request-help'],
    },
  ],
};

const softwareRec: TeamRecommendation = {
  templateId: ROLES_FORMAT_FIXTURE.id,
  agents: [
    { role: 'team-lead', responsibilities: 'Lead', skillIds: [] },
    { role: 'developer', responsibilities: 'Build', skillIds: [] },
  ],
  reasoning: 'You want to build a small CLI todo app.',
  source: 'hardcoded:engineering',
};

beforeAll(async () => {
  const templatesDir = path.join(TMP_HOME, 'templates');
  await fs.mkdir(templatesDir, { recursive: true });
  await fs.writeFile(path.join(templatesDir, `${ROLES_FORMAT_FIXTURE.id}.json`), JSON.stringify(ROLES_FORMAT_FIXTURE));
  // Seed the singleton with this test's own templates dir BEFORE
  // materialize-team's defaultProvisionTeam calls getInstance() with no
  // args — the singleton then returns THIS instance, not one pointed at
  // the real repo config/templates/.
  TemplateService.clearInstance();
  TemplateService.getInstance(templatesDir);
});

afterAll(async () => {
  TemplateService.clearInstance();
  await fs.rm(TMP_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('materializeTeam — REAL provisioning (integration)', () => {
  it('provisions a live, persisted team with real members from a registered template', async () => {
    const result = await materializeTeam(softwareRec, {
      teamsDir: path.join(TMP_HOME, 'teams'),
      projectFlagPath: path.join(TMP_HOME, 'onboarding-complete.json'),
    });

    // It took the LIVE path (not the minimal fallback).
    expect(result.provisioned).toBe(true);
    expect(result.teamConfigPath).toBe('');
    expect(result.memberCount).toBeGreaterThan(0);

    // The team is persisted and visible via StorageService.
    const teams = await StorageService.getInstance().getTeams();
    const team = teams.find((t) => t.id === result.teamId);
    expect(team).toBeDefined();
    expect(team!.members.length).toBe(result.memberCount);

    // Members are REAL and form a runnable hierarchy (not the inactive stub):
    // every member has a role; there is a delegating LEAD at hierarchy level 1;
    // and the workers report up to it (parentMemberId set). (The per-member
    // systemPrompt is intentionally empty here — agents get their real prompt
    // from their role definition at spawn; the template prompt is only an
    // optional add-on.)
    for (const m of team!.members) {
      expect(typeof m.role).toBe('string');
      expect(m.role.length).toBeGreaterThan(0);
    }
    const lead = team!.members.find((m) => m.canDelegate === true && m.hierarchyLevel === 1);
    expect(lead).toBeDefined();
    const workers = team!.members.filter((m) => m.id !== lead!.id);
    expect(workers.length).toBeGreaterThan(0);
    expect(workers.every((w) => w.parentMemberId === lead!.id)).toBe(true);
    // Workers carry real skills resolved from the template.
    expect(workers.some((w) => Array.isArray(w.skillOverrides) && w.skillOverrides.length > 0)).toBe(true);
  });

  /**
   * Issue #729 — three stub teams leaked into the developer's REAL
   * `~/.crewly/teams` during a verification run. The live path called
   * `StorageService.getInstance()` with no argument, so it resolved the ambient
   * CREWLY_HOME and ignored the injected `teamsDir` completely: injection was a
   * half-truth that only governed the fallback stub write.
   */
  it('persists the live team under the INJECTED root, not the ambient home', async () => {
    const scratchHome = path.join(TMP_HOME, 'injected-root');

    const result = await materializeTeam(softwareRec, {
      teamsDir: path.join(scratchHome, 'teams'),
      projectFlagPath: path.join(scratchHome, 'onboarding-complete.json'),
    });
    expect(result.provisioned).toBe(true);

    // The team directory landed under the injected root.
    const entries = await fs.readdir(path.join(scratchHome, 'teams'));
    expect(entries).toContain(result.teamId);

    // …and NOT under the ambient CREWLY_HOME the singleton would have picked.
    const ambientTeams = await fs
      .readdir(path.join(TMP_HOME, 'teams'))
      .catch(() => [] as string[]);
    expect(ambientTeams).not.toContain(result.teamId);
  });

  /**
   * Issue #729 follow-up — honouring the injected root must not be done by
   * re-pointing the process-wide StorageService singleton. In a running
   * backend that would silently move the live server's storage to a
   * verification run's scratch dir.
   */
  it('does not swap the process-wide StorageService singleton for an injected root', async () => {
    const before = StorageService.getInstance();
    const scratchHome = path.join(TMP_HOME, 'injected-root-singleton');

    const result = await materializeTeam(softwareRec, {
      teamsDir: path.join(scratchHome, 'teams'),
      projectFlagPath: path.join(scratchHome, 'onboarding-complete.json'),
    });
    expect(result.provisioned).toBe(true);

    expect(StorageService.getInstance()).toBe(before);
    expect(before.getCrewlyHome()).toBe(TMP_HOME);
    const entries = await fs.readdir(path.join(scratchHome, 'teams'));
    expect(entries).toContain(result.teamId);
  });

  it('flips the onboarding flag with the live team id', async () => {
    const flagPath = path.join(TMP_HOME, 'flag-2.json');
    const result = await materializeTeam(softwareRec, {
      teamsDir: path.join(TMP_HOME, 'teams'),
      projectFlagPath: flagPath,
    });
    const flag = JSON.parse(await fs.readFile(flagPath, 'utf8'));
    expect(flag.onboardingComplete).toBe(true);
    expect(flag.teamId).toBe(result.teamId);
  });
});
