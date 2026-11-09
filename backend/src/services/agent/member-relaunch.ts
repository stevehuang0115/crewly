/**
 * Relaunching a team member on purpose — shared by the runtime fallback
 * (moving an idle agent to another runtime) and model tiers (an idle member
 * whose model changed, crewly#1173).
 *
 * The path: check that the agent is idle (no running turn, no recent PTY
 * output), stop its session the way a relaunch does
 * (`AgentRegistrationService.stopSessionForRelaunch`: exit monitoring off,
 * PTY killed, conversation id kept), forget its PTY activity and hung state,
 * then `createAgentSession` again — which resumes the conversation when
 * auto-resume is on and resolves the member's model afresh.
 *
 * Callers mark the session with `markPlannedRelaunch` around the relaunch so
 * the restart / heartbeat / hung monitors leave it alone.
 *
 * @module services/agent/member-relaunch
 */

import { RUNTIME_FALLBACK_CONSTANTS } from '../../constants.js';

/** The registration-service calls a relaunch makes. */
export interface MemberRelaunchRegistration {
  stopSessionForRelaunch(sessionName: string): Promise<boolean>;
  createAgentSession(config: { sessionName: string; role: string; projectPath?: string; memberId?: string; teamId?: string }): Promise<{ success: boolean; error?: string }>;
}

/** Team / project facts a relaunch reads. */
export interface MemberRelaunchStorage {
  getTeams(): Promise<Array<{ id: string; projectIds: string[]; members: Array<{ id: string; role: string; sessionName: string }> }>>;
  getProjects(): Promise<Array<{ id: string; path: string }>>;
}

/** What {@link startMemberSession} needs. */
export interface StartMemberContext {
  storage: MemberRelaunchStorage;
  /** The agent's last working directory, when the team has no project */
  cwdOf?: (sessionName: string) => Promise<string | undefined>;
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * Whether an agent is mid-turn: its observed working status is
 * `in_progress`, or its PTY printed within `quietMs`.
 *
 * @param sessionName - Session
 * @param quietMs - PTY quiet time that counts as idle
 * @returns True when busy (or unknown — a failure reads as busy)
 */
export async function isAgentBusy(sessionName: string, quietMs: number = RUNTIME_FALLBACK_CONSTANTS.IDLE_QUIET_MS): Promise<boolean> {
  try {
    const { ActivityMonitorService } = await import('../monitoring/activity-monitor.service.js');
    const { PtyActivityTrackerService } = await import('./pty-activity-tracker.service.js');
    if (ActivityMonitorService.getInstance().getObservedWorkingStatus(sessionName) === 'in_progress') return true;
    const tracker = PtyActivityTrackerService.getInstance();
    return tracker.hasActivity(sessionName) && tracker.getIdleTimeMs(sessionName) < quietMs;
  } catch {
    return true;
  }
}

/**
 * Stop a session for a relaunch and forget its PTY activity and hung state
 * (grace-revokes of the old session must not flag the new one as hung).
 *
 * @param reg - Registration service
 * @param sessionName - Session
 * @returns True when the session was stopped
 */
export async function stopForRelaunch(reg: Pick<MemberRelaunchRegistration, 'stopSessionForRelaunch'>, sessionName: string): Promise<boolean> {
  const stopped = await reg.stopSessionForRelaunch(sessionName);
  const { PtyActivityTrackerService } = await import('./pty-activity-tracker.service.js');
  PtyActivityTrackerService.getInstance().clearSession(sessionName);
  const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
  try {
    TaskPoolService.getInstance().clearHungState(sessionName);
  } catch {
    // task pool not ready
  }
  return stopped;
}

/**
 * Start a team member's session again (after {@link stopForRelaunch}).
 *
 * @param ctx - Storage, cwd lookup, logger
 * @param reg - Registration service
 * @param sessionName - Member session
 * @returns True when the new session was created
 */
export async function startMemberSession(ctx: StartMemberContext, reg: Pick<MemberRelaunchRegistration, 'createAgentSession'>, sessionName: string): Promise<boolean> {
  let found: { team: { id: string; projectIds: string[] }; member: { id: string; role: string } } | null = null;
  for (const team of await ctx.storage.getTeams()) {
    const member = team.members.find((m) => m.sessionName === sessionName);
    if (member) {
      found = { team, member };
      break;
    }
  }
  if (!found) return false;
  let projectPath: string | undefined;
  if (found.team.projectIds[0]) {
    projectPath = (await ctx.storage.getProjects()).find((p) => p.id === found!.team.projectIds[0])?.path;
  }
  projectPath ??= await ctx.cwdOf?.(sessionName).catch(() => undefined);
  const result = await reg.createAgentSession({
    sessionName,
    role: found.member.role,
    projectPath,
    memberId: found.member.id,
    teamId: found.team.id,
  });
  if (!result.success) ctx.logger?.warn('Relaunch failed', { sessionName, error: result.error });
  return result.success;
}
