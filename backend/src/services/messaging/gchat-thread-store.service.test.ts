/**
 * Tests for GoogleChatThreadStoreService
 *
 * @module services/messaging/gchat-thread-store.service.test
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  GoogleChatThreadStoreService,
  getGchatThreadStore,
  setGchatThreadStore,
  resetGchatThreadStore,
} from './gchat-thread-store.service.js';
import { GCHAT_THREAD_CONSTANTS } from '../../constants.js';

describe('GoogleChatThreadStoreService', () => {
  let store: GoogleChatThreadStoreService;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gchat-thread-test-'));
    store = new GoogleChatThreadStoreService(tmpDir);
  });

  afterEach(async () => {
    resetGchatThreadStore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getThreadFilePath', () => {
    it('should compute correct file path with sanitized names', () => {
      const result = store.getThreadFilePath('spaces/ABC123', 'spaces/ABC123/threads/XYZ');
      const expected = path.join(
        tmpDir,
        GCHAT_THREAD_CONSTANTS.STORAGE_DIR,
        'spaces_ABC123',
        `spaces_ABC123_threads_XYZ${GCHAT_THREAD_CONSTANTS.FILE_EXTENSION}`
      );
      expect(result).toBe(expected);
    });

    it('should handle different space/thread combinations', () => {
      const path1 = store.getThreadFilePath('spaces/AAA', 'spaces/AAA/threads/111');
      const path2 = store.getThreadFilePath('spaces/BBB', 'spaces/BBB/threads/222');
      expect(path1).not.toBe(path2);
    });

    it('should sanitize path traversal sequences', () => {
      const result = store.getThreadFilePath('spaces/../etc', 'spaces/../etc/threads/passwd');
      expect(result).not.toContain('..');
    });
  });

  describe('ensureThreadFile', () => {
    it('should create thread file with frontmatter', async () => {
      const filePath = await store.ensureThreadFile(
        'spaces/ABC123',
        'spaces/ABC123/threads/XYZ',
        'Steve'
      );

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('---');
      expect(content).toContain('space: spaces/ABC123');
      expect(content).toContain('thread: spaces/ABC123/threads/XYZ');
      expect(content).toContain('user: Steve');
      expect(content).toContain('## Messages');
    });

    it('should not overwrite existing file', async () => {
      const filePath = await store.ensureThreadFile(
        'spaces/ABC123',
        'spaces/ABC123/threads/XYZ',
        'Steve'
      );

      await fs.appendFile(filePath, 'extra content\n', 'utf-8');
      await store.ensureThreadFile('spaces/ABC123', 'spaces/ABC123/threads/XYZ', 'Steve');

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('extra content');
    });

    it('should create nested directories', async () => {
      const filePath = await store.ensureThreadFile(
        'spaces/NEW',
        'spaces/NEW/threads/999',
        'Alice'
      );
      const dir = path.dirname(filePath);

      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('appendUserMessage', () => {
    it('should append user message to thread file', async () => {
      await store.appendUserMessage(
        'spaces/ABC',
        'spaces/ABC/threads/XYZ',
        'Steve',
        'Hello from Google Chat'
      );

      const filePath = store.getThreadFilePath('spaces/ABC', 'spaces/ABC/threads/XYZ');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('**Steve**');
      expect(content).toContain('Hello from Google Chat');
    });

    it('should create thread file if it does not exist', async () => {
      await store.appendUserMessage(
        'spaces/NEW',
        'spaces/NEW/threads/111',
        'Bob',
        'First message'
      );

      const filePath = store.getThreadFilePath('spaces/NEW', 'spaces/NEW/threads/111');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('space: spaces/NEW');
      expect(content).toContain('**Bob**');
      expect(content).toContain('First message');
    });

    it('should append multiple messages', async () => {
      await store.appendUserMessage('spaces/ABC', 'spaces/ABC/threads/XYZ', 'Steve', 'Message 1');
      await store.appendUserMessage('spaces/ABC', 'spaces/ABC/threads/XYZ', 'Alice', 'Message 2');

      const filePath = store.getThreadFilePath('spaces/ABC', 'spaces/ABC/threads/XYZ');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('Message 1');
      expect(content).toContain('Message 2');
      expect(content).toContain('**Steve**');
      expect(content).toContain('**Alice**');
    });
  });

  describe('appendBotReply', () => {
    it('should append bot reply to existing thread', async () => {
      await store.ensureThreadFile('spaces/ABC', 'spaces/ABC/threads/XYZ', 'Steve');
      await store.appendBotReply('spaces/ABC', 'spaces/ABC/threads/XYZ', 'I will handle that.');

      const filePath = store.getThreadFilePath('spaces/ABC', 'spaces/ABC/threads/XYZ');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('**Crewly**');
      expect(content).toContain('I will handle that.');
    });

    it('should skip silently if thread file does not exist', async () => {
      // Should not throw
      await store.appendBotReply('spaces/XXX', 'spaces/XXX/threads/000', 'No thread here');

      const filePath = store.getThreadFilePath('spaces/XXX', 'spaces/XXX/threads/000');
      await expect(fs.access(filePath)).rejects.toThrow();
    });
  });

  describe('getRecentMessages', () => {
    it('should return null for non-existent thread', async () => {
      const result = await store.getRecentMessages('spaces/NONE', 'spaces/NONE/threads/000', 10);
      expect(result).toBeNull();
    });

    it('should return null for empty thread (only frontmatter)', async () => {
      await store.ensureThreadFile('spaces/ABC', 'spaces/ABC/threads/XYZ', 'Steve');
      const result = await store.getRecentMessages('spaces/ABC', 'spaces/ABC/threads/XYZ', 10);
      expect(result).toBeNull();
    });

    it('should return recent messages', async () => {
      await store.appendUserMessage('spaces/ABC', 'spaces/ABC/threads/XYZ', 'Steve', 'How is Ella doing?');
      await store.appendBotReply('spaces/ABC', 'spaces/ABC/threads/XYZ', 'Ella is working on blog posts.');
      await store.appendUserMessage('spaces/ABC', 'spaces/ABC/threads/XYZ', 'Steve', 'Any updates?');

      const result = await store.getRecentMessages('spaces/ABC', 'spaces/ABC/threads/XYZ', 10);

      expect(result).not.toBeNull();
      expect(result).toContain('How is Ella doing?');
      expect(result).toContain('Ella is working on blog posts.');
      expect(result).toContain('Any updates?');
    });

    it('should limit messages to maxMessages', async () => {
      for (let i = 1; i <= 5; i++) {
        await store.appendUserMessage('spaces/ABC', 'spaces/ABC/threads/LIM', 'Steve', `Message ${i}`);
      }

      const result = await store.getRecentMessages('spaces/ABC', 'spaces/ABC/threads/LIM', 2);

      expect(result).not.toBeNull();
      expect(result).toContain('Message 4');
      expect(result).toContain('Message 5');
      expect(result).not.toContain('Message 1');
      expect(result).not.toContain('Message 2');
      expect(result).not.toContain('Message 3');
    });

    it('should include both user and bot messages', async () => {
      await store.appendUserMessage('spaces/ABC', 'spaces/ABC/threads/MIX', 'Steve', 'Hello');
      await store.appendBotReply('spaces/ABC', 'spaces/ABC/threads/MIX', 'Hi Steve!');

      const result = await store.getRecentMessages('spaces/ABC', 'spaces/ABC/threads/MIX', 10);

      expect(result).toContain('**Steve**');
      expect(result).toContain('**Crewly**');
    });
  });

  describe('singleton', () => {
    it('should start as null', () => {
      resetGchatThreadStore();
      expect(getGchatThreadStore()).toBeNull();
    });

    it('should set and get instance', () => {
      const inst = new GoogleChatThreadStoreService();
      setGchatThreadStore(inst);
      expect(getGchatThreadStore()).toBe(inst);
    });

    it('should reset instance', () => {
      setGchatThreadStore(new GoogleChatThreadStoreService());
      resetGchatThreadStore();
      expect(getGchatThreadStore()).toBeNull();
    });
  });
});
