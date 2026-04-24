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
import { ChatV2Service } from '../../services/chat-v2/chat-v2.service.js';
import { openChatDatabase } from '../../services/chat-v2/sqlite/chat-db.js';
import { loadChatV2Config } from '../../services/chat-v2/config.js';

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
});
