/**
 * Tests for CloudTalkInboundService — the machine side of Cloud Talk:
 * verify-by-fetch, record in the agent's DM as `cloud-talk`, hand to the
 * agent, idempotency, refusals, and that the reply stays off Slack and
 * uploads with the right agent/channel.
 */
import { EventEmitter } from 'events';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ChatV2Service } from '../chat-v2/chat-v2.service.js';
import { openChatDatabase } from '../chat-v2/sqlite/chat-db.js';
import { loadChatV2Config } from '../chat-v2/config.js';
import type { ChatChannelDTO, ChatMessageDTO } from '../chat-v2/types.js';
import type { ComponentLogger } from '../core/logger.service.js';
import type { IncomingMessage } from './cloud-sync.types.js';
import { toIngestUpsert } from './conversation-cloud-sync.service.js';
import {
  CloudTalkInboundService,
  cloudTalkCapabilities,
  isCloudTalkInboundActive,
  type CloudTalkFetch,
} from './cloud-talk-inbound.service.js';

const INSTANCE = 'dev-mac-mini';
const CLOUD = 'https://api.crewly.test';

function logger(): ComponentLogger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as ComponentLogger;
}

function push(over: Record<string, unknown> = {}, type = 'talk_message'): IncomingMessage {
  return {
    id: `relay-${Math.random()}`,
    from: 'crewly-cloud-slack-acct',
    fromDeviceName: 'crewly-cloud-slack',
    type: type as IncomingMessage['type'],
    payload: { v: 1, messageId: '65f0c0ffee', clientMessageId: 'talk-1', instanceId: INSTANCE, agentSession: 'ella', ...over },
    encrypted: false,
    sentAt: new Date().toISOString(),
  };
}

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const stored = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    messageId: '65f0c0ffee',
    clientMessageId: 'talk-1',
    instanceId: INSTANCE,
    agentSession: 'ella',
    text: 'how is the release going?',
    inputMode: 'voice',
    createdAt: '2026-09-28T12:00:00.000Z',
    delivery: 'sent',
    ...over,
  },
});

