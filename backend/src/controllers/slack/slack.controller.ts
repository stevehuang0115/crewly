/**
 * Slack Controller
 *
 * REST API endpoints for managing Slack integration.
 * Provides status monitoring, connection management, and message sending.
 *
 * @module controllers/slack
 */

import { Router, Request, Response, NextFunction } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { getSlackService } from '../../services/slack/slack.service.js';
import { getSlackOrchestratorBridge } from '../../services/slack/slack-orchestrator-bridge.js';
import { saveSlackCredentials, deleteSlackCredentials, hasSavedCredentials } from '../../services/slack/slack-credentials.service.js';
import { SlackConfig, SlackNotification, SlackNotificationType } from '../../types/slack.types.js';
import { SLACK_IMAGE_CONSTANTS, SLACK_FILE_UPLOAD_CONSTANTS } from '../../constants.js';
import { getAgentBehaviorLogService } from '../../services/observability/agent-behavior-log.singleton.js';
import { synthesizeSlackConversationId } from '../../services/chat-v2/legacy-dto.utils.js';

const router = Router();
const SLACK_MANIFEST_PATH = path.join(process.cwd(), 'config', 'slack-app-manifest.json');

/**
 * Cap for upload-marker content written to chat-v2.
 *
 * The marker is `[file uploaded: ${name}]${: comment}` — `initialComment`
 * is caller-controlled and unbounded. Without this cap a 10KB comment
 * would land in the chat history verbatim. Mirrors the bounded preview
 * pattern used elsewhere (`THREAD_STATUS_CONSTANTS.MAX_PREVIEW_LENGTH`
 * = 200 for inbound; 500 here so the file marker + a reasonable comment
 * tail both fit). PR #562 review follow-up.
 */
const UPLOAD_MARKER_CONTENT_MAX = 500;

/**
 * Handle Slack platform errors consistently across endpoints.
 * Returns true if the error was handled (422 sent), false otherwise.
 *
 * @param error - The caught error
 * @param res - Express response object
 * @returns True if a Slack platform error response was sent
 */
function handleSlackPlatformError(error: unknown, res: Response): boolean {
  if (
    error instanceof Error &&
    'code' in error &&
    (error as any).code === 'slack_webapi_platform_error'
  ) {
    const slackError = (error as any).data?.error || 'unknown_slack_error';
    res.status(422).json({
      success: false,
      error: `Slack API error: ${slackError}`,
      slackError,
    });
    return true;
  }
  return false;
}

/**
 * Post-Slack-send bookkeeping shared by /send, /upload-image, and /upload-file.
 *
 * After a successful Slack write, mirror the side-effects the orchestrator
 * relies on for restart-safety and request lifecycle:
 *
 *  1. Persist a turn to chat-v2 so the agent's context-recovery sees the
 *     action and does not re-send. The orchestrator was previously re-uploading
 *     attached files after restart because file uploads landed in Slack but
 *     never in chat-v2 (regression observed 2026-05-15 — dup `agentic_explainer.mp4`).
 *  2. Mark the thread-status queue entry as `replied_completed` so
 *     `recoverPendingThreads()` does not re-fire the inbound on the next boot.
 *  3. Fire the V3 SLA `markResolvedByThread` cascade so the matching Request
 *     auto-closes on file-only replies (it already worked for text replies
 *     via the same hook).
 *  4. Append the reply to the slack-thread `.md` store (the file orc reads
 *     directly on session restart). The legacy `slack-orchestrator-bridge.
 *     sendSlackResponse` path already did this for its internal flow, but
 *     replies coming through `/api/slack/send` (the reply-slack skill path
 *     orc actually uses) never reached the .md file. Without this, orc's
 *     wake-up read of the thread context shows only user messages and
 *     re-replies to everything (regression observed 2026-05-16 — orc
 *     re-replied to all 3 user messages on the CE thread after a session
 *     restart, even though /send had already marked chat-v2 + thread-status).
 *
 * All four steps are best-effort. The Slack send itself has already
 * succeeded; failures here are bookkeeping-only and must never throw.
 *
 * @param params.channelId - Slack channel the send hit
 * @param params.threadTs - Optional Slack thread root timestamp
 * @param params.conversationId - Optional caller-supplied conversation id
 * @param params.senderSessionName - Optional agent session that initiated the send
 * @param params.content - The turn content to persist (text or file marker)
 * @param params.source - Marker for the chat-v2 metadata.source field
 */
