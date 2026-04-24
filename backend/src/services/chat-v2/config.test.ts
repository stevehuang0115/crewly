/**
 * Tests for chat-v2 config loader.
 *
 * @module services/chat-v2/config.test
 */

import * as os from 'os';
import * as path from 'path';
import {
  CHAT_V2_DEFAULTS,
  expandHomePath,
  loadChatV2Config,
  parseBoolean,
  parsePositiveInt,
} from './config.js';

describe('chat-v2/config', () => {
  describe('expandHomePath', () => {
    it('expands "~" to homedir', () => {
      expect(expandHomePath('~')).toBe(os.homedir());
    });

    it('expands "~/..." to joined homedir path', () => {
      expect(expandHomePath('~/.crewly/chat.db')).toBe(
        path.join(os.homedir(), '.crewly/chat.db'),
      );
    });

    it('leaves absolute paths untouched', () => {
      expect(expandHomePath('/tmp/foo')).toBe('/tmp/foo');
    });
  });

  describe('parsePositiveInt', () => {
    it('returns fallback for undefined / empty', () => {
      expect(parsePositiveInt(undefined, 42)).toBe(42);
      expect(parsePositiveInt('', 42)).toBe(42);
    });

    it('parses valid positive integers', () => {
      expect(parsePositiveInt('7', 42)).toBe(7);
    });

    it('rejects non-positive and non-numeric values', () => {
      expect(parsePositiveInt('0', 42)).toBe(42);
      expect(parsePositiveInt('-3', 42)).toBe(42);
      expect(parsePositiveInt('abc', 42)).toBe(42);
    });
  });

  describe('parseBoolean', () => {
    it.each([
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['false', false],
      ['FALSE', false],
      ['0', false],
    ])('parses %s → %s', (raw, expected) => {
      expect(parseBoolean(raw, !expected)).toBe(expected);
    });

    it('uses fallback for undefined', () => {
      expect(parseBoolean(undefined, true)).toBe(true);
      expect(parseBoolean(undefined, false)).toBe(false);
    });

    it('uses fallback for unrecognized input', () => {
      expect(parseBoolean('yes', false)).toBe(false);
      expect(parseBoolean('nope', true)).toBe(true);
    });
  });

  describe('loadChatV2Config', () => {
    it('returns defaults with paths expanded when env is empty', () => {
      const cfg = loadChatV2Config({});
      expect(cfg.enabled).toBe(CHAT_V2_DEFAULTS.enabled);
      expect(cfg.maxMessageBytes).toBe(CHAT_V2_DEFAULTS.maxMessageBytes);
      expect(cfg.storage.dbPath).toContain(path.join(os.homedir(), '.crewly'));
      expect(cfg.storage.dbPath.endsWith('chat.db')).toBe(true);
    });

    it('rebases storage paths under CREWLY_HOME when set', () => {
      const cfg = loadChatV2Config({ CREWLY_HOME: '/tmp/crewly-test' });
      expect(cfg.storage.dbPath).toBe('/tmp/crewly-test/chat.db');
      expect(cfg.storage.attachmentsDir).toBe('/tmp/crewly-test/chat-attachments');
      expect(cfg.storage.uploadsStagingDir).toBe('/tmp/crewly-test/chat-uploads-staging');
    });

    it('honors explicit CREWLY_CHAT_DB_PATH over CREWLY_HOME', () => {
      const cfg = loadChatV2Config({
        CREWLY_HOME: '/tmp/crewly-test',
        CREWLY_CHAT_DB_PATH: '/var/data/chat.sqlite',
      });
      expect(cfg.storage.dbPath).toBe('/var/data/chat.sqlite');
      expect(cfg.storage.attachmentsDir).toBe('/tmp/crewly-test/chat-attachments');
    });

    it('overrides scalar values from env', () => {
      const cfg = loadChatV2Config({
        CREWLY_CHAT_MAX_MESSAGE_BYTES: '4096',
        CREWLY_CHAT_WS_HEARTBEAT_MS: '15000',
        CREWLY_CHAT_ENABLED: 'false',
      });
      expect(cfg.maxMessageBytes).toBe(4096);
      expect(cfg.websocket.heartbeatIntervalMs).toBe(15000);
      expect(cfg.enabled).toBe(false);
    });

    it('falls back to defaults on invalid numeric env overrides', () => {
      const cfg = loadChatV2Config({
        CREWLY_CHAT_MAX_MESSAGE_BYTES: 'not-a-number',
      });
      expect(cfg.maxMessageBytes).toBe(CHAT_V2_DEFAULTS.maxMessageBytes);
    });

    it('produces an immutable config object', () => {
      const cfg = loadChatV2Config({});
      expect(Object.isFrozen(cfg)).toBe(true);
      expect(Object.isFrozen(cfg.websocket)).toBe(true);
    });
  });
});
