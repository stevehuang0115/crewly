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

const router = Router();
const SLACK_MANIFEST_PATH = path.join(process.cwd(), 'config', 'slack-app-manifest.json');

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

    // Persist orchestrator/agent replies to the chat store so they appear
    // in the Chat UI. Phase 6c of unified-chat-message-store spec: the
    // call site now invokes the canonical `ChatV2Service.recordTurn`
    // directly (the legacy `ChatService.addDirectMessage` façade has
    // been retired).
    //
    // 2026-05-15 follow-up: the reply-slack skill only sends
    // `{channelId, text, threadTs}` (no `conversationId`), so an
    // earlier `if (conversationId)` guard silently dropped every
    // tool-driven reply on the floor. Synthesize a conversationId
    // from `channelId + threadTs` using the same format the inbound
    // bridge writes (`slack-${channelId}-${threadTs}`) so the agent
    // reply and the user inbound land on the same chat-v2 channel.
    const resolvedConversationId: string | undefined =
      (typeof conversationId === 'string' && conversationId.length > 0
        ? conversationId
        : undefined) ??
      (typeof channelId === 'string' && typeof threadTs === 'string'
        ? `slack-${channelId}-${String(threadTs).replace('.', '-')}`
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
          content: typeof text === 'string' ? text : String(text),
          metadata: {
            source: 'reply-tool',
            slackChannelId: typeof channelId === 'string' ? channelId : undefined,
            slackThreadTs: typeof threadTs === 'string' ? threadTs : undefined,
          },
        });
      } catch {
        // Non-fatal — Slack delivery succeeded, chat persistence is best-effort
      }
    }

    // Mark the thread as replied_completed in the thread-status queue.
    //
    // Bug from 2026-05-08 dogfood: every backend restart re-enqueued the
    // user's original Slack message via the
    // `ThreadStatusQueueService.recoverPendingThreads` → message-queue
    // `[RECOVERY]` path. orc would then "re-reply" to the same message
    // multiple times after each restart, even though the user only sent
    // one message and orc had already replied.
    //
    // Root cause: when orc invoked `reply-slack` skill → `POST /slack/send`,
    // we sent to Slack + persisted to chat, but we never updated the
    // thread-status entry. The entry stayed in `received` (or
    // `replied_waiting_actions`) status, so the recovery loop on the
    // next boot considered it unreplied and re-fired it.
    //
    // Fix: mark the thread as `replied_completed` here, atomically with
    // the actual Slack send. Now the next restart sees a terminal status
    // and skips re-enqueue.
    //
    // Why `replied_completed` and not `replied_to_follow_up`: orc has
    // produced its user-facing acknowledgement; whatever async work
    // continues downstream (Request → WIs → workers) is tracked by the
    // pool, not by the thread-status queue. Conflating "user got a reply"
    // with "all downstream work resolved" was the original architectural
    // mistake — they belong in different queues.
    //
    // Best-effort: if the threadKey isn't tracked yet (rare race where
    // the trackInbound call hasn't landed) or the markReplied throws,
    // we log and continue — Slack delivery is the primary success
    // criterion, thread-status is bookkeeping.
    if (threadTs && channelId) {
      try {
        const { ThreadStatusQueueService } = await import('../../services/messaging/thread-status-queue.service.js');
        const tsq = ThreadStatusQueueService.getInstance();
        const threadKey = `${channelId}:${threadTs}`;
        // Create the entry if it isn't tracked yet, then mark replied.
        // The trackInbound is idempotent — if the entry exists, this is
        // a no-op via `get(threadKey)` short-circuit.
        if (!tsq.get(threadKey)) {
          tsq.trackInbound({
            threadKey,
            conversationId: conversationId || `slack-${channelId}-${String(threadTs).replace('.', '-')}`,
            source: 'slack',
            messagePreview: '[reply-only — no inbound recorded]',
          });
        }
        tsq.markReplied(threadKey, 'replied_completed');
      } catch {
        // Non-fatal — Slack delivery succeeded, thread bookkeeping is best-effort
      }
    }

    // 2026-05-12 dogfood: notify the V3 SLA tracker that this thread
    // got a real orc reply. Without this hook, fixing the bridge's
    // delivery-ack callback to no longer fire `fromOrcReply=true` (the
    // 5-of-7-false-done bug) would leave Requests with no path at all
    // to terminal — the respond_to_user WI would sit in `queued`
    // forever after orc replies via this endpoint. Real orc replies
    // come through here (reply-slack skill posts to /slack/send), so
    // this is the right place to trigger the cascade.
    //
    // Best-effort: lazy import + try/catch so a subscriber-boot failure
    // can never break the actual Slack reply.
    if (threadTs) {
      try {
        const { getRequestSlaSubscriber } = await import('../../services/v3/request-sla.subscriber.js');
        const sub = getRequestSlaSubscriber();
        if (sub) {
          await sub.markResolvedByThread(threadTs);
        }
      } catch {
        // Slack delivery already succeeded; SLA hook is bookkeeping.
      }
    }

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
    const { channelId, filePath, filename, title, initialComment, threadTs } = req.body;

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
    const { channelId, filePath, filename, title, initialComment, threadTs } = req.body;

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
