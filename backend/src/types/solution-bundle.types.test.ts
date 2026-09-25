/**
 * Tests for the solution bundle types: the manifest and deployment shapes
 * compile as documented, and a template's `bundle` section is optional on
 * TeamTemplate (backward compatible).
 */

import type { TeamTemplate } from './team-template.types.js';
import type { BundleDeployment, BundleTemplate, SolutionBundle } from './solution-bundle.types.js';

describe('solution bundle types', () => {
  it('a minimal bundle section needs only the owner-facing basics, runtime and server', () => {
    const bundle: SolutionBundle = {
      schemaVersion: 1,
      label: '小老板营销团队',
      tagline: 't',
      ownerSummary: 's',
      runtime: { recommended: 'crewly-agent' },
      server: { tier: 'entry' },
    };
    expect(bundle.questions).toBeUndefined();
  });

  it('TeamTemplate keeps working without a bundle and accepts one', () => {
    const base: Omit<TeamTemplate, 'bundle'> = {
      id: 'x',
      name: 'X',
      description: '',
      category: 'content',
      version: '1.0.0',
      hierarchical: false,
      roles: [],
      defaultRuntime: 'claude-code',
      verificationPipeline: { name: 'p', steps: [], passPolicy: 'all', maxRetries: 0 },
    };
    const plain: TeamTemplate = base;
    const withBundle: TeamTemplate = {
      ...base,
      bundle: { schemaVersion: 1, label: 'l', tagline: 't', ownerSummary: 's', runtime: { recommended: 'claude-code' }, server: { tier: 'standard' } },
    };
    expect(plain.bundle).toBeUndefined();
    expect(withBundle.bundle?.server.tier).toBe('standard');
  });

  it('a bundle template and a deployment have the documented shape', () => {
    const template: BundleTemplate = {
      id: 't',
      name: 'T',
      description: '',
      roles: [],
      bundle: { schemaVersion: 1, label: 'l', tagline: 't', ownerSummary: 's', runtime: { recommended: 'codex-cli' }, server: { tier: 'advanced' } },
    };
    const deployment: BundleDeployment = {
      templateId: template.id,
      templateVersion: '1.0.0',
      jobId: 'j',
      status: 'partial',
      runtime: 'codex-cli',
      answers: { platforms: ['小红书'] },
      startedAt: '',
      updatedAt: '',
      teams: [{ key: 'main', teamId: 't', name: 'T' }],
      steps: [{ id: 'slack', label: '建 Slack 频道', status: 'pending', reason: 'slack_not_connected' }],
      connectors: [{ id: 'canva', products: [], required: false, why: 'x', status: 'unknown', connectPath: '/connections?platform=canva' }],
      firstWeek: [{ id: 'a', title: 'A', day: 0, dueAt: '', teamId: 't', target: 's', status: 'scheduled' }],
      schedules: { daily: 'cron-1' },
      channels: { approvals: 'C1' },
    };
    expect(deployment.steps[0].status).toBe('pending');
  });
});
