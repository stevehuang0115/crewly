/**
 * Wiring of support access on the instance (crewly#1558 slice 2): builds the
 * in-process support API from the real services and starts the support relay
 * on the Cloud relay queue.
 *
 * @module services/support/support.wiring
 */

import { LoggerService } from '../core/logger.service.js';
import { getSettingsService } from '../settings/index.js';
import { isOwnerStopped } from '../agent/owner-stopped.registry.js';
import { isSessionPaused } from '../team/team-pause.registry.js';
import { SUPPORT_ACCESS_CONSTANTS } from '../../constants.js';
import type { CrewlySettings } from '../../types/settings.types.js';
import type { AgentRegistrationService } from '../agent/agent-registration.service.js';
import { SupportApiService, readFileTail, serviceLogPath, type SupportChatSource, type SupportOrchestrator, type SupportTeam } from './support-api.service.js';
import { SupportRelayService, type ISupportRelayCloudSync } from './support-relay.service.js';

/** What the wiring needs from the server. */
export interface SupportWiringDeps {
  cloudSync: ISupportRelayCloudSync;
  chat: () => SupportChatSource | null;
  teams: () => Promise<SupportTeam[]>;
  orchestrator: () => Promise<SupportOrchestrator | null>;
  crewlyHome: string;
  agentRegistration: () => Pick<AgentRegistrationService, 'createAgentSession'> | null | undefined;
  /** Settings reader (default: the settings service) */
  settings?: () => Promise<CrewlySettings>;
  /** Restart override (tests); default: the re-login resumer's restart path */
  restartAgent?: (session: string) => Promise<boolean>;
}

/**
 * Whether the owner allows support grantees (`support.allowGrantees`, default on).
 *
 * @param settings - Current settings
 * @returns False only when the owner turned it off
 */
export function grantAllowed(settings: CrewlySettings): boolean {
  return settings.support?.allowGrantees !== false;
}

/**
 * Restart one agent the way a re-login does (stop exit monitoring, kill the
 * PTY, keep the conversation id, `createAgentSession` again; the
 * orchestrator through OrchestratorRestartService).
 *
 * @param agentRegistration - Agent registration service accessor
 * @returns Restart function
 */
export function createResumerRestart(
  agentRegistration: SupportWiringDeps['agentRegistration'],
): (session: string) => Promise<boolean> {
  return async (session) => {
    const [{ ReloginAgentResumerService }, sessionMod, { OrchestratorRestartService }, { RuntimeExitMonitorService }, { PtyActivityTrackerService }] = await Promise.all([
      import('../agent/relogin-agent-resumer.service.js'),
      import('../session/index.js'),
      import('../orchestrator/orchestrator-restart.service.js'),
      import('../agent/runtime-exit-monitor.service.js'),
      import('../agent/pty-activity-tracker.service.js'),
    ]);
    const resumer = new ReloginAgentResumerService({
      getBackend: () => sessionMod.getSessionBackendSync(),
      getPersistence: () => sessionMod.getSessionStatePersistence(),
      getAgentRegistration: () => agentRegistration() ?? null,
      restartOrchestrator: () => OrchestratorRestartService.getInstance().attemptRestart(),
      stopExitMonitoring: (name) => RuntimeExitMonitorService.getInstance().stopMonitoring(name),
      clearActivity: (name) => PtyActivityTrackerService.getInstance().clearSession(name),
    });
    const { resumed } = await resumer.resume([session]);
    return resumed.includes(session);
  };
}

/**
 * Build the support API and start the support relay.
 *
 * @param deps - Server collaborators
 * @returns The started relay (for shutdown)
 */
export function startSupportRelay(deps: SupportWiringDeps): SupportRelayService {
  const settings = deps.settings ?? (() => getSettingsService().getSettings());
  const api = new SupportApiService({
    chat: deps.chat,
    teams: deps.teams,
    orchestrator: deps.orchestrator,
    settings,
    readLogTail: () => readFileTail(serviceLogPath(deps.crewlyHome), SUPPORT_ACCESS_CONSTANTS.ERROR_TAIL_BYTES),
    restartAgent: deps.restartAgent ?? createResumerRestart(deps.agentRegistration),
    isOwnerStopped,
    isSessionPaused,
  });
  const relay = new SupportRelayService({
    cloudSync: deps.cloudSync,
    api,
    allowGrantees: async () => grantAllowed(await settings()),
    logger: LoggerService.getInstance().createComponentLogger('SupportRelay'),
  });
  relay.start();
  return relay;
}
