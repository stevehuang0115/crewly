/**
 * Tests for WhatsApp inbox capture (Baileys events → store)
 *
 * @module services/whatsapp/whatsapp-inbox-capture.test
 */

import {
  toEpochMs,
  canonicalJid,
  unwrapMessageContent,
  classifyMessageContent,
  parseBaileysMessage,
  chatFromContact,
  chatFromChat,
  chatFromGroup,
  isGroupJid,
  WhatsAppInboxCapture,
} from './whatsapp-inbox-capture.js';
import { WhatsAppInboxStore, IN_MEMORY_DB } from './whatsapp-inbox.store.js';

const ANN = '4915550001@s.whatsapp.net';
const ANN_LID = '99887766@lid';
const GROUP = '120363000000000001@g.us';
const OWN = '4915559999@s.whatsapp.net';
const NOW_MS = 1_760_000_000_000;
const NOW_S = NOW_MS / 1000;

describe('toEpochMs', () => {
  it('handles seconds as number, numeric string, bigint and protobuf Long', () => {
    expect(toEpochMs(1700000000)).toBe(1700000000000);
    expect(toEpochMs('1700000000')).toBe(1700000000000);
    expect(toEpochMs(BigInt(1700000000))).toBe(1700000000000);
    expect(toEpochMs({ toNumber: () => 1700000000 })).toBe(1700000000000);
    expect(toEpochMs({ low: 1700000000, high: 0, unsigned: true })).toBe(1700000000000);
  });

  it('rejects junk', () => {
    expect(toEpochMs(undefined)).toBeNull();
    expect(toEpochMs(0)).toBeNull();
    expect(toEpochMs('abc')).toBeNull();
    expect(toEpochMs(NaN)).toBeNull();
  });
});

describe('JID helpers', () => {
  it('detects groups', () => {
    expect(isGroupJid(GROUP)).toBe(true);
    expect(isGroupJid(ANN)).toBe(false);
  });

  it('prefers the phone-number JID over a LID when the alternate is supplied', () => {
    expect(canonicalJid(ANN_LID, ANN)).toBe(ANN);
    expect(canonicalJid(ANN_LID)).toBe(ANN_LID);
    expect(canonicalJid(ANN, ANN_LID)).toBe(ANN);
    expect(canonicalJid(ANN_LID, 'other@lid')).toBe(ANN_LID);
  });
});

describe('classifyMessageContent', () => {
  it.each([
    [{ conversation: 'hi' }, 'text', 'hi'],
    [{ extendedTextMessage: { text: 'link https://x' } }, 'text', 'link https://x'],
    [{ imageMessage: { caption: 'look' } }, 'image', 'look'],
    [{ imageMessage: {} }, 'image', ''],
    [{ videoMessage: { caption: 'clip' } }, 'video', 'clip'],
    [{ ptvMessage: {} }, 'video', ''],
    [{ documentMessage: { fileName: 'invoice.pdf' } }, 'document', 'invoice.pdf'],
    [{ documentMessage: { caption: 'see', fileName: 'x.pdf' } }, 'document', 'see'],
    [{ audioMessage: { ptt: true } }, 'audio', ''],
    [{ stickerMessage: {} }, 'sticker', ''],
    [{ locationMessage: { degreesLatitude: 1 } }, 'other', ''],
    [{ ephemeralMessage: { message: { conversation: 'vanishing' } } }, 'text', 'vanishing'],
    [{ viewOnceMessageV2: { message: { imageMessage: { caption: 'once' } } } }, 'image', 'once'],
    [{ documentWithCaptionMessage: { message: { documentMessage: { caption: 'doc cap' } } } }, 'document', 'doc cap'],
  ])('%j → %s', (content, kind, text) => {
    expect(classifyMessageContent(content)).toEqual({ kind, text });
  });

  it('returns null for protocol-only / reaction / empty content', () => {
    expect(classifyMessageContent({ protocolMessage: { type: 0 } })).toBeNull();
    expect(classifyMessageContent({ reactionMessage: { text: '👍' } })).toBeNull();
    expect(classifyMessageContent({ senderKeyDistributionMessage: {}, messageContextInfo: {} })).toBeNull();
    expect(classifyMessageContent({})).toBeNull();
    expect(classifyMessageContent(undefined)).toBeNull();
  });

  it('unwraps nested wrappers', () => {
    expect(unwrapMessageContent({ ephemeralMessage: { message: { viewOnceMessage: { message: { conversation: 'deep' } } } } }))
      .toEqual({ conversation: 'deep' });
  });
});

