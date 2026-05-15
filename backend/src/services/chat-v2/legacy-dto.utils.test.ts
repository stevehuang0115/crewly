/**
 * Tests for chat-v2 ↔ legacy DTO translation helpers.
 *
 * @module services/chat-v2/legacy-dto-utils.test
 */

import {
  senderToV2,
  v2MessageToLegacy,
  v2ChannelToLegacy,
  inferSourceFromLegacyMetadata,
  SYSTEM_PRINCIPAL,
} from './legacy-dto.utils.js';
import type { ChatMessageDTO, ChatChannelDTO } from './types.js';

describe('senderToV2', () => {
  it('maps user → user', () => {
    expect(senderToV2({ type: 'user', id: 'U999', name: 'Steve' })).toEqual({
      type: 'user',
      id: 'U999',
    });
  });

  it('maps system → system', () => {
    expect(senderToV2({ type: 'system', id: 'system' })).toEqual({
      type: 'system',
      id: 'system',
    });
  });

  it('maps orchestrator → agent', () => {
    expect(senderToV2({ type: 'orchestrator', id: 'crewly-orc', name: 'Orc' })).toEqual({
      type: 'agent',
      id: 'crewly-orc',
    });
  });

  it('maps agent → agent', () => {
    expect(senderToV2({ type: 'agent', id: 'crewly-product-sam' })).toEqual({
      type: 'agent',
      id: 'crewly-product-sam',
    });
  });

  it('treats unknown sender types as agent (forward-compatible)', () => {
    expect(senderToV2({ type: 'auditor' as any, id: 'crewly-auditor' })).toEqual({
      type: 'agent',
      id: 'crewly-auditor',
    });
  });

  it('falls back to name → id → literal for senderId when fields are missing', () => {
    expect(senderToV2({ type: 'user', name: 'Steve' } as any).id).toBe('Steve');
    expect(senderToV2({ type: 'user' } as any).id).toBe('user');
  });
});

describe('v2MessageToLegacy', () => {
  const dto: ChatMessageDTO = {
    id: 'msg-1',
    channelId: 'slack-D0AC7-1234',
    seq: 1,
    senderType: 'agent',
    senderId: 'crewly-orc',
    content: 'hello',
    contentType: 'markdown',
    createdAt: 1700000000000,
    metadata: { source: 'in-process-runtime' },
    mentions: [],
  };

  it('converts createdAt ms → ISO timestamp', () => {
    const legacy = v2MessageToLegacy(dto);
    expect(legacy.timestamp).toBe('2023-11-14T22:13:20.000Z');
  });

  it('maps senderType=agent → from.type=orchestrator', () => {
    expect(v2MessageToLegacy(dto).from.type).toBe('orchestrator');
  });

  it('maps senderType=user → from.type=user', () => {
    expect(v2MessageToLegacy({ ...dto, senderType: 'user', senderId: 'U999' }).from.type).toBe(
      'user',
    );
  });

  it('maps senderType=system → from.type=system', () => {
    expect(v2MessageToLegacy({ ...dto, senderType: 'system', senderId: 'system' }).from.type).toBe(
      'system',
    );
  });

  it('preserves metadata as-is', () => {
    expect(v2MessageToLegacy(dto).metadata).toEqual({ source: 'in-process-runtime' });
  });

  it('preserves conversationId (= channelId)', () => {
    expect(v2MessageToLegacy(dto).conversationId).toBe('slack-D0AC7-1234');
  });
});

describe('v2ChannelToLegacy', () => {
  const channel: ChatChannelDTO = {
    id: 'slack-D0AC7-1234',
    agentSession: 'crewly-orc',
    name: 'Slack Thread',
    createdAt: 1700000000000,
    lastMessageAt: 1700000060000,
    archivedAt: null,
    agentPresence: { status: 'online', lastSeenAt: null },
    type: 'dm',
  };

  it('maps lastMessageAt → updatedAt ISO', () => {
    const legacy = v2ChannelToLegacy(channel, 5);
    expect(legacy.updatedAt).toBe('2023-11-14T22:14:20.000Z');
  });

  it('falls back to createdAt when lastMessageAt is null', () => {
    const noLast: ChatChannelDTO = { ...channel, lastMessageAt: null };
    const legacy = v2ChannelToLegacy(noLast, 0);
    expect(legacy.updatedAt).toBe(new Date(channel.createdAt).toISOString());
  });

  it('treats archivedAt != null as isArchived=true', () => {
    expect(v2ChannelToLegacy({ ...channel, archivedAt: 1700001000000 }, 0).isArchived).toBe(true);
  });

  it('infers channelType from conversationId', () => {
    expect(v2ChannelToLegacy(channel, 0).channelType).toBe('slack');
    expect(v2ChannelToLegacy({ ...channel, id: 'web-conv-abc' }, 0).channelType).toBe('chat');
  });

  it('builds participantIds from owner + agentSession', () => {
    const legacy = v2ChannelToLegacy(channel, 0);
    expect(legacy.participantIds).toEqual(['user', 'crewly-orc']);
  });
});

describe('inferSourceFromLegacyMetadata', () => {
  it('returns slack when source is slack', () => {
    expect(inferSourceFromLegacyMetadata({ source: 'slack' })).toBe('slack');
  });

  it('returns web when source is web', () => {
    expect(inferSourceFromLegacyMetadata({ source: 'web' })).toBe('web');
  });

  it('returns system as the safe default', () => {
    expect(inferSourceFromLegacyMetadata(undefined)).toBe('system');
    expect(inferSourceFromLegacyMetadata({})).toBe('system');
    expect(inferSourceFromLegacyMetadata({ source: 'unknown' })).toBe('system');
  });
});

describe('SYSTEM_PRINCIPAL', () => {
  it('is a valid ChatPrincipal with system userId', () => {
    expect(SYSTEM_PRINCIPAL).toEqual({ userId: 'system', source: 'oss' });
  });
});
