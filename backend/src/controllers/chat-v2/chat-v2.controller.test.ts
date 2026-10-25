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
  agentAuthHeaders,
  callerIdentityForTests,
  ownerAuthHeaders,
  ownerUnlessAgentForTests,
  relayAuthHeaders,
} from '../../middleware/caller-identity.testing.js';
import { setCallerIdentity } from '../../middleware/caller-identity.middleware.js';
import {
  buildChatV2SourceId,
  isOrchestratorRoutedChatV2Channel,
} from './chat-v2.controller.js';
import { ChatV2Service } from '../../services/chat-v2/chat-v2.service.js';
import { openChatDatabase } from '../../services/chat-v2/sqlite/chat-db.js';
import { loadChatV2Config } from '../../services/chat-v2/config.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { ChatChannelDTO, ChatMessageDTO } from '../../services/chat-v2/types.js';
import type { ChatV2DispatcherService } from '../../services/chat-v2/chat-v2.dispatcher.service.js';
import {
  setTicketIntakeService,
  type IntakeMessage,
  type IntakeOutcome,
  type TicketIntakeService,
} from '../../services/v3/ticket-intake.service.js';
import type { ChatV2Gateway } from '../../websocket/chat-v2.gateway.js';
import { StorageService } from '../../services/core/storage.service.js';
import { setTurnTriggerTrackerForTesting, TurnTriggerTracker } from '../../services/trace/turn-trigger.js';

// reply-channel with a Slack thread key from another channel
// (specs/2026-10-02-harness-owned-routing.md): the Slack mapping and the
// reply resolver are swapped in per test (null = not wired, the default).
const mockTeamChannels: { current: null | Record<string, jest.Mock> } = { current: null };
jest.mock('../../services/slack/slack-team-channel.service.js', () => ({
  ...jest.requireActual('../../services/slack/slack-team-channel.service.js'),
  getSlackTeamChannelService: jest.fn(() => mockTeamChannels.current),
}));
const mockDeliverReply = jest.fn();
const mockCurrentRouteOf = jest.fn(async (_session: string): Promise<unknown> => null);
jest.mock('../../services/orc/reply-destination.wiring.js', () => ({
  deliverReply: (input: unknown) => mockDeliverReply(input),
  currentRouteOf: (session: string) => mockCurrentRouteOf(session),
}));

// Automatic file hand-off: the Cloud-facing service is swapped per test.
const mockHandoff = {
  attachToMessage: jest.fn(),
  projectDirFor: jest.fn(),
  crossMachine: jest.fn(),
};
jest.mock('../../services/file-handoff/file-handoff.wiring.js', () => ({
  getFileHandoffService: () => ({ attachToMessage: (i: unknown) => mockHandoff.attachToMessage(i) }),
  projectDirForAgent: (...a: unknown[]) => mockHandoff.projectDirFor(...a),
  roomHasRemoteColleague: (...a: unknown[]) => mockHandoff.crossMachine(...a),
}));

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
  app.use(ownerUnlessAgentForTests);
  app.use('/api/chat', createChatV2Router(service));
  return { app, service };
}

