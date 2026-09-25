/**
 * Real wiring of the bundle apply engine inside the backend.
 *
 * Adds the live collaborators to the base set (`bundle-deps.ts`): Slack
 * through SlackTeamChannelService, the orchestrator through the chat path
 * the onboarding first task uses, connector probes through the Cloud token
 * services, and the running CronTaskService. Also runs the timer that
 * delivers due first-week tasks and resumes deployments that were waiting
 * (on the backend, or on Slack).
 *
 * @module services/bundle/bundle-apply.factory
 */

import { BUNDLE_CONSTANTS } from '../../constants.js';
import type { Team } from '../../types/index.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { LoggerService } from '../core/logger.service.js';
import { CronTaskService } from '../workflow/cron-task.service.js';
import { getHarnessService } from '../harness/harness.service.js';
import { getSlackService } from '../slack/slack.service.js';
import { getSlackTeamChannelService } from '../slack/slack-team-channel.service.js';
import { GoogleWorkspaceTokenService } from '../google/google-workspace-token.service.js';
import { CanvaTokenService } from '../canva/canva-token.service.js';
import { MicrosoftTokenService } from '../microsoft/microsoft-token.service.js';
import { getWhatsAppService } from '../whatsapp/whatsapp.service.js';
import { BundleApplyService, type BundleApplyDeps, type BundleSlackApi } from './bundle-apply.service.js';
import { createConnectorChecker } from './bundle-connectors.js';
import type { BundleCatalog } from './bundle-catalog.js';
import { createBaseBundleDeps } from './bundle-deps.js';

const logger = LoggerService.getInstance().createComponentLogger('BundleApply');

/**
 * Slack through the team-channel service; reads as not connected when the
 * service is not up (Slack never configured on this machine).
 *
 * @returns Slack collaborator
 */
export function createSlackBundleApi(): BundleSlackApi {
  return {
    isConnected: () => {
      try {
        return !!getSlackTeamChannelService() && getSlackService().isConnected();
      } catch {
        return false;
      }
    },
    async ensureTeamChannel(team: Team) {
      const service = getSlackTeamChannelService();
      if (!service) throw new Error('Slack team channels are not running');
      const mapping = await service.ensureTeamChannel(team);
      return { slackChannelId: mapping.slackChannelId, slackChannelName: mapping.slackChannelName };
    },
    async ensureAgentChannel(input) {
      const service = getSlackTeamChannelService();
      if (!service) throw new Error('Slack team channels are not running');
      const mapping = await service.ensureAgentChannel(input);
      return { slackChannelId: mapping.slackChannelId, slackChannelName: mapping.slackChannelName };
    },
  };
}

/**
 * Backend collaborators.
 *
 * @returns Dependencies backed by the backend's services
 */
export function createBackendBundleDeps(): BundleApplyDeps & { catalog: BundleCatalog } {
  const base = createBaseBundleDeps({
    crewlyHome: getCrewlyHomePath(),
    // The backend runs with the package root as its working directory
    // (`crewly start`), the same assumption TemplateService makes.
    packageRoot: process.cwd(),
    getOrcHarness: () => getHarnessService().orc.get(),
  });
  return {
    ...base,
    slack: createSlackBundleApi(),
    schedules: { create: (request) => CronTaskService.getInstance().create(request) },
    orchestrator: {
      async send(content, metadata) {
        // Loaded lazily: the chat path pulls in the chat controller.
        const { sendViaChat } = await import('../onboarding/onboarding-checklist.factory.js');
        return sendViaChat(content, metadata);
      },
    },
    connectors: createConnectorChecker({
      'google-workspace': async () => {
        const status = await GoogleWorkspaceTokenService.getInstance().status();
        return { connected: status.connected, connections: status.connections.map((c) => ({ products: [...c.products] })) };
      },
      canva: async () => (await CanvaTokenService.getInstance().status()).connected,
      'microsoft-todo': async () => (await MicrosoftTokenService.getInstance().status()).connected,
      whatsapp: async () => getWhatsAppService().isConnected(),
      slack: async () => getSlackService().isConnected(),
    }),
  };
}

let deps: (BundleApplyDeps & { catalog: BundleCatalog }) | null = null;
let instance: BundleApplyService | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * The backend collaborators, built once.
 *
 * @returns Dependencies
 */
function backendDeps(): BundleApplyDeps & { catalog: BundleCatalog } {
  if (!deps) deps = createBackendBundleDeps();
  return deps;
}

/**
 * The backend's apply engine.
 *
 * @returns The singleton
 */
export function getBundleApplyService(): BundleApplyService {
  if (!instance) instance = new BundleApplyService(backendDeps());
  return instance;
}

/**
 * The backend's bundle catalog (OSS templates + CREWLY_TEMPLATE_DIRS).
 *
 * @returns The catalog
 */
export function getBundleCatalog(): BundleCatalog {
  return backendDeps().catalog;
}

/**
 * Replace or clear the singleton (tests).
 *
 * @param service - Service to use, or null to clear
 */
export function setBundleApplyServiceForTesting(service: BundleApplyService | null): void {
  instance = service;
  if (!service) deps = null;
}

/**
 * One maintenance pass: resume waiting deployments, deliver due tasks.
 *
 * @param service - Engine
 */
export async function runBundleMaintenance(service: BundleApplyService = getBundleApplyService()): Promise<void> {
  try {
    const resumed = await service.resumeWaiting();
    if (resumed.length > 0) logger.info('Resumed bundle deployments', { templates: resumed });
    const sent = await service.deliverDue();
    if (sent > 0) logger.info('Delivered first-week tasks', { count: sent });
  } catch (error) {
    logger.warn('Bundle maintenance failed (non-critical)', { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Start the maintenance timer (runs once right away). Idempotent.
 */
export function startBundleMaintenance(): void {
  if (timer) return;
  void runBundleMaintenance();
  timer = setInterval(() => void runBundleMaintenance(), BUNDLE_CONSTANTS.TICK_INTERVAL_MS);
  timer.unref();
}

/**
 * Stop the maintenance timer.
 */
export function stopBundleMaintenance(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
