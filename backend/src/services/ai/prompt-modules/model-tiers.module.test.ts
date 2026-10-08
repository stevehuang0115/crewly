/**
 * Tests for ModelTiersModule — the lead's tier section when "Optimize usage" is on (crewly#1173).
 */

import { ModelTiersModule } from './model-tiers.module.js';
import type { ModuleConfig } from './prompt-module.interface.js';

const base: ModuleConfig = {
  sessionName: 'mkt-owen',
  memberId: 'm-owen',
  role: 'team-leader',
  agentSkillsPath: '/skills/agent',
  tlSkillsPath: '/skills/team-leader',
  projectRoot: '/crewly',
};

const tiers = {
  optimizeUsage: true,
  members: [
    { name: 'Owen', tier: null, model: 'runtime default' },
    { name: 'Ella', tier: 'weak', model: 'haiku' },
  ],
  routingRules: ['polling / formatting -> Ella'],
};

describe('ModelTiersModule', () => {
  const mod = new ModelTiersModule();

  it('is only for a lead of a team with Optimize usage on', () => {
    expect(mod.shouldInclude({ ...base, canDelegate: true, teamTiers: tiers })).toBe(true);
    expect(mod.shouldInclude({ ...base, canDelegate: false, teamTiers: tiers })).toBe(false);
    expect(mod.shouldInclude({ ...base, canDelegate: true })).toBe(false);
    expect(mod.shouldInclude({ ...base, canDelegate: true, teamTiers: { ...tiers, optimizeUsage: false } })).toBe(false);
  });

  it('lists members by tier, the routing rules and the skill', async () => {
    const text = await mod.build({ ...base, canDelegate: true, teamTiers: tiers });
    expect(text).toContain('## Model Tiers ("Optimize usage" is on)');
    expect(text).toContain('- Ella: weak → haiku');
    expect(text).toContain('- Owen: no tier → runtime default');
    expect(text).toContain('- polling / formatting -> Ella');
    expect(text).toContain('bash /skills/team-leader/propose-tier-change/execute.sh');
    expect(text).toContain('The owner approves every change');
  });
});
