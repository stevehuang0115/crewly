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
import { getSlackTeamChannelService } from '../../services/slack/slack-team-channel.service.js';
import { getSlackAgentIdentityService, SlackIdentityCloudError } from '../../services/slack/slack-agent-identity.service.js';
import { getSlackAgentPostService, SlackAgentPostError } from '../../services/slack/slack-agent-post.service.js';
import {
  startSlackTeamChannels,
  ensureSlackCloudConfigService,
  ensureSlackInstanceRegistry,
  handleSlackCloudConfigChange,
  getActiveSlackSource,
  setActiveSlackSource,
} from '../../services/slack/slack-initializer.js';
import { getSlackInstanceRegistryService } from '../../services/slack/slack-instance-registry.service.js';
import { CloudClientService } from '../../services/cloud/cloud-client.service.js';
import { SlackConfig, SlackNotification, SlackNotificationType } from '../../types/slack.types.js';
import { SLACK_IMAGE_CONSTANTS, SLACK_FILE_UPLOAD_CONSTANTS, SLACK_CLOUD_CONSTANTS } from '../../constants.js';
import type { SlackCloudWorkspaceSummary } from '../../types/slack.types.js';
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
 *  5. Clear the OrcDeliveryEnforcer pending-delivery ledger for the thread.
 *     Lives here rather than inline in `/send` so a deliverable handed over
 *     as an image or a file counts as delivered too. Previously only text
 *     replies cleared it, so an attachment reply left the watchdog armed and
 *     it kept nudging the orchestrator to deliver what it had already
 *     delivered — each nudge answered with another copy of the same reply.
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
      const { slackOutboundClientMessageId } = await import(
        '../../services/chat-v2/legacy-dto.utils.js'
      );
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
        // Shared idempotency key with SlackService.recordOutboundToChatV2 so a
        // text reply (which goes out via sendMessage → that mirror) isn't
        // persisted twice. File/image uploads don't go through sendMessage, so
        // this stays their single persist; the key just makes it idempotent.
        ...(typeof channelId === 'string' && typeof threadTs === 'string'
          ? {
              clientMessageId: slackOutboundClientMessageId(channelId, threadTs, content),
            }
          : {}),
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

  // 5. Clear the pending-delivery reminder the enforcer is holding for this
  //    thread (2026-05-23 incident ledger). Any successful reply to the
  //    thread counts — text, image, or file.
  if (threadTs && channelId) {
    try {
      const { OrcDeliveryEnforcerService } = await import(
        '../../services/orc/orc-delivery-enforcer.service.js'
      );
      OrcDeliveryEnforcerService.getInstance()?.markDelivered({ channelId, threadTs });
    } catch {
      // Non-fatal — enforcer not wired (e.g. headless mode).
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

    // Team channels (one Slack channel per team). Best-effort; never fails connect.
    await startSlackTeamChannels();

    // Persist credentials to disk so they survive server restarts
    await saveSlackCredentials(config);
    setActiveSlackSource('env');

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
    setActiveSlackSource(null);

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

// ---------------------------------------------------------------------------
// Crewly Cloud owns Slack (Slack v3) — one-click install, status, primary
// ---------------------------------------------------------------------------

/**
 * Answer 401 unless the OSS install is signed in to Crewly Cloud.
 *
 * @param res - Response used for the 401
 * @returns `{ token, cloudUrl }` or null after the response was sent
 */
function requireCloudLogin(res: Response): { token: string; cloudUrl: string } | null {
  const cloud = CloudClientService.getInstance();
  const token = cloud.getToken();
  const cloudUrl = cloud.getCloudUrl();
  if (!cloud.isConnected() || !token || !cloudUrl) {
    res.status(401).json({
      success: false,
      error: 'Log in to Crewly Cloud first (Settings → Cloud) — Slack is installed through your Crewly account',
      code: 'CLOUD_NOT_CONNECTED',
    });
    return null;
  }
  return { token, cloudUrl: cloudUrl.replace(/\/$/, '') };
}

/**
 * The dashboard URL the Slack install flow returns to: the caller's
 * `returnUrl` when it is an http(s) URL, otherwise this server's origin +
 * the Settings Slack tab.
 *
 * @param req - The request
 * @returns An absolute http(s) URL
 */
function resolveInstallReturnUrl(req: Request): string {
  const requested = typeof req.query.returnUrl === 'string' ? req.query.returnUrl.trim() : '';
  if (/^https?:\/\//i.test(requested)) return requested;
  const host = req.get('host') || `localhost`;
  return `${req.protocol}://${host}${SLACK_CLOUD_CONSTANTS.INSTALL_RETURN_PATH}`;
}

/**
 * GET /api/slack/cloud/install-url
 *
 * Build the one-click install link: Cloud's `/api/cloud/slack/install`
 * with the current Cloud JWT (a browser redirect cannot set headers) and
 * the dashboard return URL.
 *
 * @query returnUrl - Optional absolute http(s) URL to come back to
 * @returns `{ url, returnUrl }`
 */
router.get('/cloud/install-url', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const login = requireCloudLogin(res);
    if (!login) return;
    const returnUrl = resolveInstallReturnUrl(req);
    // The instance id lets Cloud bind the installed workspace to this
    // instance, so an account with several workspaces needs no extra pick.
    const registry = await ensureSlackInstanceRegistry();
    const instanceId = registry.getInstanceId() ?? (await registry.resolveInstanceId());
    const url =
      `${login.cloudUrl}${SLACK_CLOUD_CONSTANTS.CLOUD_PATH}${SLACK_CLOUD_CONSTANTS.INSTALL_PATH}` +
      `?token=${encodeURIComponent(login.token)}&returnUrl=${encodeURIComponent(returnUrl)}` +
      (instanceId ? `&instanceId=${encodeURIComponent(instanceId)}` : '');
    res.json({ success: true, data: { url, returnUrl, instanceId } });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/slack/cloud/status
 *
 * The Cloud-owned Slack picture for this instance: connected workspace,
 * transport, primary flag, registry heartbeat and agents still waiting for
 * their install click. `?refresh=1` re-fetches the config from Cloud first
 * and connects when a workspace just appeared (the post-install landing).
 */
router.get('/cloud/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cloud = CloudClientService.getInstance();
    const cloudConnected = cloud.isConnected() && !!cloud.getToken() && !!cloud.getCloudUrl();
    const configService = await ensureSlackCloudConfigService();
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    if (refresh) {
      await configService.refresh();
    } else {
      await configService.load();
    }
    const slackService = getSlackService();
    const config = configService.getConfig();
    if (refresh && config && !slackService.isConnected() && configService.getSourceMode() !== 'env') {
      await handleSlackCloudConfigChange(config);
    }
    const registry = getSlackInstanceRegistryService();
    const primary = registry ? await registry.isPrimary() : await (await ensureSlackInstanceRegistry()).isPrimary();
    const hasSaved = await hasSavedCredentials();
    // Every workspace on the account, for the Settings switcher. Best effort:
    // a listing failure must not hide the rest of the status.
    let workspaces: SlackCloudWorkspaceSummary[] | null = null;
    if (cloudConnected && configService.getSourceMode() !== 'env') {
      try {
        workspaces = await configService.listWorkspaces();
      } catch {
        workspaces = null;
      }
    }
    res.json({
      success: true,
      data: {
        cloudConnected,
        sourceMode: configService.getSourceMode(),
        activeSource: getActiveSlackSource(),
        connected: slackService.isConnected(),
        transport: slackService.isConnected() ? slackService.getTransport() : null,
        workspace: config
          ? {
              slackTeamId: config.workspace.slackTeamId,
              slackTeamName: config.workspace.slackTeamName,
              botUserId: config.workspace.botUserId,
              appId: config.workspace.appId,
              agentIdentities: config.agents.length,
            }
          : null,
        configFetchedAt: configService.getFetchedAt(),
        configError: configService.getLastError(),
        primary,
        instanceId: registry?.getInstanceId() ?? null,
        lastHeartbeatAt: registry?.getLastHeartbeatAt() ?? null,
        registryError: registry?.getLastError() ?? null,
        pendingInstalls: registry?.getPendingInstalls() ?? [],
        availableWorkspaces: configService.getAvailableWorkspaces(),
        workspaces,
        selectedWorkspaceId: registry ? await registry.getWorkspaceId() : null,
        local: {
          env: !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN && process.env.SLACK_SIGNING_SECRET),
          saved: hasSaved,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/slack/cloud/primary
 *
 * Make (or unmake) this instance the account's primary — the one that gets
 * DMs to the master bot and messages in channels no team owns. Persisted
 * locally and pushed to Cloud right away.
 *
 * @body primary - boolean (required)
 */
router.put('/cloud/primary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { primary } = req.body ?? {};
    if (typeof primary !== 'boolean') {
      res.status(400).json({ success: false, error: 'primary (boolean) is required' });
      return;
    }
    const registry = await ensureSlackInstanceRegistry();
    await registry.setPrimary(primary);
    res.json({
      success: true,
      data: { primary: await registry.isPrimary(), lastHeartbeatAt: registry.getLastHeartbeatAt(), registryError: registry.getLastError() },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/slack/directory?channel=C…
 *
 * Who an agent can @: every agent of the Crewly account (any machine) with
 * team, machine and Slack mention, plus — when a channel is given — every
 * bot and human actually in that channel, including agents of other
 * Crewly accounts. Backs the `list-colleagues` skill.
 */
router.get('/directory', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getSlackDirectoryService } = await import('../../services/slack/slack-directory.service.js');
    const directory = getSlackDirectoryService();
    if (!directory) {
      res.status(503).json({ success: false, error: 'Slack directory is available only on the Cloud transport (Settings → Slack → Connect Slack)', code: 'directory_unavailable' });
      return;
    }
    const channel = typeof req.query.channel === 'string' && req.query.channel ? req.query.channel : undefined;
    const entries = await directory.list(channel);
    res.json({ success: true, data: { channel: channel ?? null, colleagues: entries } });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/slack/cloud/workspaces
 *
 * Every Slack workspace installed on the Cloud account (redacted), plus the
 * one this instance currently serves.
 */
router.get('/cloud/workspaces', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireCloudLogin(res)) return;
    const configService = await ensureSlackCloudConfigService();
    const registry = await ensureSlackInstanceRegistry();
    const workspaces = await configService.listWorkspaces();
    res.json({
      success: true,
      data: {
        workspaces,
        selectedWorkspaceId: await registry.getWorkspaceId(),
        activeWorkspaceId: configService.getConfig()?.workspace.slackTeamId ?? null,
      },
    });
  } catch (error) {
    if (error instanceof SlackIdentityCloudError) {
      res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({ success: false, error: error.message, code: error.code });
      return;
    }
    next(error);
  }
});

/**
 * PUT /api/slack/cloud/workspace
 *
 * Choose which of the account's workspaces this instance serves. Persisted
 * locally, pushed to Cloud (re-binding the instance), then the config is
 * refreshed and Slack reconnects on the new workspace.
 *
 * @body slackTeamId - Slack team id (required)
 */
router.put('/cloud/workspace', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireCloudLogin(res)) return;
    const { slackTeamId } = req.body ?? {};
    if (typeof slackTeamId !== 'string' || !/^[TE][A-Z0-9]{2,20}$/.test(slackTeamId)) {
      res.status(400).json({ success: false, error: 'slackTeamId (Slack team id) is required' });
      return;
    }
    const registry = await ensureSlackInstanceRegistry();
    await registry.setWorkspaceId(slackTeamId);
    const configService = await ensureSlackCloudConfigService();
    const config = await configService.refresh();
    if (config) await handleSlackCloudConfigChange(config);
    res.json({
      success: true,
      data: {
        selectedWorkspaceId: slackTeamId,
        activeWorkspaceId: config?.workspace.slackTeamId ?? null,
        connected: getSlackService().isConnected(),
        registryError: registry.getLastError(),
        configError: configService.getLastError(),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/slack/cloud/agents/sync
 *
 * Re-run the per-agent app provisioning for every team and return the
 * install links still pending (the Settings "Sync agents" button).
 */
router.post('/cloud/agents/sync', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireCloudLogin(res)) return;
    const registry = await ensureSlackInstanceRegistry();
    const result = await registry.syncAgents();
    if (!result) {
      res.status(502).json({ success: false, error: registry.getLastError() ?? 'Agent sync failed', code: 'AGENT_SYNC_FAILED' });
      return;
    }
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/slack/cloud/workspace
 *
 * Remove the account's Slack workspace on Cloud and disconnect here.
 */
router.delete('/cloud/workspace', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireCloudLogin(res)) return;
    const configService = await ensureSlackCloudConfigService();
    const removed = await configService.removeWorkspace();
    // The config change already asked the initializer to disconnect (async);
    // make sure a cloud-sourced connection is down before answering.
    await handleSlackCloudConfigChange(null);
    const slackService = getSlackService();
    if (slackService.isConnected() && slackService.getTransport() === 'cloud') {
      await slackService.disconnect();
      setActiveSlackSource(null);
    }
    res.json({ success: true, data: { removed } });
  } catch (error) {
    if (error instanceof SlackIdentityCloudError) {
      res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({ success: false, error: error.message, code: error.code });
      return;
    }
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Team channels — one Slack channel + one chat-v2 huddle per Crewly team
// ---------------------------------------------------------------------------

/**
 * Resolve the team-channel service or answer 503 when Slack is not up.
 *
 * @param res - Response used for the 503
 * @returns The service, or null after the response was sent
 */
function requireTeamChannels(res: Response) {
  const service = getSlackTeamChannelService();
  if (!service) {
    res.status(503).json({
      success: false,
      error: 'Slack team channels are unavailable — connect Slack first',
      code: 'SLACK_NOT_CONNECTED',
    });
    return null;
  }
  return service;
}

/**
 * GET /api/slack/team-channels
 *
 * Settings plus every non-archived team with its mapping (or null).
 */
router.get('/team-channels', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const service = requireTeamChannels(res);
    if (!service) return;
    const [settings, teams] = await Promise.all([service.getSettings(), service.listTeamsWithMappings()]);
    res.json({ success: true, data: { settings, teams } });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/slack/team-channels/settings
 *
 * @body autoCreate - Create a channel automatically for every new team
 * @body channelPrefix - Prefix for auto-created channel names
 */
router.put('/team-channels/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = requireTeamChannels(res);
    if (!service) return;
    const { autoCreate, channelPrefix } = req.body ?? {};
    if (autoCreate !== undefined && typeof autoCreate !== 'boolean') {
      res.status(400).json({ success: false, error: 'autoCreate must be a boolean' });
      return;
    }
    if (channelPrefix !== undefined && typeof channelPrefix !== 'string') {
      res.status(400).json({ success: false, error: 'channelPrefix must be a string' });
      return;
    }
    const settings = await service.updateSettings({ autoCreate, channelPrefix });
    res.json({ success: true, data: settings });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/slack/team-channels
 *
 * Create (or link) the Slack channel for a team.
 *
 * @body teamId - Crewly team id (required)
 * @body slackChannelId - Existing Slack channel to link instead of creating (optional)
 */
router.post('/team-channels', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = requireTeamChannels(res);
    if (!service) return;
    const { teamId, slackChannelId } = req.body ?? {};
    if (typeof teamId !== 'string' || teamId.trim().length === 0) {
      res.status(400).json({ success: false, error: 'teamId is required' });
      return;
    }
    if (slackChannelId !== undefined && typeof slackChannelId !== 'string') {
      res.status(400).json({ success: false, error: 'slackChannelId must be a string' });
      return;
    }
    const team = await service.getTeam(teamId);
    if (!team) {
      res.status(404).json({ success: false, error: `Team not found: ${teamId}` });
      return;
    }
    const mapping = await service.ensureTeamChannel(team, {
      slackChannelId: slackChannelId?.trim() || undefined,
    });
    res.status(201).json({ success: true, data: mapping });
  } catch (error) {
    if (!handleSlackPlatformError(error, res)) {
      next(error);
    }
  }
});

/**
 * DELETE /api/slack/team-channels/:teamId
 *
 * Unlink a team. `?archive=true` also archives the Slack channel.
 */
router.delete('/team-channels/:teamId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = requireTeamChannels(res);
    if (!service) return;
    const archive = req.query.archive === 'true' || req.query.archive === '1';
    const removed = await service.unlinkTeam(req.params.teamId, { archiveSlackChannel: archive });
    if (!removed) {
      res.status(404).json({ success: false, error: 'No Slack channel is linked to this team' });
      return;
    }
    res.json({ success: true, data: { removed: true, archivedSlackChannel: archive } });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Agent identities — one real Slack bot user per agent, via Crewly Cloud
// ---------------------------------------------------------------------------

/**
 * Resolve the identity service, answering 503 when Slack team channels are
 * not started, and 401 when the OSS install is not logged in to Cloud.
 *
 * @param res - Response used for the error
 * @returns The service, or null after the response was sent
 */
function requireIdentities(res: Response) {
  const service = getSlackAgentIdentityService();
  if (!service) {
    res.status(503).json({ success: false, error: 'Slack is not connected', code: 'SLACK_NOT_CONNECTED' });
    return null;
  }
  if (!service.isAvailable()) {
    res.status(401).json({
      success: false,
      error: 'Log in to Crewly Cloud first (crewly cloud login) — agent identities are provisioned there',
      code: 'CLOUD_NOT_CONNECTED',
    });
    return null;
  }
  return service;
}

/**
 * Serialize a Cloud failure with its status and code, or pass on.
 */
function sendIdentityError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof SlackIdentityCloudError) {
    res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({ success: false, error: err.message, code: err.code });
    return;
  }
  next(err);
}

/** Strip bot tokens before anything leaves the process. */
function publicIdentity<T extends { botToken?: string }>(record: T): Omit<T, 'botToken'> & { hasToken: boolean } {
  const { botToken, ...rest } = record;
  return { ...rest, hasToken: !!botToken };
}

/**
 * GET /api/slack/agent-identities
 *
 * Cloud status (config token, counts) plus the local identity cache
 * (without tokens). `?refresh=1` pulls from Cloud first.
 */
router.get('/agent-identities', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = requireIdentities(res);
    if (!service) return;
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const [cloud, identities] = await Promise.all([
      service.getCloudStatus(),
      refresh ? service.refreshFromCloud() : service.list(),
    ]);
    res.json({ success: true, data: { cloud, identities: identities.map(publicIdentity) } });
  } catch (error) {
    sendIdentityError(error, res, next);
  }
});

/**
 * PUT /api/slack/agent-identities/config-token
 *
 * @body token - Slack app configuration token (optional, may be expired)
 * @body refreshToken - Its refresh token (required)
 */
router.put('/agent-identities/config-token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = requireIdentities(res);
    if (!service) return;
    const { token, refreshToken } = req.body ?? {};
    if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
      res.status(400).json({ success: false, error: 'refreshToken is required' });
      return;
    }
    const status = await service.setConfigToken(typeof token === 'string' ? token.trim() : '', refreshToken.trim());
    res.json({ success: true, data: status });
  } catch (error) {
    sendIdentityError(error, res, next);
  }
});

/**
 * DELETE /api/slack/agent-identities/config-token
 */
router.delete('/agent-identities/config-token', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const service = requireIdentities(res);
    if (!service) return;
    const removed = await service.deleteConfigToken();
    res.json({ success: true, data: { removed } });
  } catch (error) {
    sendIdentityError(error, res, next);
  }
});

/**
 * POST /api/slack/agent-identities/provision
 *
 * Provision identities for every member of a mapped team and (re)announce
 * the install links in its Slack channel.
 *
 * @body teamId - A team with a Slack channel (required)
 */
router.post('/agent-identities/provision', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = requireIdentities(res);
    if (!service) return;
    const teamChannels = getSlackTeamChannelService();
    const { teamId } = req.body ?? {};
    if (typeof teamId !== 'string' || !teamId.trim() || !teamChannels) {
      res.status(400).json({ success: false, error: 'teamId is required' });
      return;
    }
    const team = await teamChannels.getTeam(teamId);
    const mapping = teamChannels.findByTeamId(teamId);
    if (!team || !mapping) {
      res.status(404).json({ success: false, error: 'Team has no Slack channel yet — create one first' });
      return;
    }
    const result = await teamChannels.ensureIdentities(team, mapping);
    res.json({ success: true, data: result });
  } catch (error) {
    sendIdentityError(error, res, next);
  }
});

/**
 * DELETE /api/slack/agent-identities/:agentSession
 *
 * Delete the agent's Slack app on Cloud and forget it locally.
 */
router.delete('/agent-identities/:agentSession', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = requireIdentities(res);
    if (!service) return;
    const removed = await service.remove(req.params.agentSession);
    res.json({ success: true, data: { removed } });
  } catch (error) {
    sendIdentityError(error, res, next);
  }
});

