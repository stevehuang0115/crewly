/**
 * Tests for Slack Initializer
 *
 * @module services/slack/slack-initializer.test
 */

// Jest globals are available automatically
import {
  isSlackConfigured,
  getSlackConfigFromEnv,
  getSlackConfig,
  initializeSlackIfConfigured,
  shutdownSlack,
  startSlackTeamChannels,
  resolveSlackConfig,
  connectSlack,
  handleSlackCloudConfigChange,
  refreshSlackCloudConfig,
  getActiveSlackSource,
  resetSlackInitializerState,
} from './slack-initializer.js';
import { getSlackTeamChannelService, setSlackTeamChannelService } from './slack-team-channel.service.js';
import { SlackCloudConfigService, setSlackCloudConfigService, getSlackCloudConfigService } from './slack-cloud-config.service.js';
import { getSlackInstanceRegistryService } from './slack-instance-registry.service.js';
import { getSlackAgentIdentityService, setSlackAgentIdentityService } from './slack-agent-identity.service.js';
import type { SlackCloudConfig } from '../../types/slack.types.js';

// startSlackTeamChannels pulls its collaborators lazily; give it fakes so
// it never opens the chat database or reads real team storage.
const mockChatOn = jest.fn();
jest.mock('../chat-v2/chat-v2.singleton.js', () => ({
  getChatV2Service: () => ({ on: mockChatOn, off: jest.fn() }),
}));
const mockOnStorageEvent = jest.fn(() => () => undefined);
jest.mock('../core/storage.service.js', () => ({
  StorageService: { getInstance: () => ({ getTeams: async () => [], onStorageEvent: mockOnStorageEvent }) },
}));
jest.mock('../../utils/file-io.utils.js', () => ({
  safeReadJson: async (_p: string, d: unknown) => d,
  atomicWriteJson: async () => undefined,
}));
const mockCloud = { connected: false, token: null as string | null, url: null as string | null };
jest.mock('../cloud/cloud-client.service.js', () => ({
  CloudClientService: {
    getInstance: () => ({
      isConnected: () => mockCloud.connected,
      getToken: () => mockCloud.token,
      getCloudUrl: () => mockCloud.url,
    }),
  },
}));
// Relay + device identity for the cloud transport / registry.
const mockSyncListeners: Array<(msg: unknown) => void> = [];
jest.mock('../cloud/cloud-sync.service.js', () => ({
  CloudSyncService: {
    getInstance: () => ({
      on: (_e: string, h: (msg: unknown) => void) => {
        mockSyncListeners.push(h);
      },
      off: (_e: string, h: (msg: unknown) => void) => {
        const i = mockSyncListeners.indexOf(h);
        if (i >= 0) mockSyncListeners.splice(i, 1);
      },
      getQueueId: () => 'queue-1',
    }),
  },
}));
jest.mock('../cloud/device-identity.service.js', () => ({
  DeviceIdentityService: {
    getInstance: () => ({ getOrCreateIdentity: async () => ({ deviceId: 'device-1', deviceName: 'mbp' }) }),
  },
}));
import { resetSlackService, getSlackService, SlackService } from './slack.service.js';
import { resetSlackOrchestratorBridge } from './slack-orchestrator-bridge.js';
import * as slackCredentials from './slack-credentials.service.js';

