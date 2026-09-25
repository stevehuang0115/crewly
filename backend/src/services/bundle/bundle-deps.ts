/**
 * The collaborators every bundle deployment needs, backend or not.
 *
 * Kept free of the backend's live singletons (Slack, chat, Cloud), so the
 * CLI can deploy a bundle while Crewly is not running: the team, norms,
 * SOPs, skills and schedules are all files; Slack, connector checks and
 * first-week hand-offs are left `pending` and done by the backend when it
 * starts (`BundleApplyService.resumeWaiting` / `deliverDue`).
 *
 * @module services/bundle/bundle-deps
 */

import { homedir } from 'os';
import * as path from 'path';
import { StorageService } from '../core/storage.service.js';
import { CronTaskService } from '../workflow/cron-task.service.js';
import type { BundleApplyDeps } from './bundle-apply.service.js';
import { BundleCatalog, bundleTemplateDirs } from './bundle-catalog.js';
import { resolveBundleRuntime } from './bundle-runtime.js';
import { createSkillSetupInstaller } from './bundle-skill-installer.js';
import { getSkillDiscoveryService } from '../skill-setup/skill-discovery.service.js';
import { getSkillInstallJobService } from '../skill-setup/skill-install-job.service.js';
import { BundleDeploymentStore } from './bundle-state.store.js';

/** Inputs of {@link createBaseBundleDeps}. */
export interface BaseBundleDepsOptions {
  /** Crewly home to deploy into */
  crewlyHome: string;
  /** Crewly package root (bundled templates and skills) */
  packageRoot: string;
  /** Extra template directories (CLI `--templates-dir`), before CREWLY_TEMPLATE_DIRS */
  extraTemplateDirs?: string[];
  /** The orchestrator's harness on this machine */
  getOrcHarness(): Promise<string | null>;
  /** Environment (tests) */
  env?: NodeJS.ProcessEnv;
}

/**
 * Collaborators without Slack, connector checks or orchestrator hand-offs
 * (those are `null`: the engine records the steps as pending).
 *
 * @param options - Homes, package root, harness lookup
 * @returns Dependencies
 */
export function createBaseBundleDeps(options: BaseBundleDepsOptions): BundleApplyDeps & { catalog: BundleCatalog } {
  const env = options.env ?? process.env;
  const storage = StorageService.getInstance(options.crewlyHome);
  const cron = new CronTaskService(options.crewlyHome);
  return {
    catalog: new BundleCatalog(() => bundleTemplateDirs(options.packageRoot, options.extraTemplateDirs ?? [], env)),
    store: new BundleDeploymentStore(options.crewlyHome),
    crewlyHome: options.crewlyHome,
    teams: {
      get: async (teamId) => (await storage.getTeams()).find((t) => t.id === teamId) ?? null,
      save: (team) => storage.saveTeam(team),
    },
    skills: createSkillSetupInstaller({
      discovery: getSkillDiscoveryService(),
      jobs: getSkillInstallJobService(),
      crewlyHome: options.crewlyHome,
      marketplaceHome: path.join(homedir(), '.crewly'),
    }),
    slack: null,
    schedules: { create: (request) => cron.create(request) },
    orchestrator: null,
    connectors: null,
    resolveRuntime: async (recommended, requested) =>
      resolveBundleRuntime({
        recommended,
        requested,
        orcHarness: await options.getOrcHarness().catch(() => null),
        hasDeepseekKey: !!env.DEEPSEEK_API_KEY,
      }),
    now: () => new Date(),
  };
}
