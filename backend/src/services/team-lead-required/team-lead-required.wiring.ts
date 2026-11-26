/**
 * A team must have a lead — the real dependencies
 * (specs/2026-10-04-tl-delegation.md §6). Called once decision cards run:
 * builds the service, registers the `team_lead` card handler and starts the
 * check (a few minutes after boot, then hourly).
 *
 * @module services/team-lead-required/team-lead-required.wiring
 */

import * as path from 'path';
import { TEAM_LEAD_REQUIRED_CONSTANTS } from '../../constants.js';
import { REDIS_CONSTANTS } from '../../../../config/constants.js';
import type { Team } from '../../types/index.js';
import { findPackageRoot } from '../../utils/package-root.js';
import { RedisCacheService } from '../cache/redis-cache.service.js';
import { LoggerService } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import { DecisionService, type DecisionKindHandler } from '../decisions/decision.service.js';
import { TeamLeadRequiredService, setTeamLeadRequiredService, type TeamLeadDecisions } from './team-lead-required.service.js';
import { TeamLeadRequiredStore } from './team-lead-required.store.js';
import { applyTeamLead } from './team-lead.apply.js';

/** What the composition root provides. */
export interface TeamLeadRequiredWiringInput {
  crewlyHome: string;
  decisions: TeamLeadDecisions;
  /** Deliver text to an agent (wakes a stopped one) */
  sendToAgent: (session: string, text: string) => Promise<boolean>;
  /** Package root (the composition root's findPackageRoot(__dirname)) */
  packageRoot?: string;
  /** Team store (default: the process StorageService) */
  storage?: { getTeams(): Promise<Team[]>; saveTeam(team: Team): Promise<unknown> };
  /** Drops the cached team list after a change (default: the Redis cache) */
  invalidateTeams?: () => Promise<void>;
  /** Registers the kind handler (default: DecisionService.registerKindHandler) */
  register?: (kind: typeof TEAM_LEAD_REQUIRED_CONSTANTS.DECISION_KIND, handler: DecisionKindHandler | null) => void;
  /** False builds and registers without starting the timers (tests) */
  startTimers?: boolean;
}

/**
 * Build, register and start the service.
 *
 * @param input - Composition-root hooks
 * @returns The running service
 */
export function startTeamLeadRequired(input: TeamLeadRequiredWiringInput): TeamLeadRequiredService {
  const storage = input.storage ?? StorageService.getInstance();
  const invalidateTeams =
    input.invalidateTeams ??
    (async () => {
      await RedisCacheService.getInstance().invalidate(REDIS_CONSTANTS.KEYS.TEAMS_LIST);
    });
  const service = new TeamLeadRequiredService({
    store: TeamLeadRequiredStore.inHome(input.crewlyHome),
    getTeams: () => storage.getTeams(),
    decisions: () => input.decisions,
    setLead: async (team, memberId) => {
      // Same path as POST /api/teams/:id/lead; the route drops the cached
      // team list through its middleware, here it is done by hand.
      await applyTeamLead({ storage, team, memberId, mode: 'set', actor: { type: 'owner', via: 'decision' } });
      await invalidateTeams().catch(() => undefined);
    },
    deliverToAgent: input.sendToAgent,
    // The same lookup the decision cards use (crewly#1367), with no place:
    // the owner's recent messages decide.
    ownerLanguage: async () => {
      try {
        const { ownerLanguageOf } = await import('../orc/owner-completion-report.wiring.js');
        const { getChatV2Service } = await import('../chat-v2/chat-v2.singleton.js');
        return await ownerLanguageOf({ kind: 'owner' }, null, getChatV2Service(), () => null);
      } catch {
        return null;
      }
    },
    tlSkillsPath: path.join(input.packageRoot ?? findPackageRoot(process.cwd()), 'config', 'skills', 'team-leader'),
    logger: LoggerService.getInstance().createComponentLogger('TeamLeadRequired'),
  });
  (input.register ?? ((kind, handler) => DecisionService.registerKindHandler(kind, handler)))(TEAM_LEAD_REQUIRED_CONSTANTS.DECISION_KIND, service);
  setTeamLeadRequiredService(service);
  if (input.startTimers !== false) service.start();
  return service;
}