describe('parseBaileysMessage', () => {
  it('keeps fromMe messages with the own JID as sender and no pushName', () => {
    const parsed = parseBaileysMessage(
      { key: { remoteJid: ANN, fromMe: true, id: 'o1' }, message: { conversation: 'sure' }, pushName: 'Me', messageTimestamp: NOW_S },
      OWN,
    );
    expect(parsed).toEqual({
      message: { id: 'o1', chatId: ANN, fromMe: true, senderJid: OWN, senderName: null, text: 'sure', ts: NOW_MS, kind: 'text' },
      isGroup: false,
      pushName: null,
    });
  });

  it('uses the participant as sender in groups', () => {
    const parsed = parseBaileysMessage({
      key: { remoteJid: GROUP, fromMe: false, id: 'g1', participant: ANN_LID, participantAlt: ANN },
      message: { conversation: 'hey all' },
      pushName: 'Ann',
      messageTimestamp: NOW_S,
    });
    expect(parsed?.message).toMatchObject({ chatId: GROUP, senderJid: ANN, senderName: 'Ann' });
    expect(parsed?.isGroup).toBe(true);
  });

  it('canonicalizes a LID chat to the phone-number JID', () => {
    const parsed = parseBaileysMessage({
      key: { remoteJid: ANN_LID, remoteJidAlt: ANN, fromMe: false, id: 'l1' },
      message: { conversation: 'via lid' },
      messageTimestamp: NOW_S,
    });
    expect(parsed?.message.chatId).toBe(ANN);
    expect(parsed?.message.senderJid).toBe(ANN);
  });

  it('skips status broadcasts, protocol messages, missing ids and missing timestamps', () => {
    expect(parseBaileysMessage({ key: { remoteJid: 'status@broadcast', id: 's' }, message: { conversation: 'story' }, messageTimestamp: NOW_S })).toBeNull();
    expect(parseBaileysMessage({ key: { remoteJid: ANN, id: 'p' }, message: { protocolMessage: {} }, messageTimestamp: NOW_S })).toBeNull();
    expect(parseBaileysMessage({ key: { remoteJid: ANN }, message: { conversation: 'x' }, messageTimestamp: NOW_S })).toBeNull();
    expect(parseBaileysMessage({ key: { remoteJid: ANN, id: 'n' }, message: { conversation: 'x' } })).toBeNull();
    expect(parseBaileysMessage(null)).toBeNull();
  });
});

describe('chat name sources', () => {
  it('contacts: address-book name outranks notify/verifiedName', () => {
    expect(chatFromContact({ id: ANN, name: 'Ann Smith', notify: 'annie' })).toEqual({ id: ANN, name: 'Ann Smith', nameRank: 3 });
    expect(chatFromContact({ id: ANN, notify: 'annie' })).toEqual({ id: ANN, name: 'annie', nameRank: 1 });
    expect(chatFromContact({ id: ANN_LID, phoneNumber: ANN, verifiedName: 'Ann Co' })).toEqual({ id: ANN, name: 'Ann Co', nameRank: 1 });
    expect(chatFromContact({ id: ANN })).toBeNull();
    expect(chatFromContact({})).toBeNull();
  });

  it('chats and groups', () => {
    expect(chatFromChat({ id: GROUP, name: 'Family', conversationTimestamp: NOW_S })).toEqual({
      id: GROUP, name: 'Family', nameRank: 2, isGroup: true, lastMessageAt: NOW_MS,
    });
    expect(chatFromChat({ id: 'status@broadcast' })).toBeNull();
    expect(chatFromGroup({ id: GROUP, subject: 'Family' })).toEqual({ id: GROUP, name: 'Family', nameRank: 2, isGroup: true });
    expect(chatFromGroup({ subject: 'x' })).toBeNull();
  });
});