describe('Slack Initializer', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    resetSlackService();
    resetSlackOrchestratorBridge();
    process.env = { ...originalEnv };
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_DEFAULT_CHANNEL;
    delete process.env.SLACK_ALLOWED_USERS;
  });

  afterEach(() => {
    process.env = originalEnv;
    resetSlackService();
    resetSlackOrchestratorBridge();
    resetSlackInitializerState();
    getSlackTeamChannelService()?.stop();
    setSlackTeamChannelService(null);
    getSlackAgentIdentityService()?.stop();
    setSlackAgentIdentityService(null);
    mockCloud.connected = false;
    mockCloud.token = null;
    mockCloud.url = null;
    mockSyncListeners.length = 0;
    jest.restoreAllMocks();
  });

  describe('isSlackConfigured', () => {
    it('should return false when no env vars are set', () => {
      expect(isSlackConfigured()).toBe(false);
    });

    it('should return false when only bot token is set', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      expect(isSlackConfigured()).toBe(false);
    });

    it('should return false when only app token is set', () => {
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      expect(isSlackConfigured()).toBe(false);
    });

    it('should return false when only signing secret is set', () => {
      process.env.SLACK_SIGNING_SECRET = 'secret';
      expect(isSlackConfigured()).toBe(false);
    });

    it('should return false when missing one required var', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      // Missing signing secret
      expect(isSlackConfigured()).toBe(false);
    });

    it('should return true when all required vars are set', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      process.env.SLACK_SIGNING_SECRET = 'secret';
      expect(isSlackConfigured()).toBe(true);
    });
  });

  describe('getSlackConfigFromEnv', () => {
    it('should return null when not configured', () => {
      expect(getSlackConfigFromEnv()).toBeNull();
    });

    it('should return null when partially configured', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      expect(getSlackConfigFromEnv()).toBeNull();
    });

    it('should return config when fully configured', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      process.env.SLACK_SIGNING_SECRET = 'secret';

      const config = getSlackConfigFromEnv();
      expect(config).not.toBeNull();
      expect(config?.botToken).toBe('xoxb-test');
      expect(config?.appToken).toBe('xapp-test');
      expect(config?.signingSecret).toBe('secret');
      expect(config?.socketMode).toBe(true);
    });

    it('should include optional default channel', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      process.env.SLACK_SIGNING_SECRET = 'secret';
      process.env.SLACK_DEFAULT_CHANNEL = 'C123456';

      const config = getSlackConfigFromEnv();
      expect(config?.defaultChannelId).toBe('C123456');
    });

    it('should parse allowed user IDs', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      process.env.SLACK_SIGNING_SECRET = 'secret';
      process.env.SLACK_ALLOWED_USERS = 'U111,U222,U333';

      const config = getSlackConfigFromEnv();
      expect(config?.allowedUserIds).toEqual(['U111', 'U222', 'U333']);
    });

    it('should filter empty strings from allowed users', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      process.env.SLACK_SIGNING_SECRET = 'secret';
      process.env.SLACK_ALLOWED_USERS = 'U111,,U222,';

      const config = getSlackConfigFromEnv();
      expect(config?.allowedUserIds).toEqual(['U111', 'U222']);
    });

    it('should handle empty allowed users string', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      process.env.SLACK_SIGNING_SECRET = 'secret';
      process.env.SLACK_ALLOWED_USERS = '';

      const config = getSlackConfigFromEnv();
      expect(config?.allowedUserIds).toEqual([]);
    });
  });

  describe('getSlackConfig', () => {
    it('should return env config when env vars are set', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-env';
      process.env.SLACK_APP_TOKEN = 'xapp-env';
      process.env.SLACK_SIGNING_SECRET = 'secret-env';

      const config = await getSlackConfig();
      expect(config).not.toBeNull();
      expect(config!.botToken).toBe('xoxb-env');
    });

    it('should fall back to saved credentials when env vars are not set', async () => {
      jest.spyOn(slackCredentials, 'loadSlackCredentials').mockResolvedValue({
        botToken: 'xoxb-saved',
        appToken: 'xapp-saved',
        signingSecret: 'secret-saved',
        socketMode: true,
      });

      const config = await getSlackConfig();
      expect(config).not.toBeNull();
      expect(config!.botToken).toBe('xoxb-saved');
    });

    it('should prefer env vars over saved credentials', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-env';
      process.env.SLACK_APP_TOKEN = 'xapp-env';
      process.env.SLACK_SIGNING_SECRET = 'secret-env';

      jest.spyOn(slackCredentials, 'loadSlackCredentials').mockResolvedValue({
        botToken: 'xoxb-saved',
        appToken: 'xapp-saved',
        signingSecret: 'secret-saved',
        socketMode: true,
      });

      const config = await getSlackConfig();
      expect(config!.botToken).toBe('xoxb-env');
      // Should not even call loadSlackCredentials
      expect(slackCredentials.loadSlackCredentials).not.toHaveBeenCalled();
    });

    it('should return null when neither env vars nor saved credentials exist', async () => {
      jest.spyOn(slackCredentials, 'loadSlackCredentials').mockResolvedValue(null);

      const config = await getSlackConfig();
      expect(config).toBeNull();
    });

    it('should return null when loading saved credentials throws', async () => {
      jest.spyOn(slackCredentials, 'loadSlackCredentials').mockRejectedValue(
        new Error('disk error')
      );

      const config = await getSlackConfig();
      expect(config).toBeNull();
    });
  });

  describe('initializeSlackIfConfigured', () => {
    it('should return not attempted when not configured', async () => {
      jest.spyOn(slackCredentials, 'loadSlackCredentials').mockResolvedValue(null);
      const result = await initializeSlackIfConfigured();

      expect(result.attempted).toBe(false);
      expect(result.success).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it('should attempt initialization when configured', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      process.env.SLACK_SIGNING_SECRET = 'secret';

      // Mock SlackService.initialize to throw a controlled error
      // instead of making real network calls to Slack
      const mockError = new Error('Mock Slack init failure');
      jest.spyOn(SlackService.prototype, 'initialize').mockRejectedValue(mockError);

      const result = await initializeSlackIfConfigured();

      expect(result.attempted).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should include error message on failure', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      process.env.SLACK_SIGNING_SECRET = 'secret';

      // Mock SlackService.initialize to throw a controlled error
      // instead of making real network calls to Slack
      const mockError = new Error('Mock Slack connection error');
      jest.spyOn(SlackService.prototype, 'initialize').mockRejectedValue(mockError);

      const result = await initializeSlackIfConfigured();

      expect(result.attempted).toBe(true);
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error?.length).toBeGreaterThan(0);
      expect(result.error).toBe('Mock Slack connection error');
    });
  });

  describe('startSlackTeamChannels', () => {
    afterEach(() => {
      getSlackTeamChannelService()?.stop();
      setSlackTeamChannelService(null);
    });

    it('builds the singleton once and subscribes to team + chat events', async () => {
      await startSlackTeamChannels();
      const first = getSlackTeamChannelService();
      expect(first).not.toBeNull();
      expect(mockOnStorageEvent).toHaveBeenCalledTimes(1);
      expect(mockChatOn).toHaveBeenCalledWith('chat_message', expect.any(Function));

      await startSlackTeamChannels();
      expect(getSlackTeamChannelService()).toBe(first);
      expect(mockOnStorageEvent).toHaveBeenCalledTimes(1);
    });

    it('never throws — a failing start is logged, not propagated', async () => {
      mockChatOn.mockImplementationOnce(() => {
        throw new Error('chat db unavailable');
      });
      await expect(startSlackTeamChannels()).resolves.toBeUndefined();
    });
  });

  describe('Slack v3 — Cloud owns Slack', () => {
    const CLOUD_CONFIG: SlackCloudConfig = {
      workspace: { slackTeamId: 'T1', slackTeamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-cloud', appId: 'A0' },
      agents: [{ agentSession: 'alpha-kai-1', teamId: 't1', botUserId: 'UKAI', botToken: 'xoxb-kai', appId: 'A1', displayName: 'Kai' }],
      transport: 'cloud',
    };

    /** The registry heartbeat / agent sync must never leave the process. */
    let globalFetch: jest.SpyInstance;
    beforeEach(() => {
      globalFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, data: { installUrls: [] } }),
      } as unknown as Response);
    });

    /** Install a config service whose Cloud fetch returns the given config (or 404). */
    function installCloudConfig(config: SlackCloudConfig | null, env: NodeJS.ProcessEnv = {}) {
      mockCloud.connected = true;
      mockCloud.token = 'jwt';
      mockCloud.url = 'https://api.crewlyai.com';
      const fetchImpl = jest.fn(async () =>
        config
          ? { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: config }) }
          : { ok: false, status: 404, text: async () => JSON.stringify({ success: false }) },
      ) as unknown as typeof fetch;
      const service = new SlackCloudConfigService({
        cloud: { isConnected: () => mockCloud.connected, getToken: () => mockCloud.token, getCloudUrl: () => mockCloud.url },
        fetchImpl,
        env: { ...process.env, ...env },
        setInterval: (() => ({ unref: () => undefined })) as unknown as typeof setInterval,
        clearInterval: (() => undefined) as unknown as typeof clearInterval,
      });
      setSlackCloudConfigService(service);
      return { service, fetchImpl: fetchImpl as unknown as jest.Mock };
    }

    describe('resolveSlackConfig precedence', () => {
      it('returns null when neither local tokens nor a Cloud workspace exist', async () => {
        jest.spyOn(slackCredentials, 'loadSlackCredentials').mockResolvedValue(null);
        installCloudConfig(null);
        expect(await resolveSlackConfig()).toBeNull();
      });

      it('uses the Cloud workspace with the cloud transport when no local tokens exist', async () => {
        jest.spyOn(slackCredentials, 'loadSlackCredentials').mockResolvedValue(null);
        installCloudConfig(CLOUD_CONFIG);
        const resolved = await resolveSlackConfig();
        expect(resolved?.source).toBe('cloud');
        expect(resolved?.config).toMatchObject({ botToken: 'xoxb-cloud', transport: 'cloud', botUserId: 'UBOT', socketMode: false });
      });

      it('prefers Cloud over env tokens when both exist (migration)', async () => {
        process.env.SLACK_BOT_TOKEN = 'xoxb-env';
        process.env.SLACK_APP_TOKEN = 'xapp-env';
        process.env.SLACK_SIGNING_SECRET = 'secret-env';
        installCloudConfig(CLOUD_CONFIG);
        const resolved = await resolveSlackConfig();
        expect(resolved?.source).toBe('cloud');
        expect(resolved?.config.botToken).toBe('xoxb-cloud');
      });

      it('CREWLY_SLACK_SOURCE=env keeps the self-hosted app and never asks Cloud', async () => {
        process.env.SLACK_BOT_TOKEN = 'xoxb-env';
        process.env.SLACK_APP_TOKEN = 'xapp-env';
        process.env.SLACK_SIGNING_SECRET = 'secret-env';
        const { fetchImpl } = installCloudConfig(CLOUD_CONFIG, { CREWLY_SLACK_SOURCE: 'env' });
        const resolved = await resolveSlackConfig();
        expect(resolved?.source).toBe('env');
        expect(resolved?.config.botToken).toBe('xoxb-env');
        expect(fetchImpl).not.toHaveBeenCalled();
      });

      it('CREWLY_SLACK_SOURCE=cloud ignores local tokens even when Cloud has nothing', async () => {
        process.env.SLACK_BOT_TOKEN = 'xoxb-env';
        process.env.SLACK_APP_TOKEN = 'xapp-env';
        process.env.SLACK_SIGNING_SECRET = 'secret-env';
        const load = jest.spyOn(slackCredentials, 'loadSlackCredentials');
        installCloudConfig(null, { CREWLY_SLACK_SOURCE: 'cloud' });
        expect(await resolveSlackConfig()).toBeNull();
        expect(load).not.toHaveBeenCalled();
      });

      it('falls back to env tokens when signed in to Cloud but no workspace is installed', async () => {
        process.env.SLACK_BOT_TOKEN = 'xoxb-env';
        process.env.SLACK_APP_TOKEN = 'xapp-env';
        process.env.SLACK_SIGNING_SECRET = 'secret-env';
        installCloudConfig(null);
        expect((await resolveSlackConfig())?.source).toBe('env');
      });
    });

    describe('connectSlack (cloud source)', () => {
      it('initialises SlackService with the cloud transport, attaches the relay, seeds identities and starts the registry', async () => {
        const { service } = installCloudConfig(CLOUD_CONFIG);
        await service.refresh();
        const init = jest.spyOn(SlackService.prototype, 'initialize').mockResolvedValue(undefined);
        const attach = jest.spyOn(SlackService.prototype, 'attachCloudTransport');
        const bridgeInit = jest
          .spyOn((await import('./slack-orchestrator-bridge.js')).SlackOrchestratorBridge.prototype, 'initialize')
          .mockResolvedValue(undefined);

        const result = await connectSlack({ config: service.toSlackConfig()!, source: 'cloud' });

        expect(result).toEqual({ attempted: true, success: true });
        expect(init).toHaveBeenCalledWith(expect.objectContaining({ transport: 'cloud', botToken: 'xoxb-cloud' }));
        expect(attach).toHaveBeenCalledTimes(1);
        expect(mockSyncListeners).toHaveLength(1);
        expect(bridgeInit).toHaveBeenCalled();
        expect(getActiveSlackSource()).toBe('cloud');
        // Identities from the Cloud config are installed locally.
        expect(getSlackAgentIdentityService()?.getInstalled('alpha-kai-1')).toEqual({ botUserId: 'UKAI', botToken: 'xoxb-kai' });
        // Registry is up (heartbeat + agents sync went to Cloud).
        expect(getSlackInstanceRegistryService()).not.toBeNull();
        const registryCalls = globalFetch.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${String(url)}`);
        expect(registryCalls).toEqual([
          'PUT https://api.crewlyai.com/api/cloud/slack/instances/device-1',
          'POST https://api.crewlyai.com/api/cloud/slack/agents/sync',
        ]);
      });

      it('reports the failure when SlackService cannot initialise', async () => {
        const { service } = installCloudConfig(CLOUD_CONFIG);
        await service.refresh();
        jest.spyOn(SlackService.prototype, 'initialize').mockRejectedValue(new Error('web api down'));
        const result = await connectSlack({ config: service.toSlackConfig()!, source: 'cloud' });
        expect(result).toEqual({ attempted: true, success: false, error: 'web api down' });
        expect(getActiveSlackSource()).toBeNull();
      });
    });

    describe('initializeSlackIfConfigured keeps watching Cloud', () => {
      it('starts the config refresh and connects later when a workspace appears', async () => {
        jest.spyOn(slackCredentials, 'loadSlackCredentials').mockResolvedValue(null);
        const { service } = installCloudConfig(null);
        const start = jest.spyOn(service, 'start');
        const result = await initializeSlackIfConfigured();
        expect(result.attempted).toBe(false);
        expect(start).toHaveBeenCalled();
        expect(getSlackCloudConfigService()).toBe(service);

        // The owner clicks "Connect Slack" → next refresh brings the config.
        const init = jest.spyOn(SlackService.prototype, 'initialize').mockResolvedValue(undefined);
        jest
          .spyOn((await import('./slack-orchestrator-bridge.js')).SlackOrchestratorBridge.prototype, 'initialize')
          .mockResolvedValue(undefined);
        await handleSlackCloudConfigChange(CLOUD_CONFIG);
        // handleSlackCloudConfigChange reads the config service's current config.
        expect(init).not.toHaveBeenCalled();
        (service as unknown as { config: SlackCloudConfig }).config = CLOUD_CONFIG;
        await handleSlackCloudConfigChange(CLOUD_CONFIG);
        expect(init).toHaveBeenCalledWith(expect.objectContaining({ transport: 'cloud' }));
        expect(getActiveSlackSource()).toBe('cloud');
      });

      it('refreshSlackCloudConfig (after Cloud login) fetches now and connects from a cached config Cloud could not confirm at boot', async () => {
        jest.spyOn(slackCredentials, 'loadSlackCredentials').mockResolvedValue(null);
        const { service, fetchImpl } = installCloudConfig(CLOUD_CONFIG);
        // Boot happened while signed out: cache is populated, nothing connected.
        await service.refresh();
        expect(getSlackService().isConnected()).toBe(false);

        const init = jest.spyOn(SlackService.prototype, 'initialize').mockResolvedValue(undefined);
        jest
          .spyOn((await import('./slack-orchestrator-bridge.js')).SlackOrchestratorBridge.prototype, 'initialize')
          .mockResolvedValue(undefined);
        await refreshSlackCloudConfig();

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(init).toHaveBeenCalledWith(expect.objectContaining({ transport: 'cloud' }));
        expect(getActiveSlackSource()).toBe('cloud');
      });

      it('disconnects a cloud-sourced connection when the workspace is removed, leaves an env one alone', async () => {
        const { service } = installCloudConfig(CLOUD_CONFIG);
        await service.refresh();
        jest.spyOn(SlackService.prototype, 'initialize').mockResolvedValue(undefined);
        jest
          .spyOn((await import('./slack-orchestrator-bridge.js')).SlackOrchestratorBridge.prototype, 'initialize')
          .mockResolvedValue(undefined);
        const disconnect = jest.spyOn(SlackService.prototype, 'disconnect').mockResolvedValue(undefined);

        await connectSlack({ config: service.toSlackConfig()!, source: 'cloud' });
        await handleSlackCloudConfigChange(null);
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(getActiveSlackSource()).toBeNull();

        await connectSlack({ config: { botToken: 'x', appToken: 'y', signingSecret: 'z', socketMode: true }, source: 'env' });
        await handleSlackCloudConfigChange(null);
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(getActiveSlackSource()).toBe('env');
      });
    });
  });

  describe('shutdownSlack', () => {
    it('should not throw when not connected', async () => {
      await expect(shutdownSlack()).resolves.not.toThrow();
    });

    it('should handle shutdown gracefully', async () => {
      // Get service to ensure it exists
      const service = getSlackService();
      expect(service.isConnected()).toBe(false);

      await expect(shutdownSlack()).resolves.not.toThrow();
    });
  });
});
