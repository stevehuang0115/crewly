/**
 * Slack-Orchestrator Bridge
 *
 * Routes messages between Slack and the Crewly orchestrator,
 * enabling mobile control of AI teams.
 *
 * @module services/slack/bridge
 */

import { EventEmitter } from 'events';
import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { PDFParse } from 'pdf-parse';
import { getSlackService, SlackService } from './slack.service.js';
import { getChatService, ChatService } from '../chat/chat.service.js';
import {
  isOrchestratorActive,
  isAgentActive,
  getOrchestratorOfflineMessage,
  triggerOrchestratorSetup,
} from '../orchestrator/index.js';
import {
  SlackIncomingMessage,
  SlackNotification,
  SlackConversationContext,
  SlackImageInfo,
  SlackFileInfo,
  SlackFile,
  SlackBlock,
  SlackTextObject,
  SlackElement,
  ParsedSlackCommand,
  parseCommandIntent,
} from '../../types/slack.types.js';
import { ContentApprovalService } from '../onboarding/content-approval.service.js';
import { getSlackImageService } from './slack-image.service.js';
import type { MessageQueueService } from '../messaging/message-queue.service.js';
import type { SlackThreadStoreService } from './slack-thread-store.service.js';
import { ORCHESTRATOR_SESSION_NAME, MESSAGE_QUEUE_CONSTANTS, SLACK_IMAGE_CONSTANTS, SLACK_FILE_DOWNLOAD_CONSTANTS, SLACK_BRIDGE_CONSTANTS, AUDITOR_SCHEDULER_CONSTANTS, THREAD_STATUS_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { CROSS_MACHINE_PREFIX } from '../../types/cross-machine.types.js';
import { getCrossMachineMessageService } from './cross-machine-message.service.js';
import type { ThreadStatusQueueService } from '../messaging/thread-status-queue.service.js';
import { TERMINAL_REQUEST_STATUSES } from '../../types/v2/request.types.js';

/**
 * Bridge configuration
 */
export interface SlackBridgeConfig {
  /** Orchestrator session name */
  orchestratorSession: string;
  /** Enable typing indicators */
  showTypingIndicator: boolean;
  /** Maximum response length before truncation */
  maxResponseLength: number;
  /** Enable proactive notifications */
  enableNotifications: boolean;
  /** Response timeout in ms */
  responseTimeoutMs: number;
  /** Time to wait for reply-slack skill before fallback delivery (ms) */
  skillDeliveryWaitMs: number;
}

/**
 * Internal envelope for orchestrator-bound responses.
 *
 * The orchestrator bridge needs to distinguish a real orc reply (delivered
 * via the `slackResolve` callback fired by the orc's reply-slack skill)
 * from a placeholder string returned on `responseTimeoutMs` /
 * orchestrator-offline / queue-error fallbacks. Only real orc replies
 * may auto-resolve the V3 SLA tracker (`markResolvedByThread`).
 *
 * Steve 2026-04-30 incident: a 30s timeout placeholder was firing
 * `markResolvedByThread`, then PR #382's cascade closed the parent
 * Request to `done` even though the orc never received the message
 * (Bug 1: agent-registration skip-rewrite swallowed the input).
 *
 * @internal
 */
interface OrcResponse {
  /** Response text shown to the user (real orc reply OR placeholder). */
  response: string;
  /**
   * `true` only when the response originated from the orc's `slackResolve`
   * callback (reply-slack skill). `false` for any timeout / offline /
   * fallback path. Drives whether the SLA chain is auto-resolved.
   */
  fromOrcReply: boolean;
}

/**
 * Default bridge configuration
 */
const DEFAULT_CONFIG: SlackBridgeConfig = {
  orchestratorSession: ORCHESTRATOR_SESSION_NAME,
  showTypingIndicator: true,
  maxResponseLength: 3000,
  enableNotifications: true,
  responseTimeoutMs: (MESSAGE_QUEUE_CONSTANTS?.DEFAULT_MESSAGE_TIMEOUT ?? 120000) + 5000,
  skillDeliveryWaitMs: SLACK_BRIDGE_CONSTANTS?.SKILL_DELIVERY_WAIT_MS ?? 3000,
};

/**
 * Maximum time to wait for an auto-recovery setup attempt before giving
 * up and falling through to the offline path. Capped tight to avoid
 * blocking the message ingress thread when setup is wedged.
 */
const AUTO_RECOVERY_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Auto-Request suppression gates (Pipeline-#4 fix, Patch D)
//
// Spec: 2026-05-05-request-decompose-pipeline-gap.md §4 Patch D.
// Live data measured ~80% of auto-Requests in D0AC7NF5N7L matched one of
// these gates and were never actionable.
// ---------------------------------------------------------------------------

/**
 * Minimum trimmed text length required to create an auto-Request. Anything
 * shorter is treated as "trivial" (length-gate). Set deliberately tight so a
 * one-sentence command like "fix the build" (15 chars) still passes.
 */
const MIN_AUTO_REQUEST_TEXT_LENGTH = 12;

/**
 * Trimmed-text regex for trivial acknowledgement messages — anchored,
 * case-insensitive, allows trailing punctuation/emoji whitespace. Matches
 * "ok", "好的", "thx", "👍", etc. Add new locale tokens here as needed.
 */
const TRIVIAL_ACK_PATTERN = /^(ok|好的|收到|thx|thanks|谢谢|👍|✅|got it|sure|yes|是|对|对的)\W*$/i;

/**
 * Trimmed-text regex matching the synthetic `[Slack File: …]` titles
 * generated by the file-handling path when a user uploads a file with no
 * narrative. Caught before the thread-continuation gate to avoid the lookup.
 */
const FILE_ONLY_TITLE_PATTERN = /^\[Slack File:[^\]]*\]\.?\s*$/;

/**
 * Pure pre-fetch gates for auto-Request suppression (Patch D). Exported for
 * focused unit testing — the full thread-continuation gate also lives in
 * {@link SlackOrchestratorBridge.shouldSuppressAutoRequest} but requires a
 * RequestService lookup so cannot be a pure function.
 *
 * Each function returns the suppression reason string (matches the values
 * logged at debug level) or `null` when the gate does not match.
 */
export function suppressTrivialOrShort(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (trimmed.length < MIN_AUTO_REQUEST_TEXT_LENGTH || TRIVIAL_ACK_PATTERN.test(trimmed)) {
    return 'trivial_or_short';
  }
  return null;
}

export function suppressFileOnly(rawText: string): string | null {
  const trimmed = rawText.trim();
  return FILE_ONLY_TITLE_PATTERN.test(trimmed) ? 'file_only' : null;
}

/**
 * Slack-Orchestrator Bridge singleton
 */
let bridgeInstance: SlackOrchestratorBridge | null = null;

/**
 * SlackOrchestratorBridge class
 *
 * Routes messages between Slack and the Crewly orchestrator.
 * Handles command parsing, response formatting, and proactive notifications.
 *
 * @example
 * ```typescript
 * const bridge = getSlackOrchestratorBridge();
 * await bridge.initialize();
 *
 * // Send notification when task completes
 * await bridge.notifyTaskCompleted('Fix bug', 'Developer', 'MyProject');
 * ```
 */
export class SlackOrchestratorBridge extends EventEmitter {
  private logger = LoggerService.getInstance().createComponentLogger('SlackBridge');
  private slackService: SlackService;
  private chatService: ChatService;
  private messageQueueService: MessageQueueService | null = null;
  private threadStatusQueue: ThreadStatusQueueService | null = null;
  private threadStore: SlackThreadStoreService | null = null;
  private config: SlackBridgeConfig;
  private initialized = false;
  /** Track if we've already logged the missing scope warning */
  private loggedMissingScope = false;

  /**
   * Pending completion reactions keyed by "channelId:threadTs".
   * Stores the original message ts so that the ✅ reaction is added to the
   * correct message when the reply-slack skill delivers a response.
   */
  private pendingReactions = new Map<string, string>();

  /**
   * Track channel+thread pairs where Slack delivery was already handled
   * by the reply-slack skill (execute.sh). Used by sendSlackResponse to
   * avoid sending a duplicate fallback message to the same thread.
   */

  /**
   * Create a new SlackOrchestratorBridge
   *
   * @param config - Partial configuration to override defaults
   */
  constructor(config: Partial<SlackBridgeConfig> = {}) {
    super();
    this.slackService = getSlackService();
    this.chatService = getChatService();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the bridge
   *
   * Sets up message listeners and orchestrator subscriptions.
   *
   * @returns Promise that resolves when initialized
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Listen for Slack messages
    this.slackService.on('message', this.handleSlackMessage.bind(this));

    // Initialize cross-machine messaging and route received messages to orchestrator
    try {
      const crossMachineService = getCrossMachineMessageService();
      await crossMachineService.initialize();
      crossMachineService.on('message', (msg) => {
        this.handleCrossMachineMessage(msg);
      });
      this.logger.info('Cross-machine message listener registered');
    } catch (err) {
      this.logger.warn('Cross-machine messaging not available', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.initialized = true;
    this.logger.info('Initialized');
  }

  /**
   * Check if bridge is initialized
   *
   * @returns True if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Set the message queue service for enqueuing messages to the orchestrator.
   * Called during server initialization.
   *
   * @param service - The MessageQueueService instance
   */
  setMessageQueueService(service: MessageQueueService): void {
    this.messageQueueService = service;
  }

  /**
   * Set the thread status queue service for tracking inbound message lifecycle.
   * Called during server initialization.
   *
   * @param service - The ThreadStatusQueueService instance
   */
  setThreadStatusQueue(service: ThreadStatusQueueService): void {
    this.threadStatusQueue = service;
  }

  /**
   * Set the Slack thread store service for persisting thread conversations.
   * Called during server initialization.
   *
   * @param store - The SlackThreadStoreService instance
   */
  setSlackThreadStore(store: SlackThreadStoreService): void {
    this.threadStore = store;
  }

  /**
   * Get current configuration
   *
   * @returns A copy of the current configuration
   */
  getConfig(): SlackBridgeConfig {
    return { ...this.config };
  }

  /**
   * Handle incoming Slack message
   *
   * Parses the command, routes to appropriate handler, and sends response.
   *
   * @param message - Incoming Slack message
   */
  private async handleSlackMessage(message: SlackIncomingMessage): Promise<void> {
    this.logger.info('Received message', {
      preview: (message.text || '').substring(0, 50),
      hasImages: message.hasImages,
      hasFiles: message.hasFiles,
      fileCount: message.files?.length || 0,
    });

    try {
      // Cross-machine message intercept — detect and route before normal processing
      if (message.text && message.text.startsWith(CROSS_MACHINE_PREFIX)) {
        const crossMachineService = getCrossMachineMessageService();
        if (crossMachineService.isEnabled()) {
          const handled = crossMachineService.handleIncomingMessage(message);
          if (handled) {
            this.logger.debug('Cross-machine message handled', {
              preview: message.text.substring(0, 80),
            });
            return; // Don't process as a normal message
          }
        }
      }

      // Download files if present (both images and non-image files)
      if (message.hasFiles && message.files) {
        const imageFiles = message.files.filter(f => f.mimetype?.startsWith('image/'));
        const nonImageFiles = message.files.filter(f => !f.mimetype?.startsWith('image/'));

        // Download images via existing path (pass only imageFiles to avoid redundant API calls)
        if (imageFiles.length > 0) {
          await this.downloadMessageImages(message, imageFiles);
        }

        // Download non-image files
        if (nonImageFiles.length > 0) {
          await this.downloadMessageFiles(message, nonImageFiles);
        }
      }

      // Get or create conversation context
      const context = this.slackService.getConversationContext(
        message.threadTs || message.ts,
        message.channelId,
        message.userId
      );

      // Build enriched text with file references for the agent
      const enrichedText = this.enrichTextWithFiles(message);

      // Store inbound message in thread file (with image metadata)
      if (this.threadStore) {
        const threadTs = message.threadTs || message.ts;
        try {
          const userName = message.user?.realName || message.user?.name || message.userId;
          await this.threadStore.appendUserMessage(
            message.channelId,
            threadTs,
            userName,
            enrichedText,
            message.images
          );
        } catch (err) {
          this.logger.warn('Failed to store thread message', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Override message text with enriched version for downstream processing
      message.text = enrichedText;

      // Auditor prefix routing — intercept "auditor ...", "/auditor ...", or "@auditor ..." messages
      const auditorMatch = enrichedText.match(/^[/@]?auditor[\s:]+(.+)/is);
      if (auditorMatch) {
        const auditorMessage = auditorMatch[1].trim();
        try {
          if (this.config.showTypingIndicator) {
            await this.addTypingIndicator(message);
          }
          const { AuditorSchedulerService } = await import('../agent/auditor-scheduler.service.js');
          const scheduler = AuditorSchedulerService.getInstance();
          await scheduler.handleUserMessage(auditorMessage, {
            channelId: message.channelId,
            threadTs: message.threadTs || message.ts,
          });
          if (this.config.showTypingIndicator) {
            await this.markComplete(message);
          }
        } catch (error) {
          await this.sendErrorResponse(message, error as Error);
        }
        return;
      }

      // #177: @mention routing — route to specific agent if @name is detected
      const mentionTarget = await this.resolveMentionTarget(enrichedText);
      if (mentionTarget) {
        const isActive = await isAgentActive(mentionTarget.sessionName);
        if (isActive) {
          this.logger.info('Routing message to mentioned agent', {
            agent: mentionTarget.name,
            session: mentionTarget.sessionName,
          });
          if (this.config.showTypingIndicator) {
            await this.addTypingIndicator(message);
          }
          // Strip the @mention prefix and send to the target agent
          const cleanMessage = enrichedText.replace(new RegExp(`^@${mentionTarget.name}\\s*`, 'i'), '').trim();
          const response = await this.sendToAgent(mentionTarget.sessionName, cleanMessage || enrichedText, context);
          // Same empty-response guard as the orchestrator route — an
          // empty response is QueueProcessor's fire-and-forget delivery
          // ack, not a real reply. Don't auto-resolve the SLA tracker.
          await this.sendSlackResponse(message, response, response.length > 0);
          if (this.config.showTypingIndicator) {
            await this.markComplete(message);
          }
          return;
        } else {
          this.logger.info('Mentioned agent is inactive, falling back to orchestrator', {
            agent: mentionTarget.name,
          });
        }
      }

      // Parse command intent
      const command = this.parseCommand(message.text);

      // Add typing indicator
      if (this.config.showTypingIndicator) {
        await this.addTypingIndicator(message);
      }

      // Handle based on intent.
      // `response` is the user-visible text; `fromOrcReply` tracks whether
      // the response came from the orc's reply-slack callback (true) or a
      // local string / fallback / placeholder (false). Only true responses
      // may auto-resolve the V3 SLA tracker downstream.
      let response: string;
      let fromOrcReply = false;
      let isOrchestratorRoute = false;
      switch (command.intent) {
        case 'help':
          response = this.getHelpMessage();
          break;
        case 'status': {
          const r = await this.handleStatusCommand(command, context);
          response = r.response;
          fromOrcReply = r.fromOrcReply;
          break;
        }
        case 'list_projects':
        case 'list_teams':
        case 'list_agents': {
          const r = await this.handleListCommand(command, context);
          response = r.response;
          fromOrcReply = r.fromOrcReply;
          break;
        }
        case 'pause':
        case 'resume': {
          const r = await this.handleControlCommand(command, context);
          response = r.response;
          fromOrcReply = r.fromOrcReply;
          break;
        }
        default:
          // V3 Request creation for Slack user messages — fire-and-forget
          setImmediate(async () => {
            try {
              const { RequestService } = await import('../v3/request.service.js');
              const svc = RequestService.getInstance();
              // 2026-05-13 dogfood fix: encode BOTH thread root AND message
              // ts in sourceConversationItemId. The previous form was
              // `slack-{channel}-{message.ts}`, which made
              // `extractSlackThreadTs(sourceConv)` return the per-message
              // ts — never the actual Slack thread root. The SLA
              // threadIndex therefore mapped per-message ts → requestId,
              // but when orc replied via reply-slack → POST /api/slack/send
              // → markResolvedByThread(realThreadRoot), the lookup missed
              // and the Request never auto-closed (PR #538 hook was a
              // no-op for thread-reply messages).
              //
              // New form:
              //   Top-level message (msg.ts == thread root):
              //     `slack-{channelId}-{ts}`              (unchanged)
              //   Reply within an existing thread:
              //     `slack-{channelId}-{threadRoot}-msg-{messageTs}`
              //
              // The `-msg-{...}` suffix preserves per-message uniqueness
              // so `findBySourceConversationItemId` still works. The
              // updated `parseSlackThreadContext` strips the suffix
              // before extracting the threadTs, so the SLA's threadIndex
              // now keys on the actual thread root for both shapes.
              const threadRoot = message.threadTs || message.ts;
              const msgId = message.threadTs && message.threadTs !== message.ts
                ? `slack-${message.channelId}-${threadRoot}-msg-${message.ts}`
                : `slack-${message.channelId}-${message.ts}`;
              const existing = await svc.findBySourceConversationItemId(msgId);
              if (existing) return;

              const rawText = message.text || '';

              // Pipeline-#4 fix (spec 2026-05-05-request-decompose-pipeline-gap.md,
              // Patch D): suppress trivial / continuation / file-only Slack messages
              // that pollute the Request stream without ever becoming actionable
              // work. ~80% of historical auto-Requests in D0AC7NF5N7L matched one
              // of these gates (dogfood data 2026-05-05).
              const suppressionReason = await this.shouldSuppressAutoRequest(message, rawText, svc);
              if (suppressionReason) {
                this.logger.debug('V3 Request creation suppressed', { msgId, reason: suppressionReason });
                return;
              }

              const { generateRequestTitle, classifyIntent } = await import('../v3/v3-data.service.js');
              // Auto-classify so request-decompose.subscriber sees correct
              // intentLevel/intentCategory. Without this, every Slack-auto
              // Request defaulted to L1+other and was never decomposed
              // into delegation WorkItems — the entire Slack→WorkItem
              // pipeline was silently no-op.
              const { intentLevel, intentCategory } = classifyIntent(rawText);
              const request = await svc.create({
                title: generateRequestTitle(rawText, intentCategory),
                description: rawText,
                sourceConversationItemId: msgId,
                priority: 'normal',
                tags: ['slack'],
                intentLevel,
                intentCategory,
              });
              // P2-2: RequestTracker.setActiveRequest write removed. The
              // companion read in v3-data.service.ts no longer falls back
              // to time-window correlation; downstream delegate-task
              // skills must now pass requestId explicitly.
              this.logger.debug('V3 Request created from Slack message', { msgId, requestId: request.id });
            } catch (err) {
              this.logger.warn('V3 Request creation from Slack failed (non-critical)', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          });
          // Send to orchestrator for processing
          {
            const r = await this.sendToOrchestrator(message.text, context);
            response = r.response;
            fromOrcReply = r.fromOrcReply;
          }
          isOrchestratorRoute = true;
      }

      // Send response back to Slack. The `fromOrcReply` flag gates the V3
      // SLA auto-resolve hook inside sendSlackResponse — placeholders and
      // fallbacks must NOT mark the respond_to_user WI as resolved.
      await this.sendSlackResponse(message, response, fromOrcReply);

      // For orchestrator-routed messages, defer ✅ until reply-slack delivers
      // the actual response. Store pending reaction keyed by channel+thread
      // so addCompletionReaction() can find it when the reply arrives.
      if (isOrchestratorRoute && this.config.showTypingIndicator) {
        const threadTs = message.threadTs || message.ts;
        const key = `${message.channelId}:${threadTs}`;
        this.pendingReactions.set(key, message.ts);
      } else if (this.config.showTypingIndicator) {
        // Non-orchestrator commands complete immediately
        await this.markComplete(message);
      }

      this.emit('message_handled', { message, response });
    } catch (error) {
      this.logger.error('Error handling message', { error: error instanceof Error ? error.message : String(error) });
      await this.sendErrorResponse(message, error as Error);
      this.emit('error', error);
    }
  }

  /**
   * Handle an incoming cross-machine message.
   * Routes the message payload to the local orchestrator via the message queue.
   *
   * @param msg - Parsed cross-machine message
   */
  private async handleCrossMachineMessage(msg: import('../../types/cross-machine.types.js').CrossMachineMessage): Promise<void> {
    this.logger.info('Routing cross-machine message to orchestrator', {
      from: msg.fromName,
      type: msg.type,
      messageId: msg.messageId,
    });

    // Format as a human-readable message for the orchestrator
    const orchestratorMessage = [
      `[Cross-Machine] from ${msg.fromName} (${msg.from})`,
      `Type: ${msg.type}`,
      msg.payload.message ? `Message: ${msg.payload.message}` : '',
      msg.payload.task ? `Task: ${msg.payload.task}` : '',
      msg.payload.priority ? `Priority: ${msg.payload.priority}` : '',
      msg.payload.context ? `Context: ${msg.payload.context}` : '',
      msg.payload.summary ? `Summary: ${msg.payload.summary}` : '',
    ].filter(Boolean).join('\n');

    if (this.messageQueueService) {
      try {
        this.messageQueueService.enqueue({
          content: orchestratorMessage,
          conversationId: `x-machine-${msg.from}-${Date.now()}`,
          source: 'cross-machine',
          sourceMetadata: {
            fromDevice: msg.from,
            fromDeviceName: msg.fromName,
            messageType: msg.type,
            messageId: msg.messageId,
          },
        });
        this.logger.info('Cross-machine message enqueued to orchestrator');
      } catch (err) {
        this.logger.error('Failed to enqueue cross-machine message', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      this.logger.warn('Cannot route cross-machine message — MessageQueueService not available');
    }
  }

  /**
   * Parse command from message text
   *
   * Cleans the message and extracts the command intent.
   *
   * @param text - Raw message text
   * @returns Parsed command with intent and parameters
   */
  parseCommand(text: string): ParsedSlackCommand {
    // Remove bot mention if present
    const cleanedText = text.replace(/<@[A-Z0-9]+>/g, '').trim();

    return {
      intent: parseCommandIntent(cleanedText),
      rawText: cleanedText,
      parameters: this.extractParameters(cleanedText),
    };
  }

  /**
   * Extract parameters from command text
   *
   * @param text - Command text
   * @returns Extracted parameters
   */
  private extractParameters(text: string): Record<string, string> {
    const params: Record<string, string> = {};

    // Extract quoted strings
    const quotedMatch = text.match(/"([^"]+)"/);
    if (quotedMatch) {
      params.quoted = quotedMatch[1];
    }

    // Extract @mentions
    const mentionMatch = text.match(/@(\w+)/);
    if (mentionMatch) {
      params.mention = mentionMatch[1];
    }

    // Extract project/team names after keywords
    const forMatch = text.match(/(?:for|on|in)\s+(\w+)/i);
    if (forMatch) {
      params.target = forMatch[1];
    }

    return params;
  }

  /**
   * Get help message
   *
   * @returns Formatted help message for Slack
   */
  getHelpMessage(): string {
    return `*Crewly Commands:*

:clipboard: *Status*
• \`status\` - Get overall status
• \`status [project name]\` - Get project status
• \`how is [team] doing\` - Get team progress

:page_facing_up: *Lists*
• \`list projects\` - Show all projects
• \`list teams\` - Show all teams
• \`list agents\` or \`who's working\` - Show active agents

:gear: *Actions*
• \`assign [task] to [agent/team]\` - Assign work
• \`create task: [description]\` - Create a new task
• \`pause [agent/team]\` - Pause work
• \`resume [agent/team]\` - Resume work

:speech_balloon: *Chat*
Just type naturally to chat with the orchestrator!`;
  }

  /**
   * Determine whether an inbound Slack message should be suppressed from
   * auto-Request creation. Returns a reason string when the message should
   * be skipped, or `null` when a Request should be created normally.
   *
   * Three gates (Pipeline-#4 fix, spec
   * 2026-05-05-request-decompose-pipeline-gap.md, Patch D):
   *
   *   1. **Length / acknowledgement gate.** Trimmed text is shorter than
   *      {@link MIN_AUTO_REQUEST_TEXT_LENGTH} OR matches the trivial
   *      acknowledgement allowlist ({@link TRIVIAL_ACK_PATTERN}). Catches
   *      "好的", "ok", "👍", "thx" — class noise that is never actionable.
   *
   *   2. **Thread continuation gate.** When the inbound message is a reply
   *      inside an existing thread (`message.threadTs` ≠ `message.ts`) AND a
   *      Request already exists for the **parent** message, suppress to
   *      prevent every "are we still in this thread?" follow-up from creating
   *      a new sibling Request. Existing Request continues to receive
   *      orchestrator routing.
   *
   *   3. **File-only / synthetic-title gate.** Messages whose text is a
   *      synthetic `[Slack File: …]` placeholder with no narrative are
   *      artefacts of slack-bridge file-handling, not user requests.
   *
   * Each gate returns a stable reason string for log auditability. The
   * caller logs at `debug` so suppression decisions are observable without
   * noise.
   *
   * @param message - The incoming Slack message (already validated)
   * @param rawText - The raw text body, trimmed by caller if needed
   * @param svc - The RequestService instance for the thread-continuation lookup
   * @returns A reason string when suppressed; `null` when allowed
   */
  private async shouldSuppressAutoRequest(
    message: SlackIncomingMessage,
    rawText: string,
    svc: import('../v3/request.service.js').RequestService,
  ): Promise<string | null> {
    const trimmed = rawText.trim();

    // Gate 1 — length + ack allowlist
    if (trimmed.length < MIN_AUTO_REQUEST_TEXT_LENGTH || TRIVIAL_ACK_PATTERN.test(trimmed)) {
      return 'trivial_or_short';
    }

    // Gate 3 — file-only synthetic title (run before gate 2 to skip the I/O)
    if (FILE_ONLY_TITLE_PATTERN.test(trimmed)) {
      return 'file_only';
    }

    // Gate 2 — thread continuation: this message is a reply, and the parent
    // message already has a NON-TERMINAL Request. Cheaper than threading
    // detection at the SLA layer.
    //
    // ARCH 2026-05-05 PR #453 review (NC-1): the gate MUST check
    // `parentRequest.status` is non-terminal — otherwise a thread that
    // completed (parent → done via orc_reply / orc_reply_recheck) and then
    // received a NEW actionable user message would silently suppress the new
    // Request, re-opening the user-visible reliability gap that INBOUND-1
    // was built to close. Terminal-parent threads release suppression so the
    // child message creates a fresh Request.
    const threadTs = message.threadTs;
    if (threadTs && threadTs !== message.ts) {
      const parentMsgId = `slack-${message.channelId}-${threadTs}`;
      const parentRequest = await svc.findBySourceConversationItemId(parentMsgId);
      if (parentRequest && !TERMINAL_REQUEST_STATUSES.has(parentRequest.status)) {
        return 'thread_continuation';
      }
    }

    return null;
  }

  /**
   * Handle status command
   *
   * @param command - Parsed command
   * @param context - Conversation context
   * @returns Status response
   */
  private async handleStatusCommand(
    command: ParsedSlackCommand,
    context: SlackConversationContext
  ): Promise<OrcResponse> {
    return await this.sendToOrchestrator(
      `Give me a brief status update. ${command.rawText}`,
      context
    );
  }

  /**
   * Handle list commands (projects, teams, agents)
   *
   * @param command - Parsed command
   * @param context - Conversation context
   * @returns List response
   */
  private async handleListCommand(
    command: ParsedSlackCommand,
    context: SlackConversationContext
  ): Promise<OrcResponse> {
    const prompts: Record<string, string> = {
      list_projects: 'List all active projects with their status.',
      list_teams: 'List all teams and their current assignments.',
      list_agents: 'List all agents, their status, and what they are working on.',
    };

    return await this.sendToOrchestrator(
      prompts[command.intent] || command.rawText,
      context
    );
  }

  /**
   * Handle control commands (pause, resume)
   *
   * @param command - Parsed command
   * @param context - Conversation context
   * @returns Control response
   */
  private async handleControlCommand(
    command: ParsedSlackCommand,
    context: SlackConversationContext
  ): Promise<OrcResponse> {
    const action = command.intent === 'pause' ? 'Pause' : 'Resume';
    const target = command.parameters.target || command.parameters.mention || 'all agents';

    return await this.sendToOrchestrator(`${action} ${target}.`, context);
  }

  /**
   * Attempt to auto-recover the orchestrator with a hard timeout.
   *
   * Calls `triggerOrchestratorSetup()` from the orchestrator service module
   * directly (bypassing HTTP). Wraps the attempt in a 5-second deadline so
   * a wedged setup cannot stall the Slack message ingress thread.
   *
   * Behavior:
   * - Timeout: rejects with a TimeoutError-like message after 5s.
   * - Setup error: rejects with the underlying error.
   * - Setup returning `success: false`: rejects with the recorded error
   *   (the caller treats this the same as a thrown error and falls
   *   through to the offline path).
   *
   * Caller is expected to wrap the call in try/catch and continue down
   * the offline path on rejection — auto-recovery is best-effort.
   *
   * @returns Resolves when setup completes successfully (or was skipped
   *          because the orc was already healthy)
   * @throws Error on timeout or setup failure
   * @internal Visible for tests via class member access.
   */
  private async attemptAutoRecovery(): Promise<void> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`auto-recovery setup timed out after ${AUTO_RECOVERY_TIMEOUT_MS}ms`));
      }, AUTO_RECOVERY_TIMEOUT_MS);
      // Don't keep the process alive just for this timer
      timeoutHandle.unref?.();
    });

    try {
      const result = await Promise.race([triggerOrchestratorSetup(), timeoutPromise]);
      if (!result.success) {
        throw new Error(result.error || 'orchestrator setup returned success=false');
      }
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Send message to orchestrator via the message queue and wait for response.
   *
   * Checks if the orchestrator is active before sending. Enqueues the message
   * and waits for the response via a resolve callback injected into sourceMetadata.
   *
   * @param message - Message to send
   * @param context - Optional conversation context
   * @returns Orchestrator response or offline/error message
   */
  private async sendToOrchestrator(
    message: string,
    context?: SlackConversationContext
  ): Promise<OrcResponse> {
    try {
      // Check if orchestrator is active before attempting to send
      let isActive = await isOrchestratorActive();

      // Auto-recovery (B0 hot-fix, defense-in-depth):
      // ESTestNode regression — `isActive` falsely reports offline when the
      // orchestrator is an in-process Crewly Agent runtime that has lost its
      // status registration but is otherwise healthy. Before falling
      // through to the offline path, attempt one synchronous setup call.
      // This is intentionally once-per-message (not retry-loop). On
      // success we re-check isActive and proceed normally; on failure we
      // continue down the existing offline branch (Auditor + queue).
      if (!isActive) {
        const recoveryStart = Date.now();
        this.logger.info('Orchestrator offline — attempting auto-recovery via triggerOrchestratorSetup', {
          timeoutMs: AUTO_RECOVERY_TIMEOUT_MS,
        });
        try {
          await this.attemptAutoRecovery();
          isActive = await isOrchestratorActive();
          this.logger.info('Auto-recovery setup attempt complete', {
            elapsedMs: Date.now() - recoveryStart,
            isActiveAfter: isActive,
          });
        } catch (err) {
          this.logger.warn('Auto-recovery setup attempt failed (falling through to offline path)', {
            elapsedMs: Date.now() - recoveryStart,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!isActive) {
        // Fallback: route to Auditor agent if it's active
        const auditorSession = AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME;
        const auditorActive = await isAgentActive(auditorSession);
        if (auditorActive) {
          this.logger.info('Orchestrator offline — routing message to Auditor agent');
          // Auditor fallback is NOT an orc reply — caller must not auto-resolve SLA.
          const fallback = await this.sendToAuditorFallback(message, context);
          return { response: fallback, fromOrcReply: false };
        }

        // #247: Queue the message for replay when orchestrator comes back online,
        // instead of silently dropping it. The queue processor defers delivery
        // until the orchestrator registers (agentStatus === 'active').
        // NOTE: This is an offline-path acknowledgement, NOT a real orc reply —
        // every return from this branch must set `fromOrcReply: false`.
        if (this.messageQueueService) {
          this.logger.info('Orchestrator offline — queuing message for replay when it comes back online');

          // Enrich message with thread file path hint for orchestrator context
          let enrichedMessage = message;
          if (this.threadStore && context) {
            const threadFilePath = this.threadStore.getThreadFilePath(context.channelId, context.threadTs);
            enrichedMessage = `${message}\n\n[Thread context file: ${threadFilePath}]`;
          }

          // Store in chat service for persistence
          const result = await this.chatService.sendMessage({
            content: enrichedMessage,
            conversationId: context?.conversationId,
            metadata: {
              source: 'slack',
              userId: context?.userId,
              channelId: context?.channelId,
            },
          });

          try {
            this.messageQueueService.enqueue({
              content: enrichedMessage,
              conversationId: result.conversation.id,
              source: 'slack',
              sourceMetadata: {
                userId: context?.userId,
                channelId: context?.channelId,
                threadTs: context?.threadTs,
              },
            });

            // Track inbound thread for offline message recovery
            if (this.threadStatusQueue && context?.channelId) {
              try {
                const threadKey = context.threadTs
                  ? `${context.channelId}:${context.threadTs}`
                  : `${context.channelId}:${Date.now()}`;
                this.threadStatusQueue.trackInbound({
                  source: 'slack',
                  threadKey,
                  conversationId: result.conversation.id,
                  messagePreview: message.slice(0, THREAD_STATUS_CONSTANTS.MAX_PREVIEW_LENGTH),
                  sourceMetadata: {
                    channelId: context.channelId,
                    threadTs: context.threadTs,
                    userId: context.userId,
                  },
                });
              } catch (trackErr) {
                this.logger.warn('Failed to track inbound thread status (offline path)', {
                  error: trackErr instanceof Error ? trackErr.message : String(trackErr),
                });
              }
            }

            return {
              response: 'The orchestrator is currently offline. Your message has been queued and will be processed when it comes back online.',
              fromOrcReply: false,
            };
          } catch (enqueueErr) {
            this.logger.warn('Failed to queue message for offline orchestrator', {
              error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
            });
          }
        }

        this.logger.info('Orchestrator is not active, returning offline message');
        return { response: getOrchestratorOfflineMessage(true), fromOrcReply: false };
      }

      // Check if message queue service is available
      if (!this.messageQueueService) {
        this.logger.error('Message queue service not configured');
        return {
          response: 'The Slack bridge is not properly configured. Please restart the server.',
          fromOrcReply: false,
        };
      }

      // Enrich message with thread file path hint for orchestrator context
      let enrichedMessage = message;
      if (this.threadStore && context) {
        const threadFilePath = this.threadStore.getThreadFilePath(context.channelId, context.threadTs);
        enrichedMessage = `${message}\n\n[Thread context file: ${threadFilePath}]`;
      }

      // Send message via chat service to store it
      const result = await this.chatService.sendMessage({
        content: enrichedMessage,
        conversationId: context?.conversationId,
        metadata: {
          source: 'slack',
          userId: context?.userId,
          channelId: context?.channelId,
        },
      });

      // Enqueue the message with a resolve callback for response routing.
      // The QueueProcessorService will call slackResolve() when the
      // orchestrator responds, unblocking this promise.
      //
      // The promise resolves with `{response, fromOrcReply}`. `fromOrcReply`
      // is `true` ONLY when slackResolve fires (orc's reply-slack skill
      // delivered an actual reply). On responseTimeoutMs or enqueue failure
      // it is `false` — the placeholder must NOT auto-resolve the SLA
      // tracker (Steve 2026-04-30 incident: false-done Request cascade).
      const orcResponse = await new Promise<OrcResponse>((resolve) => {
        let resolved = false;

        const timeoutId = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve({
              response: 'The orchestrator is still processing your request. It will reply here when ready — no need to resend.',
              fromOrcReply: false,
            });
          }
        }, this.config.responseTimeoutMs);

        try {
          this.messageQueueService!.enqueue({
            content: enrichedMessage,
            conversationId: result.conversation.id,
            source: 'slack',
            sourceMetadata: {
              slackResolve: (resp: string) => {
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeoutId);
                  // 2026-05-12 dogfood bug: the QueueProcessor fires
                  // `routeResponse(message, '')` immediately after PTY
                  // delivery to unblock this promise (see
                  // queue-processor.service.ts:692 "fire-and-forget"
                  // comment). That call carries an EMPTY response — orc
                  // has only RECEIVED the message, not REPLIED. The
                  // previous shape of this callback always returned
                  // `fromOrcReply: true`, so every Slack delivery
                  // triggered `markResolvedByThread('orc_reply')` →
                  // `maybeCloseRequest` → Request cascaded to `done`
                  // with `result: "Auto-closed by SLA: orc_reply"`
                  // before the user ever saw a reply.
                  //
                  // Real orc replies (via the reply-slack skill) come
                  // through a different route — the orc invokes
                  // `POST /slack/send`, which posts to Slack directly;
                  // the SLA tracker is resolved when the
                  // `respond_to_user` WI transitions to `verified` and
                  // the cascade subscriber picks it up. That path
                  // produces a non-empty response payload only when
                  // a worker explicitly drives reply text back through
                  // the queue (rare; most orc replies are direct API).
                  //
                  // Gate: treat empty resp as a delivery ack ONLY
                  // (fromOrcReply=false). Non-empty resp keeps the
                  // legacy `true` semantics for any worker path that
                  // does echo a reply through the queue.
                  const fromOrcReply = resp.length > 0;
                  resolve({ response: resp, fromOrcReply });
                }
              },
              userId: context?.userId,
              channelId: context?.channelId,
              threadTs: context?.threadTs,
            },
          });

          // Track inbound thread for lifecycle monitoring and restart recovery
          if (this.threadStatusQueue && context?.channelId) {
            try {
              const threadKey = context.threadTs
                ? `${context.channelId}:${context.threadTs}`
                : `${context.channelId}:${Date.now()}`;
              this.threadStatusQueue.trackInbound({
                source: 'slack',
                threadKey,
                conversationId: result.conversation.id,
                messagePreview: message.slice(0, THREAD_STATUS_CONSTANTS.MAX_PREVIEW_LENGTH),
                sourceMetadata: {
                  channelId: context.channelId,
                  threadTs: context.threadTs,
                  userId: context.userId,
                },
              });
            } catch (trackErr) {
              this.logger.warn('Failed to track inbound thread status', {
                error: trackErr instanceof Error ? trackErr.message : String(trackErr),
              });
            }
          }
        } catch (enqueueErr) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            resolve({
              response: `Failed to enqueue message: ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}`,
              fromOrcReply: false,
            });
          }
        }
      });

      return orcResponse;
    } catch (error) {
      this.logger.error('Error sending to orchestrator', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Route a message to the Auditor agent as a fallback when the orchestrator is offline.
   *
   * Enqueues the message targeting the Auditor's session so the queue processor
   * delivers it to the Auditor PTY instead of the orchestrator. Includes Slack
   * context (channel, thread) so the Auditor can respond.
   *
   * **Thread file enrichment (parity with `sendToOrchestrator` ~line 712):**
   * When a `threadStore` and Slack `context` are available, the enriched
   * message also carries a `[Thread context file: <path>]` line. Without
   * this, the Auditor receives only the bare `[SLACK_CONTEXT:...]` prefix
   * and cannot read prior thread history, causing context-blind replies.
   * This is the bug Steve hit on 2026-04-25 (StevesPrompt deploy thread):
   * orchestrator dropped, Slack fell through here, Auditor responded with
   * "I cannot see the rest of the conversation" because the thread file
   * pointer was missing. Bringing the enrichment in line with the
   * orchestrator path closes the gap.
   *
   * @param message - Original user message
   * @param context - Slack conversation context
   * @returns Acknowledgement message to the user
   */
  private async sendToAuditorFallback(
    message: string,
    context?: SlackConversationContext,
  ): Promise<string> {
    const auditorSession = AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME;

    // Build a context-enriched message so the Auditor knows the source
    const slackPrefix = context
      ? `[SLACK_CONTEXT:channelId=${context.channelId},threadTs=${context.threadTs || ''}]`
      : '';
    let enrichedMessage = `${slackPrefix} [FALLBACK] Orchestrator is offline. User message:\n${message}`;
    if (this.threadStore && context) {
      const threadFilePath = this.threadStore.getThreadFilePath(
        context.channelId,
        context.threadTs,
      );
      enrichedMessage += `\n\n[Thread context file: ${threadFilePath}]`;
    }

    // Try to enqueue via the message queue (same path as orchestrator delivery)
    if (this.messageQueueService) {
      try {
        // Store in chat history
        const result = await this.chatService.sendMessage({
          content: enrichedMessage,
          conversationId: context?.conversationId,
          metadata: {
            source: 'slack',
            userId: context?.userId,
            channelId: context?.channelId,
          },
        });

        this.messageQueueService.enqueue({
          content: enrichedMessage,
          conversationId: result.conversation.id,
          source: 'slack',
          targetSession: auditorSession,
          sourceMetadata: {
            slackResolve: undefined,
            userId: context?.userId,
            channelId: context?.channelId,
          },
        });

        this.logger.info('Message routed to Auditor agent via queue', { auditorSession });
        return 'The orchestrator is currently offline. Your message has been forwarded to the Auditor agent.';
      } catch (err) {
        this.logger.error('Failed to route message to Auditor via queue', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Last resort: direct delivery via AuditorSchedulerService
    try {
      const { AuditorSchedulerService } = await import('../agent/auditor-scheduler.service.js');
      const scheduler = AuditorSchedulerService.getInstance();
      await scheduler.handleUserMessage(
        `[FALLBACK] Orchestrator is offline. User message: ${message}`,
        { channelId: context?.channelId || '', threadTs: context?.threadTs || '' },
      );
      return 'The orchestrator is currently offline. Your message has been forwarded to the Auditor agent.';
    } catch (err) {
      this.logger.error('Failed to route message to Auditor via scheduler', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return getOrchestratorOfflineMessage(true);
  }

  /**
   * Refresh file download URLs via the Slack files.info API.
   * The event payload URLs may not work with just the bot token — the
   * files.info API returns authenticated URLs and validates scope.
   *
   * @param files - Slack file objects to refresh URLs for (mutated in place)
   * @returns true if downloads can proceed, false if scope is missing
   */
  private async refreshFileUrls(files: SlackFile[]): Promise<boolean> {
    for (const file of files) {
      try {
        const freshInfo = await this.slackService.getFileInfo(file.id);
        if (freshInfo.url_private_download) {
          file.url_private_download = freshInfo.url_private_download;
        }
        if (freshInfo.url_private) {
          file.url_private = freshInfo.url_private;
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('missing_scope') || errMsg.includes('not_allowed_token_type')) {
          this.logger.error('Bot token lacks files:read scope — cannot download files. Add the "files:read" scope to your Slack app.');
          return false;
        }
        this.logger.warn('Could not refresh URL via files.info', { fileName: file.name, error: errMsg });
      }
    }
    return true;
  }

  /**
   * Download image files from a Slack message using SlackImageService.
   * Populates `message.images` with successfully downloaded image info.
   * Downloads are batched with a concurrency limit of MAX_CONCURRENT_DOWNLOADS.
   *
   * @param message - Incoming message to attach downloaded images to
   * @param imageFiles - Pre-filtered list of image files to download
   */
  private async downloadMessageImages(message: SlackIncomingMessage, imageFiles: SlackFile[]): Promise<void> {
    const botToken = this.slackService.getBotToken();
    if (!botToken) {
      this.logger.warn('Cannot download images: no bot token available');
      return;
    }

    if (imageFiles.length === 0) {
      return;
    }

    const slackImageService = getSlackImageService();
    const files = imageFiles;
    const downloadedImages: SlackImageInfo[] = [];
    const maxConcurrent = SLACK_IMAGE_CONSTANTS.MAX_CONCURRENT_DOWNLOADS;
    const rejectionMessages: string[] = [];

    // Refresh file URLs via files.info API before downloading.
    const canProceed = await this.refreshFileUrls(files);
    if (!canProceed) return;

    for (let i = 0; i < files.length; i += maxConcurrent) {
      const batch = files.slice(i, i + maxConcurrent);
      const results = await Promise.allSettled(
        batch.map((file) => slackImageService.downloadImage(file, botToken)),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          downloadedImages.push(result.value);
        } else {
          const fileName = batch[j].name;
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
          this.logger.warn('Failed to download image', { fileName, reason });
          // Track files rejected due to validation (size/type) to warn the Slack user.
          // These match the error prefixes from SlackImageService.downloadImage().
          if (reason.startsWith('File too large:') || reason.startsWith('Unsupported image type:')) {
            rejectionMessages.push(`${fileName}: ${reason}`);
          }
        }
      }
    }

    if (downloadedImages.length > 0) {
      message.images = downloadedImages;
    }

    // Send a warning back to Slack if any files were rejected
    if (rejectionMessages.length > 0) {
      try {
        const maxMB = Math.round(SLACK_IMAGE_CONSTANTS.MAX_FILE_SIZE / (1024 * 1024));
        const supportedTypes = SLACK_IMAGE_CONSTANTS.SUPPORTED_MIMES.map(m => m.replace('image/', '').toUpperCase()).join(', ');
        const warningText = `:warning: Some image(s) could not be processed:\n${rejectionMessages.map(f => `• ${f}`).join('\n')}\n\nSupported types: ${supportedTypes}. Max size: ${maxMB} MB.`;
        await this.slackService.sendMessage({
          channelId: message.channelId,
          text: warningText,
          threadTs: message.threadTs || message.ts,
        });
      } catch (err) {
        this.logger.warn('Failed to send rejection warning to Slack', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * Download non-image file attachments from a Slack message.
   * Uses authenticated fetch (same pattern as SlackImageService) to download
   * files to a temp directory. Populates `message.attachments` with results.
   * Skips magic-byte validation since these are generic files.
   *
   * @param message - Incoming message to populate with downloaded file info
   * @param nonImageFiles - Non-image SlackFile objects to download
   */
  private async downloadMessageFiles(message: SlackIncomingMessage, nonImageFiles: SlackFile[]): Promise<void> {
    const botToken = this.slackService.getBotToken();
    if (!botToken) {
      this.logger.warn('Cannot download files: no bot token available');
      return;
    }

    const crewlyHome = path.join(os.homedir(), '.crewly');
    const tempDir = path.join(crewlyHome, SLACK_FILE_DOWNLOAD_CONSTANTS.TEMP_DIR);
    await fs.mkdir(tempDir, { recursive: true });

    const downloadedFiles: SlackFileInfo[] = [];
    const rejectionMessages: string[] = [];
    const maxConcurrent = SLACK_FILE_DOWNLOAD_CONSTANTS.MAX_CONCURRENT_DOWNLOADS;

    // Refresh file URLs via files.info API
    const canProceed = await this.refreshFileUrls(nonImageFiles);
    if (!canProceed) return;

    for (let i = 0; i < nonImageFiles.length; i += maxConcurrent) {
      const batch = nonImageFiles.slice(i, i + maxConcurrent);
      const results = await Promise.allSettled(
        batch.map(async (file) => {
          // Size check
          if (file.size > SLACK_FILE_DOWNLOAD_CONSTANTS.MAX_FILE_SIZE) {
            const maxMB = Math.round(SLACK_FILE_DOWNLOAD_CONSTANTS.MAX_FILE_SIZE / (1024 * 1024));
            throw new Error(`File too large: ${file.size} bytes (max ${maxMB} MB)`);
          }

          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const localPath = path.join(tempDir, `${file.id}-${safeName}`);
          const downloadUrl = file.url_private_download || file.url_private;

          // Authenticated fetch with manual redirect handling, timeout, and resource cleanup
          const maxRedirects = SLACK_FILE_DOWNLOAD_CONSTANTS.MAX_DOWNLOAD_REDIRECTS;
          const timeoutMs = SLACK_FILE_DOWNLOAD_CONSTANTS.DOWNLOAD_TIMEOUT_MS;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
          let currentUrl = downloadUrl;
          let response: Response | null = null;

          try {
            let exhaustedRedirects = true;
            for (let r = 0; r <= maxRedirects; r++) {
              response = await fetch(currentUrl, {
                headers: { 'Authorization': `Bearer ${botToken}` },
                redirect: 'manual',
                signal: controller.signal,
              });
              if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (!location) throw new Error(`Redirect without Location header`);
                // Drain response body to free the socket before following redirect
                await response.body?.cancel();
                currentUrl = location;
                continue;
              }
              exhaustedRedirects = false;
              break;
            }

            if (exhaustedRedirects) {
              throw new Error(`Too many redirects (${maxRedirects}) while downloading file from Slack`);
            }

            if (!response || !response.ok) {
              throw new Error(`Download failed with status ${response?.status || 'unknown'}`);
            }
            if (!response.body) {
              throw new Error('Empty response body from Slack');
            }

            const fileStream = createWriteStream(localPath);
            const nodeStream = Readable.fromWeb(response.body as import('stream/web').ReadableStream);
            await pipeline(nodeStream, fileStream);
          } catch (downloadErr) {
            // Clean up partial file on failure
            try { await fs.unlink(localPath); } catch { /* ignore if file doesn't exist */ }
            throw downloadErr;
          } finally {
            clearTimeout(timeoutId);
          }

          // Extract text from PDFs after download
          let extractedText: string | undefined;
          if (SLACK_FILE_DOWNLOAD_CONSTANTS.EXTRACTABLE_MIMES.includes(file.mimetype)) {
            extractedText = await this.extractPdfText(localPath, file.name);
          }

          return {
            id: file.id,
            name: file.name,
            mimetype: file.mimetype,
            localPath,
            size: file.size,
            permalink: file.permalink,
            extractedText,
          } satisfies SlackFileInfo;
        }),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          downloadedFiles.push(result.value);
        } else {
          const fileName = batch[j].name;
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
          this.logger.warn('Failed to download file', { fileName, reason });
          if (reason.startsWith('File too large:')) {
            rejectionMessages.push(`${fileName}: ${reason}`);
          }
        }
      }
    }

    if (downloadedFiles.length > 0) {
      message.attachments = downloadedFiles;
    }

    if (rejectionMessages.length > 0) {
      try {
        const maxMB = Math.round(SLACK_FILE_DOWNLOAD_CONSTANTS.MAX_FILE_SIZE / (1024 * 1024));
        const warningText = `:warning: Some file(s) could not be downloaded:\n${rejectionMessages.map(f => `• ${f}`).join('\n')}\n\nMax size: ${maxMB} MB.`;
        await this.slackService.sendMessage({
          channelId: message.channelId,
          text: warningText,
          threadTs: message.threadTs || message.ts,
        });
      } catch (err) {
        this.logger.warn('Failed to send file rejection warning to Slack', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * Enrich message text with file path references so agents
   * can read them via their file-reading tools (Claude Code Read, Gemini @file).
   * Includes both images and non-image file attachments.
   *
   * @param message - Message with optional downloaded images and files
   * @returns Enriched text with file references appended
   */
  private enrichTextWithFiles(message: SlackIncomingMessage): string {
    let text = message.text || '';

    if (message.images && message.images.length > 0) {
      for (const img of message.images) {
        const dims = img.width && img.height ? ` (${img.width}x${img.height})` : '';
        text += `\n[Slack Image: ${img.localPath}${dims}, ${img.mimetype}]`;
      }
    }

    if (message.attachments && message.attachments.length > 0) {
      for (const file of message.attachments) {
        const sizeStr = file.size < 1024 ? `${file.size}B` : `${Math.round(file.size / 1024)}KB`;
        text += `\n[Slack File: ${file.localPath} (${file.name}, ${file.mimetype}, ${sizeStr})]`;
        if (file.extractedText) {
          text += `\n--- Extracted content from ${file.name} ---\n${file.extractedText}\n--- End of ${file.name} ---`;
        }
      }
    }

    return text;
  }

  /**
   * Extract text content from a downloaded PDF file.
   * Returns undefined if extraction fails or produces no text.
   *
   * @param filePath - Absolute path to the downloaded PDF
   * @param fileName - Original file name (for logging)
   * @returns Extracted text (possibly truncated) or undefined
   */
  async extractPdfText(filePath: string, fileName: string): Promise<string | undefined> {
    try {
      const fileBuffer = await fs.readFile(filePath);
      const parser = new PDFParse({ data: fileBuffer });
      const pdfData = await parser.getText();
      const rawText = typeof pdfData === 'string' ? pdfData : pdfData?.text;
      if (rawText && rawText.trim().length > 0) {
        const maxLen = SLACK_FILE_DOWNLOAD_CONSTANTS.MAX_EXTRACTED_TEXT_LENGTH;
        return rawText.trim().length > maxLen
          ? rawText.trim().substring(0, maxLen) + '\n... [truncated]'
          : rawText.trim();
      }
      return undefined;
    } catch (extractErr) {
      this.logger.warn('Failed to extract text from PDF', {
        fileName,
        error: extractErr instanceof Error ? extractErr.message : String(extractErr),
      });
      return undefined;
    }
  }

  /**
   * Add typing indicator to message
   *
   * @param message - Message to add indicator to
   */
  private async addTypingIndicator(message: SlackIncomingMessage): Promise<void> {
    try {
      await this.slackService.addReaction(message.channelId, message.ts, 'eyes');
    } catch (error) {
      // Non-critical - reactions require 'reactions:write' scope which is optional
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('missing_scope')) {
        // Only log once about missing scope, not on every message
        if (!this.loggedMissingScope) {
          this.logger.warn('Reactions disabled - add reactions:write scope to Slack app for typing indicators');
          this.loggedMissingScope = true;
        }
      } else {
        this.logger.warn('Could not add typing indicator', { error: errorMessage });
      }
    }
  }

  /**
   * Mark message as complete
   *
   * @param message - Message to mark complete
   */
  private async markComplete(message: SlackIncomingMessage): Promise<void> {
    try {
      await this.slackService.addReaction(message.channelId, message.ts, 'white_check_mark');
    } catch (error) {
      // Non-critical - reactions require 'reactions:write' scope which is optional
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes('missing_scope')) {
        this.logger.warn('Could not add completion indicator', { error: errorMessage });
      }
      // Silent fail for missing_scope since we already logged about it
    }
  }

  /**
   * Add a completion reaction (✅) to a message that was previously
   * stored as a pending reaction. Consumes the pending reaction.
   *
   * @param channelId - Slack channel ID
   * @param threadTs - Thread timestamp (key for lookup)
   */
  public async addCompletionReaction(channelId: string, threadTs: string): Promise<void> {
    const key = `${channelId}:${threadTs}`;
    const messageTs = this.pendingReactions.get(key);

    if (messageTs) {
      // Consume the pending reaction
      this.pendingReactions.delete(key);

      try {
        await this.slackService.addReaction(channelId, messageTs, 'white_check_mark');
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        // Suppress "already_reacted" errors as they are common and non-fatal
        if (errMsg.includes('already_reacted')) {
          return;
        }
        // Suppress "missing_scope" since we already log/warn about that elsewhere
        if (!errMsg.includes('missing_scope')) {
          this.logger.warn('Failed to add completion reaction', { channelId, messageTs, error: errMsg });
        }
      }
    }
  }

  /**
   * Record response to thread store. Slack delivery is handled exclusively
   * by the reply-slack skill via the API — no terminal output fallback needed.
   *
   * The `fromOrcReply` flag gates the V3 SLA auto-resolve hook
   * (`markResolvedByThread`). Only real orc replies (delivered via the
   * orc's reply-slack skill → `slackResolve` callback) may auto-resolve
   * the SLA tracker. Placeholder / timeout / offline / fallback responses
   * must NOT trigger the cascade — doing so closes the parent Request to
   * `done` even though the orc never actually replied (Steve 2026-04-30
   * incident: false-done Request, paired with Bug 1 silent-drop in
   * agent-registration.service.ts).
   *
   * Default `fromOrcReply = true` preserves the legacy behaviour for the
   * mention-routing call site (line ~327) which currently has no
   * placeholder semantics — its `sendToAgent` path delivers a direct
   * agent reply when reachable. If that path later grows a timeout
   * fallback, the call site should pass `false` explicitly.
   *
   * @param originalMessage - Original incoming message
   * @param response        - Response content (real reply or placeholder)
   * @param fromOrcReply    - `true` only when the response came from a
   *   real agent/orc reply path. `false` for any timeout / fallback /
   *   offline acknowledgement. Drives whether the SLA tracker is
   *   auto-resolved for the matching Slack thread.
   */
  private async sendSlackResponse(
    originalMessage: SlackIncomingMessage,
    response: string,
    fromOrcReply: boolean = true,
  ): Promise<void> {
    await this.recordThreadReply(originalMessage, response);

    // INBOUND-1.4: notify the RequestSlaSubscriber that the orc replied to
    // this Slack thread so any tracked respond_to_user WorkItem can
    // auto-transition and the SLA timers no-op. Lazy import breaks the
    // static cycle (subscriber boot wires this bridge).
    if (!fromOrcReply) {
      this.logger.debug('Skipping SLA auto-resolve — response is not a real orc reply', {
        threadTs: originalMessage.ts,
        responsePreview: response.slice(0, 60),
      });
      return;
    }

    try {
      const { getRequestSlaSubscriber } = await import('../v3/request-sla.subscriber.js');
      const sub = getRequestSlaSubscriber();
      if (sub) {
        // sourceConversationItemId for slack messages is `slack-${channelId}-${ts}`
        // (see line ~372 above); the threadTs we index on is the original
        // user message ts. originalMessage.ts is exactly that.
        await sub.markResolvedByThread(originalMessage.ts);
      }
    } catch (err) {
      this.logger.debug('SLA auto-resolve hook failed (non-critical)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Send error response
   *
   * @param message - Original message
   * @param error - Error that occurred
   */
  private async sendErrorResponse(
    message: SlackIncomingMessage,
    error: Error
  ): Promise<void> {
    await this.slackService.sendMessage({
      channelId: message.channelId,
      text: `:warning: Sorry, I encountered an error: ${error.message}`,
      threadTs: message.threadTs || message.ts,
    });
  }

  /**
   * Format response for Slack
   *
   * Converts markdown to Slack-compatible formatting.
   *
   * @param text - Text to format
   * @returns Formatted text
   */
  formatForSlack(text: string): string {
    // Convert markdown headers to bold
    let formatted = text.replace(/^### (.+)$/gm, '*$1*');
    formatted = formatted.replace(/^## (.+)$/gm, '*$1*');
    formatted = formatted.replace(/^# (.+)$/gm, '*$1*');

    // Slack already supports backtick code formatting
    // Convert code blocks (simplified)
    formatted = formatted.replace(/```[\w]*\n([\s\S]*?)```/g, '```$1```');

    return formatted;
  }

  /**
   * Persist Slack reply content to the thread store when available.
   */
  private async recordThreadReply(
    originalMessage: SlackIncomingMessage,
    content: string
  ): Promise<void> {
    if (!this.threadStore) return;
    const trimmed = content?.trim();
    if (!trimmed) return;

    const threadTs = originalMessage.threadTs || originalMessage.ts;
    if (!threadTs) return;

    try {
      await this.threadStore.appendOrchestratorReply(originalMessage.channelId, threadTs, trimmed);
    } catch (err) {
      this.logger.warn('Failed to store thread reply', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Send proactive notification to Slack
   *
   * @param notification - Notification to send
   */
  async sendNotification(notification: SlackNotification): Promise<void> {
    if (!this.config.enableNotifications) return;
    await this.slackService.sendNotification(notification);
  }

  /**
   * Send a content approval notification to Slack with Block Kit buttons.
   *
   * Posts a rich message with content preview and approve/reject buttons.
   * Links the Slack message back to the approval record so interactive
   * button clicks can resolve the approval.
   *
   * @param approvalId - The content approval ID
   * @param channelId - Slack channel ID
   * @param threadTs - Optional thread timestamp
   * @returns The Slack message timestamp, or null if failed
   */
  async sendContentApproval(approvalId: string, channelId?: string, threadTs?: string): Promise<string | null> {
    if (!channelId) return null;
    try {
      const approval = ContentApprovalService.getInstance().get(approvalId);
      const fallbackText = `Content approval requested (ID: ${approvalId.slice(0, 8)}). Use the buttons to approve/reject.`;

      const blocks: SlackBlock[] = [
        {
          type: 'header',
          text: { type: 'plain_text', text: '\ud83d\udccb Content Approval Required', emoji: true },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Platform:*\n${approval?.platform ?? 'N/A'}` },
            { type: 'mrkdwn', text: `*Type:*\n${approval?.contentType ?? 'N/A'}` },
            { type: 'mrkdwn', text: `*Submitted by:*\n${approval?.submittedBy ?? 'Unknown'}` },
            { type: 'mrkdwn', text: `*ID:*\n${approvalId.slice(0, 8)}` },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Content Preview:*\n${(approval?.content ?? '').slice(0, 300)}${(approval?.content ?? '').length > 300 ? '...' : ''}`,
          },
        },
      ];

      // Add hashtags and scheduled time if present
      const metaFields: SlackTextObject[] = [];
      if (approval?.hashtags && approval.hashtags.length > 0) {
        metaFields.push({ type: 'mrkdwn', text: `*Hashtags:*\n${approval.hashtags.join(' ')}` });
      }
      if (approval?.scheduledTime) {
        metaFields.push({ type: 'mrkdwn', text: `*Scheduled:*\n${approval.scheduledTime}` });
      }
      if (metaFields.length > 0) {
        blocks.push({ type: 'section', fields: metaFields });
      }

      blocks.push({ type: 'divider' });

      // Actions block with approve/reject buttons
      blocks.push({
        type: 'actions',
        block_id: `content_approval_${approvalId}`,
        elements: [
          {
            type: 'button',
            action_id: 'content_approval_approve',
            text: { type: 'plain_text', text: '\u2705 Approve', emoji: true },
            value: approvalId,
            style: 'primary',
          } as SlackElement,
          {
            type: 'button',
            action_id: 'content_approval_reject',
            text: { type: 'plain_text', text: '\u274c Reject', emoji: true },
            value: approvalId,
            style: 'danger',
          } as SlackElement,
        ],
      });

      const messageTs = await this.slackService.sendMessage({
        channelId,
        text: fallbackText,
        threadTs,
        blocks,
      });

      // Link the Slack message to the approval for tracking
      if (messageTs) {
        ContentApprovalService.getInstance().linkSlackMessage(approvalId, channelId, messageTs);
      }

      return messageTs ?? null;
    } catch (err) {
      this.logger.warn('Failed to send content approval to Slack', {
        approvalId: approvalId.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Notify about task completion
   *
   * @param taskTitle - Title of completed task
   * @param agentName - Name of agent that completed the task
   * @param projectName - Name of the project
   */
  async notifyTaskCompleted(
    taskTitle: string,
    agentName: string,
    projectName: string
  ): Promise<void> {
    await this.sendNotification({
      type: 'task_completed',
      title: 'Task Completed',
      message: `*${taskTitle}*\n\nCompleted by ${agentName} on project ${projectName}`,
      urgency: 'normal',
      timestamp: new Date().toISOString(),
      metadata: { projectId: projectName },
    });
  }

  /**
   * Notify about agent needing assistance
   *
   * @param agentName - Name of agent with question
   * @param question - The question from the agent
   * @param projectName - Name of the project
   */
  async notifyAgentQuestion(
    agentName: string,
    question: string,
    projectName: string
  ): Promise<void> {
    await this.sendNotification({
      type: 'agent_question',
      title: 'Agent Needs Input',
      message: `*${agentName}* has a question:\n\n_${question}_`,
      urgency: 'high',
      timestamp: new Date().toISOString(),
      metadata: { agentId: agentName, projectId: projectName },
    });
  }

  /**
   * Notify about errors
   *
   * @param errorMessage - Error message
   * @param agentName - Optional agent name
   * @param projectName - Optional project name
   */
  async notifyError(
    errorMessage: string,
    agentName?: string,
    projectName?: string
  ): Promise<void> {
    await this.sendNotification({
      type: 'agent_error',
      title: 'Error Occurred',
      message: errorMessage,
      urgency: 'critical',
      timestamp: new Date().toISOString(),
      metadata: { agentId: agentName, projectId: projectName },
    });
  }

  /**
   * Notify about daily summary
   *
   * @param summary - Summary content
   */
  async notifyDailySummary(summary: string): Promise<void> {
    await this.sendNotification({
      type: 'daily_summary',
      title: 'Daily Summary',
      message: summary,
      urgency: 'low',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Resolve @mention in message text to an agent session (#177).
   *
   * Matches patterns: @assistant, @auditor, @sam, @leo, etc.
   * Looks up the agent name in team configs to find the session name.
   *
   * @param text - Message text to scan for @mentions
   * @returns Target agent info, or null if no mention found
   */
  private async resolveMentionTarget(text: string): Promise<{ name: string; sessionName: string } | null> {
    // Match @name at the start of the message
    const mentionMatch = text.match(/^@(\w+)\s/i);
    if (!mentionMatch) return null;

    const mentionedName = mentionMatch[1].toLowerCase();

    // Built-in aliases
    const aliases: Record<string, string> = {
      assistant: 'crewly-orc-assistant',
      auditor: 'crewly-auditor',
      orc: 'crewly-orc',
      orchestrator: 'crewly-orc',
    };

    if (aliases[mentionedName]) {
      return { name: mentionedName, sessionName: aliases[mentionedName] };
    }

    // Look up in team configs
    try {
      const StorageService = (await import('../core/storage.service.js')).StorageService;
      const storage = StorageService.getInstance();
      const teams = await storage.getTeams();
      for (const team of teams) {
        for (const member of (team.members || [])) {
          // Match by name (case-insensitive) or session name fragment
          const memberName = member.name?.toLowerCase() || '';
          const sessionParts = (member.sessionName || '').split('-');
          const shortName = sessionParts.length >= 3 ? sessionParts[2] : '';

          if (memberName === mentionedName || shortName === mentionedName) {
            return { name: mentionedName, sessionName: member.sessionName };
          }
        }
      }
    } catch (err) {
      this.logger.warn('Failed to look up mention target', {
        mention: mentionedName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return null;
  }

  /**
   * Send a message to a specific agent session via terminal deliver (#177).
   *
   * @param sessionName - Target agent session
   * @param message - Message to send
   * @param context - Slack context for response routing
   * @returns Agent response text
   */
  private async sendToAgent(
    sessionName: string,
    message: string,
    context?: SlackConversationContext,
  ): Promise<string> {
    try {
      // Enrich with Slack context for reply routing
      let enrichedMessage = message;
      if (context) {
        enrichedMessage = `[SLACK_CONTEXT:channelId=${context.channelId},threadTs=${context.threadTs || ''}]\n${message}`;
      }

      // Use message queue for agents that support it, or deliver directly
      if (this.messageQueueService) {
        const chatResult = await this.chatService.sendMessage({
          content: enrichedMessage,
          conversationId: context?.conversationId,
          metadata: { source: 'slack', channelId: context?.channelId },
        });

        return new Promise<string>((resolve) => {
          let resolved = false;
          const timeoutId = setTimeout(() => {
            if (!resolved) { resolved = true; resolve('Agent is processing your message. Check back shortly.'); }
          }, this.config.responseTimeoutMs);

          this.messageQueueService!.enqueue({
            content: enrichedMessage,
            conversationId: chatResult.conversation.id,
            source: 'slack',
            targetSession: sessionName,
            sourceMetadata: {
              slackResolve: (resp: string) => {
                if (!resolved) { resolved = true; clearTimeout(timeoutId); resolve(resp); }
              },
              channelId: context?.channelId,
              threadTs: context?.threadTs,
            },
          });
        });
      }

      // Fallback: direct terminal delivery
      const { default: fetch } = await import('node-fetch' as any).catch(() => ({ default: globalThis.fetch }));
      const apiUrl = process.env.CREWLY_API_URL || 'http://localhost:8787';
      await fetch(`${apiUrl}/api/terminal/${sessionName}/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: enrichedMessage, force: true }),
      });
      return 'Message delivered to agent. Response will arrive shortly.';
    } catch (err) {
      this.logger.error('Failed to send to agent', {
        session: sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
      return `Failed to reach agent. Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/**
 * Get bridge singleton
 *
 * @returns SlackOrchestratorBridge instance
 */
export function getSlackOrchestratorBridge(): SlackOrchestratorBridge {
  if (!bridgeInstance) {
    bridgeInstance = new SlackOrchestratorBridge();
  }
  return bridgeInstance;
}

/**
 * Reset bridge (for testing)
 */
export function resetSlackOrchestratorBridge(): void {
  bridgeInstance = null;
}