describe('CloudTalkInboundService', () => {
  let chat: ChatV2Service;
  let source: EventEmitter;
  let fetchMock: jest.Mock<CloudTalkFetch>;
  let deliver: jest.Mock<(channel: ChatChannelDTO, message: ChatMessageDTO) => Promise<void>>;
  let agents: Set<string>;
  let token: string | null;
  let refresh: jest.Mock<() => Promise<boolean>>;
  let service: CloudTalkInboundService;

  beforeEach(() => {
    chat = new ChatV2Service({
      config: loadChatV2Config({}),
      db: openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true }),
    });
    source = new EventEmitter();
    fetchMock = jest.fn<CloudTalkFetch>().mockResolvedValue(json(200, stored()));
    deliver = jest.fn<(channel: ChatChannelDTO, message: ChatMessageDTO) => Promise<void>>().mockResolvedValue(undefined);
    agents = new Set(['ella', 'crewly-orc']);
    token = 'machine-token';
    refresh = jest.fn<() => Promise<boolean>>().mockResolvedValue(false);
    service = new CloudTalkInboundService({
      source,
      cloud: { getToken: () => token, getCloudUrl: () => `${CLOUD}/`, tryRefreshToken: refresh },
      chat,
      identity: async () => ({ instanceId: INSTANCE, deviceName: 'Mac mini' }),
      deliver,
      agentExists: async (s) => agents.has(s),
      fetchImpl: fetchMock,
      sleep: async () => undefined,
      logger: logger(),
    });
  });

  afterEach(() => {
    service.stop();
    chat.close();
  });

  it('advertises talk_message only while started, and listens on the relay source', async () => {
    expect(isCloudTalkInboundActive()).toBe(false);
    expect(cloudTalkCapabilities()).toEqual([]);
    service.start();
    expect(isCloudTalkInboundActive()).toBe(true);
    expect(cloudTalkCapabilities()).toEqual(['talk_message']);
    source.emit('message', push());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalled();
    service.stop();
    expect(cloudTalkCapabilities()).toEqual([]);
  });

  it('fetches the text with the machine token, records it in the agent DM as cloud-talk and hands it to the agent', async () => {
    expect(await service.handle(push())).toBe('delivered');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${CLOUD}/api/cloud/conversations/talk/65f0c0ffee?instanceId=${INSTANCE}`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer machine-token');

    const dm = chat.ensureDmChannel({ agentSession: 'ella', principal: { userId: 'dev-user-001', source: 'oss' } }).channel;
    expect(deliver).toHaveBeenCalledTimes(1);
    const [channel, message] = deliver.mock.calls[0]!;
    expect(channel.id).toBe(dm.id);
    expect(channel.agentSession).toBe('ella');
    expect(message).toMatchObject({ senderType: 'user', content: 'how is the release going?' });
    expect(message.metadata).toMatchObject({ source: 'cloud-talk', clientMessageId: 'talk-1' });
  });

  it('records one row for a re-push of the same message and does not page the agent twice', async () => {
    expect(await service.handle(push())).toBe('delivered');
    expect(await service.handle(push())).toBe('duplicate');
    expect(deliver).toHaveBeenCalledTimes(1);
    const dm = chat.ensureDmChannel({ agentSession: 'ella', principal: { userId: 'dev-user-001', source: 'oss' } }).channel;
    expect(chat.listMessages({ channelId: dm.id, principal: { userId: 'dev-user-001', source: 'oss' } }).messages).toHaveLength(1);
  });

  it('ignores other relay types and malformed pushes (older machines ignore talk_message the same way)', async () => {
    expect(await service.handle(push({}, 'slack_event'))).toBe('ignored');
    expect(await service.handle(push({ clientMessageId: 'bad id' }))).toBe('ignored');
    expect(await service.handle({ ...push(), payload: 'nope' })).toBe('ignored');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never delivers a push Cloud does not confirm for this account and machine', async () => {
    expect(await service.handle(push({ instanceId: 'someone-else' }))).toBe('not_for_this_machine');
    fetchMock.mockResolvedValueOnce(json(404, { success: false, code: 'not_found' }));
    expect(await service.handle(push())).toBe('unverified');
    fetchMock.mockResolvedValueOnce(json(200, stored({ clientMessageId: 'talk-other' })));
    expect(await service.handle(push())).toBe('unverified');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('skips a message Cloud already marked failed (410)', async () => {
    fetchMock.mockResolvedValueOnce(json(410, { success: false, code: 'expired' }));
    expect(await service.handle(push())).toBe('expired');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refreshes the token once on 401, and retries network / 5xx errors before giving up', async () => {
    refresh.mockImplementation(async () => {
      token = 'fresh-token';
      return true;
    });
    fetchMock.mockResolvedValueOnce(json(401, {}));
    expect(await service.handle(push())).toBe('delivered');
    expect((fetchMock.mock.calls[1]![1].headers as Record<string, string>).Authorization).toBe('Bearer fresh-token');

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    expect(await service.handle(push({ messageId: 'm2', clientMessageId: 'talk-2' }))).toBe('fetch_failed');
    expect(fetchMock).toHaveBeenCalledTimes(4); // first try + 3 retries
  });

  it('refuses a message for an agent this machine does not have, and tells Cloud', async () => {
    agents.delete('ella');
    expect(await service.handle(push())).toBe('refused');
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(`${CLOUD}/api/cloud/conversations/talk/65f0c0ffee/failed`);
    expect(JSON.parse(init.body as string)).toEqual({ instanceId: INSTANCE, error: 'No agent named "ella" on Mac mini' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('talks to the orchestrator through its DM too', async () => {
    fetchMock.mockResolvedValueOnce(json(200, stored({ agentSession: 'crewly-orc' })));
    expect(await service.handle(push({ agentSession: 'crewly-orc' }))).toBe('delivered');
    expect(deliver.mock.calls[0]![0].agentSession).toBe('crewly-orc');
  });

  it('keeps the agent reply off Slack and uploads both turns with the agent, channel and Talk id', async () => {
    await service.handle(push());
    const [channel, owner] = deliver.mock.calls[0]!;
    // The agent answers in the DM (reply-chat → recordTurn).
    const { message: reply } = chat.recordTurn({
      channelId: channel.id,
      senderType: 'agent',
      senderId: 'ella',
      content: 'Release is on track.',
      metadata: { source: 'reply-tool' },
    });
    // G6: the owner's latest turn came from Cloud Talk → no Slack mirror.
    expect(chat.getLatestOwnerTurnSource(channel.id)).toBe('cloud-talk');

    const rows = chat.getCloudOutbox().getMessages([owner.id, reply.id]);
    const ownerUp = toIngestUpsert(rows.get(owner.id)!, 1);
    const replyUp = toIngestUpsert(rows.get(reply.id)!, 2);
    expect(ownerUp).toMatchObject({ agentSession: 'ella', source: 'cloud-talk', direction: 'in', senderKind: 'owner', clientMessageId: 'talk-1', channel: { localId: channel.id, kind: 'dm' } });
    expect(replyUp).toMatchObject({ agentSession: 'ella', source: 'cloud-talk', direction: 'out', senderKind: 'agent', channel: { localId: channel.id } });
    expect(replyUp?.clientMessageId).toBeUndefined();
  });
});
