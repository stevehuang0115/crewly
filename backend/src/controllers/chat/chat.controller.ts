/**
 * Chat Controller
 *
 * HTTP request handlers for chat functionality. Provides endpoints for
 * sending messages, managing conversations, and retrieving chat history.
 *
 * @module controllers/chat/chat.controller
 */

import type { Request, Response, NextFunction } from 'express';
import {
  getChatService,
  MessageValidationError,
  ConversationNotFoundError,
} from '../../services/chat/chat.service.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { getSessionBackendSync } from '../../services/session/session-backend.factory.js';
import { LoggerService, ComponentLogger } from '../../services/core/logger.service.js';
import type { MessageQueueService } from '../../services/messaging/message-queue.service.js';
import type {
  SendMessageInput,
  ChatMessageFilter,
  ConversationFilter,
  ChatSenderType,
  ChatContentType,
} from '../../types/chat.types.js';
import {
  createChatMessage,
  detectContentType,
  formatMessageContent,
} from '../../types/chat.types.js';

// Module-level message queue service instance
let messageQueueService: MessageQueueService | null = null;

// Logger instance for chat controller
const logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('ChatController');

/**
 * Set the message queue service for enqueuing messages to the orchestrator.
 * Called during server initialization.
 *
 * @param service - The MessageQueueService instance
 */
export function setMessageQueueService(service: MessageQueueService): void {
  messageQueueService = service;
}

// =============================================================================
// Message Endpoints
// =============================================================================

/**
 * POST /api/chat/send
 *
 * Send a message to the orchestrator. Creates a new conversation if
 * conversationId is not provided.
 *
 * @param req - Request with body: { content: string, conversationId?: string, metadata?: object }
 * @param res - Response with sent message and conversation
 */
export async function sendMessage(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { content, conversationId, metadata, forwardToOrchestrator: shouldForward = true } = req.body;

    if (!content || (typeof content === 'string' && content.trim().length === 0)) {
      res.status(400).json({
        success: false,
        error: 'Message content is required',
      });
      return;
    }

    const input: SendMessageInput = {
      content,
      conversationId,
      metadata,
    };

    const chatService = getChatService();
    const result = await chatService.sendMessage(input);

    // Enqueue message for orchestrator processing if enabled (default: true)
    let orchestratorStatus: { forwarded: boolean; queued?: boolean; queueId?: string; error?: string } = { forwarded: false };

    if (shouldForward) {
      const backend = getSessionBackendSync();
      const sessionExists = backend?.sessionExists(ORCHESTRATOR_SESSION_NAME) ?? false;

      if (!sessionExists) {
        orchestratorStatus = {
          forwarded: false,
          error: 'Orchestrator is not running. Please start the orchestrator first.',
        };
      } else if (!messageQueueService) {
        orchestratorStatus = {
          forwarded: false,
          error: 'Message queue service not initialized',
        };
      } else {
        try {
          const queued = messageQueueService.enqueue({
            content,
            conversationId: result.conversation.id,
            source: 'web_chat',
          });
          orchestratorStatus = { forwarded: true, queued: true, queueId: queued.id };
        } catch (enqueueErr) {
          logger.warn('Failed to enqueue message', {
            error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
            conversationId: result.conversation.id,
          });
          orchestratorStatus = {
            forwarded: false,
            error: enqueueErr instanceof Error ? enqueueErr.message : 'Failed to enqueue message',
          };
        }
      }
    }

    res.status(201).json({
      success: true,
      data: {
        ...result,
        orchestrator: orchestratorStatus,
      },
    });
  } catch (error) {
    if (error instanceof MessageValidationError) {
      res.status(400).json({
        success: false,
        error: error.message,
      });
      return;
    }
    next(error);
  }
}

/**
 * GET /api/chat/messages
 *
 * Get messages for a conversation with optional filtering.
 *
 * @param req - Request with query params for filtering
 * @param res - Response with array of messages
 */
