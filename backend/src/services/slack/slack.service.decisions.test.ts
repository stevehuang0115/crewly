/**
 * Decision cards on the Slack transports (specs/2026-10-01-decision-cards.md §5):
 * Cloud-forwarded `block_actions` (crewly-services PR #24 wire shape) and
 * `reaction_added` are emitted as `interaction` / `reaction`, never as messages.
 */
import { EventEmitter } from 'events';
import { SlackService } from './slack.service.js';
import type { SlackConfig } from '../../types/slack.types.js';

jest.mock('../chat-v2/chat-v2.singleton.js', () => ({
  getChatV2Service: () => ({ ensureChannelForLegacyConversation: jest.fn(), recordTurn: jest.fn(() => ({ message: { id: 'm' } })) }),
}));
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    auth: { test: jest.fn().mockResolvedValue({ ok: true, user_id: 'UBOT' }) },
    chat: { postMessage: jest.fn().mockResolvedValue({ ts: '9.9' }), update: jest.fn() },
    reactions: { add: jest.fn() },
    users: { info: jest.fn() },
    files: { uploadV2: jest.fn(), info: jest.fn() },
  })),
}));
const boltHandlers: { actions: Array<{ id: unknown; h: (a: any) => Promise<void> }>; events: Record<string, (a: any) => Promise<void>> } = { actions: [], events: {} };
jest.mock('@slack/bolt', () => ({
  App: jest.fn().mockImplementation(() => ({
    client: { chat: { postMessage: jest.fn(), update: jest.fn() }, reactions: { add: jest.fn() }, users: { info: jest.fn() }, files: { uploadV2: jest.fn(), info: jest.fn() } },
    receiver: { client: new EventEmitter() },
    message: jest.fn(),
    event: jest.fn().mockImplementation((t: string, h: (a: any) => Promise<void>) => { boltHandlers.events[t] = h; }),
    action: jest.fn().mockImplementation((id: unknown, h: (a: any) => Promise<void>) => { boltHandlers.actions.push({ id, h }); }),
    error: jest.fn(),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
  LogLevel: { INFO: 'info' },
}));

const cloudConfig: SlackConfig = { botToken: 'xoxb-cloud', appToken: '', signingSecret: '', socketMode: false, transport: 'cloud', botUserId: 'UBOT' } as SlackConfig;

const interaction = {
  type: 'block_actions',
  api_app_id: 'A-agent',
  team: { id: 'T1' },
  user: { id: 'U-OWNER', name: 'steve' },
  container: { type: 'message', channel_id: 'C1', message_ts: '1.2', thread_ts: '1.0' },
  channel: { id: 'C1' },
  message: { ts: '1.2', thread_ts: '1.0' },
  actions: [{ action_id: 'decision:a', value: '{"d":"D-1","o":"a","i":"inst-1"}', action_ts: '3.4' }],
};

describe('SlackService decision-card transport', () => {
  it('emits a Cloud-forwarded block_actions as an interaction, not a message', async () => {
    const service = new SlackService();
    await service.initialize(cloudConfig);
    const messages: unknown[] = [];
    const interactions: any[] = [];
    service.on('message', (m) => messages.push(m));
    service.on('interaction', (e) => interactions.push(e));
    const out = service.handleCloudEnvelope({
      eventId: 'interaction:T1:1.2:3.4',
      slackTeamId: 'T1',
      apiAppId: 'A-agent',
      source: 'agent',
      agentSession: 'team-ella-1',
      event: { type: 'block_actions', channel: 'C1', user: 'U-OWNER', ts: '3.4', message_ts: '1.2', thread_ts: '1.0' } as any,
      interaction,
      receivedAt: new Date().toISOString(),
    } as any);
    expect(out).toBeNull();
    expect(messages).toHaveLength(0);
    expect(interactions).toEqual([{ payload: interaction, source: 'cloud', eventId: 'interaction:T1:1.2:3.4' }]);
  });

  it('drops a block_actions envelope without its payload', async () => {
    const service = new SlackService();
    await service.initialize(cloudConfig);
    const interactions: unknown[] = [];
    service.on('interaction', (e) => interactions.push(e));
    service.handleCloudEnvelope({ eventId: 'x', slackTeamId: 'T1', apiAppId: 'A', source: 'master', event: { type: 'block_actions' }, receivedAt: '' } as any);
    expect(interactions).toHaveLength(0);
  });

  it('emits reaction_added once per reaction (copies deduped) and never as a message', async () => {
    const service = new SlackService();
    await service.initialize(cloudConfig);
    const messages: unknown[] = [];
    const reactions: any[] = [];
    service.on('message', (m) => messages.push(m));
    service.on('reaction', (r) => reactions.push(r));
    const env = (source: 'master' | 'agent') => ({
      eventId: `Ev-${source}`,
      slackTeamId: 'T1',
      apiAppId: 'A',
      source,
      event: { type: 'reaction_added', user: 'U-OWNER', reaction: 'white_check_mark', item: { type: 'message', channel: 'C1', ts: '1.2' }, event_ts: '5.5' },
      receivedAt: '',
    });
    expect(service.handleCloudEnvelope(env('master') as any)).toBeNull();
    expect(service.handleCloudEnvelope(env('agent') as any)).toBeNull();
    expect(messages).toHaveLength(0);
    expect(reactions).toEqual([{ user: 'U-OWNER', reaction: 'white_check_mark', channelId: 'C1', messageTs: '1.2', source: 'cloud' }]);
  });

  it('ignores reactions made by its own bot', async () => {
    const service = new SlackService();
    await service.initialize(cloudConfig);
    (service as any).cachedBotUserId = 'UBOT';
    const reactions: unknown[] = [];
    service.on('reaction', (r) => reactions.push(r));
    service.handleCloudEnvelope({ eventId: 'e', slackTeamId: 'T1', apiAppId: 'A', source: 'master', event: { type: 'reaction_added', user: 'UBOT', reaction: 'x', item: { channel: 'C1', ts: '1.2' } }, receivedAt: '' } as any);
    expect(reactions).toHaveLength(0);
  });

  it('Socket Mode: decision buttons and reactions reach the same events', async () => {
    boltHandlers.actions = [];
    boltHandlers.events = {};
    const service = new SlackService();
    await service.initialize({ botToken: 'xoxb-t', appToken: 'xapp-t', signingSecret: 's', socketMode: true } as SlackConfig);
    const interactions: any[] = [];
    const reactions: any[] = [];
    service.on('interaction', (e) => interactions.push(e));
    service.on('reaction', (r) => reactions.push(r));
    const decision = boltHandlers.actions.find((a) => a.id instanceof RegExp && (a.id as RegExp).test('decision:a'));
    expect(decision).toBeDefined();
    const ack = jest.fn().mockResolvedValue(undefined);
    await decision!.h({ ack, body: interaction, action: interaction.actions[0], respond: jest.fn() });
    expect(ack).toHaveBeenCalled();
    expect(interactions).toEqual([{ payload: interaction, source: 'socket' }]);
    await boltHandlers.events.reaction_added({ event: { type: 'reaction_added', user: 'U-OWNER', reaction: 'alarm_clock', item: { channel: 'C1', ts: '1.2' } } });
    expect(reactions).toEqual([{ user: 'U-OWNER', reaction: 'alarm_clock', channelId: 'C1', messageTs: '1.2', source: 'socket' }]);
  });
});
