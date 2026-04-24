/**
 * DTO translation tests.
 *
 * Covers the wire↔domain mapping that the HTTP client relies on — the
 * places real-world bugs tend to surface (timezone drift, nullability,
 * `starting` vs `online`).
 *
 * @module api/dto.test
 */

import { describe, it, expect } from 'vitest';
import {
  channelFromDTO,
  messageFromDTO,
  attachmentFromDTO,
  agentPresenceFromDTO,
  type ChannelDTO,
  type MessageDTO,
  type AttachmentDTO,
} from './dto';

describe('channelFromDTO', () => {
  it('converts createdAt ms to ISO and unwraps presence.status', () => {
    const dto: ChannelDTO = {
      id: 'ch-sam',
      agentSession: 'crewly-product-sam-dd2b46f7',
      name: 'Sam · backend',
      purpose: 'Product TL',
      createdAt: 1729790000000,
      lastMessageAt: 1729790500000,
      archivedAt: null,
      agentPresence: { status: 'busy', lastSeenAt: 1729789990000 },
    };
    const ch = channelFromDTO(dto);
    expect(ch.id).toBe('ch-sam');
    expect(ch.agentSession).toBe('crewly-product-sam-dd2b46f7');
    expect(ch.createdAt).toBe(new Date(1729790000000).toISOString());
    expect(ch.lastMessageAt).toBe(new Date(1729790500000).toISOString());
    expect(ch.presence).toBe('busy');
  });

  it('maps wire `starting` to UI `online` (UI has no "starting" state)', () => {
    const dto: ChannelDTO = {
      id: 'ch-1',
      agentSession: 's',
      name: 'n',
      createdAt: 0,
      agentPresence: { status: 'starting', lastSeenAt: null },
    };
    expect(channelFromDTO(dto).presence).toBe('online');
  });

  it('omits lastMessageAt when the wire value is null/undefined', () => {
    const dto: ChannelDTO = {
      id: 'ch-1',
      agentSession: 's',
      name: 'n',
      createdAt: 0,
      lastMessageAt: null,
      agentPresence: { status: 'offline', lastSeenAt: null },
    };
    expect(channelFromDTO(dto).lastMessageAt).toBeUndefined();
  });
});

describe('messageFromDTO', () => {
  it('translates senderType/senderId into nested author + preserves seq', () => {
    const dto: MessageDTO = {
      id: 'msg-1',
      channelId: 'ch-1',
      seq: 42,
      senderType: 'agent',
      senderId: 'crewly-product-sam-dd2b46f7',
      content: 'hello',
      contentType: 'markdown',
      createdAt: 1729790000000,
      attachments: [],
    };
    const m = messageFromDTO(dto);
    expect(m.seq).toBe(42);
    expect(m.author.role).toBe('agent');
    expect(m.author.id).toBe('crewly-product-sam-dd2b46f7');
    expect(m.author.name).toBe('crewly-product-sam-dd2b46f7');
    expect(m.content).toBe('hello');
    expect(m.createdAt).toBe(new Date(1729790000000).toISOString());
    expect(m.deliveryStatus).toBe('sent');
  });

  it('labels system messages with a friendly author name', () => {
    const dto: MessageDTO = {
      id: 'msg-2',
      channelId: 'ch-1',
      seq: 1,
      senderType: 'system',
      senderId: 'system',
      content: 'Agent is offline.',
      contentType: 'system_note',
      createdAt: 0,
      attachments: [],
    };
    expect(messageFromDTO(dto).author.name).toBe('System');
  });

  it('maps attachments into their UI shape', () => {
    const att: AttachmentDTO = {
      id: 'att-1',
      mimeType: 'image/png',
      sizeBytes: 1234,
      url: '/api/chat/attachments/att-1',
      originalName: 'shot.png',
    };
    expect(attachmentFromDTO(att)).toEqual({
      id: 'att-1',
      kind: 'image',
      url: '/api/chat/attachments/att-1',
      filename: 'shot.png',
      size: 1234,
      mimeType: 'image/png',
    });
  });
});

describe('agentPresenceFromDTO', () => {
  it('maps status + ms lastSeenAt into the UI shape', () => {
    const p = agentPresenceFromDTO({
      agentSession: 'crewly-product-sam',
      status: 'online',
      lastSeenAt: 1729790000000,
    });
    expect(p.agentId).toBe('crewly-product-sam');
    expect(p.status).toBe('online');
    expect(p.lastSeen).toBe(new Date(1729790000000).toISOString());
  });

  it('handles null lastSeenAt gracefully', () => {
    const p = agentPresenceFromDTO({
      agentSession: 'crewly-product-sam',
      status: 'offline',
      lastSeenAt: null,
    });
    expect(p.lastSeen).toBeUndefined();
  });
});