async function recordSlackReplyBookkeeping(params: {
  channelId: string;
  threadTs?: string;
  conversationId?: string;
  senderSessionName?: string;
  content: string;
  /**
   * Audit sub-kind for the chat-v2 metadata, recorded alongside the
   * canonical `source: 'reply-tool'`. Keeps the closed `RECORD_TURN_SOURCES`
   * enum intact while still letting downstream consumers distinguish text
   * replies from attachment uploads.
   */
  replyKind: 'text' | 'file-upload' | 'image-upload';
}): Promise<void> {
  const { channelId, threadTs, conversationId, senderSessionName, content, replyKind } = params;

  // 1. Persist agent turn into chat-v2 so context recovery sees the reply.
  const resolvedConversationId: string | undefined =
    (typeof conversationId === 'string' && conversationId.length > 0
      ? conversationId
      : undefined) ??
    (typeof channelId === 'string' && typeof threadTs === 'string'
      ? synthesizeSlackConversationId(channelId, threadTs)
      : undefined);
  if (resolvedConversationId) {
    try {
      const { getChatV2Service } = await import('../../services/chat-v2/chat-v2.singleton.js');
      const chatV2 = getChatV2Service();
      const agentSession =
        typeof senderSessionName === 'string' && senderSessionName.length > 0
          ? senderSessionName
          : 'crewly-orc';
      const channel = chatV2.ensureChannelForLegacyConversation({
        conversationId: resolvedConversationId,
        agentSession,
      });
      chatV2.recordTurn({
        channelId: channel.id,
        senderType: 'agent',
        senderId: agentSession,
        content,
        metadata: {
          source: 'reply-tool',
          replyKind,
          // Mirror the pre-PR /send guards exactly. `req.body` destructure
          // is `any`, so a non-string slip-through would persist as-is into
          // chat-v2 metadata without these `typeof` checks.
          slackChannelId: typeof channelId === 'string' ? channelId : undefined,
          slackThreadTs: typeof threadTs === 'string' ? threadTs : undefined,
        },
      });
    } catch {
      // Non-fatal — Slack delivery succeeded.
    }
  }

  // 2. Mark thread-status replied_completed (idempotent — creates entry if missing).
  if (threadTs && channelId) {
    try {
      const { ThreadStatusQueueService } = await import('../../services/messaging/thread-status-queue.service.js');
      const tsq = ThreadStatusQueueService.getInstance();
      const threadKey = `${channelId}:${threadTs}`;
      if (!tsq.get(threadKey)) {
        tsq.trackInbound({
          threadKey,
          conversationId: resolvedConversationId ?? synthesizeSlackConversationId(channelId, threadTs),
          source: 'slack',
          messagePreview: '[reply-only — no inbound recorded]',
        });
      }
      tsq.markReplied(threadKey, 'replied_completed');
    } catch {
      // Non-fatal.
    }
  }

  // 3. SLA cascade — closes the matching Request when orc replies in-thread.
  if (threadTs) {
    try {
      const { getRequestSlaSubscriber } = await import('../../services/v3/request-sla.subscriber.js');
      const sub = getRequestSlaSubscriber();
      if (sub) {
        await sub.markResolvedByThread(threadTs);
      }
    } catch {
      // Non-fatal.
    }
  }

  // 4. Append to the slack-thread .md store so orc's wake-up read of the
  //    thread context file sees its own reply. Without this, orc reads the
  //    file, sees only user messages, and re-replies to everything.
  if (threadTs && channelId) {
    try {
      const { getSlackThreadStore } = await import('../../services/slack/slack-thread-store.service.js');
      const store = getSlackThreadStore();
      if (store) {
        await store.appendOrchestratorReply(channelId, threadTs, content);
      }
    } catch {
      // Non-fatal — Slack delivery succeeded.
    }
  }
}

