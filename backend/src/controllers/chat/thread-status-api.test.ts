/**
 * Thread Status API Endpoint Tests
 *
 * Unit tests for the thread status endpoints added to the chat controller.
 * Uses mocked ThreadStatusQueueService to verify HTTP behavior.
 *
 * @module controllers/chat/thread-status-api.test
 */

// Mock node-pty before any imports to prevent native binary load failure
jest.mock('node-pty', () => ({
  spawn: jest.fn(),
}));

import express, { Application } from 'express';
import request from 'supertest';
import { createChatRouter } from './chat.routes.js';
import { setThreadStatusQueueService } from './chat.controller.js';
import type { ThreadStatusEntry, ThreadStatusStats } from '../../types/thread-status.types.js';

// =============================================================================
// Mock Thread Status Queue Service
// =============================================================================

const mockEntries: ThreadStatusEntry[] = [
  {
    id: 'e1',
    source: 'slack',
    threadKey: 'C123:ts1',
    conversationId: 'conv-1',
    status: 'enqueued',
    receivedAt: '2026-03-23T10:00:00Z',
    updatedAt: '2026-03-23T10:00:00Z',
    messagePreview: 'Deploy feature X',
    retryCount: 0,
  },
  {
    id: 'e2',
    source: 'web_chat',
    threadKey: 'web:conv-2',
    conversationId: 'conv-2',
    status: 'replied_completed',
    receivedAt: '2026-03-23T09:00:00Z',
    deliveredAt: '2026-03-23T09:01:00Z',
    repliedAt: '2026-03-23T09:02:00Z',
    updatedAt: '2026-03-23T09:02:00Z',
    messagePreview: 'Check agent status',
    retryCount: 0,
  },
  {
    id: 'e3',
    source: 'slack',
    threadKey: 'C456:ts3',
    conversationId: 'conv-3',
    status: 'replied_waiting_actions',
    receivedAt: '2026-03-23T08:00:00Z',
    deliveredAt: '2026-03-23T08:01:00Z',
    repliedAt: '2026-03-23T08:02:00Z',
    updatedAt: '2026-03-23T08:02:00Z',
    messagePreview: 'Refactor the API',
    retryCount: 0,
    delegatedAgents: ['agent-a', 'agent-b'],
  },
];

const mockStats: ThreadStatusStats = {
  total: 3,
  byStatus: {
    enqueued: 1,
    delivered: 0,
    replied_completed: 1,
    replied_waiting_actions: 1,
    replied_to_follow_up: 0,
    expired: 0,
    error: 0,
  },
  oldestPending: '2026-03-23T08:00:00Z',
};

const mockThreadStatusQueueService = {
  getAllEntries: jest.fn().mockReturnValue(mockEntries),
  getByStatus: jest.fn().mockImplementation((status: string) =>
    mockEntries.filter((e) => e.status === status)
  ),
  getStats: jest.fn().mockReturnValue(mockStats),
  get: jest.fn().mockImplementation((threadKey: string) =>
    mockEntries.find((e) => e.threadKey === threadKey) ?? null
  ),
};

// =============================================================================
// Test Setup
// =============================================================================

describe('Thread Status API Endpoints', () => {
  let app: Application;

  beforeAll(() => {
    // Wire mock service into controller
    setThreadStatusQueueService(mockThreadStatusQueueService as any);
  });

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/chat', createChatRouter());
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(500).json({ success: false, error: err.message });
    });

    jest.clearAllMocks();
  });

  afterAll(() => {
    setThreadStatusQueueService(null as any);
  });

  // ===========================================================================
  // GET /api/chat/thread-status
  // ===========================================================================

  describe('GET /api/chat/thread-status', () => {
    it('returns all thread status entries', async () => {
      const res = await request(app).get('/api/chat/thread-status');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(3);
      expect(res.body.count).toBe(3);
      expect(mockThreadStatusQueueService.getAllEntries).toHaveBeenCalled();
    });

    it('filters by status query parameter', async () => {
      const res = await request(app).get('/api/chat/thread-status?status=enqueued');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe('enqueued');
      expect(mockThreadStatusQueueService.getByStatus).toHaveBeenCalledWith('enqueued');
    });

    it('returns empty array when no entries match status', async () => {
      const res = await request(app).get('/api/chat/thread-status?status=expired');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.count).toBe(0);
    });
  });

  // ===========================================================================
  // GET /api/chat/thread-status/stats
  // ===========================================================================

  describe('GET /api/chat/thread-status/stats', () => {
    it('returns thread status statistics', async () => {
      const res = await request(app).get('/api/chat/thread-status/stats');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.byStatus.enqueued).toBe(1);
      expect(res.body.data.byStatus.replied_completed).toBe(1);
      expect(res.body.data.oldestPending).toBe('2026-03-23T08:00:00Z');
      expect(mockThreadStatusQueueService.getStats).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // GET /api/chat/thread-status/:threadKey
  // ===========================================================================

  describe('GET /api/chat/thread-status/:threadKey', () => {
    it('returns a specific thread by threadKey', async () => {
      const res = await request(app).get('/api/chat/thread-status/C123%3Ats1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.threadKey).toBe('C123:ts1');
      expect(res.body.data.status).toBe('enqueued');
      expect(mockThreadStatusQueueService.get).toHaveBeenCalledWith('C123:ts1');
    });

    it('returns 404 for unknown threadKey', async () => {
      const res = await request(app).get('/api/chat/thread-status/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Thread not found');
    });

    it('returns thread with delegated agents', async () => {
      const res = await request(app).get('/api/chat/thread-status/C456%3Ats3');

      expect(res.status).toBe(200);
      expect(res.body.data.delegatedAgents).toEqual(['agent-a', 'agent-b']);
      expect(res.body.data.status).toBe('replied_waiting_actions');
    });
  });

  // ===========================================================================
  // Service Not Initialized
  // ===========================================================================

  describe('when service is not initialized', () => {
    let uninitApp: Application;

    beforeEach(() => {
      setThreadStatusQueueService(null as any);
      uninitApp = express();
      uninitApp.use(express.json());
      uninitApp.use('/api/chat', createChatRouter());
    });

    afterEach(() => {
      setThreadStatusQueueService(mockThreadStatusQueueService as any);
    });

    it('GET /api/chat/thread-status returns 503', async () => {
      const res = await request(uninitApp).get('/api/chat/thread-status');
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not initialized');
    });

    it('GET /api/chat/thread-status/stats returns 503', async () => {
      const res = await request(uninitApp).get('/api/chat/thread-status/stats');
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
    });

    it('GET /api/chat/thread-status/:threadKey returns 503', async () => {
      const res = await request(uninitApp).get('/api/chat/thread-status/C123%3Ats1');
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
    });
  });
});
