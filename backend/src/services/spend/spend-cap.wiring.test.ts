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
      storage: { getTeams: async () => [{ members: [{ name: 'Ella', sessionName: 'ella-1' }] }] },
      registration: () => ({ isInProcessRuntimeActive: () => false, sendMessageToAgent }),
      sessionExists: (s) => s === 'ella-1',
      activate,
      logger,
    });
    expect(getSpendCapService()).toBe(service);
    expect(addInboundInterceptor).toHaveBeenCalledWith('the spend cap commands', expect.any(Function));
    expect(service.displayNameOf('ella-1')).toBe('Ella');
    expect(service.displayNameOf('crewly-orc')).toBe('Orc');

    // Cap Ella at $1 and record $2 of DeepSeek spend today: she is stopped.
    TokenUsageService.getInstance().recordUsage('ella-1', 'ella-1', 5_000_000, 100_000, 'deepseek/deepseek-chat');
    await service.setCaps({ agents: { 'ella-1': 1 } });
    expect(spendCapStopOf('ella-1')).toMatchObject({ scope: 'agent', capUsd: 1 });
    SubAgentMessageQueue.getInstance().enqueue('ella-1', 'queued while capped');

    // Raising the cap lifts the stop and flushes her queue into the live session.
    await service.raiseToday('ella-1', 50);
    expect(spendCapStopOf('ella-1')).toBeNull();
    expect(sendMessageToAgent).toHaveBeenCalledWith('ella-1', 'queued while capped');
    expect(activate).not.toHaveBeenCalled();
  });
});
