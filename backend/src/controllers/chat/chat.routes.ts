/**
 * Chat Routes
 *
 * Express router configuration for chat API endpoints.
 *
 * @module controllers/chat/chat.routes
 */

import { Router } from 'express';
import type { ApiContext } from '../types.js';
import {
  sendMessage,
  getMessages,
  getMessage,
  getConversations,
  getCurrentConversation,
  getConversation,
  createConversation,
  updateConversation,
  archiveConversation,
  unarchiveConversation,
  deleteConversation,
  clearConversation,
  getStatistics,
  agentResponse,
  getThreadStatusList,
  getThreadStatusStats,
  getThreadStatusByKey,
  handleGetHighlights,
} from './chat.controller.js';

/**
 * Creates chat router with all chat-related endpoints.
 * Note: MessageQueueService is wired via setMessageQueueService() from index.ts.
 *
 * @param context - API context with services (optional, for backward compatibility)
 * @returns Express router configured with chat routes
 */
export function createChatRouter(context?: ApiContext): Router {
  const router = Router();

  // Message endpoints
  router.post('/send', sendMessage);
  router.get('/messages', getMessages);
  router.get('/messages/:conversationId/:messageId', getMessage);

  // Agent response endpoint (for bash skills to post messages directly)
  router.post('/agent-response', agentResponse);

  // Highlights
  router.get('/highlights', handleGetHighlights);

  // Statistics
  router.get('/statistics', getStatistics);

  // Thread status endpoints (specific routes before parameterized)
  router.get('/thread-status/stats', getThreadStatusStats);
  router.get('/thread-status/:threadKey', getThreadStatusByKey);
  router.get('/thread-status', getThreadStatusList);

  // Conversation endpoints - specific routes first
  router.get('/conversations/current', getCurrentConversation);
  router.get('/conversations', getConversations);
  router.post('/conversations', createConversation);
  router.get('/conversations/:id', getConversation);
  router.put('/conversations/:id', updateConversation);
  router.delete('/conversations/:id', deleteConversation);
  router.put('/conversations/:id/archive', archiveConversation);
  router.put('/conversations/:id/unarchive', unarchiveConversation);
  router.post('/conversations/:id/clear', clearConversation);

  return router;
}
