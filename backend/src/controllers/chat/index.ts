/**
 * Chat Controller Module
 *
 * Exports chat routes and controller functions.
 *
 * @module controllers/chat
 */

export { createChatRouter } from './chat.routes.js';
export {
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
  setMessageQueueService,
  setThreadStatusQueueService,
  getThreadStatusList,
  getThreadStatusStats,
  getThreadStatusByKey,
} from './chat.controller.js';