describe('WhatsAppInboxCapture', () => {
  let store: WhatsAppInboxStore;
  let capture: WhatsAppInboxCapture;
  let fetchGroupSubject: jest.Mock;

  beforeEach(() => {
    store = new WhatsAppInboxStore(IN_MEMORY_DB);
    fetchGroupSubject = jest.fn().mockResolvedValue('Fetched Group');
    capture = new WhatsAppInboxCapture(store, { getOwnJid: () => OWN, fetchGroupSubject, now: () => NOW_MS });
  });

  afterEach(() => store.close());

  it('stores inbound, fromMe, group and media messages from messages.upsert', () => {
    const n = capture.onMessagesUpsert({
      type: 'notify',
      messages: [
        { key: { remoteJid: ANN, fromMe: false, id: 'm1' }, message: { conversation: 'hi' }, pushName: 'Annie', messageTimestamp: NOW_S - 3 },
        { key: { remoteJid: ANN, fromMe: true, id: 'm2' }, message: { conversation: 'hello' }, messageTimestamp: NOW_S - 2 },
        { key: { remoteJid: GROUP, fromMe: false, id: 'm3', participant: ANN }, message: { stickerMessage: {} }, messageTimestamp: NOW_S - 1 },
        { key: { remoteJid: ANN, fromMe: false, id: 'm4' }, message: { audioMessage: {} }, messageTimestamp: NOW_S },
        { key: { remoteJid: ANN, id: 'r1' }, message: { reactionMessage: { text: '❤' } }, messageTimestamp: NOW_S },
      ],
    });
    expect(n).toBe(4);
    expect(store.listMessages(ANN, { limit: 10 }).map((m) => [m.id, m.kind, m.fromMe])).toEqual([
      ['m1', 'text', false],
      ['m2', 'text', true],
      ['m4', 'audio', false],
    ]);
    expect(store.listMessages(GROUP, { limit: 10 })[0].kind).toBe('sticker');
    expect(store.getChat(ANN)?.name).toBe('Annie');
  });

  it('is idempotent on re-delivery', () => {
    const upsert = { type: 'notify', messages: [{ key: { remoteJid: ANN, id: 'm1' }, message: { conversation: 'hi' }, messageTimestamp: NOW_S }] };
    capture.onMessagesUpsert(upsert);
    capture.onMessagesUpsert(upsert);
    expect(store.listMessages(ANN, { limit: 10 })).toHaveLength(1);
  });

  it('fetches a group subject once when the group has no name', async () => {
    const m = (id: string) => ({ key: { remoteJid: GROUP, id, participant: ANN }, message: { conversation: id }, messageTimestamp: NOW_S });
    capture.onMessagesUpsert({ messages: [m('g1'), m('g2')] });
    await new Promise((r) => setImmediate(r));
    expect(fetchGroupSubject).toHaveBeenCalledTimes(1);
    expect(store.getChat(GROUP)?.name).toBe('Fetched Group');
  });

  it('does not fetch a subject for a group that already has a name, and survives fetch errors', async () => {
    store.upsertChat({ id: GROUP, name: 'Known', nameRank: 2 });
    capture.captureMessage({ key: { remoteJid: GROUP, id: 'g1' }, message: { conversation: 'x' }, messageTimestamp: NOW_S });
    expect(fetchGroupSubject).not.toHaveBeenCalled();

    const other = '120363000000000002@g.us';
    fetchGroupSubject.mockRejectedValueOnce(new Error('offline'));
    capture.captureMessage({ key: { remoteJid: other, id: 'g2' }, message: { conversation: 'x' }, messageTimestamp: NOW_S });
    await new Promise((r) => setImmediate(r));
    expect(store.getChat(other)?.name).toBeNull();
  });

  it('seeds history: chats, contact names, recent messages only', () => {
    const n = capture.onHistorySet({
      chats: [{ id: GROUP, name: 'Family', conversationTimestamp: NOW_S }, { id: 'status@broadcast' }],
      contacts: [{ id: ANN, name: 'Ann Smith' }, { id: 'x' }],
      messages: [
        { key: { remoteJid: ANN, id: 'h1' }, message: { conversation: 'recent' }, pushName: 'annie', messageTimestamp: NOW_S - 86400 },
        { key: { remoteJid: ANN, id: 'h2', fromMe: true }, message: { conversation: 'mine' }, messageTimestamp: NOW_S - 86000 },
        { key: { remoteJid: ANN, id: 'h-old' }, message: { conversation: 'ancient' }, messageTimestamp: NOW_S - 100 * 86400 },
        { key: { remoteJid: GROUP, id: 'h3', participant: ANN }, message: { imageMessage: { caption: 'pic' } }, messageTimestamp: { low: NOW_S - 50, high: 0 } },
      ],
      syncType: 3,
    });
    expect(n).toBe(3);
    expect(store.getChat(ANN)?.name).toBe('Ann Smith'); // contact name not overwritten by pushName
    expect(store.getChat(GROUP)?.name).toBe('Family');
    expect(store.getChat('status@broadcast')).toBeNull();
    expect(store.listMessages(ANN, { limit: 10 }).map((m) => m.id)).toEqual(['h1', 'h2']);
    expect(store.listMessages(GROUP, { limit: 10 })[0]).toMatchObject({ kind: 'image', text: 'pic' });
  });

  it('names a chat from a history pushName when nothing better is known', () => {
    capture.onHistorySet({
      messages: [{ key: { remoteJid: ANN, id: 'h1' }, message: { conversation: 'x' }, pushName: 'annie', messageTimestamp: NOW_S }],
    });
    expect(store.getChat(ANN)?.name).toBe('annie');
  });

  it('handles contacts, chats and groups events and ignores non-arrays', () => {
    capture.onContacts([{ id: ANN, notify: 'annie' }, { id: ANN, name: 'Ann Smith' }]);
    capture.onChats([{ id: GROUP, name: 'Fam' }]);
    capture.onGroups([{ id: GROUP, subject: 'Family' }]);
    capture.onContacts(null);
    capture.onChats('x');
    capture.onGroups(undefined);
    expect(capture.onMessagesUpsert(null)).toBe(0);
    expect(capture.onHistorySet(null)).toBe(0);
    expect(store.getChat(ANN)?.name).toBe('Ann Smith');
    expect(store.getChat(GROUP)?.name).toBe('Family');
  });
});
