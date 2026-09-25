/**
 * Tests for the marketplace skill installer used by bundles: bundled and
 * installed skills count as available, missing ones are installed from the
 * registry, and nothing is installed outside the deployment's CREWLY_HOME.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { MarketplaceItem } from '../../types/marketplace.types.js';
import { createMarketplaceSkillInstaller, findBundledSkill } from './bundle-skill-installer.js';

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