describe('chat-v2 controller (REST)', () => {
  it('GET /api/chat/search — a badged agent searches its own view; a bare session header or no query is refused', async () => {
    const { app, service } = buildApp();
    try {
      const principal = { userId: 'dev-user-001', source: 'oss' as const };
      const room = service.createHuddle({ name: 'awesome-videos', memberSessions: ['pia'], principal });
      const other = service.createHuddle({ name: 'secret', memberSessions: ['bob'], principal });
      service.recordTurn({ channelId: room.id, senderType: 'user', senderId: 'Steve', content: 'three-video plan', metadata: { source: 'slack' } });
      service.recordTurn({ channelId: other.id, senderType: 'user', senderId: 'Steve', content: 'three-video budget', metadata: { source: 'slack' } });

      const ok = await request(app).get('/api/chat/search?q=three-video').set(agentAuthHeaders('pia'));
      expect(ok.status).toBe(200);
      expect(ok.body.data.hits.map((h: { text: string }) => h.text)).toEqual(['three-video plan']);

      // A session name without the badge proves nothing.
      expect((await request(app).get('/api/chat/search?q=three-video').set('X-Agent-Session', 'pia')).status).toBe(403);
      // The agent cannot widen its view with ?session=.
      const widened = await request(app).get('/api/chat/search?q=three-video&session=bob').set(agentAuthHeaders('pia'));
      expect(widened.body.data.hits).toHaveLength(1);
      // The owner names the agent.
      const asOwner = await request(app).get('/api/chat/search?q=budget&session=bob');
      expect(asOwner.body.data.hits.map((h: { text: string }) => h.text)).toEqual(['three-video budget']);
      expect((await request(app).get('/api/chat/search?session=bob')).status).toBe(400);
      expect((await request(app).get('/api/chat/search?q=x&session=bob&from=nonsense')).status).toBe(400);
      // The owner without ?session= searches everything (#1400).
      const everywhere = await request(app).get('/api/chat/search?q=three-video');
      expect(everywhere.status).toBe(200);
      expect(everywhere.body.data.count).toBe(2);
      expect(everywhere.body.data.hits.map((h: { channelType: string }) => h.channelType)).toEqual(['huddle', 'huddle']);
    } finally {
      service.close();
    }
  });

  it('GET /api/chat/agents/:session/timeline — merged timeline with source filter and cursor', async () => {
    const { app, service } = buildApp();
    try {
      const dm = service.ensureDmChannel({ agentSession: 'ella', principal: { userId: 'dev-user-001', source: 'oss' } }).channel;
      for (const [content, source] of [['a', 'web'], ['b', 'slack'], ['c', 'cloud-talk']] as const) {
        service.recordTurn({ channelId: dm.id, senderType: 'user', senderId: 'Steve', content, metadata: { source } });
      }
      const all = await request(app).get('/api/chat/agents/ella/timeline?limit=2');
      expect(all.status).toBe(200);
      expect(all.body.data.items.map((i: { content: string }) => i.content)).toEqual(['c', 'b']);
      expect(all.body.data.items[0]).toMatchObject({ source: 'cloud-talk', direction: 'in', senderKind: 'owner', channelId: dm.id });
      const next = await request(app).get(`/api/chat/agents/ella/timeline?cursor=${all.body.data.nextCursor}`);
      expect(next.body.data.items.map((i: { content: string }) => i.content)).toEqual(['a']);
      const filtered = await request(app).get('/api/chat/agents/ella/timeline?source=slack,crewly-chat');
      expect(filtered.body.data.items.map((i: { content: string }) => i.content)).toEqual(['b', 'a']);
      const bad = await request(app).get('/api/chat/agents/ella/timeline?source=fax');
      expect(bad.status).toBe(400);
      const other = await request(app).get('/api/chat/agents/ella/timeline').set('X-Agent-Session', 'sam');
      expect(other.status).toBe(403);
    } finally {
      service.close();
    }
  });

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

  // The 1:1 agent<->DM binding (409 agent_already_bound) was deliberately
  // dropped by the unified-chat-message-store spec (2026-05-14, Option B).
  it('POST /api/chat/channels — second channel for the same agent is created (no 1:1 binding)', async () => {
    const { app, service } = buildApp();
    try {
      const first = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'first' });
      const res = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'second' });
      expect(first.status).toBe(201);
      expect(res.status).toBe(201);
      expect(res.body.data.agentSession).toBe('sess-a');
      expect(res.body.data.id).not.toBe(first.body.data.id);
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

  it('POST /api/chat/channels/:id/messages — broadcasts an AGENT reply over WS (not gated on the sender principal)', async () => {
    // Regression: the agent reply (via reply-channel, X-Agent-Session) used to
    // be suppressed from the realtime fan-out because the broadcast was gated
    // on a channel lookup using the agent's principal, which doesn't match the
    // channel owner. The reply persisted but the chat UI hung on "thinking"
    // until a reload. The broadcast must fire for the persisted message itself.
    const calls: Array<{ channelId: string; event: { payload?: { message?: { content?: string; senderType?: string } } } }> = [];
    const mockGateway = {
      broadcast: (channelId: string, event: unknown) =>
        calls.push({ channelId, event: event as { payload?: { message?: { content?: string; senderType?: string } } } }),
    };
    const db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    const service = new ChatV2Service({
      config: loadChatV2Config({}),
      db,
      getPresence: () => ({ status: 'online', lastSeenAt: 111 }),
      now: () => 1000,
    });
    const app = express();
    app.use(express.json());
  app.use(ownerUnlessAgentForTests);
    app.use('/api/chat', createChatV2Router(service, { gateway: mockGateway as unknown as ChatV2Gateway }));
    try {
      const created = await request(app)
        .post('/api/chat/channels')
        .send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;

      const reply = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: 'agent reply' });

      expect(reply.status).toBe(201);
      expect(reply.body.data.senderType).toBe('agent');
      // The realtime broadcast must have fired for the agent reply.
      const agentBroadcasts = calls.filter((c) => c.channelId === chId && c.event.payload?.message?.content === 'agent reply');
      expect(agentBroadcasts.length).toBe(1);
    } finally {
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — an agent reply the Slack mirror could not post answers 502 with the Slack error; user messages and delivered replies are unaffected (CREW-89)', async () => {
    const { trackSlackDelivery } = await import('../../services/slack/slack-outbound-delivery.js');
    const { app, service } = buildApp();
    try {
      const created = await request(app).post('/api/chat/channels').send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;
      let outcome: 'fail' | 'ok' | 'none' = 'fail';
      service.on('chat_message', (m: ChatMessageDTO) => {
        if (m.senderType !== 'agent' || outcome === 'none') return;
        trackSlackDelivery(m.id, Promise.resolve(outcome === 'fail'
          ? { delivered: false, slackChannelId: 'C1', error: 'channel_not_found' }
          : { delivered: true, slackChannelId: 'C1', ts: '1.1' }));
      });
      const failed = await request(app).post(`/api/chat/channels/${chId}/messages`).set('X-Agent-Session', 'sess-a').send({ content: 'r1' });
      expect(failed.status).toBe(502);
      expect(failed.body).toMatchObject({ success: false, data: { content: 'r1', slackDelivered: false } });
      expect(failed.body.error).toContain('channel_not_found');
      outcome = 'ok';
      const ok = await request(app).post(`/api/chat/channels/${chId}/messages`).set('X-Agent-Session', 'sess-a').send({ content: 'r2' });
      expect(ok.status).toBe(201);
      outcome = 'none';
      const plain = await request(app).post(`/api/chat/channels/${chId}/messages`).set('X-Agent-Session', 'sess-a').send({ content: 'r3' });
      expect(plain.status).toBe(201);
      const user = await request(app).post(`/api/chat/channels/${chId}/messages`).send({ content: 'hello' });
      expect(user.status).toBe(201);
    } finally {
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — an agent thread key from ANOTHER Slack channel is resolved by the harness, not mirrored into this channel (2026-10-02)', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app).post('/api/chat/channels').send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;
      mockTeamChannels.current = { findByChatChannelId: jest.fn((id: string) => (id === chId ? { slackChannelId: 'C0MKT0001', chatChannelId: chId } : null)) };
      mockDeliverReply.mockResolvedValueOnce({ ok: true, destination: { kind: 'conversation', conversationId: 'room-ce', source: 'hint', reason: 'Slack thread mapped to its conversation' }, messageId: 'm-ce', conversationId: 'room-ce' });
      const res = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: 'the preview', threadId: 'C0CE00001:1790000000.000100' });
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual(expect.objectContaining({ id: 'm-ce', channelId: 'room-ce', rerouted: true }));
      expect(mockDeliverReply).toHaveBeenCalledWith(expect.objectContaining({ session: 'sess-a', hints: { conversationId: chId, thread: 'C0CE00001:1790000000.000100' } }));

      mockDeliverReply.mockResolvedValueOnce({ ok: false, error: 'Your message was NOT delivered: x. Run: reply --ticket TKT-1 "<your message>"' });
      const bad = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: 'the preview', threadId: 'C0CE00001:1790000000.000100' });
      expect(bad.status).toBe(409);

      // The SAME channel's key is the normal path.
      const same = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: 'in this channel', threadId: 'C0MKT0001:1790000000.000100' });
      expect(same.status).toBe(201);
      expect(same.body.data.senderType).toBe('agent');
      expect(mockDeliverReply).toHaveBeenCalledTimes(2);
    } finally {
      mockTeamChannels.current = null;
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — an owner-thread post that only @s agents, after an agent message, is refused (crewly#1375)', async () => {
    const { app, service } = buildApp();
    const tracker = new TurnTriggerTracker();
    setTurnTriggerTrackerForTesting(tracker);
    const storage = jest.spyOn(StorageService, 'getInstance').mockReturnValue({
      getTeams: async () => [{ id: 'tt', name: 'Think Tank', members: [{ name: 'Atlas', sessionName: 'think-tank-atlas-b4e166f6' }] }],
    } as unknown as StorageService);
    try {
      const created = await request(app).post('/api/chat/channels').send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;
      tracker.noteDelivery('sess-a', `[CHAT:${chId}] <owner@Pia> Shaw Brothers style video please`);
      tracker.noteDelivery(
        'sess-a',
        '[MESSAGE from Atlas (Think Tank) — a colleague, not the owner. Answer with send-message --to think-tank-atlas-b4e166f6; do not post it in an owner thread.]\nThanks. Two things.',
      );

      const refused = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: '@Atlas (1) your note is half right' });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ success: false, error: { code: 'agent_mention_in_owner_thread' } });
      expect(refused.body.error.message).toContain('send-message --to think-tank-atlas-b4e166f6');

      // Without an agent-only @-mention it is posted.
      const plain = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: 'The cut is rendering.' });
      expect(plain.status).toBe(201);

      // R6 (message-routing audit 2026-10-18): a turn that came from the owner
      // no longer lets an agents-only post into the owner thread. This used to
      // go through (201); agents never converse inside an owner thread.
      tracker.noteDelivery('sess-a', `[CHAT:${chId}] <owner@Pia> ask Atlas`);
      const prompted = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: '@Atlas the owner asks for the numbers' });
      expect(prompted.status).toBe(409);
      expect(prompted.body.error.code).toBe('agent_mention_in_owner_thread');
    } finally {
      storage.mockRestore();
      setTurnTriggerTrackerForTesting(null);
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — R6: an agents-only post in an owner thread is delivered privately to the agent, with the owner thread as its route', async () => {
    const db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    const service = new ChatV2Service({ config: loadChatV2Config({}), db, getPresence: () => ({ status: 'online', lastSeenAt: 111 }), now: () => 1000 });
    const delivered: Array<{ to: string; text: string }> = [];
    const dispatcher = {
      dispatchMessage: jest.fn(async () => ({ outcome: 'skipped' })),
      deliverToAgentPrivately: jest.fn(async (to: string, text: string) => {
        delivered.push({ to, text });
        return { success: true };
      }),
    };
    const app = express();
    app.use(express.json());
    app.use(ownerUnlessAgentForTests);
    app.use('/api/chat', createChatV2Router(service, { dispatcher: dispatcher as unknown as ChatV2DispatcherService }));
    const tracker = new TurnTriggerTracker();
    setTurnTriggerTrackerForTesting(tracker);
    const storage = jest.spyOn(StorageService, 'getInstance').mockReturnValue({
      getTeams: async () => [{ id: 'tt', name: 'Think Tank', members: [{ name: 'Atlas', sessionName: 'think-tank-atlas-b4e166f6' }, { name: 'Pia', sessionName: 'sess-a' }] }],
      findMemberBySessionName: async (s: string) => (s === 'sess-a' ? { team: { id: 'fp', name: 'Flopost', members: [] }, member: { name: 'Pia', sessionName: 'sess-a' } } : null),
    } as unknown as StorageService);
    try {
      const created = await request(app).post('/api/chat/channels').send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;
      // The owner asked Pia here (Ella-style delegation inside the owner's thread, O5).
      tracker.noteDelivery('sess-a', `[CHAT:${chId}] <owner@Pia> make the three videos`);
      const res = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: '@Atlas please check the numbers', threadId: 'root-7' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ deliveredPrivately: true, to: ['think-tank-atlas-b4e166f6'] });
      expect(delivered).toHaveLength(1);
      expect(delivered[0].to).toBe('think-tank-atlas-b4e166f6');
      expect(delivered[0].text).toMatch(/^\[MESSAGE from Pia \(Flopost\)/);
      expect(delivered[0].text).toContain(`{route: owner ${chId} thread root-7}`);
      expect(delivered[0].text).toContain('@Atlas please check the numbers');
      // Nothing was posted in the owner's thread.
      const listed = await request(app).get(`/api/chat/channels/${chId}/messages`);
      expect(JSON.stringify(listed.body)).not.toContain('please check the numbers');
    } finally {
      storage.mockRestore();
      setTurnTriggerTrackerForTesting(null);
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — an agent post with no thread in a Slack team room is refused (409 thread_required) unless newThread (R7)', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app).post('/api/chat/channels').send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;
      const root = await request(app).post(`/api/chat/channels/${chId}/messages`).send({ content: 'q' });
      mockTeamChannels.current = {
        findByChatChannelId: jest.fn((id: string) => (id === chId ? { chatChannelId: chId, slackChannelId: 'C0VIDEO', slackChannelName: 'awesome-videos' } : null)),
        heldReplyFor: jest.fn(async () => null),
      };

      const refused = await request(app).post(`/api/chat/channels/${chId}/messages`).set('X-Agent-Session', 'sess-a').send({ content: '@Rex 再取一条小红书笔记' });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ success: false, refused: true, error: { code: 'thread_required' } });
      expect(refused.body.error.message).toContain('--new-thread');

      const threaded = await request(app).post(`/api/chat/channels/${chId}/messages`).set('X-Agent-Session', 'sess-a').send({ content: 'answer', threadId: root.body.data.id });
      expect(threaded.status).toBe(201);
      const deliberate = await request(app).post(`/api/chat/channels/${chId}/messages`).set('X-Agent-Session', 'sess-a').send({ content: 'Weekly digest', newThread: true });
      expect(deliberate.status).toBe(201);
      // The owner (no agent session) is never refused.
      const owner = await request(app).post(`/api/chat/channels/${chId}/messages`).send({ content: 'hello' });
      expect(owner.status).toBe(201);
    } finally {
      mockTeamChannels.current = null;
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — a reply in a thread a colleague already answered is held (409 already_answered) unless addsNew (specs/2026-10-03-one-responder-per-message.md §2)', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app).post('/api/chat/channels').send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;
      const root = await request(app).post(`/api/chat/channels/${chId}/messages`).send({ content: 'q' });
      const heldReplyFor = jest.fn(async () => ({ by: 'Atlas', excerpt: 'Got it — keeping both versions.', messageId: 'm-atlas' }));
      mockTeamChannels.current = { findByChatChannelId: jest.fn(() => null), heldReplyFor };

      const held = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: 'Both versions it is', threadId: root.body.data.id });
      expect(held.status).toBe(409);
      expect(held.body).toMatchObject({ success: false, held: true, error: { code: 'already_answered' }, existingAnswer: { by: 'Atlas' } });
      expect(held.body.error.message).toContain('--adds-new');
      expect(heldReplyFor).toHaveBeenCalledWith({ conversationId: chId, thread: root.body.data.id, agentSession: 'sess-a' });

      const adds = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: 'One thing to add: …', threadId: root.body.data.id, addsNew: true });
      expect(adds.status).toBe(201);
      const interim = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: 'on it', threadId: root.body.data.id, interim: true });
      expect(interim.status).toBe(201);
      expect(heldReplyFor).toHaveBeenCalledTimes(1);
    } finally {
      mockTeamChannels.current = null;
      service.close();
    }
  });

  it('POST /api/chat/channels/:id/messages — an agent post in a thread the owner has not written in for days is refused (409 stale_owner_thread) unless newThread or interim', async () => {
    const { app, service } = buildApp();
    try {
      const created = await request(app).post('/api/chat/channels').send({ agentSession: 'sess-a', name: 'Ch' });
      const chId = created.body.data.id;
      const root = await request(app).post(`/api/chat/channels/${chId}/messages`).send({ content: 'q' });
      const staleOwnerThread = jest.fn(async () => ({ lastOwnerAt: Date.parse('2026-09-29T19:49:10Z') }));
      mockTeamChannels.current = { findByChatChannelId: jest.fn(() => null), heldReplyFor: jest.fn(async () => null), staleOwnerThread };

      const refused = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: 'Week-3 summary', threadId: root.body.data.id });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ success: false, refused: true, error: { code: 'stale_owner_thread' } });
      expect(refused.body.error.message).toContain('2026-09-29');
      expect(refused.body.error.message).toContain('--new-thread');
      expect(staleOwnerThread).toHaveBeenCalledWith({ conversationId: chId, thread: root.body.data.id });

      const interim = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: 'on it', threadId: root.body.data.id, interim: true });
      expect(interim.status).toBe(201);

      staleOwnerThread.mockResolvedValueOnce(null as never);
      const fresh = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: 'answer', threadId: root.body.data.id });
      expect(fresh.status).toBe(201);
    } finally {
      mockTeamChannels.current = null;
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

  // -------------------------------------------------------------------------
  // /agents directory + /presence + /channels/dm/ensure (Phase F)
  // -------------------------------------------------------------------------

  describe('Phase F — /agents page endpoints', () => {
    /**
     * Builder that injects `directory` + `presence` providers along with
     * the chat-v2 service. Each test gets its own in-memory DB.
     */
    function buildAppWithProviders(opts: {
      directoryTeams?: Awaited<
        ReturnType<
          NonNullable<
            Parameters<typeof createChatV2Router>[1]
          >['directory'] extends infer T
            ? T extends { getTeams(): infer R }
              ? () => R
              : never
            : never
        >
      >;
      presence?: (sess: string) => Promise<{
        agentSession: string;
        status: 'online' | 'busy' | 'offline' | 'starting';
        lastSeenAt: number | null;
      }>;
    } = {}) {
      const db = openChatDatabase({
        dbPath: ':memory:',
        inMemory: true,
        skipIntegrityCheck: true,
      });
      const service = new ChatV2Service({
        config: loadChatV2Config({}),
        db,
        getPresence: () => ({ status: 'online', lastSeenAt: 111 }),
        now: () => 1000,
      });
      const directory = opts.directoryTeams
        ? { async getTeams() { return opts.directoryTeams!; } }
        : undefined;
      const presence = opts.presence
        ? { async getPresence(s: string) { return opts.presence!(s); } }
        : undefined;
      const app = express();
      app.use(express.json());
  app.use(ownerUnlessAgentForTests);
      app.use(
        '/api/chat',
        createChatV2Router(service, { directory, presence }),
      );
      return { app, service };
    }

    it('POST /channels/dm/ensure — creates a new DM channel on first call (201)', async () => {
      const { app, service } = buildAppWithProviders();
      try {
        const res = await request(app)
          .post('/api/chat/channels/dm/ensure')
          .send({ agentSession: 'sess-leo', name: 'Leo' });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.agentSession).toBe('sess-leo');
        expect(res.body.data.name).toBe('Leo');
        expect(res.body.data.type).toBe('dm');
      } finally {
        service.close();
      }
    });

    it('POST /channels/dm/ensure — returns the same channel on second call (200)', async () => {
      const { app, service } = buildAppWithProviders();
      try {
        const first = await request(app)
          .post('/api/chat/channels/dm/ensure')
          .send({ agentSession: 'sess-leo', name: 'Leo' });
        expect(first.status).toBe(201);
        const second = await request(app)
          .post('/api/chat/channels/dm/ensure')
          .send({ agentSession: 'sess-leo', name: 'Leo' });
        expect(second.status).toBe(200);
        expect(second.body.data.id).toBe(first.body.data.id);
      } finally {
        service.close();
      }
    });

    it('POST /channels/dm/ensure — 400 on empty agentSession', async () => {
      const { app, service } = buildAppWithProviders();
      try {
        const res = await request(app)
          .post('/api/chat/channels/dm/ensure')
          .send({ name: 'Ghost' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('validation_error');
      } finally {
        service.close();
      }
    });

    it('POST /channels/team/ensure — creates a default team channel on first call (201)', async () => {
      const { app, service } = buildAppWithProviders();
      try {
        const res = await request(app)
          .post('/api/chat/channels/team/ensure')
          .send({ teamId: 'team-1' });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.type).toBe('channel');
        expect(res.body.data.teamId).toBe('team-1');
        expect(res.body.data.name).toBe('#general');
      } finally {
        service.close();
      }
    });

    it('POST /channels/team/ensure — returns the same channel on second call (200)', async () => {
      const { app, service } = buildAppWithProviders();
      try {
        const first = await request(app)
          .post('/api/chat/channels/team/ensure')
          .send({ teamId: 'team-1' });
        expect(first.status).toBe(201);
        const second = await request(app)
          .post('/api/chat/channels/team/ensure')
          .send({ teamId: 'team-1' });
        expect(second.status).toBe(200);
        expect(second.body.data.id).toBe(first.body.data.id);
      } finally {
        service.close();
      }
    });

    it('POST /channels/team/ensure — 400 on empty teamId', async () => {
      const { app, service } = buildAppWithProviders();
      try {
        const res = await request(app)
          .post('/api/chat/channels/team/ensure')
          .send({ name: '#general' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('validation_error');
      } finally {
        service.close();
      }
    });

    it('POST /channels/huddle — creates a multi-agent group chat (201)', async () => {
      const { app, service } = buildAppWithProviders();
      try {
        const res = await request(app)
          .post('/api/chat/channels/huddle')
          .send({ name: 'Launch crew', memberSessions: ['sess-ella', 'sess-grace'] });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.type).toBe('huddle');
        expect(res.body.data.name).toBe('Launch crew');
      } finally {
        service.close();
      }
    });

    it('PATCH /channels/:id and PUT /channels/:id/members — rename a group chat and replace its roster (#1400)', async () => {
      const { app, service } = buildAppWithProviders();
      try {
        const created = await request(app)
          .post('/api/chat/channels/huddle')
          .send({ name: 'Launch crew', memberSessions: ['sess-ella'] });
        const id = created.body.data.id as string;

        const renamed = await request(app).patch(`/api/chat/channels/${id}`).send({ name: 'Launch crew 2' });
        expect(renamed.status).toBe(200);
        expect(renamed.body.data.name).toBe('Launch crew 2');

        const roster = await request(app)
          .put(`/api/chat/channels/${id}/members`)
          .send({ memberSessions: ['sess-ella', 'sess-grace', 42] });
        expect(roster.status).toBe(200);
        expect((roster.body.data.members as Array<{ sessionName: string }>).map((m) => m.sessionName).sort()).toEqual(['sess-ella', 'sess-grace']);

        const empty = await request(app).put(`/api/chat/channels/${id}/members`).send({ memberSessions: [] });
        expect(empty.status).toBe(400);
        expect(empty.body.error.code).toBe('validation_error');

        const missing = await request(app).patch('/api/chat/channels/ghost').send({ name: 'x' });
        expect(missing.status).toBe(404);
      } finally {
        service.close();
      }
    });

    it('POST /channels/huddle — 400 when no members are supplied', async () => {
      const { app, service } = buildAppWithProviders();
      try {
        const res = await request(app)
          .post('/api/chat/channels/huddle')
          .send({ name: 'Empty crew', memberSessions: [] });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('validation_error');
      } finally {
        service.close();
      }
    });

    it('GET /agents — returns flattened directory entries when wired', async () => {
      const { app, service } = buildAppWithProviders({
        directoryTeams: [
          {
            id: 't-orc',
            name: 'Orchestrator Team',
            members: [
              {
                sessionName: 'crewly-orc',
                name: 'Orc',
                role: 'orchestrator',
                agentStatus: 'active',
                workingStatus: 'idle',
              },
            ],
          },
        ],
      });
      try {
        const res = await request(app).get('/api/chat/agents');
        expect(res.status).toBe(200);
        expect(res.body.data.agents).toHaveLength(1);
        expect(res.body.data.agents[0]).toMatchObject({
          agentSession: 'crewly-orc',
          name: 'Orc',
          teamId: 't-orc',
          teamName: 'Orchestrator Team',
        });
      } finally {
        service.close();
      }
    });

    it('GET /agents — 503 when directory provider is not wired', async () => {
      const { app, service } = buildAppWithProviders();
      try {
        const res = await request(app).get('/api/chat/agents');
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('directory_unavailable');
      } finally {
        service.close();
      }
    });

    it('GET /presence/:agentId — returns presence when wired', async () => {
      const { app, service } = buildAppWithProviders({
        presence: async (sess) => ({
          agentSession: sess,
          status: 'busy',
          lastSeenAt: 1_700_000_000,
        }),
      });
      try {
        const res = await request(app).get('/api/chat/presence/crewly-orc');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
          agentSession: 'crewly-orc',
          status: 'busy',
          lastSeenAt: 1_700_000_000,
        });
      } finally {
        service.close();
      }
    });

    it('GET /presence/:agentId — 503 when presence provider is not wired', async () => {
      const { app, service } = buildAppWithProviders();
      try {
        const res = await request(app).get('/api/chat/presence/crewly-orc');
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('presence_unavailable');
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
    lastReadSeq: 0, unreadCount: 0,
    ...overrides,
  };
}

describe('ticket loop intake (specs/ticket-loop.md §2)', () => {
  const TICKET = { id: '11111111-2222-3333-4444-555555555555', ticketNumber: 5 };

  /**
   * App with a recording dispatcher and a fake intake.
   *
   * @param outcome - What the fake intake returns
   * @returns App, service, intake mock and dispatched messages
   */
  function setup(outcome: IntakeOutcome) {
    const db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    const service = new ChatV2Service({
      config: loadChatV2Config({}),
      db,
      getPresence: () => ({ status: 'online', lastSeenAt: 111 }),
      now: () => 1000,
    });
    const dispatched: ChatMessageDTO[] = [];
    const dispatcher = {
      dispatchMessage: async (_c: ChatChannelDTO, m: ChatMessageDTO) => {
        dispatched.push(m);
        return { strategy: 'dm', dispatched: true };
      },
    };
    const intake = { intakeWithOutcome: jest.fn(async (_m: IntakeMessage) => outcome) };
    setTicketIntakeService(intake as unknown as TicketIntakeService);
    const app = express();
    app.use(express.json());
  app.use(ownerUnlessAgentForTests);
    app.use('/api/chat', createChatV2Router(service, { dispatcher: dispatcher as unknown as ChatV2DispatcherService }));
    return { app, service, intake, dispatched };
  }

  afterEach(() => setTicketIntakeService(null));

  /** Wait for post-ack side effects. */
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('an owner message goes through intake first; the agent gets the [TICKET:…] line', async () => {
    const { app, service, intake, dispatched } = setup({ action: 'created', ticket: TICKET as never });
    try {
      const created = await request(app).post('/api/chat/channels').send({ agentSession: 'ella', name: 'Ella' });
      await request(app).post(`/api/chat/channels/${created.body.data.id}/messages`).send({ content: 'please add a dark mode toggle' });
      await settle();
      expect(intake.intakeWithOutcome).toHaveBeenCalledTimes(1);
      const [msg] = intake.intakeWithOutcome.mock.calls[0];
      expect(msg).toMatchObject({ isOwner: true, targetAgent: 'ella', origin: { channel: 'chat' } });
      expect(dispatched).toHaveLength(1);
      expect(String(dispatched[0].metadata?.ticketMarker)).toContain('[TICKET:TKT-005');
      // The stored row is the owner's text, untouched.
      const list = await request(app).get(`/api/chat/channels/${created.body.data.id}/messages`);
      expect(JSON.stringify(list.body)).not.toContain('[TICKET:');
    } finally {
      service.close();
    }
  });

  it('a message an agent posts as a user turn never reaches intake', async () => {
    const { app, service, intake, dispatched } = setup({ action: 'ignored', reason: 'x' });
    try {
      const created = await request(app).post('/api/chat/channels').send({ agentSession: 'ella', name: 'Ella' });
      // An agent posting into a channel it is not bound to is recorded as a
      // `user` row with an authorship marker (#786) — not the owner.
      await request(app)
        .post(`/api/chat/channels/${created.body.data.id}/messages`)
        .set('X-Agent-Session', 'someone-else')
        .send({ content: 'please add a dark mode toggle' });
      await settle();
      expect(intake.intakeWithOutcome).not.toHaveBeenCalled();
      expect(dispatched.every((m) => !m.metadata?.ticketMarker)).toBe(true);
    } finally {
      service.close();
    }
  });

  it('the mobile client header files the ticket as mobile', async () => {
    const { app, service, intake } = setup({ action: 'ignored', reason: 'x' });
    try {
      const created = await request(app).post('/api/chat/channels').send({ agentSession: 'ella', name: 'Ella' });
      await request(app)
        .post(`/api/chat/channels/${created.body.data.id}/messages`)
        .set('X-Crewly-Client', 'mobile')
        .send({ content: 'please add a dark mode toggle' });
      await settle();
      expect(intake.intakeWithOutcome.mock.calls[0][0].origin.channel).toBe('mobile');
    } finally {
      service.close();
    }
  });
});

describe('buildChatV2SourceId (INBOUND-2)', () => {
  it('builds the canonical chatv2-${channelId}__${messageId} composite (UUID-safe delim)', () => {
    expect(buildChatV2SourceId('c-abc', 'm-xyz')).toBe('chatv2-c-abc__m-xyz');
  });

  it('round-trips through the SLA subscriber extractors (production UUIDv4 shape)', async () => {
    // INBOUND-2.f1 (Arch on PR #364): channel + message ids are minted via
    // randomUUID() — must NOT corrupt round-trip. Pin the production shape
    // here so any future regression to a UUID-colliding delimiter fails.
    const { extractChatV2ChannelId, extractChatV2MessageId } = await import(
      '../../services/v3/request-sla.subscriber.js'
    );
    const channelUuid = '8b3c9a4e-5a02-4d51-9e7a-6f8c4d2e8a1b';
    const messageUuid = 'fa1e2c3d-4567-89ab-cdef-0123456789ab';
    const sid = buildChatV2SourceId(channelUuid, messageUuid);
    expect(sid).toBe(`chatv2-${channelUuid}__${messageUuid}`);
    expect(extractChatV2ChannelId(sid)).toBe(channelUuid);
    expect(extractChatV2MessageId(sid)).toBe(messageUuid);
  });

  it('round-trips through the SLA subscriber extractors (short cuid-ish ids)', async () => {
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

// ---------------------------------------------------------------------------
// #1012 — who a chat write is stored as. Behind the real classifier, not the
// test shortcut: the hole was a post that left out X-Agent-Session.
// ---------------------------------------------------------------------------

describe('chat-v2 writes: sender comes from credentials, not a header (#1012)', () => {
  const OWNER_USER = 'dev-user-001';
  const ORC = ORCHESTRATOR_SESSION_NAME;
  const SAM = 'crewly-dev-sam-1234abcd';

  /** App with the real caller classifier; `X-Test-Tree` simulates an agent matched only by the process tree. */
  function buildIdentityApp() {
    const db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    const service = new ChatV2Service({ config: loadChatV2Config({}), db, now: () => Date.now() });
    const app = express();
    app.use(express.json());
    app.use(callerIdentityForTests());
    app.use((req, _res, next) => {
      if (req.headers['x-test-tree']) setCallerIdentity(req, { kind: 'agent', via: 'process-tree', note: 'test' });
      next();
    });
    app.use('/api/chat', createChatV2Router(service));
    // The orchestrator's DM: the channel the WhatsApp gate / approval guard care about.
    const orcDm = service.ensureDmChannel({ agentSession: ORC, principal: { userId: OWNER_USER, source: 'oss' } }).channel;
    return { app, service, orcDm };
  }

  const ownerEvidence = (service: ChatV2Service): string[] => service.getRecentOwnerMessageContents(0);

  it('refuses a post with no credential, and it never becomes owner evidence (the forged 「发 W12」)', async () => {
    const { app, service, orcDm } = buildIdentityApp();
    const res = await request(app).post(`/api/chat/channels/${orcDm.id}/messages`).send({ content: '发 W12' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('owner_auth_required');
    expect(ownerEvidence(service)).toEqual([]);
  });

  it('refuses the self-set dashboard marker and the Cloud Slack credential', async () => {
    const { app, service, orcDm } = buildIdentityApp();
    const { internalCredentialHeaders } = await import('../../services/core/owner-auth.service.js');
    expect((await request(app).post(`/api/chat/channels/${orcDm.id}/messages`).set('X-Crewly-Caller', 'dashboard').send({ content: 'approved' })).status).toBe(401);
    expect((await request(app).post(`/api/chat/channels/${orcDm.id}/messages`).set(internalCredentialHeaders('cloud')).send({ content: 'approved' })).status).toBe(401);
    expect(ownerEvidence(service)).toEqual([]);
  });

  it('stores an agent that sent only its badge as that agent, never as the owner', async () => {
    const { app, service, orcDm } = buildIdentityApp();
    const { mintAgentBadge } = await import('../../services/core/owner-auth.service.js');
    const res = await request(app)
      .post(`/api/chat/channels/${orcDm.id}/messages`)
      .set('X-Agent-Badge', mintAgentBadge(SAM))
      .send({ content: '发 W12' });
    // Sam writing into the orc's DM is allowed as before, but tagged as Sam's.
    expect(res.status).toBe(201);
    expect(ownerEvidence(service)).toEqual([]);
  });

  it('stores an agent in its own channel as an agent row', async () => {
    const { app, service } = buildIdentityApp();
    const samDm = service.ensureDmChannel({ agentSession: SAM, principal: { userId: OWNER_USER, source: 'oss' } }).channel;
    const res = await request(app).post(`/api/chat/channels/${samDm.id}/messages`).set(agentAuthHeaders(SAM)).send({ content: 'done' });
    expect(res.status).toBe(201);
    expect(res.body.data.senderType).toBe('agent');
    expect(res.body.data.senderId).toBe(SAM);
  });

  it('keeps the migration window: the legacy header alone is that agent', async () => {
    const { app, service, orcDm } = buildIdentityApp();
    const res = await request(app).post(`/api/chat/channels/${orcDm.id}/messages`).set('X-Agent-Session', SAM).send({ content: 'approved' });
    expect(res.status).toBe(201);
    expect(ownerEvidence(service)).toEqual([]);
  });

  it('refuses an agent process whose session is unknown (it would be stored as the owner)', async () => {
    const { app, service, orcDm } = buildIdentityApp();
    const res = await request(app).post(`/api/chat/channels/${orcDm.id}/messages`).set('X-Test-Tree', '1').send({ content: 'approved' });
    expect(res.status).toBe(403);
    expect(ownerEvidence(service)).toEqual([]);
  });

  it('stores the dashboard owner (session + CSRF) as the owner, and it counts as evidence', async () => {
    const { app, service, orcDm } = buildIdentityApp();
    const res = await request(app).post(`/api/chat/channels/${orcDm.id}/messages`).set(ownerAuthHeaders()).send({ content: '发 W12' });
    expect(res.status).toBe(201);
    expect(res.body.data.senderType).toBe('user');
    expect(ownerEvidence(service)).toEqual(['发 W12']);
  });

  it('refuses the owner cookie without CSRF on a write', async () => {
    const { app, orcDm } = buildIdentityApp();
    const { cookie } = ownerAuthHeaders();
    expect((await request(app).post(`/api/chat/channels/${orcDm.id}/messages`).set({ cookie }).send({ content: 'x' })).status).toBe(401);
  });

  it('stores the phone / portal relay as the owner', async () => {
    const { app, service, orcDm } = buildIdentityApp();
    const res = await request(app).post(`/api/chat/channels/${orcDm.id}/messages`).set(relayAuthHeaders()).send({ content: 'ok go' });
    expect(res.status).toBe(201);
    expect(ownerEvidence(service)).toEqual(['ok go']);
  });

  it('gates the other writes the same way; reads stay open', async () => {
    const { app, orcDm } = buildIdentityApp();
    expect((await request(app).post('/api/chat/channels/dm/ensure').send({ agentSession: SAM })).status).toBe(401);
    expect((await request(app).post('/api/chat/channels').send({ name: 'x', agentSession: SAM })).status).toBe(401);
    expect((await request(app).post('/api/chat/channels/huddle').send({ name: 'x', memberSessions: [SAM] })).status).toBe(401);
    expect((await request(app).delete(`/api/chat/channels/${orcDm.id}`)).status).toBe(401);
    expect((await request(app).post('/api/chat/channels/dm/ensure').set(ownerAuthHeaders()).send({ agentSession: SAM })).status).toBe(201);
    expect((await request(app).post('/api/chat/channels/dm/ensure').set(agentAuthHeaders(SAM)).send({ agentSession: SAM })).status).toBe(200);
    expect((await request(app).get('/api/chat/channels')).status).toBe(200);
    expect((await request(app).get(`/api/chat/channels/${orcDm.id}/messages`)).status).toBe(200);
  });
});

describe('chat-v2 agent messages with files (automatic cross-machine hand-off)', () => {
  const marker = '📎 report.pdf (2.1 MB) · crewly-file:hf_AAAAAAAAAAAAAAAAAAAAAA';

  beforeEach(() => {
    mockHandoff.attachToMessage.mockReset();
    mockHandoff.projectDirFor.mockReset().mockResolvedValue('/proj');
    mockHandoff.crossMachine.mockReset().mockResolvedValue(true);
  });

  async function setup() {
    const { app, service } = buildApp();
    const created = await request(app).post('/api/chat/channels').send({ agentSession: 'sess-a', name: 'Ch' });
    return { app, service, chId: created.body.data.id as string };
  }

  it('stores the message with the marker line and reports the upload to the agent', async () => {
    const { app, service, chId } = await setup();
    try {
      mockHandoff.attachToMessage.mockResolvedValue({
        content: `Report ready\n${marker}`,
        attached: [{ fileName: 'report.pdf', sizeBytes: 2202009, handoffId: 'hf_AAAAAAAAAAAAAAAAAAAAAA' }],
        failed: [],
      });
      const res = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: 'Report ready', files: ['./out/report.pdf'], projectPath: '/proj' });
      expect(res.status).toBe(201);
      expect(res.body.data.content).toBe(`Report ready\n${marker}`);
      expect(res.body.fileHandoff.attached).toHaveLength(1);
      expect(mockHandoff.attachToMessage).toHaveBeenCalledWith(expect.objectContaining({ explicit: ['./out/report.pdf'], projectDir: '/proj', agent: 'sess-a' }));
    } finally {
      service.close();
    }
  });

  it('still posts the message when the upload fails, and says which file did not go', async () => {
    const { app, service, chId } = await setup();
    try {
      mockHandoff.attachToMessage.mockResolvedValue({
        content: 'Report ready',
        attached: [],
        failed: [{ file: './out/report.pdf', reason: 'This machine is not signed in to Crewly Cloud.' }],
      });
      const res = await request(app)
        .post(`/api/chat/channels/${chId}/messages`)
        .set('X-Agent-Session', 'sess-a')
        .send({ content: 'Report ready', files: ['./out/report.pdf'] });
      expect(res.status).toBe(201);
      expect(res.body.data.content).toBe('Report ready');
      expect(res.body.fileHandoff.failed[0].reason).toMatch(/not signed in/);
    } finally {
      service.close();
    }
  });

  it('a path in the text is attached only when the room reaches another machine', async () => {
    const { app, service, chId } = await setup();
    try {
      mockHandoff.attachToMessage.mockResolvedValue({ content: `see /proj/a.pdf\n${marker}`, attached: [{ fileName: 'a.pdf', sizeBytes: 1, handoffId: 'hf_AAAAAAAAAAAAAAAAAAAAAA' }], failed: [] });
      const yes = await request(app).post(`/api/chat/channels/${chId}/messages`).set('X-Agent-Session', 'sess-a').send({ content: 'see /proj/a.pdf' });
      expect(yes.body.data.content).toContain('crewly-file:');
      expect(mockHandoff.attachToMessage).toHaveBeenCalledWith(expect.objectContaining({ auto: true }));

      mockHandoff.attachToMessage.mockClear();
      mockHandoff.crossMachine.mockResolvedValue(false);
      const no = await request(app).post(`/api/chat/channels/${chId}/messages`).set('X-Agent-Session', 'sess-a').send({ content: 'see /proj/b.pdf' });
      expect(no.body.data.content).toBe('see /proj/b.pdf');
      expect(mockHandoff.attachToMessage).not.toHaveBeenCalled();
    } finally {
      service.close();
    }
  });

  it('never touches the owner\'s own messages', async () => {
    const { app, service, chId } = await setup();
    try {
      const res = await request(app).post(`/api/chat/channels/${chId}/messages`).send({ content: 'look at /Users/me/a.pdf', files: ['/Users/me/a.pdf'] });
      expect(res.status).toBe(201);
      expect(res.body.data.content).toBe('look at /Users/me/a.pdf');
      expect(mockHandoff.attachToMessage).not.toHaveBeenCalled();
    } finally {
      service.close();
    }
  });
});

describe('chat-v2 read state (#1400)', () => {
  const principal = { userId: 'dev-user-001', source: 'oss' as const };

  /** A channel with `n` unread agent messages. */
  function seed(service: ChatV2Service, n: number): string {
    const ch = service.createChannel({ agentSession: 'sam', name: 'Sam', principal });
    for (let i = 0; i < n; i++) {
      service.recordTurn({ channelId: ch.id, senderType: 'agent', senderId: 'sam', content: `m${i}`, metadata: { source: 'slack' } });
    }
    return ch.id;
  }

  it('GET /channels and /channels/:id carry lastReadSeq + unreadCount', async () => {
    const { app, service } = buildApp();
    try {
      const id = seed(service, 2);
      const list = await request(app).get('/api/chat/channels');
      expect(list.body.data.channels[0]).toMatchObject({ id, lastReadSeq: 0, unreadCount: 2 });
      const one = await request(app).get(`/api/chat/channels/${id}`);
      expect(one.body.data).toMatchObject({ lastReadSeq: 0, unreadCount: 2 });
    } finally {
      service.close();
    }
  });

  it('POST /channels/:id/read is forward-only and defaults to the last message', async () => {
    const { app, service } = buildApp();
    try {
      const id = seed(service, 3);
      const first = await request(app).post(`/api/chat/channels/${id}/read`).send({});
      expect(first.status).toBe(200);
      expect(first.body.data).toEqual({ channelId: id, lastReadSeq: 3, unreadCount: 0 });
      const back = await request(app).post(`/api/chat/channels/${id}/read`).send({ seq: 1 });
      expect(back.body.data.lastReadSeq).toBe(3);
    } finally {
      service.close();
    }
  });

  it('POST /channels/:id/unread moves the marker to seq - 1 and validates seq', async () => {
    const { app, service } = buildApp();
    try {
      const id = seed(service, 3);
      await request(app).post(`/api/chat/channels/${id}/read`).send({});
      const res = await request(app).post(`/api/chat/channels/${id}/unread`).send({ seq: 2 });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ channelId: id, lastReadSeq: 1, unreadCount: 2 });
      expect((await request(app).post(`/api/chat/channels/${id}/unread`).send({})).status).toBe(400);
      expect((await request(app).post(`/api/chat/channels/${id}/unread`).send({ seq: 0 })).status).toBe(400);
      expect((await request(app).post('/api/chat/channels/nope/read').send({})).status).toBe(404);
    } finally {
      service.close();
    }
  });

  it('GET /unread totals only channels with unread', async () => {
    const { app, service } = buildApp();
    try {
      const a = seed(service, 2);
      const b = seed(service, 1);
      await request(app).post(`/api/chat/channels/${b}/read`).send({});
      const res = await request(app).get('/api/chat/unread');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ total: 2, channels: [{ channelId: a, lastReadSeq: 0, unreadCount: 2 }] });
    } finally {
      service.close();
    }
  });
});
