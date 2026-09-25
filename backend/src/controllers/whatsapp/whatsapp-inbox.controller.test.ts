/**
 * Tests for the WhatsApp inbox routes (read API + drafts + send gate)
 *
 * @module controllers/whatsapp/whatsapp-inbox.controller.test
 */

import request from 'supertest';
import express from 'express';
import { createWhatsAppInboxRouter, parseLimit, parseFlag, type WhatsAppInboxSender } from './whatsapp-inbox.controller.js';
import { WhatsAppInboxStore, IN_MEMORY_DB } from '../../services/whatsapp/whatsapp-inbox.store.js';
import { WHATSAPP_CONSTANTS } from '../../constants.js';
import type { WhatsAppInboxMessage } from '../../types/whatsapp.types.js';

jest.mock('../../services/chat-v2/chat-v2.singleton.js', () => ({
  getChatV2Service: jest.fn(() => {
    throw new Error('tests must inject getOwnerMessagesSince');
  }),
}));

jest.mock('@whiskeysockets/baileys', () => ({ default: jest.fn() }), { virtual: true });

const ANN = '4915550001@s.whatsapp.net';
const BOB = '4915550002@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const T0 = 1_760_000_000_000;
const AGENT = { 'X-Agent-Session': 'crewly-orc' };

/**
 * Build a message with defaults.
 *
 * @param over - Overrides
 * @returns Message
 */
function msg(over: Partial<WhatsAppInboxMessage> & { id: string; chatId: string; ts: number }): WhatsAppInboxMessage {
  return { fromMe: false, senderJid: null, senderName: null, text: '', kind: 'text', ...over };
}