export async function getMessages(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { conversationId, senderType, contentType, after, before, limit, offset } = req.query;

    if (!conversationId) {
      res.status(400).json({
        success: false,
        error: 'conversationId is required',
      });
      return;
    }

    const filter: ChatMessageFilter = {
      conversationId: conversationId as string,
      senderType: senderType as ChatSenderType | undefined,
      contentType: contentType as ChatContentType | undefined,
      after: after as string | undefined,
      before: before as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    };

    const chatService = getChatService();
    const messages = await chatService.getMessages(filter);

    res.json({
      success: true,
      data: messages,
      count: messages.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/chat/messages/:conversationId/:messageId
 *
 * Get a single message by ID.
 *
 * @param req - Request with conversationId and messageId params
 * @param res - Response with the message
 */
export async function getMessage(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { conversationId, messageId } = req.params;

    const chatService = getChatService();
    const message = await chatService.getMessage(conversationId, messageId);

    if (!message) {
      res.status(404).json({
        success: false,
        error: 'Message not found',
      });
      return;
    }

    res.json({
      success: true,
      data: message,
    });
  } catch (error) {
    next(error);
  }
}

// =============================================================================
// Agent Response Endpoint
// =============================================================================

/**
 * POST /api/chat/agent-response
 *
 * Store an agent's response message in a chat conversation. Used by
 * orchestrator bash skills to post agent responses directly to the
 * chat without going through terminal output parsing.
 *
 * @param req - Request with body: { content, senderName, senderType?, conversationId? }
 * @param res - Response with { success, data: { messageId, conversationId } }
 * @param next - Express next function for error propagation
 *
 * @example
 * ```
 * POST /api/chat/agent-response
 * {
 *   "content": "Task completed successfully. The API endpoint is live.",
 *   "senderName": "Orchestrator",
 *   "senderType": "orchestrator",
 *   "conversationId": "conv-abc123"
 * }
 * ```
 */
export async function agentResponse(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { content, senderName, senderType, conversationId } = req.body;

    if (!content || (typeof content === 'string' && content.trim().length === 0)) {
      res.status(400).json({
        success: false,
        error: 'Message content is required',
      });
      return;
    }

    if (!senderName) {
      res.status(400).json({
        success: false,
        error: 'senderName is required',
      });
      return;
    }

    const chatService = getChatService();

    // Resolve conversation: use provided ID or get/create the current one
    let resolvedConversationId = conversationId;
    if (!resolvedConversationId) {
      const current = await chatService.getCurrentConversation();
      if (current) {
        resolvedConversationId = current.id;
      } else {
        const newConversation = await chatService.createNewConversation('Agent Chat');
        resolvedConversationId = newConversation.id;
      }
    }

    // Format and create the message
    const resolvedSenderType = senderType || 'agent';
    const formattedContent = formatMessageContent(content);
    const contentType = detectContentType(formattedContent);

    const message = createChatMessage({
      conversationId: resolvedConversationId,
      content: formattedContent,
      from: {
        type: resolvedSenderType as ChatSenderType,
        name: senderName,
      },
      contentType,
      status: 'delivered',
    });

    // Use addDirectMessage to persist and emit events
    const savedMessage = await chatService.addDirectMessage(
      resolvedConversationId,
      content,
      {
        type: resolvedSenderType as ChatSenderType,
        name: senderName,
      }
    );

    logger.info('Agent response stored via REST', {
      senderName,
      senderType: resolvedSenderType,
      conversationId: resolvedConversationId,
      messageId: savedMessage.id,
    });

    // Detect agent completion and trigger immediate orchestrator notification
    if (resolvedSenderType === 'agent' && content.startsWith('[DONE]')) {
      try {
        // 1. Enqueue notification to orchestrator via MessageQueueService
        if (messageQueueService) {
          messageQueueService.enqueue({
            content: `Agent completion: ${content}`,
            conversationId: resolvedConversationId,
            source: 'system_event',
          });
        }

        // 2. Send Slack notification to relevant threads
        const { getSlackThreadStore } = await import(
          '../../services/slack/slack-thread-store.service.js'
        );
        const { getSlackOrchestratorBridge } = await import(
          '../../services/slack/slack-orchestrator-bridge.js'
        );
        const threadStore = getSlackThreadStore();
        const threads = threadStore ? threadStore.findThreadsForAgent(senderName) : [];
        if (threads.length > 0) {
          const bridge = getSlackOrchestratorBridge();
          if (bridge) {
            const summaryText = content.replace(/^\[DONE\]\s*Agent\s+\S+:\s*/, '');
            await bridge.sendNotification({
              type: 'task_completed',
              title: 'Agent Completed',
              message: `Agent ${senderName} completed: ${summaryText}`,
              urgency: 'normal',
              timestamp: new Date().toISOString(),
              channelId: threads[0].channelId,
              threadTs: threads[0].threadTs,
            });
          }
        }
      } catch (notifyErr) {
        logger.warn('Failed to send completion notification', {
          error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
          senderName,
        });
      }
    }

    res.status(201).json({
      success: true,
      data: {
        messageId: savedMessage.id,
        conversationId: resolvedConversationId,
      },
    });
  } catch (error) {
    logger.error('Failed to store agent response', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

// =============================================================================
// Conversation Endpoints
// =============================================================================

/**
 * GET /api/chat/conversations
 *
 * List all conversations with optional filtering.
 *
 * @param req - Request with query params for filtering
 * @param res - Response with array of conversations
 */
export async function getConversations(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { includeArchived, search, limit, offset } = req.query;

    const filter: ConversationFilter = {
      includeArchived: includeArchived === 'true',
      search: search as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    };

    const chatService = getChatService();
    const conversations = await chatService.getConversations(filter);

    res.json({
      success: true,
      data: conversations,
      count: conversations.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/chat/conversations/current
 *
 * Get the current (most recent active) conversation.
 * Creates a new conversation if none exists.
 *
 * @param req - Request
 * @param res - Response with current conversation
 */
export async function getCurrentConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const chatService = getChatService();
    const conversation = await chatService.getCurrentConversation();

    if (!conversation) {
      // Create a new conversation if none exists
      const newConversation = await chatService.createNewConversation('New Chat');
      res.json({
        success: true,
        data: newConversation,
        isNew: true,
      });
      return;
    }

    res.json({
      success: true,
      data: conversation,
      isNew: false,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/chat/conversations/:id
 *
 * Get a single conversation by ID.
 *
 * @param req - Request with conversation ID param
 * @param res - Response with the conversation
 */
export async function getConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const chatService = getChatService();
    const conversation = await chatService.getConversation(id);

    if (!conversation) {
      res.status(404).json({
        success: false,
        error: 'Conversation not found',
      });
      return;
    }

    res.json({
      success: true,
      data: conversation,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/chat/conversations
 *
 * Create a new conversation.
 *
 * @param req - Request with body: { title?: string }
 * @param res - Response with created conversation
 */
export async function createConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { title } = req.body;

    const chatService = getChatService();
    const conversation = await chatService.createNewConversation(title);

    res.status(201).json({
      success: true,
      data: conversation,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/chat/conversations/:id
 *
 * Update a conversation's title.
 *
 * @param req - Request with conversation ID param and body: { title: string }
 * @param res - Response with updated conversation
 */
export async function updateConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const { title } = req.body;

    if (!title || typeof title !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Title is required',
      });
      return;
    }

    const chatService = getChatService();
    const conversation = await chatService.updateConversationTitle(id, title);

    res.json({
      success: true,
      data: conversation,
    });
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      res.status(404).json({
        success: false,
        error: 'Conversation not found',
      });
      return;
    }
    next(error);
  }
}

/**
 * PUT /api/chat/conversations/:id/archive
 *
 * Archive a conversation.
 *
 * @param req - Request with conversation ID param
 * @param res - Response confirming archive
 */
export async function archiveConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const chatService = getChatService();
    await chatService.archiveConversation(id);

    res.json({
      success: true,
      message: 'Conversation archived',
    });
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      res.status(404).json({
        success: false,
        error: 'Conversation not found',
      });
      return;
    }
    next(error);
  }
}

/**
 * PUT /api/chat/conversations/:id/unarchive
 *
 * Unarchive a conversation.
 *
 * @param req - Request with conversation ID param
 * @param res - Response confirming unarchive
 */
export async function unarchiveConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const chatService = getChatService();
    await chatService.unarchiveConversation(id);

    res.json({
      success: true,
      message: 'Conversation unarchived',
    });
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      res.status(404).json({
        success: false,
        error: 'Conversation not found',
      });
      return;
    }
    next(error);
  }
}

/**
 * DELETE /api/chat/conversations/:id
 *
 * Delete a conversation and all its messages.
 *
 * @param req - Request with conversation ID param
 * @param res - Response confirming deletion
 */
export async function deleteConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const chatService = getChatService();
    await chatService.deleteConversation(id);

    res.json({
      success: true,
      message: 'Conversation deleted',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/chat/conversations/:id/clear
 *
 * Clear all messages in a conversation.
 *
 * @param req - Request with conversation ID param
 * @param res - Response confirming clear
 */
export async function clearConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const chatService = getChatService();
    await chatService.clearConversation(id);

    res.json({
      success: true,
      message: 'Conversation cleared',
    });
  } catch (error) {
    next(error);
  }
}

// =============================================================================
// Statistics Endpoint
// =============================================================================

/**
 * GET /api/chat/statistics
 *
 * Get chat statistics.
 *
 * @param req - Request
 * @param res - Response with statistics
 */
export async function getStatistics(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const chatService = getChatService();
    const statistics = await chatService.getStatistics();

    res.json({
      success: true,
      data: statistics,
    });
  } catch (error) {
    next(error);
  }
}
