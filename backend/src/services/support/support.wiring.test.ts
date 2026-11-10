/**
 * Tests for the support wiring (crewly#1558): the kill switch default and
 * an end-to-end request through the real relay + API.
 */

import { getDefaultSettings, type CrewlySettings } from '../../types/settings.types.js';
import type { ISupportRelayCloudSync, SupportRelayIncomingMessage } from './support-relay.service.js';
import { grantAllowed, startSupportRelay } from './support.wiring.js';

jest.mock('../core/logger.service.js', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { LoggerService: { getInstance: () => ({ createComponentLogger: () => log }) } };
});

jest.mock('../activity/activity-log.service.js', () => ({ recordActivity: jest.fn() }));

const ENVELOPE = { grantId: 'g1', role: 'viewer' as const, includePrivate: false, granteeEmail: 'help@crewlyai.com', granteeAccountId: 'acct-b', replyQueueId: 'q-b' };

function sync() {
  const handlers: Array<(m: SupportRelayIncomingMessage) => void> = [];
  const sent: Array<{ to: string; payload: { status: number; body: unknown } }> = [];
  const s: ISupportRelayCloudSync = {
    on: (_e, h) => void handlers.push(h),
    off: () => undefined,
    sendToPeerQueueId: async (to, _t, payload) => void sent.push({ to, payload: payload as { status: number; body: unknown } }),
  };
  return { s, handlers, sent };
}

describe('grantAllowed', () => {
  it('is on by default and off only when the owner says so', () => {
    const s = getDefaultSettings();
    expect(grantAllowed(s)).toBe(true);
    expect(grantAllowed({ ...s, support: undefined })).toBe(true);
    expect(grantAllowed({ ...s, support: { allowGrantees: false } })).toBe(false);
  });
});

describe('startSupportRelay', () => {
  it('serves a vouched request end to end and honours the kill switch', async () => {
    const { s, handlers, sent } = sync();
    let settings: CrewlySettings = getDefaultSettings();
    startSupportRelay({
      cloudSync: s,
      chat: () => null,
      teams: async () => [{ id: 't1', name: 'T', members: [{ id: 'm', name: 'Dev', sessionName: 'a-dev', agentStatus: 'active' }] }],
      orchestrator: async () => null,
      crewlyHome: '/nonexistent-crewly-home',
      agentRegistration: () => null,
      settings: async () => settings,
      restartAgent: async () => true,
    });
    expect(handlers).toHaveLength(1);
    handlers[0]({ type: 'api_request', payload: { id: 'r1', method: 'GET', path: '/support/agents' }, encrypted: false, fromDeviceName: 'q-b', supportGrant: ENVELOPE });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[0].to).toBe('q-b');
    expect(sent[0].payload.status).toBe(200);
    expect(JSON.stringify(sent[0].payload.body)).toContain('a-dev');

    settings = { ...settings, support: { allowGrantees: false } };
    handlers[0]({ type: 'api_request', payload: { id: 'r2', method: 'GET', path: '/support/agents' }, encrypted: false, fromDeviceName: 'q-b', supportGrant: ENVELOPE });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[1].payload.status).toBe(403);
  });

  it('reads recent errors from the missing service log as empty', async () => {
    const { s, handlers, sent } = sync();
    startSupportRelay({
      cloudSync: s,
      chat: () => null,
      teams: async () => [],
      orchestrator: async () => null,
      crewlyHome: '/nonexistent-crewly-home',
      agentRegistration: () => null,
      settings: async () => getDefaultSettings(),
    });
    handlers[0]({ type: 'api_request', payload: { id: 'r1', method: 'GET', path: '/support/errors' }, encrypted: false, fromDeviceName: 'q-b', supportGrant: ENVELOPE });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[0].payload).toEqual({ id: 'r1', status: 200, body: { success: true, data: { source: 'service.log', lines: [] } } });
  });
});
