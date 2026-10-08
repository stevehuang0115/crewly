/**
 * Model tiers — the real dependencies (crewly#1173). Called once decision
 * cards run: builds the service, registers the `model_tier_change` card
 * handler, and starts the hourly tick.
 *
 * @module services/model-tiers/model-tier.wiring
 */

import * as path from 'path';
import { MODEL_TIER_CONSTANTS } from '../../constants.js';
import { REDIS_CONSTANTS } from '../../../../config/constants.js';
import { RedisCacheService } from '../cache/redis-cache.service.js';
import type { Team } from '../../types/index.js';
import { findPackageRoot } from '../../utils/package-root.js';
import { LoggerService } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import { DecisionService, type DecisionKindHandler } from '../decisions/decision.service.js';
import { TokenUsageService } from '../monitoring/token-usage.service.js';
import { getSlackTeamChannelService } from '../slack/slack-team-channel.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { ModelTierService, setModelTierService, type TierDecisions } from './model-tier.service.js';
import { ModelTierStore } from './model-tier.store.js';

/** What the composition root provides. */
export interface ModelTierWiringInput {
  crewlyHome: string;
  decisions: TierDecisions;
  /** Deliver text to an agent (wakes a stopped one) */
  sendToAgent: (session: string, text: string) => Promise<boolean>;
  /** Registers the kind handler (DecisionService.registerKindHandler) */
  register?: (kind: 'model_tier_change', handler: DecisionKindHandler | null) => void;
}

/**
 * Build, register and start the model-tier service.
 *
 * @param input - Composition-root hooks
 * @returns The running service
 */
export function startModelTiers(input: ModelTierWiringInput): ModelTierService {
  const storage = StorageService.getInstance();
  const usage = TokenUsageService.getInstance();
  const service = new ModelTierService({
    store: ModelTierStore.inHome(input.crewlyHome),
    getTeams: () => storage.getTeams(),
    saveTeam: async (team: Team) => {
      await storage.saveTeam(team);
      // The cached team list would show the old tiers / toggle.
      await RedisCacheService.getInstance().invalidate(REDIS_CONSTANTS.KEYS.TEAMS_LIST).catch(() => undefined);
    },
    forEachEvent: (visit, since) => usage.forEachEvent(visit, since),
    workItems: () => TaskPoolService.getInstance().getAllItems(),
    decisions: () => input.decisions,
    deliverToAgent: input.sendToAgent,
    teamChannelOf: async (teamId) => {
      const mappings = (await getSlackTeamChannelService()?.listMappings().catch(() => [])) ?? [];
      return mappings.find((m) => m.teamId === teamId)?.slackChannelId ?? null;
    },
    tlSkillsPath: path.join(findPackageRoot(__dirname), 'config', 'skills', 'team-leader'),
    logger: LoggerService.getInstance().createComponentLogger('ModelTiers'),
  });
  setModelTierService(service);
  (input.register ?? ((kind, handler) => DecisionService.registerKindHandler(kind, handler)))(MODEL_TIER_CONSTANTS.DECISION_KIND, service);
  service.start();
  return service;
}
