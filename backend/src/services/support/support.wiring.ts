/**
 * Wiring of support access on the instance (crewly#1558): builds the
 * in-process support API from the real services and starts the support relay
 * on the Cloud relay queue (the machine that GAVE access), and builds the
 * support view its own agents read other accounts' machines through (the
 * machine that RECEIVED access).
 *
 * @module services/support/support.wiring
 */

import { LoggerService } from '../core/logger.service.js';
import { getSettingsService } from '../settings/index.js';
import { isOwnerStopped } from '../agent/owner-stopped.registry.js';
import { isSessionPaused } from '../team/team-pause.registry.js';
import { recordActivity } from '../activity/activity-log.service.js';
import { getActingFor } from '../people/acting-for.service.js';
import { getPrivateSourceTracker } from '../people/private-source.service.js';
import { ORCHESTRATOR_SESSION_NAME, SHARED_CHANNEL_CONSTANTS, SUPPORT_ACCESS_CONSTANTS } from '../../constants.js';
import type { CrewlySettings } from '../../types/settings.types.js';
import type { AgentRegistrationService } from '../agent/agent-registration.service.js';
import { SupportApiService, readFileTail, serviceLogPath, type SupportChatSource, type SupportOrchestrator, type SupportTeam } from './support-api.service.js';
import { SupportRelayService, type ISupportRelayCloudSync } from './support-relay.service.js';
import { SupportClientService, type ISupportClientCloudSync, type SupportClientCloudLogin } from './support-client.service.js';
import { SupportViewService, type SupportViewDeps } from './support-view.service.js';

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

/** What the support view wiring needs from the server. */
export interface SupportViewWiringDeps {
  cloudSync: ISupportClientCloudSync;
  /** Settings reader (default: the settings service) */
  settings?: () => Promise<CrewlySettings>;
  /** This machine's Cloud login (default: the Cloud client's) */
  cloud?: () => Promise<SupportClientCloudLogin | null>;
  /** Display name of a session's agent (default: the team member's name) */
  displayName?: SupportViewDeps['displayName'];
  /** Who a session works for (default: the acting-for service) */
  actingFor?: SupportViewDeps['actingFor'];
  /** Private-source note (default: the private-source tracker) */
  notePrivate?: SupportViewDeps['notePrivate'];
  /** Activity-log writer (default: the Activity log) */
  record?: SupportViewDeps['record'];
  fetchImpl?: typeof fetch;
}

/** What {@link startSupportView} started. */
export interface SupportViewHandle {
  client: SupportClientService;
  view: SupportViewService;
}

let supportView: SupportViewService | null = null;

/** @returns The process-wide support view, or null before it is started */
export function getSupportViewService(): SupportViewService | null {
  return supportView;
}

/** Replace the process-wide support view (tests). */
export function setSupportViewService(service: SupportViewService | null): void {
  supportView = service;
}

/**
 * Whether the owner of this machine lets its agents use support access other
 * accounts gave this account (`support.allowAgentViews`, default on).
 *
 * @param settings - Current settings
 * @returns False only when the owner turned it off
 */
export function agentViewsAllowed(settings: CrewlySettings): boolean {
  return settings.support?.allowAgentViews !== false;
}

/**
 * This machine's Cloud login, read from the Cloud client. The token goes to
 * the support client only; it is never logged.
 *
 * @returns Base URL and token, or null when this machine is not signed in
 */
export async function cloudLoginForSupport(): Promise<SupportClientCloudLogin | null> {
  const { CloudClientService } = await import('../cloud/cloud-client.service.js');
  const client = CloudClientService.getInstance();
  const token = client.getToken();
  const baseUrl = client.getCloudUrl();
  return token && baseUrl ? { baseUrl, token } : null;
}

/**
 * The name an agent goes by: the orchestrator's sender name, else the team
 * member's name.
 *
 * @param session - Agent session
 * @returns Display name, or undefined when the session is no known member
 */
export async function supportAgentDisplayName(session: string): Promise<string | undefined> {
  if (session === ORCHESTRATOR_SESSION_NAME) return SHARED_CHANNEL_CONSTANTS.ORCHESTRATOR_SENDER_NAME;
  const { StorageService } = await import('../core/storage.service.js');
  const found = await StorageService.getInstance().findMemberBySessionName(session);
  return found?.member.name || undefined;
}

/**
 * Build the support client and the support view and start listening for
 * answers on the Cloud relay queue.
 *
 * @param deps - Server collaborators
 * @returns The started client and the view (for shutdown and tests)
 */
export function startSupportView(deps: SupportViewWiringDeps): SupportViewHandle {
  const settings = deps.settings ?? (() => getSettingsService().getSettings());
  const client = new SupportClientService({
    cloudSync: deps.cloudSync,
    cloud: deps.cloud ?? cloudLoginForSupport,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    logger: LoggerService.getInstance().createComponentLogger('SupportClient'),
  });
  const view = new SupportViewService({
    client,
    allowed: async () => agentViewsAllowed(await settings()),
    displayName: deps.displayName ?? supportAgentDisplayName,
    actingFor: deps.actingFor ?? ((session) => getActingFor().actorFor(session)),
    notePrivate: deps.notePrivate ?? ((session, personId, connectorId) => getPrivateSourceTracker().note(session, personId, connectorId)),
    record: deps.record ?? recordActivity,
    logger: LoggerService.getInstance().createComponentLogger('SupportView'),
  });
  client.start();
  supportView = view;
  return { client, view };
}
