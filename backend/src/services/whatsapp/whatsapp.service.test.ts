/**
 * Tests for WhatsApp Service
 *
 * @module services/whatsapp/whatsapp.service.test
 */

import {
  WhatsAppService,
  getWhatsAppService,
  resetWhatsAppService,
  stripDeviceFromJid,
} from './whatsapp.service.js';
import { WhatsAppInboxStore } from './whatsapp-inbox.store.js';

// Mock Baileys — use require('events') inside factory to avoid jest.mock hoisting issues
jest.mock('@whiskeysockets/baileys', () => {
  const { EventEmitter } = require('events');
  const ev = new EventEmitter();
  const saveCreds = jest.fn();
  const sock = {
    ev,
    sendMessage: jest.fn().mockResolvedValue({}),
    logout: jest.fn().mockResolvedValue(undefined),
    end: jest.fn(),
    user: { id: '1234567890:1@s.whatsapp.net', name: 'TestBot' },
  };
  const makeWASocket = jest.fn().mockReturnValue(sock);
  const useMultiFileAuthState = jest.fn().mockResolvedValue({
    state: { creds: {} },
    saveCreds,
  });

  return {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason: { loggedOut: 401 },
    _testRefs: { ev, sock, saveCreds, makeWASocket, useMultiFileAuthState },
  };
});

// Mock fs — include existsSync for LoggerService/ConfigService
jest.mock('fs', () => {
  const mkdir = jest.fn().mockResolvedValue(undefined);
  const stat = jest.fn().mockResolvedValue({ size: 1024 });
  const readFile = jest.fn().mockResolvedValue(Buffer.from('test'));
  // Spread the real module so better-sqlite3 (inbox-mode tests) can load;
  // only the calls this suite asserts on are replaced.
  return {
    ...jest.requireActual('fs'),
    existsSync: jest.fn().mockReturnValue(false),
    promises: {
      mkdir: (...args: unknown[]) => mkdir(...args),
      stat: (...args: unknown[]) => stat(...args),
      readFile: (...args: unknown[]) => readFile(...args),
    },
    createWriteStream: jest.fn(),
    _testRefs: { mkdir, stat, readFile },
  };
});

// Get test references after mocks are applied
const baileysMock = require('@whiskeysockets/baileys');
const mockEv = baileysMock._testRefs.ev;
const mockSock = baileysMock._testRefs.sock;
const mockMakeWASocket = baileysMock._testRefs.makeWASocket;
const mockUseMultiFileAuthState = baileysMock._testRefs.useMultiFileAuthState;

const fsMock = require('fs');
const mockMkdir = fsMock._testRefs.mkdir;
const mockStat = fsMock._testRefs.stat;