describe('WhatsApp inbox routes', () => {
  let store: WhatsAppInboxStore;
  let now: number;
  let ownerMessages: Array<{ at: number; text: string }>;
  let sender: { isConnected: jest.Mock; sendMessage: jest.Mock };
  let getOwnerMessagesSince: jest.Mock;
  let app: express.Express;

  beforeEach(() => {
    store = new WhatsAppInboxStore(IN_MEMORY_DB);
    now = T0;
    ownerMessages = [];
    sender = { isConnected: jest.fn().mockReturnValue(true), sendMessage: jest.fn().mockResolvedValue(undefined) };
    getOwnerMessagesSince = jest.fn((since: number) =>
      ownerMessages.filter((m) => m.at >= since).sort((a, b) => b.at - a.at).map((m) => m.text),
    );
    app = express();
    app.use(express.json());
    app.use(
      '/api/whatsapp',
      createWhatsAppInboxRouter({
        getStore: () => store,
        getSender: () => sender as unknown as WhatsAppInboxSender,
        getOwnerMessagesSince,
        now: () => now,
      }),
    );
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ success: false, error: err.message });
    });

    store.upsertChat({ id: ANN, name: 'Ann', nameRank: 3 });
    store.upsertMessages([
      msg({ id: 'a1', chatId: ANN, ts: 10, text: 'dinner tonight?' }),
      msg({ id: 'a2', chatId: ANN, ts: 20, text: 'yes!', fromMe: true }),
      msg({ id: 'a3', chatId: ANN, ts: 30, text: 'at 8?' }),
      msg({ id: 'b1', chatId: BOB, ts: 40, text: 'invoice attached', kind: 'document' }),
      msg({ id: 'g1', chatId: GROUP, ts: 50, text: 'family dinner Sunday' }),
    ]);
  });

  afterEach(() => store.close());

  describe('helpers', () => {
    it('parseLimit clamps and defaults', () => {
      expect(parseLimit(undefined, 20, 100)).toBe(20);
      expect(parseLimit('5', 20, 100)).toBe(5);
      expect(parseLimit('500', 20, 100)).toBe(100);
      expect(parseLimit('-1', 20, 100)).toBe(20);
      expect(parseLimit('abc', 20, 100)).toBe(20);
    });

    it('parseFlag only accepts explicit truthy values', () => {
      expect(parseFlag('true')).toBe(true);
      expect(parseFlag('1')).toBe(true);
      expect(parseFlag('false')).toBe(false);
      expect(parseFlag(undefined)).toBe(false);
    });
  });

  describe('GET /inbox', () => {
    it('lists chats needing a reply, groups excluded by default, newest first', async () => {
      const res = await request(app).get('/api/whatsapp/inbox').set(AGENT);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.map((e: { chat: { id: string }; unansweredCount: number }) => [e.chat.id, e.unansweredCount])).toEqual([
        [BOB, 1],
        [ANN, 1],
      ]);
    });

    it('includes groups with includeGroups=true and honours limit', async () => {
      const res = await request(app).get('/api/whatsapp/inbox?includeGroups=true&limit=1');
      expect(res.body.data.map((e: { chat: { id: string } }) => e.chat.id)).toEqual([GROUP]);
    });

    it('passes store errors to the error handler', async () => {
      store.close();
      const res = await request(app).get('/api/whatsapp/inbox');
      expect(res.status).toBe(500);
      store = new WhatsAppInboxStore(IN_MEMORY_DB);
    });
  });

  describe('GET /chats', () => {
    it('lists recent chats and filters by q', async () => {
      const all = await request(app).get('/api/whatsapp/chats');
      expect(all.body.data.map((c: { id: string }) => c.id)).toEqual([GROUP, BOB, ANN]);
      const q = await request(app).get('/api/whatsapp/chats?q=ann');
      expect(q.body.data.map((c: { id: string }) => c.id)).toEqual([ANN]);
    });
  });

  describe('GET /chats/:chatId/messages', () => {
    it('returns a chronological page with nextBefore for paging back', async () => {
      const res = await request(app).get(`/api/whatsapp/chats/${encodeURIComponent(ANN)}/messages?limit=2`);
      expect(res.status).toBe(200);
      expect(res.body.data.chat.name).toBe('Ann');
      expect(res.body.data.messages.map((m: { id: string }) => m.id)).toEqual(['a2', 'a3']);
      expect(res.body.data.nextBefore).toBe(20);
      const older = await request(app).get(`/api/whatsapp/chats/${encodeURIComponent(ANN)}/messages?limit=2&before=20`);
      expect(older.body.data.messages.map((m: { id: string }) => m.id)).toEqual(['a1']);
      expect(older.body.data.nextBefore).toBeNull();
    });

    it('404s an unknown chat', async () => {
      const res = await request(app).get('/api/whatsapp/chats/nobody%40s.whatsapp.net/messages');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('chat_not_found');
    });
  });

  describe('GET /search', () => {
    it('finds messages across chats', async () => {
      const res = await request(app).get('/api/whatsapp/search?q=dinner');
      expect(res.body.data.map((h: { id: string }) => h.id)).toEqual(['g1', 'a1']);
    });

    it('requires q', async () => {
      const res = await request(app).get('/api/whatsapp/search?q=%20');
      expect(res.status).toBe(400);
    });
  });

  describe('drafts', () => {
    /**
     * Create a draft as the orchestrator.
     *
     * @param text - Draft text
     * @returns Response body data
     */
    async function draftAsAgent(text = 'Yes, 8 works!'): Promise<{ id: string; code: string }> {
      const res = await request(app).post('/api/whatsapp/drafts').set(AGENT).send({ chatId: ANN, text });
      expect(res.status).toBe(201);
      return res.body.data;
    }

    it('creates a pending draft with a W-code, author and owner instruction; never sends', async () => {
      const res = await request(app).post('/api/whatsapp/drafts').set(AGENT).send({ chatId: ANN, text: '  Yes, 8 works!  ' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        code: 'W1',
        status: 'pending',
        createdBy: 'crewly-orc',
        createdAt: T0,
        text: 'Yes, 8 works!',
        recipient: 'Ann',
      });
      expect(res.body.data.instruction).toContain('「发 W1」');
      expect(sender.sendMessage).not.toHaveBeenCalled();
      const second = await draftAsAgent('another');
      expect(second.code).toBe('W2');
    });

    it('records owner-created drafts with createdBy null', async () => {
      const res = await request(app).post('/api/whatsapp/drafts').send({ chatId: ANN, text: 'hi' });
      expect(res.body.data.createdBy).toBeNull();
    });

    it('validates input and refuses unknown chats', async () => {
      expect((await request(app).post('/api/whatsapp/drafts').send({ chatId: ANN })).status).toBe(400);
      expect((await request(app).post('/api/whatsapp/drafts').send({ text: 'x' })).status).toBe(400);
      const long = 'x'.repeat(WHATSAPP_CONSTANTS.MAX_MESSAGE_LENGTH + 1);
      expect((await request(app).post('/api/whatsapp/drafts').send({ chatId: ANN, text: long })).status).toBe(400);
      const unknown = await request(app).post('/api/whatsapp/drafts').send({ chatId: '1@s.whatsapp.net', text: 'x' });
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('chat_not_found');
    });

    it('lists drafts by status with recipient names and rejects bad status', async () => {
      const d1 = await draftAsAgent('one');
      await draftAsAgent('two');
      await request(app).post(`/api/whatsapp/drafts/${d1.id}/discard`);
      const pending = await request(app).get('/api/whatsapp/drafts?status=pending');
      expect(pending.body.data.map((d: { code: string }) => d.code)).toEqual(['W2']);
      expect(pending.body.data[0].recipient).toBe('Ann');
      expect((await request(app).get('/api/whatsapp/drafts')).body.data).toHaveLength(2);
      expect((await request(app).get('/api/whatsapp/drafts?status=bogus')).status).toBe(400);
    });

    it('discards by code, only once', async () => {
      await draftAsAgent();
      const ok = await request(app).post('/api/whatsapp/drafts/W1/discard').set(AGENT);
      expect(ok.status).toBe(200);
      expect(ok.body.data.status).toBe('discarded');
      const again = await request(app).post('/api/whatsapp/drafts/W1/discard');
      expect(again.status).toBe(409);
      expect((await request(app).post('/api/whatsapp/drafts/W9/discard')).status).toBe(404);
    });

    describe('POST /drafts/:id/send — the gate', () => {
      it('owner (no X-Agent-Session) can send without a chat confirmation', async () => {
        const d = await draftAsAgent();
        now = T0 + 5000;
        const res = await request(app).post(`/api/whatsapp/drafts/${d.id}/send`);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ status: 'sent', sentAt: T0 + 5000, via: 'owner' });
        expect(sender.sendMessage).toHaveBeenCalledWith({ to: ANN, text: 'Yes, 8 works!' });
        expect(getOwnerMessagesSince).not.toHaveBeenCalled();
      });

      it('agent without the owner confirmation → 403 needs_owner_confirmation, nothing sent', async () => {
        const d = await draftAsAgent();
        const res = await request(app).post(`/api/whatsapp/drafts/${d.code}/send`).set(AGENT);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('needs_owner_confirmation');
        expect(res.body.error).toContain('「发 W1」');
        expect(res.body.data).toEqual({ code: 'W1', reason: 'no_confirmation' });
        expect(sender.sendMessage).not.toHaveBeenCalled();
        expect(store.findDraft('W1')?.status).toBe('pending');
      });

      it('agent with the owner\'s 「发 W1」 after the draft → sent once', async () => {
        const d = await draftAsAgent();
        ownerMessages.push({ at: T0 + 60_000, text: '发 W1' });
        now = T0 + 90_000;
        const res = await request(app).post(`/api/whatsapp/drafts/${d.id}/send`).set(AGENT);
        expect(res.status).toBe(200);
        expect(res.body.data.via).toBe('owner_confirmation');
        expect(sender.sendMessage).toHaveBeenCalledTimes(1);
        expect(getOwnerMessagesSince).toHaveBeenCalledWith(T0, WHATSAPP_CONSTANTS.OWNER_CONFIRM_SCAN_LIMIT);
      });

      it('agent: a confirmation that predates the draft does not count', async () => {
        ownerMessages.push({ at: T0 - 1, text: '发 W1' });
        const d = await draftAsAgent();
        const res = await request(app).post(`/api/whatsapp/drafts/${d.id}/send`).set(AGENT);
        expect(res.status).toBe(403);
      });

      it('agent: the wrong code is refused', async () => {
        const d = await draftAsAgent();
        ownerMessages.push({ at: T0 + 1000, text: '发 W2' });
        const res = await request(app).post(`/api/whatsapp/drafts/${d.id}/send`).set(AGENT);
        expect(res.status).toBe(403);
        expect(sender.sendMessage).not.toHaveBeenCalled();
      });

      it('agent: outside the confirm window is refused even with a confirmation', async () => {
        const d = await draftAsAgent();
        ownerMessages.push({ at: T0 + 1000, text: '发 W1' });
        now = T0 + WHATSAPP_CONSTANTS.DRAFT_CONFIRM_WINDOW_MS + 1;
        const res = await request(app).post(`/api/whatsapp/drafts/${d.id}/send`).set(AGENT);
        expect(res.status).toBe(403);
        expect(res.body.data.reason).toBe('window_expired');
        expect(sender.sendMessage).not.toHaveBeenCalled();
      });

      it('already sent → 409, never twice', async () => {
        const d = await draftAsAgent();
        expect((await request(app).post(`/api/whatsapp/drafts/${d.id}/send`)).status).toBe(200);
        const again = await request(app).post(`/api/whatsapp/drafts/${d.id}/send`);
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('draft_not_pending');
        expect(sender.sendMessage).toHaveBeenCalledTimes(1);
      });

      it('concurrent owner sends of the same draft send exactly once', async () => {
        const d = await draftAsAgent();
        let release: () => void = () => undefined;
        sender.sendMessage.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
        const first = request(app).post(`/api/whatsapp/drafts/${d.id}/send`).then((r) => r);
        const second = request(app).post(`/api/whatsapp/drafts/${d.id}/send`).then((r) => r);
        await new Promise((r) => setTimeout(r, 50));
        release();
        const statuses = (await Promise.all([first, second])).map((r) => r.status).sort();
        expect(statuses).toEqual([200, 409]);
        expect(sender.sendMessage).toHaveBeenCalledTimes(1);
      });

      it('discarded drafts cannot be sent', async () => {
        const d = await draftAsAgent();
        await request(app).post(`/api/whatsapp/drafts/${d.id}/discard`);
        expect((await request(app).post(`/api/whatsapp/drafts/${d.id}/send`)).status).toBe(409);
      });

      it('unknown draft → 404', async () => {
        expect((await request(app).post('/api/whatsapp/drafts/W42/send')).status).toBe(404);
      });

      it('not connected → 503 and the draft stays pending', async () => {
        const d = await draftAsAgent();
        sender.isConnected.mockReturnValue(false);
        const res = await request(app).post(`/api/whatsapp/drafts/${d.id}/send`);
        expect(res.status).toBe(503);
        expect(store.findDraft(d.id)?.status).toBe('pending');
      });

      it('a socket failure returns 502 and the draft goes back to pending with the error', async () => {
        const d = await draftAsAgent();
        sender.sendMessage.mockRejectedValueOnce(new Error('socket closed'));
        const res = await request(app).post(`/api/whatsapp/drafts/${d.id}/send`);
        expect(res.status).toBe(502);
        expect(res.body.code).toBe('send_failed');
        expect(store.findDraft(d.id)).toMatchObject({ status: 'pending', lastError: 'socket closed' });
      });
    });
  });
});
