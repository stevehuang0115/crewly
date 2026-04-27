/**
 * Integration-style tests for the chat-v2 controller.
 *
 * Uses supertest against a minimal Express app that mounts the router
 * onto an in-memory `ChatV2Service`. Exercises happy paths + error
 * shapes for the Phase 1 REST surface.
 *
 * @module controllers/chat-v2/chat-v2.controller.test
 */

import express from 'express';
import request from 'supertest';
import { createChatV2Router } from './chat-v2.routes.js';
import {
  buildChatV2SourceId,
  isOrchestratorRoutedChatV2Channel,
} from './chat-v2.controller.js';
import { ChatV2Service } from '../../services/chat-v2/chat-v2.service.js';
import { openChatDatabase } from '../../services/chat-v2/sqlite/chat-db.js';
import { loadChatV2Config } from '../../services/chat-v2/config.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { ChatChannelDTO } from '../../services/chat-v2/types.js';

/** Build a test app with the chat router mounted under /api/chat. */
function buildApp() {
  const db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
  const service = new ChatV2Service({
    config: loadChatV2Config({}),
    db,
    getPresence: () => ({ status: 'online', lastSeenAt: 111 }),
    now: () => 1000,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/chat', createChatV2Router(service));
  return { app, service };
}

describe('chat-v2 controller (REST)', () => {
  it('GET /api/chat/channels — returns empty list on a fresh DB', async () => {
    const { app, service } = buildApp();
    try {
      const res = await request(app).get('/api/chat/channels');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.channels).toEqual([]);
    } finally {
      service.close();
    }
  });

  it('POST /api/chat/channels — creates a channel and returns the DTO', async () => {
    const { app, service } = buildApp();
    try {
      const res = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'Sam backend', purpose: 'TL line' });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.agentSession).toBe('sess-a');
      expect(res.body.data.name).toBe('Sam backend');
      expect(res.body.data.agentPresence.status).toBe('online');
    } finally {
      service.close();
    }
  });

  it('POST /api/chat/channels — 400 on empty name', async () => {
    const { app, service } = buildApp();
    try {
      const res = await request(app).post('/api/chat/channels').send({ agentSession: 'sess-a' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    } finally {
      service.close();
    }
  });

  it('POST /api/chat/channels — 409 on 1:1 binding violation', async () => {
    const { app, service } = buildApp();
    try {
      await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'first' });
      const res = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'second' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('agent_already_bound');
      expect(res.body.error.details.existingChannelId).toBeTruthy();
    } finally {
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — persists and echoes back with seq', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;

      const sent = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .send({ content: 'hello', clientMessageId: 'cmid-1' });
      expect(sent.status).toBe(201);
      expect(sent.body.data.seq).toBe(1);
      expect(sent.body.data.senderType).toBe('user');
      expect(sent.body.data.content).toBe('hello');

      // Dedupe: posting the same clientMessageId returns the same persisted row.
      const again = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .send({ content: 'second attempt', clientMessageId: 'cmid-1' });
      expect(again.status).toBe(201);
      expect(again.body.data.id).toBe(sent.body.data.id);
    } finally {
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — 413 on oversize body', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;

      const res = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .send({ content: 'x'.repeat(40000) });
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('payload_too_large');
      expect(res.body.error.details.maxBytes).toBe(32768);
    } finally {
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — 400 if attachments provided before upload endpoint ships', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;

      const res = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .send({ content: 'x', attachments: [{ attachmentId: 'att-x' }] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    } finally {
      service.close();
    }
  });

  it('GET /api/chat/channels/:id/messages — paginates newest first', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;

      for (let i = 0; i < 3; i++) {
        await request(app)
          .post(`/api/chat/channels/${chId}/messages`)
          .send({ content: `m${i}` });
      }

      const page = await request(app).get(`/api/chat/channels/${chId}/messages?limit=2`);
      expect(page.status).toBe(200);
      expect(page.body.data.messages).toHaveLength(2);
      expect(page.body.data.messages.map((m: { seq: number }) => m.seq)).toEqual([3, 2]);
      expect(page.body.data.nextCursor).toBeTruthy();
    } finally {
      service.close();
    }
  });

  it('DELETE /api/chat/channels/:id — archives and is idempotent', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;

      const first = await request(app).delete(`/api/chat/channels/${chId}`);
      expect(first.status).toBe(204);
      // Re-archiving is a no-op — still 204.
      const second = await request(app).delete(`/api/chat/channels/${chId}`);
      expect(second.status).toBe(204);
    } finally {
      service.close();
    }
  });

  // ---------------------------------------------------------------------
  // Phase A — Slack-like team-chat surfaces (SEALED §3.1 + §3.2)
  // ---------------------------------------------------------------------

  it("POST /api/chat/channels — creates a type='channel' row with teamId", async () => {
    const { app, service } = buildApp();
    try {
      const res = await request(app)
        .post('/api/chat/channels')
        .send({ name: '#general', type: 'channel', teamId: 'team-1' });
      expect(res.status).toBe(201);
      expect(res.body.data.type).toBe('channel');
      expect(res.body.data.teamId).toBe('team-1');
      // Channel rows server-erase agentSession to ''.
      expect(res.body.data.agentSession).toBe('');
    } finally {
      service.close();
    }
  });

  it("POST /api/chat/channels — 400 when type='channel' but teamId omitted", async () => {
    const { app, service } = buildApp();
    try {
      const res = await request(app)
        .post('/api/chat/channels')
        .send({ name: '#orphan', type: 'channel' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(res.body.error.message).toMatch(/teamId is required/);
    } finally {
      service.close();
    }
  });

  it("POST /api/chat/channels — 400 when type='dm' but teamId is provided", async () => {
    const { app, service } = buildApp();
    try {
      const res = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'Cross-typed', type: 'dm', teamId: 'team-1' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    } finally {
      service.close();
    }
  });

  it("POST /api/chat/channels — type='dm' with targetMemberId persists it", async () => {
    const { app, service } = buildApp();
    try {
      const res = await request(app)
        .post('/api/chat/channels')
        .send({
          agentSession: 'sess-sam',
          name: 'DM with Sam',
          type: 'dm',
          targetMemberId: 'member-sam',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.targetMemberId).toBe('member-sam');
      expect(res.body.data.type).toBe('dm');
    } finally {
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — persists mentions on the wire', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;

      const sent = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .send({
          content: 'hi @Sam',
          mentions: ['member-sam-uuid'],
        });
      expect(sent.status).toBe(201);
      expect(sent.body.data.mentions).toEqual(['member-sam-uuid']);
    } finally {
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — empty mentions emits []', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;

      const sent = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .send({ content: 'no mentions' });
      expect(sent.status).toBe(201);
      expect(sent.body.data.mentions).toEqual([]);
    } finally {
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — 400 on non-array mentions', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;

      const sent = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .send({ content: 'x', mentions: 'not-an-array' });
      expect(sent.status).toBe(400);
      expect(sent.body.error.code).toBe('validation_error');
    } finally {
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — threadId persists for replies', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;

      const root = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .send({ content: 'thread root' });
      expect(root.status).toBe(201);

      const reply = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .send({ content: 'reply within thread', threadId: root.body.data.id });
      expect(reply.status).toBe(201);
      expect(reply.body.data.threadId).toBe(root.body.data.id);
    } finally {
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — 400 on non-existent threadId', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;

      const sent = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .send({ content: 'orphan reply', threadId: 'no-such-id' });
      expect(sent.status).toBe(400);
      expect(sent.body.error.code).toBe('validation_error');
    } finally {
      service.close();
    }
  });

  it('GET /api/chat/channels/:id — 404 for unknown id', async () => {
    const { app, service } = buildApp();
    try {
      const res = await request(app).get('/api/chat/channels/nope');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('channel_not_found');
    } finally {
      service.close();
    }
  });

  // -------------------------------------------------------------------------
  // Phase C — channel-rail listing refinements: ?type= + ?teamId= filters.
  // -------------------------------------------------------------------------

  describe('GET /api/chat/channels — Phase C filters', () => {
    /**
     * Seeds the in-memory store with: 1 DM + 2 team channels across 2 teams.
     * Returns the test rig so each test can keep an explicit close() handle.
     */
    function buildAppWithMixedFixture() {
      const rig = buildApp();
      rig.service.createChannel({
        agentSession: 'sess-dm',
        name: 'DM with Sam',
        principal: { userId: 'dev-user-001', source: 'oss' },
        type: 'dm',
        targetMemberId: 'sam-id',
      });
      rig.service.createChannel({
        agentSession: '',
        name: '#general-product',
        principal: { userId: 'dev-user-001', source: 'oss' },
        type: 'channel',
        teamId: 'team-product',
      });
      rig.service.createChannel({
        agentSession: '',
        name: '#general-marketing',
        principal: { userId: 'dev-user-001', source: 'oss' },
        type: 'channel',
        teamId: 'team-marketing',
      });
      return rig;
    }

    it('?type=dm filters to DM channels', async () => {
      const { app, service } = buildAppWithMixedFixture();
      try {
        const res = await request(app).get('/api/chat/channels?type=dm');
        expect(res.status).toBe(200);
        expect(res.body.data.channels).toHaveLength(1);
        expect(res.body.data.channels[0].type).toBe('dm');
      } finally {
        service.close();
      }
    });

    it('?type=channel filters to team channels', async () => {
      const { app, service } = buildAppWithMixedFixture();
      try {
        const res = await request(app).get('/api/chat/channels?type=channel');
        expect(res.status).toBe(200);
        expect(res.body.data.channels).toHaveLength(2);
        expect(res.body.data.channels.every((c: { type: string }) => c.type === 'channel')).toBe(
          true,
        );
      } finally {
        service.close();
      }
    });

    it('?type=invalid → 400 validation_error', async () => {
      const { app, service } = buildAppWithMixedFixture();
      try {
        const res = await request(app).get('/api/chat/channels?type=group');
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('validation_error');
        expect(res.body.error.message).toContain('unknown channel type');
      } finally {
        service.close();
      }
    });

    it('?teamId= filters to a single team', async () => {
      const { app, service } = buildAppWithMixedFixture();
      try {
        const res = await request(app).get('/api/chat/channels?teamId=team-product');
        expect(res.status).toBe(200);
        expect(res.body.data.channels).toHaveLength(1);
        expect(res.body.data.channels[0].name).toBe('#general-product');
        expect(res.body.data.channels[0].teamId).toBe('team-product');
      } finally {
        service.close();
      }
    });

    it('?type=channel&teamId=… composes filters', async () => {
      const { app, service } = buildAppWithMixedFixture();
      try {
        const res = await request(app).get(
          '/api/chat/channels?type=channel&teamId=team-marketing',
        );
        expect(res.status).toBe(200);
        expect(res.body.data.channels).toHaveLength(1);
        expect(res.body.data.channels[0].name).toBe('#general-marketing');
      } finally {
        service.close();
      }
    });

    it('empty ?type= and ?teamId= are treated as omitted (back-compat)', async () => {
      const { app, service } = buildAppWithMixedFixture();
      try {
        const res = await request(app).get('/api/chat/channels?type=&teamId=');
        expect(res.status).toBe(200);
        expect(res.body.data.channels).toHaveLength(3);
      } finally {
        service.close();
      }
    });

    it('no query params returns the full owner-scoped list (back-compat)', async () => {
      const { app, service } = buildAppWithMixedFixture();
      try {
        const res = await request(app).get('/api/chat/channels');
        expect(res.status).toBe(200);
        expect(res.body.data.channels).toHaveLength(3);
      } finally {
        service.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// INBOUND-2 — pure helper unit tests
// ---------------------------------------------------------------------------

/** Minimal channel DTO factory for the orchestrator-routing predicate. */
function makeChannel(overrides: Partial<ChatChannelDTO> = {}): ChatChannelDTO {
  return {
    id: 'c-1',
    agentSession: 'sess-a',
    name: 'Channel',
    createdAt: 0,
    agentPresence: { status: 'online', lastSeenAt: null },
    type: 'dm',
    ...overrides,
  };
}

describe('buildChatV2SourceId (INBOUND-2)', () => {
  it('builds the canonical chatv2-${channelId}-${messageId} composite', () => {
    expect(buildChatV2SourceId('c-abc', 'm-xyz')).toBe('chatv2-c-abc-m-xyz');
  });

  it('round-trips through the SLA subscriber extractors', async () => {
    const { extractChatV2ChannelId, extractChatV2MessageId } = await import(
      '../../services/v3/request-sla.subscriber.js'
    );
    const sid = buildChatV2SourceId('cabc123', 'mxyz789');
    expect(extractChatV2ChannelId(sid)).toBe('cabc123');
    expect(extractChatV2MessageId(sid)).toBe('mxyz789');
  });
});

describe('isOrchestratorRoutedChatV2Channel (INBOUND-2)', () => {
  it('returns true for type=dm channels bound to the orchestrator session', () => {
    const ch = makeChannel({ type: 'dm', agentSession: ORCHESTRATOR_SESSION_NAME });
    expect(isOrchestratorRoutedChatV2Channel(ch)).toBe(true);
  });

  it('returns false for type=dm channels bound to a non-orc agent', () => {
    const ch = makeChannel({ type: 'dm', agentSession: 'crewly-product-leo-x' });
    expect(isOrchestratorRoutedChatV2Channel(ch)).toBe(false);
  });

  it('returns false for type=channel (team-scoped) — out of v1 scope', () => {
    const ch = makeChannel({
      type: 'channel',
      agentSession: '',
      teamId: 't-1',
    });
    expect(isOrchestratorRoutedChatV2Channel(ch)).toBe(false);
  });

  it('returns false when agentSession is empty', () => {
    const ch = makeChannel({ type: 'dm', agentSession: '' });
    expect(isOrchestratorRoutedChatV2Channel(ch)).toBe(false);
  });
});
