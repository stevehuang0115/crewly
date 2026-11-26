/**
 * Temporary members and seat requests — the real dependencies
 * (specs/2026-11-26-temp-members-seat-requests.md). Called once decision
 * cards run: builds the service, registers the `team_seat` card handler and
 * starts the removal tick.
 *
 * Members are added and removed through the team controller's own paths
 * (`addMemberToTeam`, `stopTeamMemberGracefully` + `removeMemberFromTeam`),
 * so a temporary member is an ordinary member with a `temporary` record.
 *
 * @module services/temp-members/temp-member.wiring
 */

import * as path from 'path';
import { TEMP_MEMBER_CONSTANTS } from '../../constants.js';
import { REDIS_CONSTANTS } from '../../../../config/constants.js';
import type { ApiContext } from '../../controllers/types.js';
import type { Team } from '../../types/index.js';
import { findPackageRoot } from '../../utils/package-root.js';
import { isAgentBusy } from '../agent/member-relaunch.js';
import { PtyActivityTrackerService } from '../agent/pty-activity-tracker.service.js';
import { ResourceModeService } from '../agent/resource-mode.service.js';
import { RedisCacheService } from '../cache/redis-cache.service.js';
import { LoggerService } from '../core/logger.service.js';
import { DecisionService, type DecisionKindHandler } from '../decisions/decision.service.js';
import { getRoleService } from '../settings/role.service.js';
import { getSlackTeamChannelService } from '../slack/slack-team-channel.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { TlDelegationService } from '../tl-delegation/tl-delegation.service.js';
import { setTempMemberService, TempMemberService, type NewMemberInput, type SeatDecisions, type TempMemberDeps } from './temp-member.service.js';
import { TempMemberStore } from './temp-member.store.js';

/** The team-controller paths members are added and removed through. */
export interface MemberPaths {
  addMemberToTeam: (context: ApiContext, team: Team, input: NewMemberInput) => Promise<Team['members'][number]>;
  stopTeamMemberGracefully: (context: ApiContext, team: Team, member: Team['members'][number]) => Promise<{ success: boolean; error?: string }>;
  removeMemberFromTeam: (context: ApiContext, team: Team, memberId: string) => Promise<Team['members'][number] | null>;
}

/** What the composition root provides. */
export interface TempMemberWiringInput {
  /** Package root (the composition root's findPackageRoot(__dirname)) */
  packageRoot?: string;
  crewlyHome: string;
  decisions: SeatDecisions;
  /** Deliver text to an agent (wakes a stopped one) */
  sendToAgent: (session: string, text: string) => Promise<boolean>;
  /** The API context the team controller's member paths run with */
  apiContext: () => ApiContext;
  /** Registers the kind handler (DecisionService.registerKindHandler) */
  register?: (kind: 'team_seat', handler: DecisionKindHandler | null) => void;
  /** The member paths (default: the team controller's) */
  memberPaths?: () => Promise<MemberPaths>;
}

/**
 * The add / remove functions of {@link TempMemberDeps} over the team
 * controller's member paths. Removing stops a running session the way
 * stop-agent does, then removes the member; the cached team list is dropped
 * either way.
 *
 * @param input - API context and the member paths
 * @returns `addMember`, `removeMember` and `saveTeam`
 */
export function createMemberOps(input: { apiContext: () => ApiContext; memberPaths: () => Promise<MemberPaths>; invalidate?: () => Promise<void> }): Pick<TempMemberDeps, 'addMember' | 'removeMember' | 'saveTeam'> {
  const invalidate = input.invalidate ?? (async () => undefined);
  const teamOf = async (teamId: string): Promise<Team | undefined> => (await input.apiContext().storageService.getTeams()).find((t) => t.id === teamId);
  return {
    addMember: async (teamId, member) => {
      const team = await teamOf(teamId);
      if (!team) throw new Error('Team not found');
      const { addMemberToTeam } = await input.memberPaths();
      const added = await addMemberToTeam(input.apiContext(), team, member);
      await invalidate().catch(() => undefined);
      return added;
    },
    removeMember: async (teamId, memberId) => {
      const team = await teamOf(teamId);
      const member = team?.members.find((m) => m.id === memberId);
      if (!team || !member) return false;
      const { stopTeamMemberGracefully, removeMemberFromTeam } = await input.memberPaths();
      // A failed graceful stop is not fatal: the remove path kills what is left of the session.
      if (member.sessionName) await stopTeamMemberGracefully(input.apiContext(), team, member).catch(() => undefined);
      const removed = await removeMemberFromTeam(input.apiContext(), team, memberId);
      await invalidate().catch(() => undefined);
      return !!removed;
    },
    saveTeam: async (team) => {
      await input.apiContext().storageService.saveTeam(team);
      await invalidate().catch(() => undefined);
    },
  };
}

/**
 * Build, register and start the temporary-member service.
 *
 * @param input - Composition-root hooks
 * @returns The running service
 */
export function startTempMembers(input: TempMemberWiringInput): TempMemberService {
  const logger = LoggerService.getInstance().createComponentLogger('TempMembers');
  const memberPaths = input.memberPaths ?? (async () => (await import('../../controllers/team/team.controller.js')) as unknown as MemberPaths);
  const service = new TempMemberService({
    store: TempMemberStore.inHome(input.crewlyHome),
    getTeams: () => input.apiContext().storageService.getTeams(),
    ...createMemberOps({
      apiContext: input.apiContext,
      memberPaths,
      // The cached team list would still show (or miss) the member.
      invalidate: () => RedisCacheService.getInstance().invalidate(REDIS_CONSTANTS.KEYS.TEAMS_LIST).then(() => undefined),
    }),
    knownRoles: async () => (await getRoleService().listRoles()).map((r) => r.name),
    underMemoryPressure: () => ResourceModeService.getInstance().getMode() === 'pressure',
    workItems: () => TaskPoolService.getInstance().getAllItems(),
    isBusy: (session) => isAgentBusy(session),
    lastActivityAt: (session) => lastPtyActivityAt(session),
    noMemberFitsCount: (teamId, sessions, sinceMs) => TlDelegationService.getInstance().keptWorkSince(sinceMs, { teamId, sessions }).length,
    decisions: () => input.decisions,
    deliverToAgent: input.sendToAgent,
    teamChannelOf: async (teamId) => {
      const mappings = (await getSlackTeamChannelService()?.listMappings().catch(() => [])) ?? [];
      return mappings.find((m) => m.teamId === teamId)?.slackChannelId ?? null;
    },
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
    logger,
  });
  setTempMemberService(service);
  (input.register ?? ((kind, handler) => DecisionService.registerKindHandler(kind, handler)))(TEMP_MEMBER_CONSTANTS.DECISION_KIND, service);
  service.start();
  return service;
}

/**
 * When a session last printed to its terminal.
 *
 * @param session - Session name
 * @returns Epoch ms, or null when it never printed
 */
export function lastPtyActivityAt(session: string): number | null {
  const tracker = PtyActivityTrackerService.getInstance();
  if (!tracker.hasActivity(session)) return null;
  return Date.now() - tracker.getIdleTimeMs(session);
}
