/**
 * Skill installation for bundles, through the existing marketplace install.
 *
 * Kept behind {@link BundleSkillInstaller} so the apply engine can switch to
 * the skill-autoinstall runner (`feat/skill-autoinstall`: skill discovery
 * over bundled / installed / registry skills + install jobs with setup
 * recipes) when it lands, without touching the engine.
 *
 * A skill counts as available when it is bundled with Crewly
 * (`config/skills/{agent,team-leader,orchestrator}/**`) or already installed
 * from the marketplace. Missing ones are installed with the marketplace
 * installer (`POST /api/marketplace/:id/install` / `crewly install <id>`).
 *
 * @module services/bundle/bundle-skill-installer
 */

import { existsSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import type { MarketplaceItem, MarketplaceRegistry } from '../../types/marketplace.types.js';
import type { BundleSkillInstaller } from './bundle-apply.service.js';

/** Skill roots under `config/skills/` that ship with Crewly. */
const BUNDLED_SKILL_ROOTS = ['agent', 'team-leader', 'orchestrator'] as const;
/** How deep a skill folder may sit under a root (e.g. agent/core/<id>). */
const MAX_SKILL_DEPTH = 3;
/** Files that make a folder a skill. */
const SKILL_MARKERS = ['SKILL.md', 'skill.json', 'execute.sh'] as const;

/**
 * Find a skill folder by id under the bundled skill roots.
 *
 * @param packageRoot - Crewly package root (contains `config/skills`)
 * @param skillId - Skill id (folder name)
 * @returns The folder, or null
 */
export function findBundledSkill(packageRoot: string, skillId: string): string | null {
  const walk = (dir: string, depth: number): string | null => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || entry.startsWith('_')) continue;
      const full = path.join(dir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (entry === skillId && SKILL_MARKERS.some((m) => existsSync(path.join(full, m)))) return full;
      if (depth < MAX_SKILL_DEPTH) {
        const found = walk(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  for (const root of BUNDLED_SKILL_ROOTS) {
    const found = walk(path.join(packageRoot, 'config', 'skills', root), 1);
    if (found) return found;
  }
  return null;
}

/** What the marketplace installer needs. */
export interface MarketplaceSkillInstallerDeps {
  /** Crewly package root */
  packageRoot: string;
  /** The Crewly home this deployment writes to */
  crewlyHome: string;
  /**
   * The Crewly home the marketplace installer writes to. The marketplace
   * code always uses `~/.crewly`; when a deployment runs under another
   * CREWLY_HOME (tests, trials) installing would write outside it, so the
   * installer refuses instead.
   */
  marketplaceHome: string;
  /** Local install folder of a skill */
  installPath(skillId: string): string;
  fetchRegistry(): Promise<MarketplaceRegistry>;
  installItem(item: MarketplaceItem): Promise<{ success: boolean; message: string }>;
}

/**
 * A {@link BundleSkillInstaller} over the marketplace.
 *
 * @param deps - Package root, homes and marketplace functions
 * @returns Installer
 */
export function createMarketplaceSkillInstaller(deps: MarketplaceSkillInstallerDeps): BundleSkillInstaller {
  return {
    async isAvailable(skillId) {
      if (findBundledSkill(deps.packageRoot, skillId)) return true;
      try {
        return existsSync(deps.installPath(skillId));
      } catch {
        return false;
      }
    },
    async install(skillId) {
      if (path.resolve(deps.crewlyHome) !== path.resolve(deps.marketplaceHome)) {
        return {
          ok: false,
          message: `Not installed: the marketplace installs into ${deps.marketplaceHome}, not this CREWLY_HOME (${deps.crewlyHome})`,
        };
      }
      const registry = await deps.fetchRegistry();
      const item = registry.items.find((i) => i.id === skillId && i.type === 'skill');
      if (!item) return { ok: false, message: `"${skillId}" is not in the marketplace` };
      const result = await deps.installItem(item);
      return { ok: result.success, message: result.message };
    },
  };
}

/** The parts of the skill-setup services the bundle installer uses. */
export interface SkillSetupInstallerDeps<S extends { installed: boolean; ready?: boolean } = { installed: boolean; ready?: boolean }> {
  /** SkillDiscoveryService: resolve + probe (is it set up?) */
  discovery: {
    resolve(id: string): Promise<S | null>;
    probe(skill: S): Promise<S>;
  };
  /** SkillInstallJobService: install + setup as a job */
  jobs: {
    startInstall(input: { skillId: string; ownerDashboard?: boolean; resumeNote?: string }): Promise<
      { kind: 'already-ready' } | { kind: 'job'; job: { jobId: string } }
    >;
    waitForJob(jobId: string): Promise<{ state: string; log: string }>;
  };
  /** Home this deploy writes to */
  crewlyHome: string;
  /** Home the marketplace download writes to (always ~/.crewly today) */
  marketplaceHome: string;
}

/**
 * Bundle skill installer on the skill-setup services (specs/skill-auto-install.md):
 * a skill counts as available only when its declared dependencies are set up,
 * and installing runs that setup too (brew/apt/model downloads). Deploying a
 * bundle is the owner's own action, so third-party skills in it install as
 * the owner (`ownerDashboard`).
 *
 * @param deps - Discovery and install-job services
 * @returns Installer for the apply engine
 */
export function createSkillSetupInstaller<S extends { installed: boolean; ready?: boolean }>(deps: SkillSetupInstallerDeps<S>): BundleSkillInstaller {
  return {
    async isAvailable(skillId) {
      const skill = await deps.discovery.resolve(skillId);
      if (!skill || !skill.installed) return false;
      const probed = await deps.discovery.probe(skill);
      return probed.ready !== false;
    },
    async install(skillId) {
      const skill = await deps.discovery.resolve(skillId);
      if (!skill) return { ok: false, message: `"${skillId}" is not bundled with Crewly or listed in the marketplace` };
      // A download from the marketplace lands in ~/.crewly whatever CREWLY_HOME
      // says — refuse rather than write into the real home from a test deploy.
      if (!skill.installed && path.resolve(deps.crewlyHome) !== path.resolve(deps.marketplaceHome)) {
        return {
          ok: false,
          message: `Not installed: the marketplace installs into ${deps.marketplaceHome}, not this CREWLY_HOME (${deps.crewlyHome})`,
        };
      }
      const started = await deps.jobs.startInstall({ skillId, ownerDashboard: true, resumeNote: 'solution bundle deploy' });
      if (started.kind === 'already-ready') return { ok: true, message: `${skillId} already set up` };
      const job = await deps.jobs.waitForJob(started.job.jobId);
      const tail = job.log.trim().split('\n').slice(-3).join(' | ');
      return job.state === 'succeeded'
        ? { ok: true, message: `${skillId} installed and set up` }
        : { ok: false, message: `${skillId} install failed${tail ? `: ${tail}` : ''}` };
    },
  };
}
