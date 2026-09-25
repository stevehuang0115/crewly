/**
 * Tests for the backend wiring of the bundle engine: the Slack adapter, the
 * maintenance pass and its timer.
 */

import type { Team } from '../../types/index.js';

const mockTeamChannels = {
  ensureTeamChannel: jest.fn(async () => ({ slackChannelId: 'C1', slackChannelName: 'team' })),
  ensureAgentChannel: jest.fn(async () => ({ slackChannelId: 'C2', slackChannelName: 'extra' })),
};
let mockChannelService: typeof mockTeamChannels | null = mockTeamChannels;
let mockSlackConnected = true;

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    }),
  },
}));
jest.mock('../slack/slack-team-channel.service.js', () => ({ getSlackTeamChannelService: () => mockChannelService }));
jest.mock('../slack/slack.service.js', () => ({ getSlackService: () => ({ isConnected: () => mockSlackConnected }) }));
jest.mock('../harness/harness.service.js', () => ({ getHarnessService: () => ({ orc: { get: async () => 'claude-code' } }) }));
jest.mock('../google/google-workspace-token.service.js', () => ({ GoogleWorkspaceTokenService: { getInstance: jest.fn() } }));
jest.mock('../canva/canva-token.service.js', () => ({ CanvaTokenService: { getInstance: jest.fn() } }));
jest.mock('../microsoft/microsoft-token.service.js', () => ({ MicrosoftTokenService: { getInstance: jest.fn() } }));
jest.mock('../whatsapp/whatsapp.service.js', () => ({ getWhatsAppService: jest.fn() }));

import {
  createBackendBundleDeps,
  createSlackBundleApi,
  getBundleApplyService,
  getBundleCatalog,
  runBundleMaintenance,
  setBundleApplyServiceForTesting,
  startBundleMaintenance,
  stopBundleMaintenance,
} from './bundle-apply.factory.js';
import type { BundleApplyService } from './bundle-apply.service.js';

describe('bundle apply factory', () => {
  afterEach(() => {
    mockChannelService = mockTeamChannels;
    mockSlackConnected = true;
    stopBundleMaintenance();
    setBundleApplyServiceForTesting(null);
  });

  describe('createSlackBundleApi', () => {
    it('is connected only when Slack and the team-channel service are up', () => {
      const api = createSlackBundleApi();
      expect(api.isConnected()).toBe(true);
      mockSlackConnected = false;
      expect(api.isConnected()).toBe(false);
      mockSlackConnected = true;
      mockChannelService = null;
      expect(api.isConnected()).toBe(false);
    });

    it('delegates channel creation to SlackTeamChannelService', async () => {
      const api = createSlackBundleApi();
      expect(await api.ensureTeamChannel({ id: 't' } as Team)).toEqual({ slackChannelId: 'C1', slackChannelName: 'team' });
      const input = { name: 'x', purpose: '', memberSessions: ['a'] };
      expect(await api.ensureAgentChannel(input)).toEqual({ slackChannelId: 'C2', slackChannelName: 'extra' });
      expect(mockTeamChannels.ensureAgentChannel).toHaveBeenCalledWith(input);
    });

    it('throws when the team-channel service is not running', async () => {
      mockChannelService = null;
      await expect(createSlackBundleApi().ensureTeamChannel({ id: 't' } as Team)).rejects.toThrow(/not running/);
    });
  });

  it('backend deps add Slack, schedules, the orchestrator and connector checks', () => {
    const deps = createBackendBundleDeps();
    expect(deps.slack).not.toBeNull();
    expect(deps.schedules).not.toBeNull();
    expect(deps.orchestrator).not.toBeNull();
    expect(deps.connectors).not.toBeNull();
  });

  it('singletons share one catalog', () => {
    expect(getBundleApplyService()).toBe(getBundleApplyService());
    expect(getBundleCatalog()).toBe(getBundleCatalog());
  });

  it('a maintenance pass resumes waiting deployments and delivers due tasks, and survives errors', async () => {
    const service = { resumeWaiting: jest.fn(async () => ['x']), deliverDue: jest.fn(async () => 2) } as unknown as BundleApplyService;
    await runBundleMaintenance(service);
    expect(service.resumeWaiting).toHaveBeenCalled();
    expect(service.deliverDue).toHaveBeenCalled();
    const broken = { resumeWaiting: jest.fn(async () => { throw new Error('x'); }), deliverDue: jest.fn() } as unknown as BundleApplyService;
    await expect(runBundleMaintenance(broken)).resolves.toBeUndefined();
  });

  it('the maintenance timer starts once and stops', () => {
    const service = { resumeWaiting: jest.fn(async () => []), deliverDue: jest.fn(async () => 0) } as unknown as BundleApplyService;
    setBundleApplyServiceForTesting(service);
    const spy = jest.spyOn(global, 'setInterval');
    startBundleMaintenance();
    startBundleMaintenance();
    expect(spy).toHaveBeenCalledTimes(1);
    stopBundleMaintenance();
    spy.mockRestore();
  });
});
