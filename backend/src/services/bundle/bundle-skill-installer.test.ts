/**
 * Tests for the marketplace skill installer used by bundles: bundled and
 * installed skills count as available, missing ones are installed from the
 * registry, and nothing is installed outside the deployment's CREWLY_HOME.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { MarketplaceItem } from '../../types/marketplace.types.js';
import { createMarketplaceSkillInstaller, findBundledSkill, createSkillSetupInstaller } from './bundle-skill-installer.js';

describe('bundle skill installer', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'bundle-skills-'));
    mkdirSync(path.join(root, 'config', 'skills', 'agent', 'core', 'gmail-search'), { recursive: true });
    writeFileSync(path.join(root, 'config', 'skills', 'agent', 'core', 'gmail-search', 'SKILL.md'), '# x');
    mkdirSync(path.join(root, 'config', 'skills', 'agent', 'web-search'), { recursive: true });
    writeFileSync(path.join(root, 'config', 'skills', 'agent', 'web-search', 'execute.sh'), '');
    mkdirSync(path.join(root, 'config', 'skills', 'agent', 'empty-dir'), { recursive: true });
    mkdirSync(path.join(root, 'installed', 'my-skill'), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds bundled skills at any depth and ignores folders without a skill file', () => {
    expect(findBundledSkill(root, 'gmail-search')).toBe(path.join(root, 'config', 'skills', 'agent', 'core', 'gmail-search'));
    expect(findBundledSkill(root, 'web-search')).not.toBeNull();
    expect(findBundledSkill(root, 'empty-dir')).toBeNull();
    expect(findBundledSkill(root, 'nope')).toBeNull();
  });

  /** Installer over the temp tree. */
  function installer(overrides: Partial<Parameters<typeof createMarketplaceSkillInstaller>[0]> = {}) {
    const item = { id: 'remote-skill', type: 'skill', name: 'Remote', version: '1.0.0' } as MarketplaceItem;
    const installItem = jest.fn(async () => ({ success: true, message: 'Installed Remote v1.0.0' }));
    return {
      installItem,
      skills: createMarketplaceSkillInstaller({
        packageRoot: root,
        crewlyHome: '/home/u/.crewly',
        marketplaceHome: '/home/u/.crewly',
        installPath: (id) => path.join(root, 'installed', id),
        fetchRegistry: async () => ({ items: [item] }) as never,
        installItem,
        ...overrides,
      }),
    };
  }

  it('bundled or installed skills are available', async () => {
    const { skills } = installer();
    expect(await skills.isAvailable('gmail-search')).toBe(true);
    expect(await skills.isAvailable('my-skill')).toBe(true);
    expect(await skills.isAvailable('remote-skill')).toBe(false);
  });

  it('installs from the registry', async () => {
    const { skills, installItem } = installer();
    expect(await skills.install('remote-skill')).toEqual({ ok: true, message: 'Installed Remote v1.0.0' });
    expect(installItem).toHaveBeenCalledTimes(1);
    expect(await skills.install('not-there')).toEqual({ ok: false, message: '"not-there" is not in the marketplace' });
  });

  it('refuses to install into ~/.crewly when the deployment uses another CREWLY_HOME', async () => {
    const { skills, installItem } = installer({ crewlyHome: '/tmp/trial-home' });
    const result = await skills.install('remote-skill');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not this CREWLY_HOME/);
    expect(installItem).not.toHaveBeenCalled();
  });

  it('treats an invalid install path as not installed', async () => {
    const { skills } = installer({ installPath: () => { throw new Error('bad id'); } });
    expect(await skills.isAvailable('Bad/Id')).toBe(false);
  });
});

describe('createSkillSetupInstaller (skill-setup services)', () => {
  type S = { installed: boolean; ready?: boolean };
  function deps(skill: S | null, job: { state: string; log: string } = { state: 'succeeded', log: '' }, home = '/h') {
    const started: Array<{ skillId: string; ownerDashboard?: boolean }> = [];
    return {
      started,
      installer: createSkillSetupInstaller<S>({
        discovery: { resolve: async () => skill, probe: async (s) => s },
        jobs: {
          startInstall: async (input) => {
            started.push(input);
            return { kind: 'job', job: { jobId: 'j1' } };
          },
          waitForJob: async () => job,
        },
        crewlyHome: home,
        marketplaceHome: '/h',
      }),
    };
  }

  it('is available only when installed and set up', async () => {
    expect(await deps({ installed: true, ready: true }).installer.isAvailable('x')).toBe(true);
    expect(await deps({ installed: true, ready: false }).installer.isAvailable('x')).toBe(false);
    expect(await deps({ installed: false }).installer.isAvailable('x')).toBe(false);
    expect(await deps(null).installer.isAvailable('x')).toBe(false);
  });

  it('installs as the owner and waits for the job', async () => {
    const d = deps({ installed: false });
    expect(await d.installer.install('pdf-tools')).toEqual({ ok: true, message: 'pdf-tools installed and set up' });
    expect(d.started[0]).toMatchObject({ skillId: 'pdf-tools', ownerDashboard: true });
    const failed = deps({ installed: true, ready: false }, { state: 'failed', log: 'a\nb\napt needs root' });
    expect((await failed.installer.install('x')).ok).toBe(false);
  });

  it('refuses a marketplace download into another CREWLY_HOME, but sets up a local skill there', async () => {
    const remote = deps({ installed: false }, undefined, '/tmp/other');
    expect((await remote.installer.install('x')).ok).toBe(false);
    expect(remote.started).toEqual([]);
    const local = deps({ installed: true, ready: false }, undefined, '/tmp/other');
    expect((await local.installer.install('x')).ok).toBe(true);
  });
});