/**
 * GET /api/slack/status
 *
 * Get Slack integration status including connection state and message counts.
 *
 * @returns Status object with connection info
 */
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slackService = getSlackService();
    const status = slackService.getStatus();

    res.json({
      success: true,
      data: {
        ...status,
        isConfigured: slackService.isConnected(),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/slack/install
 *
 * Returns the one-click Slack app manifest and an import URL payload to simplify setup.
 */
router.get('/install', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const manifestRaw = await fs.readFile(SLACK_MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    const encodedManifest = encodeURIComponent(JSON.stringify(manifest));
    const importUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodedManifest}`;

    res.json({
      success: true,
      data: {
        manifest,
        importUrl,
        instructions: [
          'Open importUrl and create the app from manifest',
          'Enable Socket Mode and install app to workspace',
          'Copy Bot Token, App Token, Signing Secret into /api/slack/connect',
        ],
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/slack/connect
 *
 * Initialize Slack connection with configuration.
 * Uses request body or falls back to environment variables.
 *
 * @body botToken - Bot OAuth token (optional if env set)
 * @body appToken - App-level token (optional if env set)
 * @body signingSecret - Signing secret (optional if env set)
 * @body defaultChannelId - Default notification channel
 * @body allowedUserIds - Array of allowed user IDs
 * @returns Connection status on success
 */
router.post('/connect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config: SlackConfig = {
      botToken: req.body.botToken || process.env.SLACK_BOT_TOKEN || '',
      appToken: req.body.appToken || process.env.SLACK_APP_TOKEN || '',
      signingSecret: req.body.signingSecret || process.env.SLACK_SIGNING_SECRET || '',
      defaultChannelId: req.body.defaultChannelId || process.env.SLACK_DEFAULT_CHANNEL,
      allowedUserIds:
        req.body.allowedUserIds ||
        process.env.SLACK_ALLOWED_USERS?.split(',').filter(Boolean),
      socketMode: true,
    };

    // Validate required fields
    if (!config.botToken || !config.appToken || !config.signingSecret) {
      res.status(400).json({
        success: false,
        error: 'Missing required Slack credentials (botToken, appToken, signingSecret)',
      });
      return;
    }

    const slackService = getSlackService();
    await slackService.initialize(config);

    // Initialize bridge
    const bridge = getSlackOrchestratorBridge();
    await bridge.initialize();

    // Persist credentials to disk so they survive server restarts
    await saveSlackCredentials(config);

    res.json({
      success: true,
      message: 'Slack connection established',
      data: slackService.getStatus(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/slack/disconnect
 *
 * Disconnect from Slack gracefully.
 *
 * @returns Success message on disconnect
 */
router.post('/disconnect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slackService = getSlackService();
    await slackService.disconnect();

    // Remove saved credentials so Slack doesn't auto-reconnect on restart
    await deleteSlackCredentials();

    res.json({
      success: true,
      message: 'Slack disconnected',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/slack/send
 *
 * Send a message to Slack (for testing/manual notifications).
 *
 * @body channelId - Channel to send to (required)
 * @body text - Message text (required)
 * @body threadTs - Thread timestamp for replies (optional)
 * @returns Message timestamp on success
 */
router.post('/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { channelId, text, threadTs, conversationId, senderSessionName } = req.body;

    if (!channelId || !text) {
      res.status(400).json({
        success: false,
        error: 'channelId and text are required',
      });
      return;
    }

    const slackService = getSlackService();

    if (!slackService.isConnected()) {
      res.status(503).json({
        success: false,
        error: 'Slack is not connected',
      });
      return;
    }

    const messageTs = await slackService.sendMessage({
      channelId,
      text,
      threadTs,
    });

    // F14: record `agent.action` with actionType='send_slack' on
    // successful Slack send. Source `agent` from senderSessionName
    // already on the request body. Best-effort — never blocks the
    // response. Note: if sendMessage threw, we never reach here, and
    // the slack.delivery.failed event was recorded at the throw site.
    try {
      getAgentBehaviorLogService()?.record({
        type: 'agent.action',
        agent: typeof senderSessionName === 'string' ? senderSessionName : '',
        actionType: 'send_slack',
        details: {
          channelId,
          threadTs: threadTs ?? null,
          textLength: typeof text === 'string' ? text.length : 0,
          deduplicated: messageTs === '',
        },
      });
    } catch {
      /* observability is best-effort */
    }

    // Post-send bookkeeping (chat-v2 persist + thread-status terminal mark +
    // SLA cascade). The same helper is used by /upload-image and /upload-file
    // so the orchestrator never has to re-derive "did I already reply here?".
    await recordSlackReplyBookkeeping({
      channelId,
      threadTs,
      conversationId,
      senderSessionName,
      content: typeof text === 'string' ? text : String(text),
      replyKind: 'text',
    });

    res.json({
      success: true,
      data: { messageTs },
    });
  } catch (error: unknown) {
    if (!handleSlackPlatformError(error, res)) {
      next(error);
    }
  }
});

/**
 * POST /api/slack/notify
 *
 * Send a notification through the orchestrator bridge.
 *
 * @body type - Notification type (optional, defaults to 'alert')
 * @body title - Notification title (required)
 * @body message - Notification message (required)
 * @body urgency - Urgency level (optional, defaults to 'normal')
 * @body metadata - Additional metadata (optional)
 * @returns Success message on send
 */
router.post('/notify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notification: SlackNotification = {
      type: (req.body.type || 'alert') as SlackNotificationType,
      title: req.body.title,
      message: req.body.message,
      urgency: req.body.urgency || 'normal',
      timestamp: new Date().toISOString(),
      metadata: req.body.metadata,
    };

    if (!notification.title || !notification.message) {
      res.status(400).json({
        success: false,
        error: 'title and message are required',
      });
      return;
    }

    const bridge = getSlackOrchestratorBridge();
    await bridge.sendNotification(notification);

    res.json({
      success: true,
      message: 'Notification sent',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/slack/upload-image
 *
 * Upload a local image file to a Slack channel.
 * Accepts a JSON body with a filePath (not multipart) since the backend
 * and agents share the same filesystem.
 *
 * @body channelId - Slack channel to upload to (required)
 * @body filePath - Absolute path to the image file on disk (required)
 * @body filename - Override filename (optional)
 * @body title - Title for the uploaded file (optional)
 * @body initialComment - Comment to include with the upload (optional)
 * @body threadTs - Thread timestamp to upload in a thread (optional)
 * @returns Object with fileId on success
 */
router.post('/upload-image', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { channelId, filePath, filename, title, initialComment, threadTs, conversationId, senderSessionName } = req.body;

    if (!channelId || !filePath) {
      res.status(400).json({
        success: false,
        error: 'channelId and filePath are required',
      });
      return;
    }

    // Validate file exists
    try {
      await fs.access(filePath);
    } catch {
      res.status(404).json({
        success: false,
        error: `File not found: ${filePath}`,
      });
      return;
    }

    // Validate file size
    const stat = await fs.stat(filePath);
    if (stat.size > SLACK_IMAGE_CONSTANTS.MAX_FILE_SIZE) {
      const maxMB = Math.round(SLACK_IMAGE_CONSTANTS.MAX_FILE_SIZE / (1024 * 1024));
      res.status(413).json({
        success: false,
        error: `File too large (max ${maxMB} MB)`,
      });
      return;
    }

    // Validate MIME type by extension
    const ext = path.extname(filePath).toLowerCase();
    const extToMime: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
    };
    const mime = extToMime[ext];
    if (!mime || !SLACK_IMAGE_CONSTANTS.SUPPORTED_MIMES.includes(mime as typeof SLACK_IMAGE_CONSTANTS.SUPPORTED_MIMES[number])) {
      res.status(415).json({
        success: false,
        error: `Unsupported image type: ${ext}`,
      });
      return;
    }

    const slackService = getSlackService();
    if (!slackService.isConnected()) {
      res.status(503).json({
        success: false,
        error: 'Slack is not connected',
      });
      return;
    }

    const result = await slackService.uploadImage({
      channelId,
      filePath,
      filename,
      title,
      initialComment,
      threadTs,
    });

    // F14 observability parity with /send — record `agent.action` so
    // dashboards counting `send_slack` include attachment uploads.
    // `details.kind` discriminates text vs file vs image when finer-
    // grained queries are needed.
    try {
      getAgentBehaviorLogService()?.record({
        type: 'agent.action',
        agent: typeof senderSessionName === 'string' ? senderSessionName : '',
        actionType: 'send_slack',
        details: {
          kind: 'image',
          channelId,
          threadTs: threadTs ?? null,
          fileId: result.fileId ?? null,
          fileSize: stat.size,
        },
      });
    } catch {
      /* observability is best-effort */
    }

    // Mirror /send post-success bookkeeping so orc's context recovery sees
    // the image was already delivered. Content captures the file marker so
    // the chat history shows what was actually sent.
    const displayName = typeof filename === 'string' && filename.length > 0 ? filename : path.basename(filePath);
    const commentSuffix = typeof initialComment === 'string' && initialComment.length > 0 ? `: ${initialComment}` : '';
    await recordSlackReplyBookkeeping({
      channelId,
      threadTs,
      conversationId,
      senderSessionName,
      content: `[image uploaded: ${displayName}]${commentSuffix}`.slice(0, UPLOAD_MARKER_CONTENT_MAX),
      replyKind: 'image-upload',
    });

    res.json({
      success: true,
      data: { fileId: result.fileId },
    });
  } catch (error: unknown) {
    if (!handleSlackPlatformError(error, res)) {
      next(error);
    }
  }
});

/**
 * POST /api/slack/upload-file
 *
 * Upload a local file (PDF, image, document, etc.) to a Slack channel.
 * Accepts a JSON body with a filePath (not multipart) since the backend
 * and agents share the same filesystem.
 *
 * @body channelId - Slack channel to upload to (required)
 * @body filePath - Absolute path to the file on disk (required)
 * @body filename - Override filename (optional)
 * @body title - Title for the uploaded file (optional)
 * @body initialComment - Comment to include with the upload (optional)
 * @body threadTs - Thread timestamp to upload in a thread (optional)
 * @returns Object with fileId on success
 */
router.post('/upload-file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { channelId, filePath, filename, title, initialComment, threadTs, conversationId, senderSessionName } = req.body;

    if (!channelId || !filePath) {
      res.status(400).json({
        success: false,
        error: 'channelId and filePath are required',
      });
      return;
    }

    // Validate file exists
    try {
      await fs.access(filePath);
    } catch {
      res.status(404).json({
        success: false,
        error: `File not found: ${filePath}`,
      });
      return;
    }

    // Validate file size
    const stat = await fs.stat(filePath);
    if (stat.size > SLACK_FILE_UPLOAD_CONSTANTS.MAX_FILE_SIZE) {
      const maxMB = Math.round(SLACK_FILE_UPLOAD_CONSTANTS.MAX_FILE_SIZE / (1024 * 1024));
      res.status(413).json({
        success: false,
        error: `File too large (max ${maxMB} MB)`,
      });
      return;
    }

    // Validate file extension
    const ext = path.extname(filePath).toLowerCase();
    if (!SLACK_FILE_UPLOAD_CONSTANTS.SUPPORTED_EXTENSIONS.includes(ext as typeof SLACK_FILE_UPLOAD_CONSTANTS.SUPPORTED_EXTENSIONS[number])) {
      res.status(415).json({
        success: false,
        error: `Unsupported file type: ${ext}`,
      });
      return;
    }

    const slackService = getSlackService();
    if (!slackService.isConnected()) {
      res.status(503).json({
        success: false,
        error: 'Slack is not connected',
      });
      return;
    }

    const result = await slackService.uploadFile({
      channelId,
      filePath,
      filename,
      title,
      initialComment,
      threadTs,
    });

    // F14 observability parity with /send — see /upload-image for the
    // shared rationale.
    try {
      getAgentBehaviorLogService()?.record({
        type: 'agent.action',
        agent: typeof senderSessionName === 'string' ? senderSessionName : '',
        actionType: 'send_slack',
        details: {
          kind: 'file',
          channelId,
          threadTs: threadTs ?? null,
          fileId: result.fileId ?? null,
          fileSize: stat.size,
        },
      });
    } catch {
      /* observability is best-effort */
    }

    // Mirror /send post-success bookkeeping. Without this the orchestrator
    // re-uploads the same file after every restart (regression 2026-05-15:
    // duplicate agentic_explainer.mp4 in D0AC7NF5N7L:1778816065.309289 thread).
    const displayName = typeof filename === 'string' && filename.length > 0 ? filename : path.basename(filePath);
    const commentSuffix = typeof initialComment === 'string' && initialComment.length > 0 ? `: ${initialComment}` : '';
    await recordSlackReplyBookkeeping({
      channelId,
      threadTs,
      conversationId,
      senderSessionName,
      content: `[file uploaded: ${displayName}]${commentSuffix}`.slice(0, UPLOAD_MARKER_CONTENT_MAX),
      replyKind: 'file-upload',
    });

    res.json({
      success: true,
      data: { fileId: result.fileId },
    });
  } catch (error: unknown) {
    if (!handleSlackPlatformError(error, res)) {
      next(error);
    }
  }
});

/**
 * GET /api/slack/config
 *
 * Get current Slack configuration (sanitized, no secrets).
 *
 * @returns Configuration status object
 */
router.get('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hasSaved = await hasSavedCredentials();

    res.json({
      success: true,
      data: {
        hasToken: !!process.env.SLACK_BOT_TOKEN,
        hasAppToken: !!process.env.SLACK_APP_TOKEN,
        hasSigningSecret: !!process.env.SLACK_SIGNING_SECRET,
        hasSavedConfig: hasSaved,
        defaultChannel: process.env.SLACK_DEFAULT_CHANNEL || null,
        allowedUsers: process.env.SLACK_ALLOWED_USERS?.split(',').filter(Boolean).length || 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