describe('WhatsAppService', () => {
  beforeEach(() => {
    resetWhatsAppService();
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Reset the event emitter listeners between tests
    mockEv.removeAllListeners();
  });

  afterEach(() => {
    resetWhatsAppService();
    jest.useRealTimers();
  });

  // --- Singleton ---

  describe('getWhatsAppService / resetWhatsAppService', () => {
    it('should return singleton instance', () => {
      expect(getWhatsAppService()).toBe(getWhatsAppService());
    });

    it('should return WhatsAppService instance', () => {
      expect(getWhatsAppService()).toBeInstanceOf(WhatsAppService);
    });

    it('should return new instance after reset', () => {
      const s1 = getWhatsAppService();
      resetWhatsAppService();
      expect(getWhatsAppService()).not.toBe(s1);
    });
  });

  // --- Initial state ---

  describe('initial state', () => {
    it('should report disconnected status', () => {
      const s = getWhatsAppService();
      expect(s.getStatus()).toEqual({
        connected: false, qrCode: null, phoneNumber: null,
        messagesSent: 0, messagesReceived: 0, mode: null,
      });
      expect(s.isConnected()).toBe(false);
      expect(s.getQRCode()).toBeNull();
    });
  });

  // --- initialize() ---

  describe('initialize', () => {
    it('should create auth directory and call Baileys', async () => {
      const service = getWhatsAppService();
      await service.initialize({});

      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining('whatsapp-auth'),
        { recursive: true },
      );
      expect(mockUseMultiFileAuthState).toHaveBeenCalled();
      expect(mockMakeWASocket).toHaveBeenCalledWith(
        expect.objectContaining({ printQRInTerminal: false }),
      );
    });

    it('should use custom authStatePath when provided', async () => {
      const service = getWhatsAppService();
      await service.initialize({ authStatePath: '/custom/path' });

      expect(mockMkdir).toHaveBeenCalledWith('/custom/path', { recursive: true });
      expect(mockUseMultiFileAuthState).toHaveBeenCalledWith('/custom/path');
    });

    // -- QR code flow --

    it('should emit qr event and store QR code on connection.update with qr', async () => {
      const service = getWhatsAppService();
      await service.initialize({});

      const qrHandler = jest.fn();
      service.on('qr', qrHandler);

      mockEv.emit('connection.update', { qr: 'test-qr-code' });

      expect(qrHandler).toHaveBeenCalledWith('test-qr-code');
      expect(service.getQRCode()).toBe('test-qr-code');
      expect(service.getStatus().qrCode).toBe('test-qr-code');
    });

    // -- Connection open --

    it('should set connected state on connection open', async () => {
      const service = getWhatsAppService();
      await service.initialize({});

      const connectedHandler = jest.fn();
      service.on('connected', connectedHandler);

      mockEv.emit('connection.update', { connection: 'open' });

      expect(service.isConnected()).toBe(true);
      expect(connectedHandler).toHaveBeenCalled();
      expect(service.getQRCode()).toBeNull();
    });

    it('should extract phone number from sock.user.id on open', async () => {
      const service = getWhatsAppService();
      await service.initialize({});
      mockEv.emit('connection.update', { connection: 'open' });

      expect(service.getStatus().phoneNumber).toBe('1234567890');
    });

    it('should fall back to config.phoneNumber when sock.user.id is absent', async () => {
      const service = getWhatsAppService();
      (mockSock as any).user = undefined;
      await service.initialize({ phoneNumber: '+9876543210' });
      mockEv.emit('connection.update', { connection: 'open' });

      expect(service.getStatus().phoneNumber).toBe('+9876543210');
      // Restore
      (mockSock as any).user = { id: '1234567890:1@s.whatsapp.net' };
    });

    it('should clear QR code on connection open', async () => {
      const service = getWhatsAppService();
      await service.initialize({});
      mockEv.emit('connection.update', { qr: 'some-qr' });
      expect(service.getQRCode()).toBe('some-qr');

      mockEv.emit('connection.update', { connection: 'open' });
      expect(service.getQRCode()).toBeNull();
    });

    // -- Connection close --

    it('should set disconnected and schedule reconnection on non-logout close', async () => {
      const service = getWhatsAppService();
      await service.initialize({});
      mockEv.emit('connection.update', { connection: 'open' });
      expect(service.isConnected()).toBe(true);

      mockEv.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 500 } } },
      });

      expect(service.isConnected()).toBe(false);
    });

    it('should emit disconnected with logged_out and not reconnect on 401', async () => {
      const service = getWhatsAppService();
      await service.initialize({});

      const disconnectedHandler = jest.fn();
      service.on('disconnected', disconnectedHandler);

      mockEv.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });

      expect(disconnectedHandler).toHaveBeenCalledWith('logged_out');
      expect(service.isConnected()).toBe(false);
    });

    // -- messages.upsert --

    it('should ignore upserts with type other than notify', async () => {
      const service = getWhatsAppService();
      await service.initialize({});
      mockEv.emit('connection.update', { connection: 'open' });

      const msgHandler = jest.fn();
      service.on('message', msgHandler);

      mockEv.emit('messages.upsert', { type: 'append', messages: [
        { key: { remoteJid: '123@s.whatsapp.net', id: 'm1' }, message: { conversation: 'hello' } },
      ] });

      expect(msgHandler).not.toHaveBeenCalled();
    });

    it('should emit message for valid notify upsert', async () => {
      const service = getWhatsAppService();
      await service.initialize({});

      const msgHandler = jest.fn();
      service.on('message', msgHandler);

      mockEv.emit('messages.upsert', {
        type: 'notify',
        messages: [{
          key: { remoteJid: '5551234@s.whatsapp.net', id: 'msg-1', fromMe: false },
          message: { conversation: 'hello world' },
          pushName: 'Alice',
          messageTimestamp: 1700000000,
        }],
      });

      expect(msgHandler).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'msg-1',
        chatId: '5551234@s.whatsapp.net',
        from: '5551234@s.whatsapp.net',
        text: 'hello world',
        isGroup: false,
        contactName: 'Alice',
        timestamp: 1700000000,
      }));
      expect(service.getStatus().messagesReceived).toBe(1);
    });

    it('should extract text from extendedTextMessage', async () => {
      const service = getWhatsAppService();
      await service.initialize({});

      const msgHandler = jest.fn();
      service.on('message', msgHandler);

      mockEv.emit('messages.upsert', {
        type: 'notify',
        messages: [{
          key: { remoteJid: '555@s.whatsapp.net', id: 'm2' },
          message: { extendedTextMessage: { text: 'quoted reply' } },
        }],
      });

      expect(msgHandler).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'quoted reply' }),
      );
    });

    it('should ignore own messages (fromMe)', async () => {
      const service = getWhatsAppService();
      await service.initialize({});

      const msgHandler = jest.fn();
      service.on('message', msgHandler);

      mockEv.emit('messages.upsert', {
        type: 'notify',
        messages: [{
          key: { remoteJid: '555@s.whatsapp.net', id: 'm3', fromMe: true },
          message: { conversation: 'self' },
        }],
      });

      expect(msgHandler).not.toHaveBeenCalled();
    });

    it('should ignore messages without text content', async () => {
      const service = getWhatsAppService();
      await service.initialize({});

      const msgHandler = jest.fn();
      service.on('message', msgHandler);

      mockEv.emit('messages.upsert', {
        type: 'notify',
        messages: [{
          key: { remoteJid: '555@s.whatsapp.net', id: 'm4' },
          message: { imageMessage: { url: 'http://...' } },
        }],
      });

      expect(msgHandler).not.toHaveBeenCalled();
    });

    it('should ignore messages without message content', async () => {
      const service = getWhatsAppService();
      await service.initialize({});

      const msgHandler = jest.fn();
      service.on('message', msgHandler);

      mockEv.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: '555@s.whatsapp.net', id: 'm5' } }],
      });

      expect(msgHandler).not.toHaveBeenCalled();
    });

    it('should detect group messages by @g.us suffix', async () => {
      const service = getWhatsAppService();
      await service.initialize({});

      const msgHandler = jest.fn();
      service.on('message', msgHandler);

      mockEv.emit('messages.upsert', {
        type: 'notify',
        messages: [{
          key: { remoteJid: '123456@g.us', id: 'm6' },
          message: { conversation: 'group msg' },
          pushName: 'Bob',
        }],
      });

      expect(msgHandler).toHaveBeenCalledWith(
        expect.objectContaining({ isGroup: true }),
      );
    });

    it('should filter messages from non-allowed contacts', async () => {
      const service = getWhatsAppService();
      await service.initialize({ allowedContacts: ['9999999'] });

      const msgHandler = jest.fn();
      service.on('message', msgHandler);

      mockEv.emit('messages.upsert', {
        type: 'notify',
        messages: [{
          key: { remoteJid: '1111111@s.whatsapp.net', id: 'm7' },
          message: { conversation: 'blocked' },
        }],
      });

      expect(msgHandler).not.toHaveBeenCalled();
    });

    it('should use JID prefix as contactName when pushName is absent', async () => {
      const service = getWhatsAppService();
      await service.initialize({});

      const msgHandler = jest.fn();
      service.on('message', msgHandler);

      mockEv.emit('messages.upsert', {
        type: 'notify',
        messages: [{
          key: { remoteJid: '5551234@s.whatsapp.net', id: 'm8' },
          message: { conversation: 'no push name' },
        }],
      });

      expect(msgHandler).toHaveBeenCalledWith(
        expect.objectContaining({ contactName: '5551234' }),
      );
    });
  });

  // --- sendMessage (connected) ---

  describe('sendMessage (connected)', () => {
    let service: WhatsAppService;

    beforeEach(async () => {
      service = getWhatsAppService();
      await service.initialize({});
      mockEv.emit('connection.update', { connection: 'open' });
    });

    it('should call sock.sendMessage with text', async () => {
      await service.sendMessage({ to: '123@s.whatsapp.net', text: 'hi' });
      expect((mockSock.sendMessage as jest.Mock)).toHaveBeenCalledWith(
        '123@s.whatsapp.net', { text: 'hi' },
      );
      expect(service.getStatus().messagesSent).toBe(1);
    });

    it('should throw for message exceeding MAX_MESSAGE_LENGTH', async () => {
      const longMsg = 'a'.repeat(4001);
      await expect(
        service.sendMessage({ to: '123@s.whatsapp.net', text: longMsg }),
      ).rejects.toThrow('Message exceeds maximum length');
    });

    it('should allow message exactly at MAX_MESSAGE_LENGTH', async () => {
      const exactMsg = 'a'.repeat(4000);
      await expect(
        service.sendMessage({ to: '123@s.whatsapp.net', text: exactMsg }),
      ).resolves.toBeUndefined();
    });
  });

  // --- sendFile (connected) ---

  describe('sendFile (connected)', () => {
    let service: WhatsAppService;

    beforeEach(async () => {
      service = getWhatsAppService();
      await service.initialize({});
      mockEv.emit('connection.update', { connection: 'open' });
    });

    it('should send document with buffer and filename', async () => {
      await service.sendFile('123@s.whatsapp.net', '/tmp/report.pdf', 'Report');
      expect((mockSock.sendMessage as jest.Mock)).toHaveBeenCalledWith(
        '123@s.whatsapp.net',
        expect.objectContaining({
          document: expect.any(Buffer),
          fileName: 'report.pdf',
          caption: 'Report',
        }),
      );
      expect(service.getStatus().messagesSent).toBe(1);
    });

    it('should use empty caption when not provided', async () => {
      await service.sendFile('123@s.whatsapp.net', '/tmp/file.txt');
      expect((mockSock.sendMessage as jest.Mock)).toHaveBeenCalledWith(
        '123@s.whatsapp.net',
        expect.objectContaining({ caption: '' }),
      );
    });

    it('should throw when file exceeds MAX_FILE_SIZE', async () => {
      mockStat.mockResolvedValueOnce({ size: 6 * 1024 * 1024 }); // 6 MB
      await expect(
        service.sendFile('123@s.whatsapp.net', '/tmp/big.zip'),
      ).rejects.toThrow('File too large');
    });
  });

  // --- disconnect (connected) ---

  describe('disconnect (when connected)', () => {
    it('should clean up and emit disconnected', async () => {
      const service = getWhatsAppService();
      await service.initialize({});
      mockEv.emit('connection.update', { connection: 'open' });

      const dcHandler = jest.fn();
      service.on('disconnected', dcHandler);

      await service.disconnect();

      expect((mockSock.end as jest.Mock)).toHaveBeenCalled();
      expect(service.isConnected()).toBe(false);
      expect(service.getQRCode()).toBeNull();
      expect(dcHandler).toHaveBeenCalledWith('manual');
    });

    it('should handle error from sock.end gracefully', async () => {
      const service = getWhatsAppService();
      await service.initialize({});
      mockEv.emit('connection.update', { connection: 'open' });

      (mockSock.end as jest.Mock).mockImplementation(() => { throw new Error('end failed'); });

      await expect(service.disconnect()).resolves.toBeUndefined();
      expect(service.isConnected()).toBe(false);
    });
  });

  // --- Inbox mode ---

  describe('inbox mode', () => {
    let store: WhatsAppInboxStore;
    const DM = '4915550001@s.whatsapp.net';
    const GROUP = '120363000000000001@g.us';
    const nowSec = () => Math.floor(Date.now() / 1000);

    beforeEach(() => {
      jest.useRealTimers();
      store = new WhatsAppInboxStore(':memory:');
    });

    afterEach(() => {
      store.close();
    });

    /**
     * Initialize the singleton in inbox mode against the in-memory store.
     *
     * @returns The service
     */
    async function startInbox(): Promise<WhatsAppService> {
      const service = getWhatsAppService();
      service.setInboxStore(store);
      await service.initialize({ mode: 'inbox' });
      return service;
    }

    it('reports inbox mode in status and passes inbox socket options', async () => {
      const service = await startInbox();
      expect(service.getMode()).toBe('inbox');
      expect(service.isInboxMode()).toBe(true);
      expect(service.getStatus().mode).toBe('inbox');
      const opts = mockMakeWASocket.mock.calls[0][0];
      expect(opts.markOnlineOnConnect).toBe(false);
      expect(opts.syncFullHistory).toBe(false);
      expect(opts.shouldSyncHistoryMessage({ syncType: 2 })).toBe(false); // FULL
      expect(opts.shouldSyncHistoryMessage({ syncType: 3 })).toBe(true); // RECENT
      expect(opts.shouldSyncHistoryMessage({ syncType: 0 })).toBe(true); // INITIAL_BOOTSTRAP
    });

    it('assistant mode (default) does not pass inbox socket options', async () => {
      const service = getWhatsAppService();
      await service.initialize({});
      expect(service.getMode()).toBe('assistant');
      expect(mockMakeWASocket.mock.calls[0][0].markOnlineOnConnect).toBeUndefined();
    });

    it('never emits "message" in inbox mode, and stores fromMe, group and media messages', async () => {
      const service = await startInbox();
      const onMessage = jest.fn();
      service.on('message', onMessage);

      mockEv.emit('messages.upsert', {
        type: 'notify',
        messages: [
          { key: { remoteJid: DM, fromMe: false, id: 'in1' }, message: { conversation: 'hi there' }, pushName: 'Ann', messageTimestamp: nowSec() - 30 },
          { key: { remoteJid: GROUP, fromMe: false, id: 'g1', participant: '4915550002@s.whatsapp.net' }, message: { conversation: 'group hi' }, pushName: 'Bob', messageTimestamp: nowSec() - 20 },
          { key: { remoteJid: DM, fromMe: false, id: 'img1' }, message: { imageMessage: { caption: 'look' } }, messageTimestamp: nowSec() - 10 },
        ],
      });
      mockEv.emit('messages.upsert', {
        type: 'append',
        messages: [{ key: { remoteJid: DM, fromMe: true, id: 'out1' }, message: { conversation: 'on my way' }, messageTimestamp: nowSec() }],
      });

      expect(onMessage).not.toHaveBeenCalled();
      const msgs = store.listMessages(DM, { limit: 10 });
      expect(msgs.map((m) => [m.id, m.kind, m.fromMe])).toEqual([
        ['in1', 'text', false],
        ['img1', 'image', false],
        ['out1', 'text', true],
      ]);
      expect(msgs[2].senderJid).toBe('1234567890@s.whatsapp.net');
      expect(store.listMessages(GROUP, { limit: 10 })[0].senderName).toBe('Bob');
      expect(store.getChat(DM)?.name).toBe('Ann');
      // Owner replied last → the DM no longer needs a reply.
      expect(store.listInbox({ limit: 10, includeGroups: true }).map((e) => e.chat.id)).toEqual([GROUP]);
      expect(service.getStatus().messagesReceived).toBe(4);
    });

    it('ignores the allowedContacts filter in inbox mode (it is the owner\'s own account)', async () => {
      const service = getWhatsAppService();
      service.setInboxStore(store);
      await service.initialize({ mode: 'inbox', allowedContacts: ['+1999'] });
      mockEv.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: DM, fromMe: false, id: 'x1' }, message: { conversation: 'hey' }, messageTimestamp: nowSec() }],
      });
      expect(store.listMessages(DM, { limit: 5 })).toHaveLength(1);
    });

    it('seeds recent history from messaging-history.set and names chats from contacts/chats/groups', async () => {
      await startInbox();
      mockEv.emit('messaging-history.set', {
        chats: [{ id: GROUP, name: 'Family', conversationTimestamp: nowSec() }],
        contacts: [{ id: DM, name: 'Ann Smith' }],
        messages: [
          { key: { remoteJid: DM, fromMe: false, id: 'h1' }, message: { conversation: 'old but recent' }, messageTimestamp: nowSec() - 3600 },
          { key: { remoteJid: DM, fromMe: false, id: 'h-ancient' }, message: { conversation: 'too old' }, messageTimestamp: nowSec() - 200 * 24 * 3600 },
        ],
        syncType: 3,
      });
      expect(store.listMessages(DM, { limit: 10 }).map((m) => m.id)).toEqual(['h1']);
      expect(store.getChat(DM)?.name).toBe('Ann Smith');
      expect(store.getChat(GROUP)?.name).toBe('Family');

      mockEv.emit('contacts.upsert', [{ id: '4915550003@s.whatsapp.net', notify: 'Cara' }]);
      mockEv.emit('groups.update', [{ id: GROUP, subject: 'Family 2' }]);
      mockEv.emit('chats.upsert', [{ id: '4915550004@s.whatsapp.net', name: 'Dan' }]);
      expect(store.getChat('4915550003@s.whatsapp.net')?.name).toBe('Cara');
      expect(store.getChat(GROUP)?.name).toBe('Family 2');
      expect(store.getChat('4915550004@s.whatsapp.net')?.name).toBe('Dan');
    });

    it('a malformed payload is logged, not thrown into the socket', async () => {
      await startInbox();
      expect(() => mockEv.emit('messaging-history.set', null)).not.toThrow();
      expect(() => mockEv.emit('messages.upsert', { messages: 'nope' })).not.toThrow();
    });

    it('records its own sent message so the chat reads as answered', async () => {
      const service = await startInbox();
      mockEv.emit('connection.update', { connection: 'open' });
      mockEv.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: DM, fromMe: false, id: 'q1' }, message: { conversation: 'ping?' }, messageTimestamp: nowSec() - 5 }],
      });
      (mockSock.sendMessage as jest.Mock).mockResolvedValueOnce({
        key: { remoteJid: DM, fromMe: true, id: 'sent1' },
        message: { conversation: 'pong' },
        messageTimestamp: nowSec(),
      });
      await service.sendMessage({ to: DM, text: 'pong' });
      expect(store.listInbox({ limit: 10 })).toEqual([]);
    });
  });

  describe('stripDeviceFromJid', () => {
    it('removes the :device part', () => {
      expect(stripDeviceFromJid('123:45@s.whatsapp.net')).toBe('123@s.whatsapp.net');
      expect(stripDeviceFromJid('123@s.whatsapp.net')).toBe('123@s.whatsapp.net');
    });
  });
});
