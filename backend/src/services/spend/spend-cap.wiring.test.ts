import { mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

const addInboundInterceptor = jest.fn(() => () => undefined);
jest.mock('../slack/slack-orchestrator-bridge.js', () => ({
  getSlackOrchestratorBridge: () => ({ addInboundInterceptor }),
}));
jest.mock('../slack/slack.service.js', () => ({
  getSlackService: () => ({ isConnected: () => false, getOwnerUserId: () => null }),
}));
jest.mock('../slack/slack-agent-identity.service.js', () => ({
  getSlackAgentIdentityService: () => null,
}));

import { startSpendCaps } from './spend-cap.wiring.js';
import { setSpendCapGate, spendCapStopOf } from './spend-cap.gate.js';
import { getSpendCapService, setSpendCapService } from './spend-cap.service.js';
import { DecisionService } from '../decisions/decision.service.js';
import { SubAgentMessageQueue } from '../messaging/sub-agent-message-queue.service.js';
import { TokenUsageService } from '../monitoring/token-usage.service.js';

describe('startSpendCaps', () => {
  let home: string;
  const logger = { info: jest.fn(), warn: jest.fn() };

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'spend-wiring-'));
    TokenUsageService.resetInstance();
  });

  afterEach(() => {
    getSpendCapService()?.stop();
    setSpendCapService(null);
    setSpendCapGate(null);
    DecisionService.registerKindHandler('spend_cap', null);
    SubAgentMessageQueue.getInstance().dequeueAll('ella-1');
    rmSync(home, { recursive: true, force: true });
  });

  it('installs the gate, the card handler and the orc-DM commands; releases queued messages when a stop lifts', async () => {
    const sendMessageToAgent = jest.fn(async () => ({ success: true }));
    const activate = jest.fn(async () => ({ success: true }));
    const service = await startSpendCaps({
      crewlyHome: home,
      storage: { getTeams: async () => [{ id: 'team-mk', name: 'Marketing', members: [{ name: 'Ella', sessionName: 'ella-1' }] }] },
      registration: () => ({ isInProcessRuntimeActive: () => false, sendMessageToAgent }),
      sessionExists: (s) => s === 'ella-1',
      activate,
      logger,
    });
    await service.refreshTeams();
    expect(getSpendCapService()).toBe(service);
    expect(addInboundInterceptor).toHaveBeenCalledWith('the token cap commands', expect.any(Function));
    expect(service.displayNameOf('ella-1')).toBe('Ella');
    expect(service.displayNameOf('crewly-orc')).toBe('Orc');

    // Cap Ella's team at 1M tokens and record 5.1M tokens today: she is stopped.
    TokenUsageService.getInstance().recordUsage('ella-1', 'ella-1', 5_000_000, 100_000, 'deepseek/deepseek-chat');
    await service.setCaps({ teams: { 'team-mk': '1M' } });
    expect(spendCapStopOf('ella-1')).toMatchObject({ scope: 'team', capTokens: 1_000_000, usedTokens: 5_100_000, teamName: 'Marketing' });
    SubAgentMessageQueue.getInstance().enqueue('ella-1', 'queued while capped');

    // Unlimited today for the team lifts the stop and flushes her queue into the live session.
    await service.boost({ scope: 'team', id: 'Marketing', unlimited: true });
    expect(spendCapStopOf('ella-1')).toBeNull();
    expect(sendMessageToAgent).toHaveBeenCalledWith('ella-1', 'queued while capped');
    expect(activate).not.toHaveBeenCalled();
  });
});

describe('startSpendCaps — USD migration', () => {
  it('converts pre-token USD caps once and logs it', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'spend-migrate-'));
    const { writeFileSync, readFileSync } = await import('fs');
    writeFileSync(path.join(home, 'spend-caps.json'), JSON.stringify({ config: { defaultAgentCapUsd: 5, totalCapUsd: null, agentCapsUsd: { 'crewly-orc': 2.5 } }, day: {} }));
    const logger = { info: jest.fn(), warn: jest.fn() };
    const service = await startSpendCaps({
      crewlyHome: home,
      storage: { getTeams: async () => [] },
      registration: () => null,
      sessionExists: () => false,
      activate: async () => undefined,
      logger,
    });
    try {
      expect(service.getConfig()).toMatchObject({ defaultAgentCapTokens: 5_000_000, totalCapTokens: null, agentCapsTokens: { 'crewly-orc': 2_500_000 } });
      expect(logger.info).toHaveBeenCalledWith('Migrated daily spend caps from USD to tokens', expect.objectContaining({ tokensPerUsd: 1_000_000 }));
      expect(JSON.parse(readFileSync(path.join(home, 'usage-caps.json'), 'utf-8')).config.defaultAgentCapTokens).toBe(5_000_000);
    } finally {
      service.stop();
      setSpendCapService(null);
      setSpendCapGate(null);
      DecisionService.registerKindHandler('spend_cap', null);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
