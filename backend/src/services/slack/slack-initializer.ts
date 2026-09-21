/**
 * Slack Initializer
 *
 * Handles automatic Slack connection on application startup.
 * Checks for environment variables and initializes if configured.
 *
 * @module services/slack/initializer
 */

import { getSlackService, type SlackService } from './slack.service.js';
import { getSlackOrchestratorBridge } from './slack-orchestrator-bridge.js';
import { loadSlackCredentials } from './slack-credentials.service.js';
import {
  SlackCloudConfigService,
  getSlackCloudConfigService,
  setSlackCloudConfigService,
} from './slack-cloud-config.service.js';
import {
  SlackInstanceRegistryService,
  getSlackInstanceRegistryService,
  setSlackInstanceRegistryService,
} from './slack-instance-registry.service.js';
import { getSlackAgentIdentityService } from './slack-agent-identity.service.js';
import { getSlackTeamChannelService } from './slack-team-channel.service.js';
import { SlackConfig, SlackCloudConfig } from '../../types/slack.types.js';
import { SLACK_CLOUD_CONSTANTS, CREWLY_CONSTANTS } from '../../constants.js';
import type { MessageQueueService } from '../messaging/message-queue.service.js';
import { LoggerService } from '../core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('SlackInitializer');

/** Where the active Slack connection's tokens came from. */
export type SlackSource = 'env' | 'cloud';

/** A config together with its provenance. */
export interface ResolvedSlackConfig {
  config: SlackConfig;
  source: SlackSource;
}

/** Source of the connection currently held by SlackService (null = none). */
let activeSource: SlackSource | null = null;
/** Session module, captured once Slack starts (for live "is this agent awake" checks). */
let sessionBackendModule: typeof import('../session/index.js') | null = null;
/** Unsubscribe for the Cloud config watch. */
let unsubscribeCloudConfig: (() => void) | null = null;
/**
 * When the Slack boot path ran. The Cloud token is often refreshed only
 * after Slack has already connected with local tokens; a Cloud config that
 * appears within this window is still treated as the boot decision and
 * replaces the self-hosted socket. Later appearances leave a live
 * connection alone.
 */
let slackBootAt = 0;
/**
 * Wire the directory (who can be @'d): Cloud roster + live channel members.
 * Never throws — without it agents simply get no roster line.
 */
