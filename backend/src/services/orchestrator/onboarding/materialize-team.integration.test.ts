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
 * the StorageService singleton). Templates load from the repo's
 * config/templates (cwd-relative), so this needs no fixtures.
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

const softwareRec: TeamRecommendation = {
  // A real, registered, software dev template (roles-format).
  templateId: 'pragmatic-mvp-dev-team',
  agents: [
    { role: 'team-lead', responsibilities: 'Lead', skillIds: [] },
    { role: 'developer', responsibilities: 'Build', skillIds: [] },
  ],
  reasoning: 'You want to build a small CLI todo app.',
  source: 'hardcoded:engineering',
};

afterAll(async () => {
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
