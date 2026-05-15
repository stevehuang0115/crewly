// Updated: 2026-04-13T15:54:17Z - request title summarization + dangling fix
/**
 * Chat Controller Tests
 *
 * Integration tests for chat API endpoints.
 *
 * @module controllers/chat/chat.controller.test
 */

// Mock node-pty before any imports to prevent native binary load failure
jest.mock('node-pty', () => ({
  spawn: jest.fn(),
}));

// Phase 6c migration note — chat.controller still calls the legacy
// ChatService façade (14 sites). The façade now delegates to chat-v2
// under the hood, so existing fixtures continue to work without
// modification. Full call-site migration is tracked as a follow-up
// cleanup PR; no architectural invariant depends on it.

import express, { Application } from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createChatRouter } from './chat.routes.js';
import { getChatService, resetChatService, ChatService } from '../../services/chat/chat.service.js';
import { setMessageQueueService } from './chat.controller.js';

// =============================================================================
// Test Setup
// =============================================================================

describe('Chat Controller', () => {
  let app: Application;
  let testDir: string;
  let chatService: ChatService;

  beforeEach(async () => {
    // Create test directory
    testDir = path.join(
      os.tmpdir(),
      `chat-controller-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(testDir, { recursive: true });

    // Reset and initialize chat service with test directory
    resetChatService();
    chatService = getChatService();
    (chatService as any).chatDir = testDir;
    await chatService.initialize();

    // Create Express app with chat routes
    app = express();
    app.use(express.json());
    app.use('/api/chat', createChatRouter());

    // Error handler
    app.use((err: any, req: any, res: any, next: any) => {
      res.status(500).json({
        success: false,
        error: err.message,
      });
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    resetChatService();
  });

  // ===========================================================================
  // POST /api/chat/send
  // ===========================================================================

  describe('POST /api/chat/send', () => {
    it('should send a message and return result', async () => {
      const response = await request(app)
        .post('/api/chat/send')
        .send({ content: 'Hello!' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.message.content).toBe('Hello!');
      expect(response.body.data.message.from.type).toBe('user');
      expect(response.body.data.conversation).toBeDefined();
      expect(response.body.data.conversation.id).toBeDefined();
    });

    it('should return 400 for missing content', async () => {
      const response = await request(app).post('/api/chat/send').send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('content');
    });

    it('should return 400 for empty content', async () => {
      const response = await request(app)
        .post('/api/chat/send')
        .send({ content: '' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 for whitespace-only content', async () => {
      const response = await request(app)
        .post('/api/chat/send')
        .send({ content: '   ' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should use existing conversation if specified', async () => {
      // Create a conversation first
      const createResponse = await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Test Conversation' });

      const conversationId = createResponse.body.data.id;

      const response = await request(app)
        .post('/api/chat/send')
        .send({ content: 'Hello!', conversationId });

      expect(response.status).toBe(201);
      expect(response.body.data.conversation.id).toBe(conversationId);
    });

    it('should include metadata in message', async () => {
      const response = await request(app)
        .post('/api/chat/send')
        .send({
          content: 'Hello!',
          metadata: { source: 'test', priority: 'high' },
        });

      expect(response.status).toBe(201);
      expect(response.body.data.message.metadata.source).toBe('test');
      expect(response.body.data.message.metadata.priority).toBe('high');
    });
  });

  // ===========================================================================
  // GET /api/chat/messages
  // ===========================================================================

  describe('GET /api/chat/messages', () => {
    it('should return messages for a conversation', async () => {
      // Send some messages first
      const sendResponse = await request(app)
        .post('/api/chat/send')
        .send({ content: 'Test message' });

      const conversationId = sendResponse.body.data.conversation.id;

      const response = await request(app)
        .get('/api/chat/messages')
        .query({ conversationId });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBe(1);
      expect(response.body.count).toBe(1);
    });

    it('should return 400 without conversationId', async () => {
      const response = await request(app).get('/api/chat/messages');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('conversationId');
    });

    it('should filter by senderType', async () => {
      const sendResponse = await request(app)
        .post('/api/chat/send')
        .send({ content: 'User message' });

      const conversationId = sendResponse.body.data.conversation.id;

      // Add an agent message via service
      await chatService.addAgentMessage(
        conversationId,
        'Agent response',
        { type: 'orchestrator' }
      );

      const response = await request(app)
        .get('/api/chat/messages')
        .query({ conversationId, senderType: 'user' });

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(1);
      expect(response.body.data[0].from.type).toBe('user');
    });

    it('should apply pagination', async () => {
      // Create conversation and send multiple messages
      const conv = await chatService.createNewConversation();
      for (let i = 0; i < 5; i++) {
        await chatService.sendMessage({ content: `Message ${i}`, conversationId: conv.id });
      }

      const response = await request(app)
        .get('/api/chat/messages')
        .query({ conversationId: conv.id, limit: 2, offset: 1 });

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(2);
    });
  });

  // ===========================================================================
  // GET /api/chat/messages/:conversationId/:messageId
  // ===========================================================================

  describe('GET /api/chat/messages/:conversationId/:messageId', () => {
    it('should return message by ID', async () => {
      const sendResponse = await request(app)
        .post('/api/chat/send')
        .send({ content: 'Test' });

      const { conversationId, id: messageId } = sendResponse.body.data.message;

      const response = await request(app).get(
        `/api/chat/messages/${conversationId}/${messageId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(messageId);
    });

    it('should return 404 for non-existent message', async () => {
      const conv = await chatService.createNewConversation();

      const response = await request(app).get(
        `/api/chat/messages/${conv.id}/non-existent-message`
      );

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });
  });

  // ===========================================================================
  // GET /api/chat/conversations
  // ===========================================================================

  describe('GET /api/chat/conversations', () => {
    it('should return list of conversations', async () => {
      await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Conv 1' });

      await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Conv 2' });

      const response = await request(app).get('/api/chat/conversations');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.length).toBe(2);
      expect(response.body.count).toBe(2);
    });

    it('should exclude archived by default', async () => {
      const createResponse = await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Archived' });

      await request(app).put(
        `/api/chat/conversations/${createResponse.body.data.id}/archive`
      );

      const response = await request(app).get('/api/chat/conversations');

      expect(response.body.data.length).toBe(0);
    });

    it('should include archived when requested', async () => {
      const createResponse = await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Archived' });

      await request(app).put(
        `/api/chat/conversations/${createResponse.body.data.id}/archive`
      );

      const response = await request(app)
        .get('/api/chat/conversations')
        .query({ includeArchived: 'true' });

      expect(response.body.data.length).toBe(1);
    });

    it('should search by title', async () => {
      await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Project Discussion' });

      await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Bug Fixes' });

      const response = await request(app)
        .get('/api/chat/conversations')
        .query({ search: 'project' });

      expect(response.body.data.length).toBe(1);
      expect(response.body.data[0].title).toBe('Project Discussion');
    });
  });

  // ===========================================================================
  // GET /api/chat/conversations/current
  // ===========================================================================

  describe('GET /api/chat/conversations/current', () => {
    it('should return most recent conversation', async () => {
      await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Current' });

      const response = await request(app).get('/api/chat/conversations/current');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.isNew).toBe(false);
    });

    it('should create new conversation if none exists', async () => {
      const response = await request(app).get('/api/chat/conversations/current');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.isNew).toBe(true);
      expect(response.body.data.title).toBe('New Chat');
    });
  });

  // ===========================================================================
  // GET /api/chat/conversations/:id
  // ===========================================================================

  describe('GET /api/chat/conversations/:id', () => {
    it('should return conversation by ID', async () => {
      const createResponse = await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Test' });

      const response = await request(app).get(
        `/api/chat/conversations/${createResponse.body.data.id}`
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.title).toBe('Test');
    });

    it('should return 404 for non-existent ID', async () => {
      const response = await request(app).get(
        '/api/chat/conversations/non-existent-id'
      );

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });
  });

  // ===========================================================================
  // POST /api/chat/conversations
  // ===========================================================================

  describe('POST /api/chat/conversations', () => {
    it('should create a new conversation', async () => {
      const response = await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'New Conversation' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.title).toBe('New Conversation');
      expect(response.body.data.id).toBeDefined();
    });

    it('should create conversation without title', async () => {
      const response = await request(app).post('/api/chat/conversations').send({});

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBeDefined();
    });
  });

  // ===========================================================================
  // PUT /api/chat/conversations/:id
  // ===========================================================================

  describe('PUT /api/chat/conversations/:id', () => {
    it('should update conversation title', async () => {
      const createResponse = await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Original' });

      const response = await request(app)
        .put(`/api/chat/conversations/${createResponse.body.data.id}`)
        .send({ title: 'Updated' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.title).toBe('Updated');
    });

    it('should return 400 for missing title', async () => {
      const createResponse = await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Test' });

      const response = await request(app)
        .put(`/api/chat/conversations/${createResponse.body.data.id}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 404 for non-existent conversation', async () => {
      const response = await request(app)
        .put('/api/chat/conversations/non-existent')
        .send({ title: 'Updated' });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });
  });

  // ===========================================================================
  // PUT /api/chat/conversations/:id/archive
  // ===========================================================================

  describe('PUT /api/chat/conversations/:id/archive', () => {
    it('should archive a conversation', async () => {
      const createResponse = await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'To Archive' });

      const response = await request(app).put(
        `/api/chat/conversations/${createResponse.body.data.id}/archive`
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify archived
      const getResponse = await request(app)
        .get('/api/chat/conversations')
        .query({ includeArchived: 'true' });

      const archived = getResponse.body.data.find(
        (c: any) => c.id === createResponse.body.data.id
      );
      expect(archived.isArchived).toBe(true);
    });

    it('should return 404 for non-existent conversation', async () => {
      const response = await request(app).put(
        '/api/chat/conversations/non-existent/archive'
      );

      expect(response.status).toBe(404);
    });
  });

  // ===========================================================================
  // PUT /api/chat/conversations/:id/unarchive
  // ===========================================================================

  describe('PUT /api/chat/conversations/:id/unarchive', () => {
    it('should unarchive a conversation', async () => {
      const createResponse = await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Archived' });

      await request(app).put(
        `/api/chat/conversations/${createResponse.body.data.id}/archive`
      );

      const response = await request(app).put(
        `/api/chat/conversations/${createResponse.body.data.id}/unarchive`
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify unarchived
      const getResponse = await request(app).get('/api/chat/conversations');

      const conv = getResponse.body.data.find(
        (c: any) => c.id === createResponse.body.data.id
      );
      expect(conv.isArchived).toBe(false);
    });

    it('should return 404 for non-existent conversation', async () => {
      const response = await request(app).put(
        '/api/chat/conversations/non-existent/unarchive'
      );

      expect(response.status).toBe(404);
    });
  });

  // ===========================================================================
  // DELETE /api/chat/conversations/:id
  // ===========================================================================

  describe('DELETE /api/chat/conversations/:id', () => {
    it('should delete a conversation', async () => {
      const createResponse = await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'To Delete' });

      const response = await request(app).delete(
        `/api/chat/conversations/${createResponse.body.data.id}`
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify deleted
      const getResponse = await request(app).get(
        `/api/chat/conversations/${createResponse.body.data.id}`
      );

      expect(getResponse.status).toBe(404);
    });

    it('should succeed even for non-existent conversation', async () => {
      const response = await request(app).delete(
        '/api/chat/conversations/non-existent'
      );

      expect(response.status).toBe(200);
    });
  });

  // ===========================================================================
  // POST /api/chat/conversations/:id/clear
  // ===========================================================================

  describe('POST /api/chat/conversations/:id/clear', () => {
    it('should clear messages in a conversation', async () => {
      const sendResponse = await request(app)
        .post('/api/chat/send')
        .send({ content: 'Message to clear' });

      const conversationId = sendResponse.body.data.conversation.id;

      const response = await request(app).post(
        `/api/chat/conversations/${conversationId}/clear`
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify messages cleared
      const messagesResponse = await request(app)
        .get('/api/chat/messages')
        .query({ conversationId });

      expect(messagesResponse.body.data.length).toBe(0);
    });
  });

  // ===========================================================================
  // GET /api/chat/statistics
  // ===========================================================================

  describe('GET /api/chat/statistics', () => {
    it('should return chat statistics', async () => {
      // Create some data
      await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Active' });

      const archivedResponse = await request(app)
        .post('/api/chat/conversations')
        .send({ title: 'Archived' });

      await request(app).put(
        `/api/chat/conversations/${archivedResponse.body.data.id}/archive`
      );

      const sendResponse = await request(app)
        .post('/api/chat/send')
        .send({ content: 'Test message' });

      const response = await request(app).get('/api/chat/statistics');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.totalConversations).toBe(3); // 2 created + 1 from send
      expect(response.body.data.archivedConversations).toBe(1);
      expect(response.body.data.totalMessages).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // POST /api/chat/agent-response
  // ===========================================================================

  describe('POST /api/chat/agent-response', () => {
    it('should route agent response and return 201', async () => {
      const response = await request(app)
        .post('/api/chat/agent-response')
        .send({
          content: 'Task completed successfully',
          senderName: 'test-agent',
          senderType: 'agent',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      // Agent messages are routed to orchestrator (not saved to chat),
      // so messageId is undefined
      expect(response.body.data.conversationId).toBeDefined();
    });

    it('should return 400 for missing content', async () => {
      const response = await request(app)
        .post('/api/chat/agent-response')
        .send({ senderName: 'test-agent' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Message content is required');
    });

    it('should return 400 for missing senderName', async () => {
      const response = await request(app)
        .post('/api/chat/agent-response')
        .send({ content: 'Hello' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('senderName is required');
    });

    it('should enqueue [DONE] status to MessageQueueService', async () => {
      const mockEnqueue = jest.fn().mockReturnValue({ id: 'q1' });
      setMessageQueueService({ enqueue: mockEnqueue } as any);

      const response = await request(app)
        .post('/api/chat/agent-response')
        .send({
          content: '[DONE] Agent test-agent: Finished implementing feature',
          senderName: 'test-agent',
          senderType: 'agent',
        });

      expect(response.status).toBe(201);
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Agent status:'),
          source: 'system_event',
        })
      );

      // Cleanup
      setMessageQueueService(null as any);
    });

    it('should enqueue [IDLE] status to MessageQueueService', async () => {
      const mockEnqueue = jest.fn().mockReturnValue({ id: 'q2' });
      setMessageQueueService({ enqueue: mockEnqueue } as any);

      const response = await request(app)
        .post('/api/chat/agent-response')
        .send({
          content: '[IDLE] Agent test-agent: Ready for next task',
          senderName: 'test-agent',
          senderType: 'agent',
        });

      expect(response.status).toBe(201);
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('[IDLE]'),
          source: 'system_event',
        })
      );

      setMessageQueueService(null as any);
    });

    it('should enqueue structured [STATUS REPORT] to MessageQueueService', async () => {
      const mockEnqueue = jest.fn().mockReturnValue({ id: 'q3' });
      setMessageQueueService({ enqueue: mockEnqueue } as any);

      const response = await request(app)
        .post('/api/chat/agent-response')
        .send({
          content: '---\n[STATUS REPORT]\nTask ID: task-1\nState: completed\n---\n\nDone.',
          senderName: 'test-agent',
          senderType: 'agent',
        });

      expect(response.status).toBe(201);
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'system_event',
        })
      );

      setMessageQueueService(null as any);
    });

    it('should enqueue all agent messages as system events', async () => {
      const mockEnqueue = jest.fn().mockReturnValue({ id: 'q4' });
      setMessageQueueService({ enqueue: mockEnqueue } as any);

      const response = await request(app)
        .post('/api/chat/agent-response')
        .send({
          content: 'Working on the feature now...',
          senderName: 'test-agent',
          senderType: 'agent',
        });

      expect(response.status).toBe(201);
      // All agent messages are now forwarded to orchestrator queue
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'system_event',
        })
      );

      setMessageQueueService(null as any);
    });

    it('should not enqueue for orchestrator messages', async () => {
      const mockEnqueue = jest.fn().mockReturnValue({ id: 'q5' });
      setMessageQueueService({ enqueue: mockEnqueue } as any);

      const response = await request(app)
        .post('/api/chat/agent-response')
        .send({
          content: '[DONE] Agent orc: Task complete',
          senderName: 'orc',
          senderType: 'orchestrator',
        });

      expect(response.status).toBe(201);
      // orchestrator messages should not trigger agent status notification
      expect(mockEnqueue).not.toHaveBeenCalled();

      setMessageQueueService(null as any);
    });
  });

  // ---------------------------------------------------------------------
  // P2-2 regression: chat.controller no longer writes to RequestTracker.
  // The companion read in v3-data.service was removed in this PR; the
  // write path here is now dead code and was deleted to prevent dead-code
  // rot. This test pins that no-write contract by inspecting the source
  // text — a static guard that fires the moment someone re-introduces
  // setActiveRequest in this controller.
  // ---------------------------------------------------------------------
  describe('P2-2: RequestTracker write removal', () => {
    it('chat.controller source must not call RequestTracker.setActiveRequest', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, 'chat.controller.ts'),
        'utf-8',
      );
      expect(src).not.toMatch(/RequestTracker\.getInstance\(\)\.setActiveRequest/);
    });
  });
});