// ---------------------------------------------------------------------------
// Agent-initiated posts — an agent starting a Slack conversation itself
// ---------------------------------------------------------------------------

/** HTTP status per post-failure reason. */
const POST_ERROR_STATUS: Record<string, number> = {
  validation: 400,
  not_connected: 503,
  target_not_found: 404,
  slack_error: 502,
};

/**
 * POST /api/slack/post
 *
 * Send a message to a Slack channel or DM as the calling agent. Used by the
 * `slack-post` skill; the agent is taken from `X-Agent-Session`.
 *
 * @body target - `#channel`, `C…`/`D…` id, `@handle` or `U…` user id (required)
 * @body text - Message text (required)
 * @body threadTs - Reply inside an existing Slack thread (optional)
 * @returns `{ success, data: { channelId, messageTs, kind, postedAs, identity } }`
 */
router.post('/post', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = getSlackAgentPostService();
    if (!service) {
      res.status(503).json({ success: false, error: 'Slack is not connected', code: 'SLACK_NOT_CONNECTED' });
      return;
    }
    const header = req.headers['x-agent-session'] ?? req.headers['x-crewly-agent-session'];
    const agentSession = typeof header === 'string' && header.length > 0 ? header : '';
    if (!agentSession) {
      res.status(400).json({
        success: false,
        error: 'X-Agent-Session header is required — the post is sent under that agent\'s identity',
        code: 'agent_session_required',
      });
      return;
    }
    const { target, text, threadTs } = req.body ?? {};
    const result = await service.post({
      agentSession,
      target: typeof target === 'string' ? target : '',
      text: typeof text === 'string' ? text : '',
      threadTs: typeof threadTs === 'string' && threadTs ? threadTs : undefined,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof SlackAgentPostError) {
      res.status(POST_ERROR_STATUS[error.code] ?? 502).json({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }
    if (!handleSlackPlatformError(error, res)) {
      next(error);
    }
  }
});

export default router;
