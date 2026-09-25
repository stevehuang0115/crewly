/**
 * Tests for WhatsAppInboxStore
 *
 * @module services/whatsapp/whatsapp-inbox.store.test
 */

import { mkdtempSync, rmSync, statSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  WhatsAppInboxStore,
  IN_MEMORY_DB,
  formatDraftCode,
  parseDraftCode,
  getDefaultInboxDbPath,
  getWhatsAppInboxStore,
  resetWhatsAppInboxStore,
} from './whatsapp-inbox.store.js';
import type { WhatsAppInboxMessage } from '../../types/whatsapp.types.js';

const ANN = '4915550001@s.whatsapp.net';
const BOB = '4915550002@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

/**
 * Build a message with defaults.
 *
 * @param over - Fields to override
 * @returns Message
 */
function msg(over: Partial<WhatsAppInboxMessage> & { id: string; chatId: string; ts: number }): WhatsAppInboxMessage {
  return { fromMe: false, senderJid: null, senderName: null, text: '', kind: 'text', ...over };
}

describe('WhatsAppInboxStore', () => {
  let store: WhatsAppInboxStore;

  beforeEach(() => {
    store = new WhatsAppInboxStore(IN_MEMORY_DB);
  });

  afterEach(() => {
    store.close();
  });

  describe('draft codes', () => {
    it('formats and parses codes', () => {
      expect(formatDraftCode(12)).toBe('W12');
      expect(parseDraftCode('W12')).toBe(12);
      expect(parseDraftCode('w12')).toBe(12);
      expect(parseDraftCode('#W12')).toBe(12);
      expect(parseDraftCode(' 12 ')).toBe(12);
      expect(parseDraftCode('W0')).toBeNull();
      expect(parseDraftCode('X12')).toBeNull();
      expect(parseDraftCode('abc')).toBeNull();
    });
  });

  describe('chats', () => {
    it('upserts idempotently and infers groups from the JID', () => {
      store.upsertChat({ id: GROUP });
      store.upsertChat({ id: GROUP });
      expect(store.getChat(GROUP)).toEqual({ id: GROUP, name: null, isGroup: true, lastMessageAt: null });
      expect(store.getChat('nope')).toBeNull();
    });

    it('never lets a lower-ranked name overwrite a higher one', () => {
      store.upsertChat({ id: ANN, name: 'annie', nameRank: 1 });
      store.upsertChat({ id: ANN, name: 'Ann Smith', nameRank: 3 });
      store.upsertChat({ id: ANN, name: 'annie2', nameRank: 1 });
      store.upsertChat({ id: ANN, name: '   ', nameRank: 3 });
      expect(store.getChat(ANN)?.name).toBe('Ann Smith');
      store.upsertChat({ id: ANN, name: 'Ann S.', nameRank: 3 });
      expect(store.getChat(ANN)?.name).toBe('Ann S.');
    });

    it('only moves lastMessageAt forward', () => {
      store.upsertChat({ id: ANN, lastMessageAt: 200 });
      store.upsertChat({ id: ANN, lastMessageAt: 100 });
      store.upsertChat({ id: ANN, lastMessageAt: null });
      expect(store.getChat(ANN)?.lastMessageAt).toBe(200);
    });
  });

  describe('messages', () => {
    it('upserts by id idempotently and creates the chat', () => {
      store.upsertMessage(msg({ id: 'm1', chatId: ANN, ts: 100, text: 'hi' }));
      store.upsertMessage(msg({ id: 'm1', chatId: ANN, ts: 100, text: 'hi (edited)', senderName: 'Ann' }));
      const rows = store.listMessages(ANN, { limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ text: 'hi (edited)', senderName: 'Ann' });
      expect(store.getChat(ANN)?.lastMessageAt).toBe(100);
    });

    it('keeps the original text when a redelivery has none, and fromMe as first stored', () => {
      store.upsertMessage(msg({ id: 'm1', chatId: ANN, ts: 100, text: 'caption', kind: 'image', fromMe: true }));
      store.upsertMessage(msg({ id: 'm1', chatId: ANN, ts: 100, text: '', kind: 'image', fromMe: false }));
      expect(store.listMessages(ANN, { limit: 1 })[0]).toMatchObject({ text: 'caption', fromMe: true });
    });

    it('pages messages chronologically with an exclusive before', () => {
      store.upsertMessages([1, 2, 3, 4, 5].map((i) => msg({ id: `m${i}`, chatId: ANN, ts: i * 10, text: `t${i}` })));
      expect(store.listMessages(ANN, { limit: 2 }).map((m) => m.id)).toEqual(['m4', 'm5']);
      expect(store.listMessages(ANN, { limit: 2, before: 40 }).map((m) => m.id)).toEqual(['m2', 'm3']);
    });

    it('searches text case-insensitively and treats % and _ literally', () => {
      store.upsertChat({ id: ANN, name: 'Ann', nameRank: 3 });
      store.upsertMessages([
        msg({ id: 'a', chatId: ANN, ts: 1, text: 'Dinner at 8?' }),
        msg({ id: 'b', chatId: BOB, ts: 2, text: 'dinner is 100% on' }),
        msg({ id: 'c', chatId: BOB, ts: 3, text: 'lunch' }),
      ]);
      expect(store.search('DINNER', 10).map((h) => h.id)).toEqual(['b', 'a']);
      expect(store.search('DINNER', 10)[1].chatName).toBe('Ann');
      expect(store.search('100%', 10).map((h) => h.id)).toEqual(['b']);
      expect(store.search('_', 10)).toEqual([]);
    });

    it('lists chats newest first and filters by name or JID', () => {
      store.upsertChat({ id: ANN, name: 'Ann', nameRank: 3, lastMessageAt: 100 });
      store.upsertChat({ id: BOB, name: 'Bob', nameRank: 3, lastMessageAt: 200 });
      store.upsertChat({ id: GROUP, name: 'Family' });
      expect(store.listChats({ limit: 10 }).map((c) => c.id)).toEqual([BOB, ANN, GROUP]);
      expect(store.listChats({ limit: 10, q: 'fam' }).map((c) => c.id)).toEqual([GROUP]);
      expect(store.listChats({ limit: 10, q: '4915550001' }).map((c) => c.id)).toEqual([ANN]);
      expect(store.listChats({ limit: 1 })).toHaveLength(1);
    });
  });

  describe('listInbox', () => {
    beforeEach(() => {
      // Ann: owner replied, then two new inbound → needs reply, 2 unanswered
      store.upsertMessages([
        msg({ id: 'a1', chatId: ANN, ts: 10, text: 'q1' }),
        msg({ id: 'a2', chatId: ANN, ts: 20, text: 'reply', fromMe: true }),
        msg({ id: 'a3', chatId: ANN, ts: 30, text: 'q2' }),
        msg({ id: 'a4', chatId: ANN, ts: 40, text: 'q3', kind: 'image' }),
      ]);
      // Bob: owner answered last → not in inbox
      store.upsertMessages([
        msg({ id: 'b1', chatId: BOB, ts: 50, text: 'yo' }),
        msg({ id: 'b2', chatId: BOB, ts: 60, text: 'hey', fromMe: true }),
      ]);
      // Group: never answered, newest overall
      store.upsertMessages([
        msg({ id: 'g1', chatId: GROUP, ts: 70, text: 'hello all', senderName: 'Cara' }),
        msg({ id: 'g2', chatId: GROUP, ts: 80, text: 'anyone?', senderName: 'Dan' }),
      ]);
    });

    it('lists only chats whose last message is not the owner\'s, excluding groups by default', () => {
      const inbox = store.listInbox({ limit: 10 });
      expect(inbox).toEqual([
        {
          chat: { id: ANN, name: null, isGroup: false, lastMessageAt: 40 },
          unansweredCount: 2,
          lastText: 'q3',
          lastKind: 'image',
          lastSenderName: null,
          lastMessageAt: 40,
        },
      ]);
    });

    it('includes groups on request, newest first, counting all inbound when never answered', () => {
      const inbox = store.listInbox({ limit: 10, includeGroups: true });
      expect(inbox.map((e) => [e.chat.id, e.unansweredCount, e.lastSenderName])).toEqual([
        [GROUP, 2, 'Dan'],
        [ANN, 2, null],
      ]);
      expect(store.listInbox({ limit: 1, includeGroups: true })).toHaveLength(1);
    });
  });

  describe('drafts', () => {
    it('creates monotonic codes and finds drafts by id or code', () => {
      const d1 = store.createDraft({ chatId: ANN, text: 'one', createdBy: 'crewly-orc', now: 1000 });
      const d2 = store.createDraft({ chatId: ANN, text: 'two', createdBy: null, now: 2000 });
      expect([d1.code, d2.code]).toEqual(['W1', 'W2']);
      expect(d1).toMatchObject({ status: 'pending', createdAt: 1000, createdBy: 'crewly-orc', sentAt: null });
      expect(store.findDraft(d1.id)?.code).toBe('W1');
      expect(store.findDraft('w2')?.id).toBe(d2.id);
      expect(store.findDraft('#W2')?.id).toBe(d2.id);
      expect(store.findDraft('W99')).toBeNull();
      expect(store.findDraft('garbage')).toBeNull();
    });

    it('keeps codes monotonic after discards', () => {
      const d1 = store.createDraft({ chatId: ANN, text: 'one', createdBy: null, now: 1 });
      store.discardDraft(d1.id, 2);
      expect(store.createDraft({ chatId: ANN, text: 'two', createdBy: null, now: 3 }).code).toBe('W2');
    });

    it('lists drafts newest first with an optional status filter', () => {
      const d1 = store.createDraft({ chatId: ANN, text: 'one', createdBy: null, now: 1 });
      store.createDraft({ chatId: ANN, text: 'two', createdBy: null, now: 2 });
      store.discardDraft(d1.id, 3);
      expect(store.listDrafts({ limit: 10 }).map((d) => d.code)).toEqual(['W2', 'W1']);
      expect(store.listDrafts({ status: 'pending', limit: 10 }).map((d) => d.code)).toEqual(['W2']);
      expect(store.listDrafts({ status: 'discarded', limit: 10 })[0].discardedAt).toBe(3);
    });

    it('claims a draft exactly once and marks it sent', () => {
      const d = store.createDraft({ chatId: ANN, text: 'x', createdBy: null, now: 1 });
      expect(store.claimDraftForSend(d.id)).toBe(true);
      expect(store.claimDraftForSend(d.id)).toBe(false);
      expect(store.discardDraft(d.id, 2)).toBe(false);
      store.markDraftSent(d.id, 5);
      expect(store.getDraftById(d.id)).toMatchObject({ status: 'sent', sentAt: 5 });
      expect(store.claimDraftForSend(d.id)).toBe(false);
    });

    it('returns a failed claim to pending with the error', () => {
      const d = store.createDraft({ chatId: ANN, text: 'x', createdBy: null, now: 1 });
      store.claimDraftForSend(d.id);
      store.releaseDraftClaim(d.id, 'socket closed');
      expect(store.getDraftById(d.id)).toMatchObject({ status: 'pending', lastError: 'socket closed' });
      expect(store.claimDraftForSend(d.id)).toBe(true);
    });

    it('discards only pending drafts', () => {
      const d = store.createDraft({ chatId: ANN, text: 'x', createdBy: null, now: 1 });
      expect(store.discardDraft(d.id, 2)).toBe(true);
      expect(store.discardDraft(d.id, 3)).toBe(false);
      expect(store.claimDraftForSend(d.id)).toBe(false);
    });
  });
});

describe('WhatsAppInboxStore on disk', () => {
  const originalHome = process.env.CREWLY_HOME;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'wa-inbox-'));
    process.env.CREWLY_HOME = tmp;
  });

  afterEach(() => {
    resetWhatsAppInboxStore();
    if (originalHome === undefined) delete process.env.CREWLY_HOME;
    else process.env.CREWLY_HOME = originalHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves the default path under CREWLY_HOME', () => {
    expect(getDefaultInboxDbPath()).toBe(path.join(tmp, 'whatsapp', 'inbox.db'));
  });

  it('creates an owner-only database file and persists across reopen', () => {
    const store = getWhatsAppInboxStore();
    expect(getWhatsAppInboxStore()).toBe(store);
    store.upsertMessage(msg({ id: 'm1', chatId: ANN, ts: 1, text: 'persist me' }));
    const file = getDefaultInboxDbPath();
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    resetWhatsAppInboxStore();
    const reopened = getWhatsAppInboxStore();
    expect(reopened).not.toBe(store);
    expect(reopened.search('persist', 5)).toHaveLength(1);
  });
});
