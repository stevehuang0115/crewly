/**
 * Slack Initializer
 *
 * Handles automatic Slack connection on application startup.
 * Checks for environment variables and initializes if configured.
 *
 * @module services/slack/initializer
 */

import { getSlackService } from './slack.service.js';
import { getSlackOrchestratorBridge } from './slack-orchestrator-bridge.js';
import { loadSlackCredentials } from './slack-credentials.service.js';
import { SlackConfig } from '../../types/slack.types.js';
import type { MessageQueueService } from '../messaging/message-queue.service.js';
import { LoggerService } from '../core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('SlackInitializer');

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
  const config = await getSlackConfig();

  if (!config) {
    logger.info('Not configured - skipping initialization');
    return { attempted: false, success: false };
  }

  try {
    const slackService = getSlackService();
    await slackService.initialize(config);

    const bridge = getSlackOrchestratorBridge();

    // Set the message queue service if provided
    if (options?.messageQueueService) {
      bridge.setMessageQueueService(options.messageQueueService);
    }

    await bridge.initialize();

    await startSlackTeamChannels();

    logger.info('Successfully connected');
    return { attempted: true, success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to initialize', { error: errorMessage });
    return { attempted: true, success: false, error: errorMessage };
  }
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
export async function startSlackTeamChannels(): Promise<void> {
  try {
    const [
      { SlackTeamChannelService, getSlackTeamChannelService, setSlackTeamChannelService },
      { SlackAgentIdentityService, getSlackAgentIdentityService, setSlackAgentIdentityService },
      { SlackAgentPostService, getSlackAgentPostService, setSlackAgentPostService },
      { getChatV2Service },
      { getChatV2RealtimeDeps },
      { StorageService },
      { CloudClientService },
    ] = await Promise.all([
      import('./slack-team-channel.service.js'),
      import('./slack-agent-identity.service.js'),
      import('./slack-agent-post.service.js'),
      import('../chat-v2/chat-v2.singleton.js'),
      import('../chat-v2/chat-v2.realtime-holder.js'),
      import('../core/storage.service.js'),
      import('../cloud/cloud-client.service.js'),
    ]);
    // Real per-agent identities live behind the Cloud login; the service is
    // always constructed and simply reports unavailable until then.
    let identities = getSlackAgentIdentityService();
    if (!identities) {
      identities = new SlackAgentIdentityService({ cloud: CloudClientService.getInstance() });
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
    let service = getSlackTeamChannelService();
    if (!service) {
      service = new SlackTeamChannelService({
        slack: getSlackService(),
        chat: getChatV2Service(),
        storage: StorageService.getInstance(),
        getDispatcher: () => getChatV2RealtimeDeps().dispatcher ?? null,
        identities,
      });
      setSlackTeamChannelService(service);
    }
    await service.start();
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
    const slackService = getSlackService();
    if (slackService.isConnected()) {
      await slackService.disconnect();
      logger.info('Disconnected');
    }
  } catch (error) {
    logger.error('Error during shutdown', { error: error instanceof Error ? (error as Error).message : String(error) });
  }
}
