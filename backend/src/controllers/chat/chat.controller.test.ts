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

// Delivery enforcer is lazily imported by the agent-response handler; stub it
// so the #731 tests can assert exactly when a thread gets tracked.
const mockMarkPendingDelivery = jest.fn();
jest.mock('../../services/orc/orc-delivery-enforcer.service.js', () => ({
  OrcDeliveryEnforcerService: {
    getInstance: () => ({ markPendingDelivery: mockMarkPendingDelivery }),
  },
  // Same rule as the real helper: the orchestrator by session name or alias.
  isOrchestratorSender: (sender: string) =>
    ['crewly-orc', 'orchestrator', 'orc'].includes(String(sender ?? '').trim().toLowerCase()),
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
import { setMessageQueueService, clipForOrchestrator, sendChatMessageToOrchestrator, pickCompletionThreads } from './chat.controller.js';
import { getChatV2Service, resetChatV2Service } from '../../services/chat-v2/chat-v2.singleton.js';
import { openChatDatabase } from '../../services/chat-v2/sqlite/chat-db.js';
import { OrcStatusRouterService } from '../../services/orc/orc-status-router.service.js';
import { OrcWakeCounter } from '../../services/orc/orc-wake-counter.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { setTicketIntakeService, type TicketIntakeService } from '../../services/v3/ticket-intake.service.js';
import { ownerUnlessAgentForTests } from '../../middleware/caller-identity.testing.js';

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

    // The ChatService façade persists through the chat-v2 singleton, whose
    // default DB lives under CREWLY_HOME and is shared by every test in this
    // file. Give each test its own in-memory chat-v2 store so conversation
    // counts / lists don't leak between tests.
    resetChatService();
    resetChatV2Service();
    getChatV2Service({
      db: openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true }),
    });
    chatService = getChatService();
    (chatService as any).chatDir = testDir;
    await chatService.initialize();

    // Create Express app with chat routes
    app = express();
    app.use(ownerUnlessAgentForTests);
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
    resetChatV2Service();
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
      // Caller metadata is preserved, but `source` is the chat-v2 audit-trail
      // discriminator and is normalized to the closed enum: an unknown value
      // like 'test' is stored as 'system' (ChatService.sendMessage, Phase 6α #5).
      expect(response.body.data.message.metadata.source).toBe('system');
      expect(response.body.data.message.metadata.priority).toBe('high');
    });

    it('should keep a recognized metadata.source on the message', async () => {
      const response = await request(app)
        .post('/api/chat/send')
        .send({ content: 'Hello!', metadata: { source: 'web', priority: 'high' } });

      expect(response.status).toBe(201);
      expect(response.body.data.message.metadata.source).toBe('web');
      expect(response.body.data.message.metadata.priority).toBe('high');
    });

    // #730: this endpoint writes a `user` row, which the commitment gate reads
    // as the owner's words. An agent session calling it must not be able to
    // manufacture an owner approval.
    it('tags a message sent by an agent session so it is never owner approval', async () => {
      const marker = `go ahead agent-${Date.now()}`;
      const response = await request(app)
        .post('/api/chat/send')
        .set('X-Agent-Session', 'crewly-orc')
        .send({ content: marker, metadata: { source: 'web' } });

      expect(response.status).toBe(201);
      expect(response.body.data.message.metadata.authorAgentSession).toBe('crewly-orc');
      expect(getChatV2Service().getRecentOwnerMessageContents(0, 500)).not.toContain(marker);
    });

    it('still counts the owner\'s own message (no agent session) as owner evidence', async () => {
      const marker = `go ahead owner-${Date.now()}`;
      const response = await request(app).post('/api/chat/send').send({ content: marker });

      expect(response.status).toBe(201);
      expect(response.body.data.message.metadata?.authorAgentSession).toBeUndefined();
      expect(getChatV2Service().getRecentOwnerMessageContents(0, 500)).toContain(marker);
    });
  });

  // ===========================================================================
  // Ticket loop (specs/ticket-loop.md §2) — legacy chat goes through intake
  // ===========================================================================

  describe('POST /api/chat/send — ticket intake', () => {
    const TICKET = { id: '11111111-2222-3333-4444-555555555555', ticketNumber: 4 };
    let intake: { intakeWithOutcome: jest.Mock };
    let enqueue: jest.Mock;

    beforeEach(() => {
      intake = { intakeWithOutcome: jest.fn(async () => ({ action: 'created', ticket: TICKET })) };
      setTicketIntakeService(intake as unknown as TicketIntakeService);
      enqueue = jest.fn(() => ({ id: 'q-1' }));
      setMessageQueueService({ enqueue } as any);
    });

    afterEach(() => {
      setTicketIntakeService(null);
      setMessageQueueService(null as any);
    });

    it('the owner’s message is intake as the owner, assigned to the orc; the delivered copy carries the ticket line', async () => {
      const response = await request(app).post('/api/chat/send').send({ content: 'please add csv export to reports' });
      expect(response.status).toBe(201);
      const [msg] = intake.intakeWithOutcome.mock.calls[0];
      expect(msg).toMatchObject({ isOwner: true, targetAgent: 'crewly-orc', tags: ['chat-ui'], origin: { channel: 'chat', ref: response.body.data.message.id } });
      expect(enqueue.mock.calls[0][0].content).toContain('[TICKET:TKT-004');
      expect(enqueue.mock.calls[0][0].content.startsWith('please add csv export to reports')).toBe(true);
      // What is stored is the owner's text alone.
      expect(response.body.data.message.content).toBe('please add csv export to reports');
    });

    it('an agent posting through this endpoint is never the owner', async () => {
      await request(app).post('/api/chat/send').set('X-Agent-Session', 'dev-1').send({ content: 'please add csv export to reports' });
      expect(intake.intakeWithOutcome.mock.calls[0][0].isOwner).toBe(false);
    });

    it('no ticket → the message is delivered unchanged', async () => {
      intake.intakeWithOutcome.mockResolvedValueOnce({ action: 'ignored', reason: 'trivial_or_short' });
      await request(app).post('/api/chat/send').send({ content: 'thanks' });
      expect(enqueue.mock.calls[0][0].content).toBe('thanks');
    });
  });

  // ===========================================================================
  // sendChatMessageToOrchestrator — shared with the onboarding first task
  // ===========================================================================

  describe('sendChatMessageToOrchestrator', () => {
    let enqueue: jest.Mock;

    beforeEach(() => {
      setTicketIntakeService({ intakeWithOutcome: jest.fn(async () => ({ action: 'ignored', reason: 'test' })) } as unknown as TicketIntakeService);
      enqueue = jest.fn(() => ({ id: 'q-7' }));
      setMessageQueueService({ enqueue } as any);
    });

    afterEach(() => {
      setTicketIntakeService(null);
      setMessageQueueService(null as any);
    });

    it('stores the owner message and queues it for the orchestrator', async () => {
      const { result, orchestrator } = await sendChatMessageToOrchestrator({ content: 'Plan my week', metadata: { source: 'onboarding_first_task' } });
      expect(result.message.content).toBe('Plan my week');
      expect(result.message.from.type).toBe('user');
      expect(orchestrator.forwarded).toBe(true);
      expect(orchestrator.queueId).toBe('q-7');
      expect(enqueue.mock.calls[0][0]).toMatchObject({ content: 'Plan my week', conversationId: result.conversation.id, source: 'web_chat' });
    });

    it('does not forward when asked not to', async () => {
      const { orchestrator } = await sendChatMessageToOrchestrator({ content: 'note to self', forwardToOrchestrator: false });
      expect(orchestrator).toEqual({ forwarded: false });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('reports a failed queue without throwing', async () => {
      enqueue.mockImplementation(() => {
        throw new Error('queue full');
      });
      const { orchestrator } = await sendChatMessageToOrchestrator({ content: 'Plan my week' });
      expect(orchestrator.forwarded).toBe(false);
      expect(orchestrator.error).toMatch(/queue/);
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

    it('records an agent reply on its own chat-v2 DM channel instead of routing it to the orchestrator', async () => {
      const { getChatV2Service } = await import('../../services/chat-v2/chat-v2.singleton.js');
      const chatV2 = getChatV2Service();
      const { channel } = chatV2.ensureDmChannel({
        agentSession: 'crewly-marketing-ella-e6a6b8ea',
        name: 'Ella',
        principal: { userId: 'dev-user-001', source: 'oss' },
      });
      const seen: Array<{ senderType: string; senderId: string; content: string }> = [];
      chatV2.on('chat_message', (m) => seen.push({ senderType: m.senderType, senderId: m.senderId, content: m.content }));
      mockMarkPendingDelivery.mockClear();

      const response = await request(app)
        .post('/api/chat/agent-response')
        .send({ content: '你好！我是 Ella。', senderName: 'crewly-marketing-ella-e6a6b8ea', senderType: 'agent', conversationId: channel.id });

      expect(response.status).toBe(201);
      expect(response.body.data.messageId).toBeDefined();
      expect(seen).toEqual([{ senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: '你好！我是 Ella。' }]);
      expect(mockMarkPendingDelivery).not.toHaveBeenCalled();

      // The agent may sign with its display name, or the skill header names the session.
      const { StorageService } = await import('../../services/core/storage.service.js');
      jest.spyOn(StorageService.getInstance(), 'getTeams').mockResolvedValue([
        { id: 't1', name: 'Crewly Marketing', members: [{ id: 'e6a6b8ea-1', name: 'Ella', sessionName: 'crewly-marketing-ella-e6a6b8ea', role: 'team-leader' }] },
      ] as never);
      const byName = await request(app)
        .post('/api/chat/agent-response')
        .send({ content: 'by display name', senderName: 'Ella', senderType: 'agent', conversationId: channel.id });
      expect(byName.body.data.messageId).toBeDefined();
      const byHeader = await request(app)
        .post('/api/chat/agent-response')
        .set('X-Agent-Session', 'crewly-marketing-ella-e6a6b8ea')
        .send({ content: 'by header', senderName: 'whatever', senderType: 'agent', conversationId: channel.id });
      expect(byHeader.body.data.messageId).toBeDefined();
      expect(seen.map((m) => m.senderId)).toEqual(Array(3).fill('crewly-marketing-ella-e6a6b8ea'));

      // Another agent reporting into that DM is not "the agent replying" — status path as before.
      const other = await request(app)
        .post('/api/chat/agent-response')
        .send({ content: '[DONE] Agent kai: done', senderName: 'kai', senderType: 'agent', conversationId: channel.id });
      expect(other.status).toBe(201);
      expect(other.body.data.messageId).toBeUndefined();
    });

    /**
     * 2026-09-30, #steamfun运维组: the owner @'d Avery (Codex) in a Slack
     * room. Her shell carried the orchestrator's CREWLY_SESSION_NAME, so
     * reply-channel was refused; she fell back to reply-chat with the room's
     * conversation id and the thread's root message id. agent-response took
     * the full answer for a status report and queued it for the orchestrator;
     * nothing reached Slack.
     */
    describe('an agent answer into a Slack room is delivered as the agent, not swallowed as status', () => {
      const AVERY = 'steamfun-portal-team-avery-member-1';
      const IVY = 'steam-fun-content-team-ivy-dd6a9b2b';
      const ANSWER = '基于当前看板，真正处于 open/blocked 的只有 7 条。需要整理和决策的内容如下：\n\n一、TKT644 …';
      let enqueue: jest.Mock;
      let warn: jest.SpyInstance;

      /**
       * The room as production had it: a Slack-mapped huddle (listed as the
       * channel's legacy conversation too) and the owner's @Avery message.
       *
       * @returns The huddle id and the owner message (thread root) id
       */
      async function setupRoom(): Promise<{ roomId: string; rootId: string }> {
        const chatV2 = getChatV2Service();
        const room = chatV2.createHuddle({
          name: '#C0C1PRK997H',
          purpose: 'Slack channel #C0C1PRK997H',
          memberSessions: [IVY, AVERY],
          principal: { userId: 'system', source: 'oss' },
        });
        const { message: root } = chatV2.recordTurn({
          channelId: room.id,
          senderType: 'user',
          senderId: 'U0ALXV0ARC6',
          content: '<@U0C2VV5LBPF> 基于我们现在还open/blocked的tickets里面 你可以汇总一下需要整理什么东西',
          mentions: [AVERY],
          metadata: { source: 'slack', slackChannelId: 'C0C1PRK997H', slackThreadTs: '1790797403.858689', slackTs: '1790797403.858689' },
        });
        const { setSlackTeamChannelService } = await import('../../services/slack/slack-team-channel.service.js');
        setSlackTeamChannelService({
          findByChatChannelId: (id: string) =>
            id === room.id
              ? { teamId: 'adhoc:C0C1PRK997H', slackChannelId: 'C0C1PRK997H', slackChannelName: 'C0C1PRK997H', chatChannelId: room.id, createdAt: '', autoCreated: false }
              : null,
        } as never);
        const { StorageService } = await import('../../services/core/storage.service.js');
        jest.spyOn(StorageService.getInstance(), 'getTeams').mockResolvedValue([
          { id: 't-portal', name: 'SteamFun Portal Team', members: [{ id: 'm1', name: 'Avery', sessionName: AVERY, role: 'operations' }] },
          { id: 't-content', name: 'Steam Fun Content Team', members: [{ id: 'm2', name: 'Ivy', sessionName: IVY, role: 'executor' }] },
        ] as never);
        return { roomId: room.id, rootId: root.id };
      }

      beforeEach(async () => {
        enqueue = jest.fn();
        setMessageQueueService({ enqueue } as any);
        const { ComponentLogger } = await import('../../services/core/logger.service.js');
        warn = jest.spyOn(ComponentLogger.prototype, 'warn');
      });

      afterEach(async () => {
        setMessageQueueService(null as any);
        const { setSlackTeamChannelService } = await import('../../services/slack/slack-team-channel.service.js');
        setSlackTeamChannelService(null);
        jest.restoreAllMocks();
      });

      it('the incident: orc header + "Avery" + room id + root message id → Avery\'s turn in the owner\'s thread', async () => {
        const { roomId, rootId } = await setupRoom();
        const seen: Array<{ senderType: string; senderId: string; threadId?: string; content: string }> = [];
        getChatV2Service().on('chat_message', (m) =>
          seen.push({ senderType: m.senderType, senderId: m.senderId, threadId: m.threadId, content: m.content }),
        );

        const response = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', 'crewly-orc')
          .send({ content: ANSWER, senderName: 'Avery', conversationId: roomId, slackThread: rootId });

        expect(response.status).toBe(201);
        expect(response.body.data.messageId).toBeDefined();
        // The same row reply-channel writes: an agent turn by Avery, threaded
        // under the owner's message — the Slack mirror posts it as her bot
        // into that thread and replaces her placeholder.
        expect(seen).toEqual([{ senderType: 'agent', senderId: AVERY, threadId: rootId, content: ANSWER }]);
        expect(enqueue).not.toHaveBeenCalled();
        // The wrong identity in the header is called out.
        expect(warn.mock.calls.some(([msg]) => /wrong CREWLY_SESSION_NAME/.test(String(msg)))).toBe(true);
      });

      it('with no thread named, answers the latest message that @\'d the agent here; interim notes stay interim', async () => {
        const { roomId, rootId } = await setupRoom();
        const response = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', AVERY)
          .send({ content: '我先按看板筛一遍，整理好后一次性发。', senderName: 'Avery', senderType: 'agent', conversationId: roomId, interim: true });

        expect(response.status).toBe(201);
        const row = getChatV2Service().getMessageForBridge(response.body.data.messageId);
        expect(row?.senderId).toBe(AVERY);
        expect(row?.threadId).toBe(rootId);
        expect(row?.metadata?.interim).toBe(true);
        expect(enqueue).not.toHaveBeenCalled();
      });

      it('a status marker from the same agent in the same room still takes the status path', async () => {
        const route = jest.spyOn(OrcStatusRouterService.prototype, 'route');
        const { roomId, rootId } = await setupRoom();
        const response = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', AVERY)
          .send({ content: '[DONE] Agent Avery: 汇总已发', senderName: 'Avery', senderType: 'agent', conversationId: roomId, slackThread: rootId });

        expect(response.status).toBe(201);
        expect(response.body.data.messageId).toBeUndefined();
        expect(route).toHaveBeenCalledWith(expect.objectContaining({ sender: AVERY, conversationId: roomId, content: '[DONE] Agent Avery: 汇总已发' }));
        expect(warn.mock.calls.some(([msg]) => /Substantive agent content/.test(String(msg)))).toBe(false);
        route.mockRestore();
      });

      it('an agent that is not in the room, or was never asked there, keeps the status path', async () => {
        const { roomId } = await setupRoom();
        const stranger = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', 'someone-else-1')
          .send({ content: ANSWER, senderName: 'someone-else-1', senderType: 'agent', conversationId: roomId });
        expect(stranger.body.data.messageId).toBeUndefined();

        // Ivy is a member but nobody @'d her and she named no thread.
        const unasked = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', IVY)
          .send({ content: '我也看了一下', senderName: 'Ivy', senderType: 'agent', conversationId: roomId });
        expect(unasked.body.data.messageId).toBeUndefined();
        expect(enqueue).toHaveBeenCalledTimes(2);
      });

      it('an unrelated conversation is unchanged, and substantive content routed as status is a WARN', async () => {
        const conversation = await chatService.createNewConversation('Some orchestrator thread');
        const response = await request(app)
          .post('/api/chat/agent-response')
          .send({ content: 'Here is the full analysis you asked for: …', senderName: 'kai', senderType: 'agent', conversationId: conversation.id });

        expect(response.status).toBe(201);
        expect(response.body.data.messageId).toBeUndefined();
        expect(enqueue).toHaveBeenCalledTimes(1);
        const substantive = warn.mock.calls.filter(([msg]) => /Substantive agent content routed to the orchestrator/.test(String(msg)));
        expect(substantive).toHaveLength(1);
        expect(substantive[0][1]).toEqual(expect.objectContaining({ senderName: 'kai', conversationId: conversation.id }));
      });
    });

    /**
     * specs/2026-10-02-harness-owned-routing.md: the resolver path is opt-in
     * (`intent: "message"`, set by reply-chat / send-chat-response). Status
     * payloads from report-status / handoff-task / complete-task — exactly
     * as their jq builds them — keep the status path.
     */
    describe('harness-owned routing (2026-10-02)', () => {
      const OWEN = 'ce-team-owen-lead-0001';
      const PRO_CE = 'C0C2Y1FRCP7';
      const TS = '1790897084.888289';
      let enqueue: jest.Mock;

      beforeEach(() => {
        enqueue = jest.fn();
        setMessageQueueService({ enqueue } as any);
      });

      afterEach(async () => {
        setMessageQueueService(null as any);
        const { setSlackTeamChannelService } = await import('../../services/slack/slack-team-channel.service.js');
        setSlackTeamChannelService(null);
        jest.restoreAllMocks();
      });

      /** The exact `content` strings the skills' jq produces (bash "\n" in double quotes = backslash + n). */
      const SKILL_PAYLOADS: Array<[string, string]> = [
        ['report-status --structured (old literal \\n)', '---\\n[STATUS REPORT]\\nTask ID: task-1\\nState: completed\\nReported by: dev-1\\n---\\n\\n## Status\\nShipped the API.'],
        ['report-status --structured (real newlines)', '---\n[STATUS REPORT]\nTask ID: task-1\nState: completed\nReported by: dev-1\n---\n\n## Status\nShipped the API.'],
        ['report-status milestone', '[MILESTONE] Agent dev-1: PR #12 merged — checkout now takes Apple Pay, owners see it on the next deploy'],
        ['handoff-task notice', '[HANDOFF] dev-1 → dev-2: switching to the billing bug, dev-2 owns the API now'],
        ['complete-task --structured', '---\\n[VERIFICATION REQUEST]\\nTask ID: task-1\\nRequested by: dev-1\\n---\\n\\n## Summary\\nAPI done.'],
      ];

      it.each(SKILL_PAYLOADS)('%s is a status line and keeps the status path (never shown to the owner)', async (_name, content) => {
        const { isAgentStatusMarker } = await import('./chat.controller.js');
        expect(isAgentStatusMarker(content)).toBe(true);
        const route = jest.spyOn(OrcStatusRouterService.prototype, 'route');
        const response = await request(app).post('/api/chat/agent-response').send({ content, senderName: 'dev-1', senderType: 'agent' });
        expect(response.status).toBe(201);
        expect(response.body.data.messageId).toBeUndefined();
        // The status router got it (it decides whether that wakes anyone).
        expect(route).toHaveBeenCalledWith(expect.objectContaining({ content }));
        // Even with the message flag a status line is status.
        const flagged = await request(app).post('/api/chat/agent-response').send({ content, senderName: 'dev-1', senderType: 'agent', intent: 'message' });
        expect(flagged.status).toBe(201);
        expect(flagged.body.data.messageId).toBeUndefined();
      });

      it('without intent:"message", free text keeps the main behaviour (status path)', async () => {
        const response = await request(app).post('/api/chat/agent-response').send({ content: 'Working on the feature now...', senderName: 'dev-1', senderType: 'agent' });
        expect(response.status).toBe(201);
        expect(response.body.data.messageId).toBeUndefined();
        expect(enqueue).toHaveBeenCalledTimes(1);
      });

      it('intent:"message" with nowhere to go → 409 success:false with a runnable command, never swallowed as status', async () => {
        const response = await request(app)
          .post('/api/chat/agent-response')
          .send({ content: 'Here is the full analysis you asked for: …', senderName: 'kai', senderType: 'agent', intent: 'message' });
        expect(response.status).toBe(409);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toMatch(/^Your message was NOT delivered: .*Run: reply "<your message>"$/);
        expect(enqueue).not.toHaveBeenCalled();
      });

      it('TKT-187: reply-chat --thread <#pro-ce key> with no conversation lands in the #pro-ce thread, not the newer unrelated conversation', async () => {
        const chatV2 = getChatV2Service();
        const proCe = chatV2.createHuddle({ name: '#pro-ce', purpose: 'Slack channel #pro-ce', memberSessions: [OWEN], principal: { userId: 'system', source: 'oss' } });
        const { message: root } = chatV2.recordTurn({
          channelId: proCe.id,
          senderType: 'user',
          senderId: 'UOWNER',
          content: 'Can you send me the CE preview?',
          metadata: { source: 'slack', slackChannelId: PRO_CE, slackThreadTs: TS, slackTs: TS },
        });
        const mkt = chatV2.createHuddle({ name: '#crewly-marketing', purpose: 'huddle', memberSessions: [OWEN], principal: { userId: 'system', source: 'oss' } });
        await chatService.createNewConversation('crewly-marketing huddle');
        const { OrcReplyRouteService } = await import('../../services/orc/orc-reply-route.service.js');
        OrcReplyRouteService.resetInstance();
        OrcReplyRouteService.getInstance().noteDelivery(OWEN, `[CHAT:${mkt.id}] <steve@Owen>\n\nhuddle notes?`);
        const mapping = { teamId: 'ce', slackChannelId: PRO_CE, slackChannelName: 'pro-ce', chatChannelId: proCe.id, createdAt: '', autoCreated: false };
        const { setSlackTeamChannelService } = await import('../../services/slack/slack-team-channel.service.js');
        setSlackTeamChannelService({
          findByChatChannelId: (id: string) => (id === proCe.id ? mapping : null),
          findBySlackChannelId: (ch: string) => (ch === PRO_CE ? mapping : null),
        } as never);

        const response = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', OWEN)
          .send({ content: 'Here is the CE preview: https://preview.example.com/ce', senderName: OWEN, senderType: 'agent', slackThread: `${PRO_CE}:${TS}`, intent: 'message' });

        expect(response.status).toBe(201);
        const row = chatV2.getMessageForBridge(response.body.data.messageId);
        expect(row?.channelId).toBe(proCe.id);
        expect(row?.threadId).toBe(root.id);
        expect(enqueue).not.toHaveBeenCalled();
      });

      it('[DONE] notice: only into a thread the store lists for the agent, the one the resolver picks; otherwise nothing', async () => {
        const storeMod = await import('../../services/slack/slack-thread-store.service.js');
        const bridgeMod = await import('../../services/slack/slack-orchestrator-bridge.js');
        const wiring = await import('../../services/orc/reply-destination.wiring.js');
        const listed = [{ channelId: 'C0FIRST01', threadTs: '1790000000.000100' }, { channelId: PRO_CE, threadTs: TS }];
        jest.spyOn(storeMod, 'getSlackThreadStore').mockReturnValue({ findThreadsForAgent: () => listed } as never);
        const sendNotification = jest.fn(async () => undefined);
        jest.spyOn(bridgeMod, 'getSlackOrchestratorBridge').mockReturnValue({ sendNotification, addCompletionReaction: jest.fn(async () => undefined) } as never);
        const place = jest.spyOn(wiring, 'resolveSlackPlace');

        // The resolver picks the second listed thread → the notice goes there, not to threads[0].
        place.mockResolvedValueOnce({ slackChannelId: PRO_CE, threadTs: TS, destination: {} as never });
        await request(app).post('/api/chat/agent-response').send({ content: '[DONE] Agent dev-1: preview sent', senderName: 'dev-1', senderType: 'agent' });
        expect(sendNotification).toHaveBeenCalledTimes(1);
        expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ channelId: PRO_CE, threadTs: TS }));

        // A thread the store does not list for the agent → no notice at all.
        place.mockResolvedValueOnce({ slackChannelId: 'C0ELSE001', threadTs: '1790000009.000100', destination: {} as never });
        await request(app).post('/api/chat/agent-response').send({ content: '[DONE] Agent dev-1: other', senderName: 'dev-1', senderType: 'agent' });
        // Nothing resolvable → no notice either.
        place.mockResolvedValueOnce(null);
        await request(app).post('/api/chat/agent-response').send({ content: '[DONE] Agent dev-1: third', senderName: 'dev-1', senderType: 'agent' });
        expect(sendNotification).toHaveBeenCalledTimes(1);
      });
    });

    /**
     * specs/2026-09-30-owner-message-guarantee.md §B: a substantive answer
     * with no / legacy ids that the agent owes the owner goes where the
     * owner's message came from instead of into the orchestrator's queue.
     */
    describe('an owed answer with missing or wrong ids goes to its turn origin', () => {
      const ELLA = 'crewly-marketing-ella-owed01';
      let enqueue: jest.Mock;

      beforeEach(() => {
        enqueue = jest.fn();
        setMessageQueueService({ enqueue } as any);
      });

      afterEach(async () => {
        setMessageQueueService(null as any);
        const { setOwnerMessageWatchdog } = await import('../../services/messaging/owner-message-watchdog.service.js');
        setOwnerMessageWatchdog(null);
      });

      async function setup(owed: boolean): Promise<string> {
        const { OrcReplyRouteService } = await import('../../services/orc/orc-reply-route.service.js');
        const { OwnerMessageWatchdogService, setOwnerMessageWatchdog } = await import(
          '../../services/messaging/owner-message-watchdog.service.js'
        );
        OrcReplyRouteService.resetInstance();
        const { channel } = getChatV2Service().ensureDmChannel({
          agentSession: ELLA,
          name: 'Ella',
          principal: { userId: 'dev-user-001', source: 'oss' },
        });
        OrcReplyRouteService.getInstance().noteDelivery(ELLA, `[CHAT:${channel.id}] <steve@Ella>\n\nWhere is the report?`);
        const watchdog = new OwnerMessageWatchdogService({
          isBusy: () => false,
          nudge: async () => ({ outcome: 'sent' }),
          postNote: async () => true,
        });
        if (owed) {
          watchdog.track({
            surface: 'chat',
            chatChannelId: channel.id,
            messageId: 'owner-msg-1',
            responsible: ELLA,
            recipients: [ELLA],
            required: true,
            text: 'Where is the report?',
          });
        }
        setOwnerMessageWatchdog(watchdog);
        return channel.id;
      }

      it('no conversation named → delivered to the DM the owner wrote in', async () => {
        const dmId = await setup(true);
        const response = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', ELLA)
          .send({ content: 'The report is in the shared drive.', senderName: 'Ella', senderType: 'agent' });
        expect(response.status).toBe(201);
        expect(response.body.data).toEqual(expect.objectContaining({ conversationId: dmId, reroutedToOrigin: true }));
        expect(getChatV2Service().getMessageForBridge(response.body.data.messageId)?.senderId).toBe(ELLA);
        expect(enqueue).not.toHaveBeenCalled();
      });

      it('a legacy conversation id → still the DM', async () => {
        const dmId = await setup(true);
        const legacy = await chatService.createNewConversation('Agent Chat');
        const response = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', ELLA)
          .send({ content: 'The report is in the shared drive.', senderName: 'Ella', senderType: 'agent', conversationId: legacy.id });
        expect(response.body.data.conversationId).toBe(dmId);
        expect(enqueue).not.toHaveBeenCalled();
      });

      it('status markers, and answers nobody is owed, keep the orchestrator path', async () => {
        const route = jest.spyOn(OrcStatusRouterService.prototype, 'route');
        await setup(true);
        const status = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', ELLA)
          .send({ content: '[DONE] report shipped', senderName: 'Ella', senderType: 'agent' });
        expect(status.body.data.messageId).toBeUndefined();

        await setup(false);
        const unowed = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', ELLA)
          .send({ content: 'Delegation report: all three pages done.', senderName: 'Ella', senderType: 'agent' });
        expect(unowed.body.data.messageId).toBeUndefined();
        // Both took the status path; only the answer woke the orchestrator —
        // a [DONE] with no orchestrator work waits for the digest.
        expect(route).toHaveBeenCalledTimes(2);
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Delegation report') }));
        route.mockRestore();
      });
    });

    /**
     * 2026-09-26: the owner asked the orc a question in a Slack DM; a
     * WorkItem-dispatch system turn right after it posted the answer (with
     * the owner's pending question in it) to #think-tank.
     */
    describe('orchestrator replies go back to the conversation the turn came from', () => {
      const ORC = 'crewly-orc';

      /**
       * Sets up the incident: the owner's orchestrator DM (user-owned, so the
       * "current conversation" fallback can never see it) and a newer
       * system-owned team conversation standing in for #think-tank.
       *
       * @returns The two conversation ids
       */
      async function setupIncident(): Promise<{ dmId: string; teamId: string }> {
        const { OrcReplyRouteService } = await import('../../services/orc/orc-reply-route.service.js');
        OrcReplyRouteService.resetInstance();
        const chatV2 = getChatV2Service();
        const { channel: dm } = chatV2.ensureDmChannel({
          agentSession: ORC,
          name: 'Orchestrator',
          principal: { userId: 'dev-user-001', source: 'oss' },
        });
        const team = await chatService.createNewConversation('#think-tank');
        await chatService.addDirectMessage(team.id, 'Atlas: filled the form', { type: 'agent', name: 'think-tank-atlas' });
        // The owner's DM reached the orc, then a system turn followed.
        OrcReplyRouteService.getInstance().noteDelivery(ORC, `[CHAT:${dm.id}] <UG94JLNGK@Orchestrator>\n\nA chatgpt账号`);
        OrcReplyRouteService.getInstance().noteDelivery(ORC, '[CREWLY-DISPATCH] 3 WorkItems are still queued for you');
        return { dmId: dm.id, teamId: team.id };
      }

      it('reply-chat naming a stale team conversation is re-routed to the DM', async () => {
        const { dmId, teamId } = await setupIncident();
        const response = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', ORC)
          .send({ content: '## Summary — reply "start Ella"', senderName: 'Orchestrator', senderType: 'orchestrator', conversationId: teamId });

        expect(response.status).toBe(201);
        expect(response.body.data.conversationId).toBe(dmId);
      });

      it('reply-chat with no conversation goes to the DM, not the newest system channel', async () => {
        const { dmId, teamId } = await setupIncident();
        // Without routing, the fallback is the newest system-owned conversation.
        expect((await chatService.getCurrentConversation())?.id).toBe(teamId);

        const response = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', ORC)
          .send({ content: 'Nova needs your ChatGPT login', senderName: 'Orchestrator', senderType: 'orchestrator' });

        expect(response.body.data.conversationId).toBe(dmId);
      });

      it('an explicit cross-post is kept', async () => {
        const { teamId } = await setupIncident();
        const response = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', ORC)
          .send({ content: 'Posting the plan here as asked', senderName: 'Orchestrator', senderType: 'orchestrator', conversationId: teamId, crossPost: true });

        expect(response.body.data.conversationId).toBe(teamId);
      });

      it('a post whose X-Agent-Session is another agent is not touched', async () => {
        const { teamId } = await setupIncident();
        // The header is authoritative: not the orchestrator, so no routing,
        // whatever the body claims.
        const response = await request(app)
          .post('/api/chat/agent-response')
          .set('X-Agent-Session', 'think-tank-atlas')
          .send({ content: 'Atlas: submitted', senderName: 'Orchestrator', senderType: 'system', conversationId: teamId });

        expect(response.body.data.conversationId).toBe(teamId);
      });
    });

    /**
     * Issue #731 — a cron-driven daily task reports completion with no
     * conversationId, so the handler fell back to the globally-current
     * conversation and tracked a delivery against whatever thread happened to
     * be current: a long-resolved one. The watchdog then demanded a deliverable
     * in that unrelated thread every single day.
     */
    describe('delivery tracking only for a named thread (#731)', () => {
      beforeEach(() => {
        mockMarkPendingDelivery.mockClear();
      });

      it('tracks the delivery when the agent names the conversation', async () => {
        const conversation = await chatService.createNewConversation('Slack thread');

        const response = await request(app)
          .post('/api/chat/agent-response')
          .send({
            content: '[DONE] Agent ella: research finished',
            senderName: 'ella',
            senderType: 'agent',
            conversationId: conversation.id,
          });

        expect(response.status).toBe(201);
        expect(mockMarkPendingDelivery).toHaveBeenCalledWith(
          expect.objectContaining({ conversationId: conversation.id, agentSender: 'ella' }),
        );
      });

      it('does NOT track when the conversation was inferred, not named', async () => {
        const response = await request(app)
          .post('/api/chat/agent-response')
          .send({
            content: '[COMPLETED] Agent ella: daily tech briefing posted',
            senderName: 'ella',
            senderType: 'agent',
          });

        // Still accepted and routed to the orchestrator — only the delivery
        // watchdog association is suppressed.
        expect(response.status).toBe(201);
        expect(mockMarkPendingDelivery).not.toHaveBeenCalled();
      });
    });

    it('should return 400 for missing senderName', async () => {
      const response = await request(app)
        .post('/api/chat/agent-response')
        .send({ content: 'Hello' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('senderName is required');
    });

    describe('status reports go to whoever is responsible (specs/2026-10-01-orc-status-wakes.md)', () => {
      const NOW = Date.now();
      /** A running work item of test-agent. */
      const item = (over: Partial<WorkItem>): WorkItem => ({
        id: 'wi-1', type: 'delegate', owner: 'team_lead', target: 'test-agent', title: 'Write the report',
        status: 'running', createdAt: new Date(NOW - 60_000).toISOString(), startedAt: new Date(NOW - 30_000).toISOString(),
        retryCount: 0, maxRetries: 3, inputTokens: 0, outputTokens: 0, cost: 0, ...over,
      } as WorkItem);
      /** Router with a stub pool / team list. */
      const useRouter = (items: WorkItem[]) => {
        OrcStatusRouterService.setInstance(new OrcStatusRouterService({
          enqueue: null,
          poolItems: async () => items,
          teams: async () => [],
          isOrchestrator: (n) => n === 'crewly-orc',
          now: () => NOW,
          counter: new OrcWakeCounter(),
        }));
      };
      afterEach(() => {
        setMessageQueueService(null as any);
        OrcStatusRouterService.setInstance(null);
      });

      it('[DONE] on work the orchestrator delegated wakes the orchestrator', async () => {
        useRouter([item({ owner: 'orchestrator', metadata: { delegatedBy: 'crewly-orc' } })]);
        const mockEnqueue = jest.fn().mockReturnValue({ id: 'q1' });
        setMessageQueueService({ enqueue: mockEnqueue } as any);

        const response = await request(app)
          .post('/api/chat/agent-response')
          .send({ content: '[DONE] Agent test-agent: Finished implementing feature', senderName: 'test-agent', senderType: 'agent' });

        expect(response.status).toBe(201);
        expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
          content: expect.stringContaining('Agent status:'),
          source: 'system_event',
          sourceMetadata: expect.objectContaining({ orcWakeCategory: 'delegated-done' }),
        }));
      });

      it('[DONE] on a team lead\'s work item does not wake the orchestrator', async () => {
        useRouter([item({ owner: 'team_lead', metadata: { delegatedBy: 'atlas' } })]);
        const mockEnqueue = jest.fn().mockReturnValue({ id: 'q1' });
        setMessageQueueService({ enqueue: mockEnqueue } as any);

        const response = await request(app)
          .post('/api/chat/agent-response')
          .send({ content: '[DONE] Agent test-agent: Finished', senderName: 'test-agent', senderType: 'agent', workItemId: 'wi-1' });

        expect(response.status).toBe(201);
        expect(mockEnqueue).not.toHaveBeenCalled();
      });
    });

    // 2026-09-16: every queued line is a full-context orchestrator turn, and
    // progress chatter gives it nothing to act on.
    it.each(['[IN_PROGRESS]', '[WORKING]', '[ACTIVE]', '[STARTED]', '[READY]', '[ONLINE]', '[IDLE]'])(
      'does NOT enqueue %s progress markers to the orchestrator',
      async (marker) => {
        const mockEnqueue = jest.fn().mockReturnValue({ id: 'q-progress' });
        setMessageQueueService({ enqueue: mockEnqueue } as any);

        const response = await request(app)
          .post('/api/chat/agent-response')
          .send({
            content: `${marker} Agent test-agent: still working on it`,
            senderName: 'test-agent',
            senderType: 'agent',
          });

        expect(response.status).toBe(201);
        expect(mockEnqueue).not.toHaveBeenCalled();
        setMessageQueueService(null as any);
      },
    );

    it('still enqueues [BLOCKED] (needs the orchestrator)', async () => {
      const mockEnqueue = jest.fn().mockReturnValue({ id: 'q-blocked' });
      setMessageQueueService({ enqueue: mockEnqueue } as any);

      const response = await request(app)
        .post('/api/chat/agent-response')
        .send({
          content: '[BLOCKED] Agent test-agent: need credentials',
          senderName: 'test-agent',
          senderType: 'agent',
        });

      expect(response.status).toBe(201);
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('[BLOCKED]') }),
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

    // 2026-09-13: report-status posts the orchestrator's own [DONE] with
    // senderType 'agent' and senderName 'crewly-orc'. Routing that back to
    // the orchestrator as an "agent status" and tracking it as an
    // undelivered deliverable made ORC answer its own report, forever.
    it("does not echo the orchestrator's own status report back to it, nor track it as a delivery", async () => {
      const mockEnqueue = jest.fn().mockReturnValue({ id: 'q-self' });
      setMessageQueueService({ enqueue: mockEnqueue } as any);
      mockMarkPendingDelivery.mockClear();

      const response = await request(app)
        .post('/api/chat/agent-response')
        .send({
          content: '[DONE] Agent crewly-orc: Delivered the diagnosis to Steve',
          senderName: 'crewly-orc',
          senderType: 'agent',
          conversationId: 'slack-D0AC7NF5N7L-1789324221-953849:737ad8eb',
        });

      expect(response.status).toBe(201);
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockMarkPendingDelivery).not.toHaveBeenCalled();

      setMessageQueueService(null as any);
    });

    // 2026-10-03 (steamfun-ops): the Codex orc answers owner DMs through the
    // agent reply-chat skill (senderType 'agent'). Its answer is not a status
    // line, so it must be stored as the orchestrator's message, not dropped
    // as a self-report (crewly#1015 §1).
    it("stores the orchestrator's non-status answer posted as an agent", async () => {
      const mockEnqueue = jest.fn().mockReturnValue({ id: 'q-ans' });
      setMessageQueueService({ enqueue: mockEnqueue } as any);

      const response = await request(app)
        .post('/api/chat/agent-response')
        .send({
          content: '当前 Crewly 版本是 1.20.200。',
          senderName: 'crewly-orc',
          senderType: 'agent',
        });

      expect(response.status).toBe(201);
      expect(response.body.data.messageId).toBeDefined();
      expect(mockEnqueue).not.toHaveBeenCalled();

      setMessageQueueService(null as any);
    });

    // crewly#1015 review: report-status takes a free-form --status, so any
    // status-shaped opening from the orc is its own report, not an answer.
    it("keeps any status-shaped orchestrator line a self-report ([WAITING], [IN-PROGRESS], [PENDING])", async () => {
      const mockEnqueue = jest.fn().mockReturnValue({ id: 'q-status' });
      setMessageQueueService({ enqueue: mockEnqueue } as any);
      for (const line of ['[WAITING] Agent crewly-orc: on Owen', '[IN-PROGRESS] Agent crewly-orc: checking', '[PENDING] review']) {
        const r = await request(app)
          .post('/api/chat/agent-response')
          .send({ content: line, senderName: 'crewly-orc', senderType: 'agent' });
        expect(r.status).toBe(201);
        expect(r.body.data.messageId).toBeUndefined();
      }
      expect(mockEnqueue).not.toHaveBeenCalled();
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

describe('pickCompletionThreads — a [DONE] goes to the thread it is about (2026-09-28)', () => {
  const threads = [
    { channelId: 'C0ONE', threadTs: '1790000000.000100', filePath: 'a' },
    { channelId: 'C0ONE', threadTs: '1790000500.000200', filePath: 'b' },
  ];

  it('keeps store order when nothing names a thread', () => {
    expect(pickCompletionThreads(threads, '[DONE] fixed it')).toEqual(threads);
  });

  it('a tag in the report puts its thread first', () => {
    const picked = pickCompletionThreads(threads, '[DONE] EFT form fixed [SLACK-THREAD:C0ONE:1790000500.000200]');
    expect(picked[0].threadTs).toBe('1790000500.000200');
    expect(picked).toHaveLength(2);
  });

  it('an explicit --thread key wins over a tag in the text', () => {
    const picked = pickCompletionThreads(threads, '[DONE] x [SLACK-THREAD:C0ONE:1790000500.000200]', 'C0ONE:1790000000.000100');
    expect(picked[0].threadTs).toBe('1790000000.000100');
  });

  it('a thread the agent was never registered on is ignored', () => {
    expect(pickCompletionThreads(threads, '[DONE] x [SLACK-THREAD:C0NINE:1790000999.000100]')).toEqual(threads);
  });
});

describe('clipForOrchestrator', () => {
  // Every character forwarded stays in the orchestrator's conversation and is
  // re-read on every later turn; a [DONE] report can run to thousands.
  it('passes a short status through unchanged', () => {
    expect(clipForOrchestrator('[DONE] fixed the build', 'conv-1')).toBe('[DONE] fixed the build');
  });

  it('clips a long one and says where the rest is', () => {
    const long = '[DONE] ' + 'x'.repeat(3000);
    const clipped = clipForOrchestrator(long, 'conv-1');
    expect(clipped.length).toBeLessThan(700);
    expect(clipped.startsWith('[DONE] xxx')).toBe(true);
    expect(clipped).toContain(`${long.length - 600} more characters`);
    expect(clipped).toContain('conversation conv-1');
  });
});
