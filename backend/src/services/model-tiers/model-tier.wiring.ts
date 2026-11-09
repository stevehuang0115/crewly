/**
 * Model tiers — the real dependencies (crewly#1173). Called once decision
 * cards run: builds the service, registers the `model_tier_change` card
 * handler, and starts the hourly tick. After an apply, an idle member whose
 * model changed is restarted through the same relaunch path the runtime
 * fallback uses (`services/agent/member-relaunch`).
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
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { isAgentBusy, startMemberSession, stopForRelaunch, type MemberRelaunchRegistration } from '../agent/member-relaunch.js';
import { clearPlannedRelaunch, markPlannedRelaunch } from '../agent/planned-relaunch.registry.js';
import { ModelTierService, setModelTierService, type TierDecisions, type TierRestartOutcome } from './model-tier.service.js';
import { ModelTierStore } from './model-tier.store.js';

/** What the composition root provides. */
export interface ModelTierWiringInput {
  /** Package root (the composition root's findPackageRoot(__dirname)) */
  packageRoot?: string;
  crewlyHome: string;
  decisions: TierDecisions;
  /** Deliver text to an agent (wakes a stopped one) */
  sendToAgent: (session: string, text: string) => Promise<boolean>;
  /** Registers the kind handler (DecisionService.registerKindHandler) */
  register?: (kind: 'model_tier_change', handler: DecisionKindHandler | null) => void;
  /** The agent registration service, once it runs (absent = no restarts on apply) */
  registration?: () => (MemberRelaunchRegistration & { isInProcessRuntimeActive(sessionName: string): boolean }) | null;
  /** Whether a PTY session exists */
  sessionExists?: (sessionName: string) => boolean;
}

/** What {@link createIdleRestarter} needs (real ones in {@link startModelTiers}). */
export interface IdleRestarterDeps {
  /** The member's session is running (PTY or in-process) */
  isLive: (session: string) => boolean;
  /** Mid-turn (working status / recent PTY output) */
  isBusy: (session: string) => Promise<boolean>;
  /** Work items (to see claimed work in progress) */
  workItems: () => Promise<WorkItem[]>;
  /** Stop and start the member again; true when the new session runs */
  relaunch: (session: string) => Promise<boolean>;
}

/**
 * Restart a member whose model changed, only when it is idle: running, no
 * turn in progress, and no claimed work item in progress (`running` /
 * `accepted`). A stopped member is left alone (its next start uses the new
 * model); a busy one too — never killed mid-turn.
 *
 * @param deps - Liveness, busy check, work items, relaunch
 * @returns The restarter
 */
export function createIdleRestarter(deps: IdleRestarterDeps): (session: string) => Promise<TierRestartOutcome> {
  const busyStatuses = MODEL_TIER_CONSTANTS.BUSY_WORK_STATUSES as readonly string[];
  return async (session) => {
    if (!deps.isLive(session)) return 'not_running';
    const items = await deps.workItems().catch(() => null);
    if (!items || items.some((wi) => wi.target === session && busyStatuses.includes(wi.status))) return 'busy';
    if (await deps.isBusy(session).catch(() => true)) return 'busy';
    const ok = await deps.relaunch(session).catch(() => false);
    return ok ? 'restarted' : 'failed';
  };
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
  const logger = LoggerService.getInstance().createComponentLogger('ModelTiers');
  const registration = input.registration;
  const restartIfIdle = registration
    ? createIdleRestarter({
        isLive: (session) => {
          try {
            return !!registration()?.isInProcessRuntimeActive(session) || !!input.sessionExists?.(session);
          } catch {
            return false;
          }
        },
        isBusy: (session) => isAgentBusy(session),
        workItems: () => TaskPoolService.getInstance().getAllItems(),
        relaunch: async (session) => {
          const reg = registration();
          if (!reg) return false;
          // A model change is not a crash or a hang: the restart / heartbeat /
          // hung monitors leave the session alone through the relaunch.
          markPlannedRelaunch(session, MODEL_TIER_CONSTANTS.RELAUNCH_REASON);
          let ok = false;
          try {
            await stopForRelaunch(reg, session);
            ok = await startMemberSession(
              {
                storage,
                cwdOf: async (s) => {
                  const { getSessionStatePersistence } = await import('../session/session-state-persistence.js');
                  return getSessionStatePersistence().getSessionMetadata(s)?.cwd;
                },
                logger,
              },
              reg,
              session,
            );
          } finally {
            if (ok) markPlannedRelaunch(session, MODEL_TIER_CONSTANTS.RELAUNCH_REASON);
            else clearPlannedRelaunch(session);
          }
          return ok;
        },
      })
    : undefined;
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
    // `__dirname` does not exist in the ESM build (it crashed this wiring in
    // 1.20.275); the composition root passes the package root it already knows.
    tlSkillsPath: path.join(input.packageRoot ?? findPackageRoot(process.cwd()), 'config', 'skills', 'team-leader'),
    ...(restartIfIdle ? { restartIfIdle } : {}),
    logger,
  });
  setModelTierService(service);
  (input.register ?? ((kind, handler) => DecisionService.registerKindHandler(kind, handler)))(MODEL_TIER_CONSTANTS.DECISION_KIND, service);
  service.start();
  return service;
}