async function startSlackDirectory(slackService: SlackService): Promise<void> {
  try {
    const { CloudClientService } = await import('../cloud/cloud-client.service.js');
    const { SlackDirectoryService, setSlackDirectoryService } = await import('./slack-directory.service.js');
    const cloud = CloudClientService.getInstance();
    setSlackDirectoryService(
      new SlackDirectoryService({
        getInstanceId: () => getSlackInstanceRegistryService()?.getInstanceId() ?? null,
        fetchCloudDirectory: async () => {
          const token = cloud.getToken();
          const base = cloud.getCloudUrl();
          if (!token || !base) return null;
          const res = await fetch(`${base.replace(/\/$/, '')}${SLACK_CLOUD_CONSTANTS.CLOUD_PATH}${SLACK_CLOUD_CONSTANTS.DIRECTORY_PATH}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) return null;
          const body = (await res.json()) as { success?: boolean; data?: unknown };
          return body.success && Array.isArray(body.data) ? (body.data as import('./slack-directory.service.js').CloudDirectoryInstance[]) : null;
        },
        listChannelMembers: (channelId) => slackService.listChannelMembers(channelId),
        getUser: (userId) => slackService.getUserBasic(userId),
        localMemberName: (agentSession) => localAgentNames.get(agentSession) ?? null,
      }),
    );
  } catch (err) {
    logger.debug('Slack directory not started', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Session names of the agents this instance runs (team rosters), for the agent-to-agent self filter. */
const localAgentSessions = new Set<string>();
/** Session → member display name for the agents this instance runs. */
const localAgentNames = new Map<string, string>();

/** Rebuild {@link localAgentSessions} from storage. Never throws. */
/**
 * The agent sessions that run on this machine, and their display names.
 *
 * The orchestrator is added unconditionally: it plainly runs here, but the
 * Orchestrator Team is assembled by the teams API for display and is never
 * stored, so it is absent from `getTeams()`. Without it `isLocalAgent`
 * answered false for `crewly-orc`, the agent-DM path declined a DM to this
 * machine's own orchestrator bot, and the orchestrator bridge answered on
 * the workspace bot — which is not in that conversation. The reply was
 * written and had nowhere to go (owner, 2026-09-21).
 *
 * @param teams - Teams from storage
 * @returns Session names, and the names to show for them
 */
export function buildLocalAgentRoster(
  teams: Array<{ members?: Array<{ sessionName?: string; name?: string }> }>,
): { sessions: Set<string>; names: Map<string, string> } {
  const sessions = new Set<string>([CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME]);
  const names = new Map<string, string>();
  for (const team of teams) {
    for (const m of team.members ?? []) {
      if (!m.sessionName) continue;
      sessions.add(m.sessionName);
      if (m.name) names.set(m.sessionName, m.name);
    }
  }
  return { sessions, names };
}

async function refreshLocalAgentSessions(): Promise<void> {
  try {
    const { StorageService } = await import('../core/storage.service.js');
    const teams = await StorageService.getInstance().getTeams();
    const { sessions, names } = buildLocalAgentRoster(teams);
    localAgentSessions.clear();
    localAgentNames.clear();
    for (const s of sessions) localAgentSessions.add(s);
    for (const [k, v] of names) localAgentNames.set(k, v);
  } catch {
    // storage unavailable — the live-session check still applies
  }
}

/** Init options captured at boot so a later Cloud-triggered connect gets the queue. */
let bootOptions: SlackInitOptions | undefined;

/**
 * Result of initialization attempt
 */
export interface SlackInitResult {
  /** Whether initialization was attempted */
  attempted: boolean;
  /** Whether initialization succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Check if Slack is configured via environment variables
 *
 * @returns True if all required environment variables are set
 */
export function isSlackConfigured(): boolean {
  return !!(
    process.env.SLACK_BOT_TOKEN &&
    process.env.SLACK_APP_TOKEN &&
    process.env.SLACK_SIGNING_SECRET
  );
}

/**
 * Get Slack configuration from environment variables
 *
 * @returns SlackConfig object or null if not configured
 */
export function getSlackConfigFromEnv(): SlackConfig | null {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!botToken || !appToken || !signingSecret) {
    return null;
  }

  return {
    botToken,
    appToken,
    signingSecret,
    defaultChannelId: process.env.SLACK_DEFAULT_CHANNEL,
    allowedUserIds: process.env.SLACK_ALLOWED_USERS?.split(',').filter(Boolean),
    socketMode: true,
  };
}

/**
 * Get Slack configuration from environment variables or saved credentials.
 * Environment variables take priority over saved credentials.
 *
 * @returns SlackConfig object or null if not configured
 */
export async function getSlackConfig(): Promise<SlackConfig | null> {
  // Env vars take priority
  const envConfig = getSlackConfigFromEnv();
  if (envConfig) {
    return envConfig;
  }

  // Fall back to saved credentials
  try {
    const savedConfig = await loadSlackCredentials();
    if (savedConfig) {
      logger.info('Loaded Slack credentials from saved config');
      return savedConfig;
    }
  } catch (error) {
    logger.warn('Failed to load saved Slack credentials', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return null;
}

/**
 * Build (once) the Cloud config service on top of the Cloud client.
 *
 * @returns The process-wide SlackCloudConfigService
 */
export async function ensureSlackCloudConfigService(): Promise<SlackCloudConfigService> {
  let service = getSlackCloudConfigService();
  if (!service) {
    const { CloudClientService } = await import('../cloud/cloud-client.service.js');
    // The device id is what Cloud binds a workspace to; it must accompany
    // the very first `/config` call, before the registry has started.
    const { DeviceIdentityService } = await import('../cloud/device-identity.service.js');
    let deviceId: string | null = null;
    try {
      deviceId = (await DeviceIdentityService.getInstance().getOrCreateIdentity()).deviceId;
    } catch (err) {
      logger.debug('Device identity unavailable for the Slack config request', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    service = new SlackCloudConfigService({
      cloud: CloudClientService.getInstance(),
      getInstanceId: () => getSlackInstanceRegistryService()?.getInstanceId() ?? deviceId,
    });
    setSlackCloudConfigService(service);
  }
  return service;
}

/**
 * Pick the Slack config to connect with, applying the source precedence:
 *
 *  - `CREWLY_SLACK_SOURCE=env`   → local tokens only (env / credentials file);
 *  - `CREWLY_SLACK_SOURCE=cloud` → the Cloud-owned workspace only;
 *  - unset                       → Cloud when the account has a workspace
 *    installed, otherwise local tokens. When both exist Cloud wins and this
 *    is logged once so the migration is visible.
 *
 * @returns The config and where it came from, or null when nothing is set up
 */
export async function resolveSlackConfig(): Promise<ResolvedSlackConfig | null> {
  const cloudConfigService = await ensureSlackCloudConfigService();
  const mode = cloudConfigService.getSourceMode();

  const local = mode === 'cloud' ? null : await getSlackConfig();

  let cloud: SlackConfig | null = null;
  if (mode !== 'env') {
    await cloudConfigService.loadOrRefresh();
    cloud = cloudConfigService.toSlackConfig();
  }

  if (cloud) {
    if (local) {
      logger.info(
        'Both local Slack tokens and a Cloud-owned workspace are present — using Crewly Cloud. Set CREWLY_SLACK_SOURCE=env to keep the self-hosted app.',
      );
    }
    return { config: cloud, source: 'cloud' };
  }
  if (local) return { config: local, source: 'env' };
  return null;
}

/**
 * The source of the live Slack connection.
 *
 * @returns `env`, `cloud`, or null when Slack is not connected
 */
export function getActiveSlackSource(): SlackSource | null {
  return activeSource;
}

/**
 * Record the source of a connection made outside {@link connectSlack}
 * (the manual `/api/slack/connect` route).
 *
 * @param source - The source, or null after a disconnect
 */
export function setActiveSlackSource(source: SlackSource | null): void {
  activeSource = source;
}

/**
 * Options for Slack initialization
 */
export interface SlackInitOptions {
  /** Optional MessageQueueService for enqueuing messages to orchestrator */
  messageQueueService?: MessageQueueService;
}

/**
 * Initialize Slack integration if configured via environment variables
 * or saved credentials.
 *
 * This function is designed to be called during application startup.
 * It safely handles cases where Slack is not configured.
 *
 * @param options - Optional initialization options
 * @returns Result object indicating success or failure
 *
 * @example
 * ```typescript
 * const result = await initializeSlackIfConfigured({
 *   agentRegistrationService: myService
 * });
 * if (result.success) {
 *   console.log('Slack connected!');
 * } else if (result.attempted) {
 *   console.error('Slack failed to connect:', result.error);
 * } else {
 *   console.log('Slack not configured, skipping');
 * }
 * ```
 */
export async function initializeSlackIfConfigured(
  options?: SlackInitOptions
): Promise<SlackInitResult> {
  bootOptions = options;
  slackBootAt = Date.now();
  const resolved = await resolveSlackConfig();

  // Keep watching Cloud: a workspace connected later from Settings (or on
  // another machine) lights this instance up without a restart.
  await watchSlackCloudConfig();

  if (!resolved) {
    logger.info('Not configured - skipping initialization');
    return { attempted: false, success: false };
  }

  return connectSlack(resolved, options);
}

/**
 * Connect SlackService with a resolved config and bring up the bridge, team
 * channels and — for the Cloud source — the relay transport, the identities
 * from the Cloud config and the instance registry.
 *
 * @param resolved - Config + source
 * @param options - Init options (message queue)
 * @returns Result object indicating success or failure
 */
export async function connectSlack(
  resolved: ResolvedSlackConfig,
  options?: SlackInitOptions,
): Promise<SlackInitResult> {
  const { config, source } = resolved;
  try {
    const slackService = getSlackService();
    await slackService.initialize(config);

    if (source === 'cloud') {
      await attachSlackCloudTransport();
      // Agent-to-agent: a message written by an agent running here is
      // already in chat-v2 and must not come back through Slack; one from
      // an agent on another machine is a colleague and is delivered.
      const sessionModule = await import('../session/index.js').catch(() => null);
      sessionBackendModule = sessionModule;
      slackService.isLocalAgent = (agentSession) => {
        try {
          const backend = sessionModule?.getSessionBackendSync();
          if (backend?.sessionExists(agentSession)) return true;
        } catch {
          // fall through to the roster check
        }
        return localAgentSessions.has(agentSession);
      };
      void refreshLocalAgentSessions();
      await startSlackDirectory(slackService);
    }

    const bridge = getSlackOrchestratorBridge();

    // Set the message queue service if provided
    if (options?.messageQueueService) {
      bridge.setMessageQueueService(options.messageQueueService);
    }

    await bridge.initialize();

    await startSlackTeamChannels();

    if (source === 'cloud') {
      await applyCloudIdentities();
      await startSlackInstanceRegistry();
    }

    activeSource = source;
    logger.info('Successfully connected', { source, transport: slackService.getTransport() });
    return { attempted: true, success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to initialize', { error: errorMessage, source });
    return { attempted: true, success: false, error: errorMessage };
  }
}

/**
 * Route `slack_event` relay messages from CloudSyncService into SlackService
 * (the cloud inbound transport). Non-fatal when Cloud Sync is not running —
 * events simply cannot arrive until it is.
 */
async function attachSlackCloudTransport(): Promise<void> {
  try {
    const { CloudSyncService } = await import('../cloud/cloud-sync.service.js');
    getSlackService().attachCloudTransport(CloudSyncService.getInstance());
  } catch (error) {
    logger.warn('Could not attach the Cloud Slack transport — inbound Slack events will not arrive', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Feed the per-agent identities delivered with the Cloud config into the
 * identity service (installed bot users, tokens included).
 */
async function applyCloudIdentities(): Promise<void> {
  const cloudConfigService = getSlackCloudConfigService();
  const identities = getSlackAgentIdentityService();
  if (!cloudConfigService || !identities) return;
  try {
    const added = await identities.applyCloudConfig(cloudConfigService.getAgents());
    if (added > 0) logger.info('Agent identities installed from Cloud config', { added });
  } catch (error) {
    logger.warn('Could not apply agent identities from Cloud config', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Build (once) the instance registry service without starting it — the
 * primary toggle needs it even before Slack is connected.
 *
 * @returns The process-wide SlackInstanceRegistryService
 */
export async function ensureSlackInstanceRegistry(): Promise<SlackInstanceRegistryService> {
  let registry = getSlackInstanceRegistryService();
  if (!registry) {
    const [{ CloudClientService }, { CloudSyncService }, { DeviceIdentityService }, { StorageService }] =
      await Promise.all([
        import('../cloud/cloud-client.service.js'),
        import('../cloud/cloud-sync.service.js'),
        import('../cloud/device-identity.service.js'),
        import('../core/storage.service.js'),
      ]);
    registry = new SlackInstanceRegistryService({
      cloud: CloudClientService.getInstance(),
      identity: DeviceIdentityService.getInstance(),
      sync: CloudSyncService.getInstance(),
      storage: StorageService.getInstance(),
      getTeamChannels: () => getSlackTeamChannelService(),
      getBoundWorkspaceId: () => getSlackCloudConfigService()?.getConfig()?.workspace.slackTeamId || null,
    });
    setSlackInstanceRegistryService(registry);
  }
  return registry;
}

/**
 * Build (once) and start the instance registry heartbeat. Never throws.
 *
 * @returns The registry service, or null when its dependencies are missing
 */
export async function startSlackInstanceRegistry(): Promise<SlackInstanceRegistryService | null> {
  try {
    const registry = await ensureSlackInstanceRegistry();
    await registry.start();
    return registry;
  } catch (error) {
    logger.warn('Slack instance registry not started', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Subscribe to Cloud config changes and start the 10-minute refresh (unless
 * `CREWLY_SLACK_SOURCE=env`). Idempotent.
 */
export async function watchSlackCloudConfig(): Promise<void> {
  const cloudConfigService = await ensureSlackCloudConfigService();
  if (cloudConfigService.getSourceMode() === 'env') return;
  if (!unsubscribeCloudConfig) {
    unsubscribeCloudConfig = cloudConfigService.onChange((config) => {
      void handleSlackCloudConfigChange(config);
    });
  }
  cloudConfigService.start();
}

/**
 * React to the Cloud config appearing, rotating or disappearing:
 *
 *  - appeared and Slack is not connected → connect with the cloud source;
 *  - changed while connected via Cloud → re-initialise with the new token
 *    and merge new identities;
 *  - removed while connected via Cloud → disconnect.
 *
 * A live self-hosted (`env`) connection is left alone; precedence is only
 * applied at boot so a running socket is never yanked under the owner.
 *
 * @param config - The new Cloud config (null when removed)
 */
export async function handleSlackCloudConfigChange(config: SlackCloudConfig | null): Promise<void> {
  const slackService = getSlackService();
  const cloudConfigService = getSlackCloudConfigService();
  if (!cloudConfigService) return;

  if (!config) {
    if (activeSource === 'cloud') {
      logger.info('Cloud Slack workspace removed — disconnecting');
      getSlackInstanceRegistryService()?.stop();
      await slackService.disconnect().catch(() => undefined);
      activeSource = null;
    }
    return;
  }

  const slackConfig = cloudConfigService.toSlackConfig();
  if (!slackConfig) return;

  if (!slackService.isConnected()) {
    logger.info('Cloud Slack workspace available — connecting', { workspace: config.workspace.slackTeamName });
    await connectSlack({ config: slackConfig, source: 'cloud' }, bootOptions);
    return;
  }

  // Boot race: Slack came up on local tokens because the Cloud token was
  // still being refreshed. Apply the boot precedence now instead of leaving
  // the instance on Socket Mode until the next restart.
  if (
    activeSource === 'env' &&
    cloudConfigService.getSourceMode() === 'auto' &&
    slackBootAt > 0 &&
    Date.now() - slackBootAt < SLACK_CLOUD_CONSTANTS.BOOT_PRECEDENCE_WINDOW_MS
  ) {
    logger.info('Cloud Slack workspace appeared right after boot — switching from the self-hosted app to Crewly Cloud', {
      workspace: config.workspace.slackTeamName,
    });
    await slackService.disconnect().catch(() => undefined);
    await connectSlack({ config: slackConfig, source: 'cloud' }, bootOptions);
    return;
  }

  if (activeSource === 'cloud') {
    if (slackService.getBotToken() !== slackConfig.botToken) {
      logger.info('Cloud Slack bot token rotated — re-initialising');
      await slackService.initialize(slackConfig);
      await attachSlackCloudTransport();
    }
    await applyCloudIdentities();
  }
}

/**
 * Called once Cloud is signed in (boot restore or the login route — both
 * happen after the Slack boot path ran): fetch the Cloud config now instead
 * of waiting for the 10-minute tick, connect if a workspace exists and
 * Slack is down, and re-register the instance now that a relay queue may
 * exist. Never throws.
 */
export async function refreshSlackCloudConfig(): Promise<void> {
  try {
    const cloudConfigService = await ensureSlackCloudConfigService();
    if (cloudConfigService.getSourceMode() === 'env') return;
    await watchSlackCloudConfig();
    const config = await cloudConfigService.refresh();
    // onChange only fires when the config differs from the cache; a cached
    // config that could not connect at boot needs an explicit nudge.
    if (config && !getSlackService().isConnected()) {
      await handleSlackCloudConfigChange(config);
    } else if (activeSource === 'cloud') {
      await getSlackInstanceRegistryService()?.heartbeat();
    }
  } catch (error) {
    logger.warn('Cloud Slack config refresh after login failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Reset module state (tests).
 */
export function resetSlackInitializerState(): void {
  unsubscribeCloudConfig?.();
  unsubscribeCloudConfig = null;
  activeSource = null;
  bootOptions = undefined;
  getSlackCloudConfigService()?.stop();
  getSlackInstanceRegistryService()?.stop();
  setSlackInstanceRegistryService(null);
  setSlackCloudConfigService(null);
}

/**
 * Wire and start the Slack team-channel service (one Slack channel + one
 * chat-v2 huddle per team). Idempotent — safe to call from both the boot
 * path and the `/connect` route. Never throws: team channels are an
 * optional layer on top of the orchestrator bridge, so a failure here
 * must not take the Slack connection down with it.
 *
 * Dependencies are imported lazily so this module stays cheap to load in
 * unit tests that only exercise credential resolution.
 */
/**
 * Whether an agent's runtime session exists right now (PTY alive). False
 * means a Slack message to it triggers a cold start — worth telling the
 * person in the channel.
 *
 * @param agentSession - Session name
 * @returns True when the session exists
 */
function sessionBackendExists(agentSession: string): boolean {
  try {
    return !!sessionBackendModule?.getSessionBackendSync()?.sessionExists(agentSession);
  } catch {
    return false;
  }
}

export async function startSlackTeamChannels(): Promise<void> {
  try {
    const [
      { SlackTeamChannelService, getSlackTeamChannelService, setSlackTeamChannelService },
      { SlackAgentIdentityService, getSlackAgentIdentityService, setSlackAgentIdentityService },
      { SlackAgentPostService, getSlackAgentPostService, setSlackAgentPostService },
      { SlackAgentDmService, getSlackAgentDmService, setSlackAgentDmService },
      { SlackTypingPlaceholderService, getSlackTypingPlaceholderService, setSlackTypingPlaceholderService },
      { getChatV2Service },
      { getChatV2RealtimeDeps },
      { StorageService },
      { CloudClientService },
    ] = await Promise.all([
      import('./slack-team-channel.service.js'),
      import('./slack-agent-identity.service.js'),
      import('./slack-agent-post.service.js'),
      import('./slack-agent-dm.service.js'),
      import('./slack-typing-placeholder.service.js'),
      import('../chat-v2/chat-v2.singleton.js'),
      import('../chat-v2/chat-v2.realtime-holder.js'),
      import('../core/storage.service.js'),
      import('../cloud/cloud-client.service.js'),
    ]);
    // Real per-agent identities live behind the Cloud login; the service is
    // always constructed and simply reports unavailable until then.
    let identities = getSlackAgentIdentityService();
    if (!identities) {
      identities = new SlackAgentIdentityService({
        cloud: CloudClientService.getInstance(),
        getWorkspaceId: () => getSlackCloudConfigService()?.getConfig()?.workspace.slackTeamId || null,
        getInstanceId: () => getSlackInstanceRegistryService()?.getInstanceId() ?? null,
      });
      setSlackAgentIdentityService(identities);
    }
    // Agent-initiated posts (the `slack-post` skill).
    if (!getSlackAgentPostService()) {
      setSlackAgentPostService(
        new SlackAgentPostService({
          slack: getSlackService(),
          storage: StorageService.getInstance(),
          identities,
        }),
      );
    }
    // "Is typing…" placeholders posted by the agents' own bots.
    let typing = getSlackTypingPlaceholderService();
    if (!typing) {
      typing = new SlackTypingPlaceholderService({ slack: getSlackService() });
      setSlackTypingPlaceholderService(typing);
    }
    let service = getSlackTeamChannelService();
    if (!service) {
      service = new SlackTeamChannelService({
        slack: getSlackService(),
        chat: getChatV2Service(),
        storage: StorageService.getInstance(),
        getDispatcher: () => getChatV2RealtimeDeps().dispatcher ?? null,
        identities,
        typing,
        isLocalAgent: (agentSession) => getSlackService().isLocalAgent?.(agentSession) ?? false,
        isAgentAwake: (agentSession) => sessionBackendExists(agentSession),
        getOwnerUserId: () => getSlackCloudConfigService()?.getConfig()?.workspace.installedBy || null,
      });
      setSlackTeamChannelService(service);
    }
    await service.start();
    // Slack may have (re)connected after start(): give every team its channel now.
    void service.reconcileAllTeams().catch(() => undefined);
    // DMs to an agent's own bot go to that agent's chat-v2 DM channel.
    let agentDm = getSlackAgentDmService();
    if (!agentDm) {
      agentDm = new SlackAgentDmService({
        slack: getSlackService(),
        chat: getChatV2Service(),
        storage: StorageService.getInstance(),
        getDispatcher: () => getChatV2RealtimeDeps().dispatcher ?? null,
        identities,
        isLocalAgent: (agentSession) => getSlackService().isLocalAgent?.(agentSession) ?? true,
        typing,
        isAgentAwake: (agentSession) => sessionBackendExists(agentSession),
      });
      setSlackAgentDmService(agentDm);
    }
    await agentDm.start();
    // Owner notifications must not target an agent app's own DM (the master bot cannot post there).
    getSlackService().isAgentOwnedConversation = (channelId) => !!getSlackAgentDmService()?.findBySlackChannelId(channelId);
    getSlackService().getOwnerUserId = () => getSlackCloudConfigService()?.getConfig()?.workspace.installedBy || null;
    // Team-channel threads and agent DMs belong to the agents, not the
    // orchestrator's resume briefing (which otherwise had the orchestrator
    // answering in #team channels).
    try {
      const { SessionHandoffService } = await import('../session/session-handoff.service.js');
      SessionHandoffService.getInstance().setChannelFilter(
        (channelType, channelId) =>
          channelType === 'slack' &&
          (!!getSlackTeamChannelService()?.findBySlackChannelId(channelId) || !!getSlackAgentDmService()?.findBySlackChannelId(channelId)),
      );
    } catch (err) {
      logger.debug('Could not install the team-channel filter on the handoff briefing', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } catch (error) {
    logger.warn('Slack team channels not started', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Gracefully shutdown Slack integration
 *
 * Call this during application shutdown to disconnect cleanly.
 */
export async function shutdownSlack(): Promise<void> {
  try {
    getSlackInstanceRegistryService()?.stop();
    getSlackCloudConfigService()?.stop();
    const slackService = getSlackService();
    if (slackService.isConnected()) {
      await slackService.disconnect();
      activeSource = null;
      logger.info('Disconnected');
    }
  } catch (error) {
    logger.error('Error during shutdown', { error: error instanceof Error ? (error as Error).message : String(error) });
  }
}
