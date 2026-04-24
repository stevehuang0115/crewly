/**
 * Chat V2 controller module barrel.
 *
 * @module controllers/chat-v2
 */

export { createChatV2Router } from './chat-v2.routes.js';
export {
  createChatV2Controller,
  principalFromRequest,
  sendChatError,
} from './chat-v2.controller.js';
