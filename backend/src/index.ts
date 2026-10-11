#!/usr/bin/env node

// Load environment variables from .env file BEFORE any other imports
// This ensures env vars are available when services initialize
import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import os from 'os';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

import {
	StorageService,
	TmuxService,
	SchedulerService,
	MessageSchedulerService,
	ActivityMonitorService,
	TeamActivityWebSocketService,
	TeamsJsonWatcherService,
} from './services/index.js';
import {
	getSessionBackend,
	getSessionBackendSync,
	getSessionStatePersistence,
	destroySessionBackend,
	PtySessionBackend,
	SessionCommandHelper,
} from './services/session/index.js';
import { RuntimePidRegistry } from './services/session/runtime-pid-registry.service.js';
import { removeCrewlyAgentFile, resolvePersistedSessions, selectAutoRestoreSessions } from './services/session/session-binding.js';
import type { PersistedSessionInfo } from './services/session/session-state-persistence.js';
import { ApiController } from './controllers/api.controller.js';
import { createApiRoutes } from './routes/api.routes.js';
import { TerminalGateway, setTerminalGateway } from './websocket/terminal.gateway.js';
import { initializeChatGateway } from './websocket/chat.gateway.js';
import { StartupConfig } from './types/index.js';
import { LoggerService } from './services/core/logger.service.js';
import { retryWithBackoff } from './services/core/retry.util.js';
import {
	CREWLY_CONSTANTS,
	ORCHESTRATOR_SESSION_NAME,
	AGENT_SUSPEND_CONSTANTS,
	OWNER_MESSAGE_WATCHDOG_CONSTANTS,
	TURN_STATE_CONSTANTS,
	CLOUD_DISCONNECT_NOTICE_CONSTANTS,
	ORCHESTRATOR_ROLE,
	ORCHESTRATOR_WINDOW_NAME,
	MESSAGE_QUEUE_CONSTANTS,
	RUNTIME_TYPES,
	AUDITOR_CONSTANTS,
	AUDITOR_SCHEDULER_CONSTANTS,
	API_SECURITY_CONSTANTS,
	type RuntimeType,
	TEAM_LEAD_CONSTANTS,
} from './constants.js';
import { getSettingsService } from './services/settings/index.js';
import { MemoryService } from './services/memory/memory.service.js';
import { getImprovementStartupService } from './services/orchestrator/improvement-startup.service.js';
import { dedicatedDecisionFor } from './services/people/dedicated-agent.js';
import { setPeopleBotLookup, setPeopleOwnerLookup } from './services/people/people-directory.service.js';
import { isCrewlyBotUserId } from './services/slack/slack-bot-ids.js';
import { getSlackCloudConfigService } from './services/slack/slack-cloud-config.service.js';
import { initializeSlackIfConfigured, shutdownSlack } from './services/slack/index.js';
import { isNonFatalUnhandledRejection, unhandledRejectionMessage } from './utils/unhandled-rejection.utils.js';
import { initializeWhatsAppIfConfigured, shutdownWhatsApp } from './services/whatsapp/index.js';
import { initializeGoogleChatIfConfigured } from './services/messaging/google-chat-initializer.js';
import { initializeTelegramIfConfigured, shutdownTelegram } from './services/telegram/index.js';
import { initializeCloudIfConfigured } from './services/cloud/cloud-initializer.js';
import { MessageQueueService, QueueProcessorService, ResponseRouterService } from './services/messaging/index.js';
import { ThreadStatusQueueService } from './services/messaging/thread-status-queue.service.js';
import { EventBusService } from './services/event-bus/index.js';
import { EventToWorkItemBridge } from './services/event-bus/event-to-workitem-bridge.service.js';
import { KRCompletionSubscriber } from './services/v3/kr-completion.subscriber.js';
import { FallbackTriggerCleanupSubscriber } from './services/v3/fallback-trigger-cleanup.subscriber.js';
import { MissionReminderService } from './services/v3/mission-reminder.service.js';
import { OKROwnerGuidanceService } from './services/v3/okr-owner-guidance.service.js';
import { getCrewlyHomeId, getCrewlyHomePath, migrateLegacyProjectData, resolveProjectDataDir } from './services/core/crewly-home.utils.js';
import { KRTrackingService } from './services/v3/kr-tracking.service.js';
import { getSlackOrchestratorBridge } from './services/slack/slack-orchestrator-bridge.js';
import { OKRReviewService } from './services/v3/okr-review.service.js';
import { bootEscalationService } from './services/v3/escalation-boot.js';
import { TeamBudgetGateService } from './services/budget/team-budget-gate.service.js';
import { HierarchyEscalationMonitor } from './services/hierarchy/hierarchy-escalation-monitor.service.js';
import type { EscalationService } from './services/v3/escalation.service.js';
import { AutoLearningSubscriber } from './services/memory/auto-learning.subscriber.js';
import { MilestoneNotificationSubscriber } from './services/notification/milestone-notification.subscriber.js';
import {
	RequestSlaSubscriber,
	setRequestSlaSubscriber,
	getRequestSlaSubscriber,
} from './services/v3/request-sla.subscriber.js';
import {
	RequestDecomposeSubscriber,
	setRequestDecomposeSubscriber,
} from './services/v3/request-decompose.subscriber.js';
import { RequestStatusUpdateSubscriber } from './services/v3/request-status-update.subscriber.js';
import { RequestCascadeSubscriber } from './services/v3/request-cascade.subscriber.js';
import { setRequestServiceEventBus, RequestService } from './services/v3/request.service.js';
import { OwnerReceiptService, setOwnerReceiptService } from './services/v3/owner-receipt/owner-receipt.service.js';
import { agentNameIndexOf, createSlackOwnerSender, startOwnerReceiptSchedule, teamIndexOf, teamLeadIndexOf } from './services/v3/owner-receipt/owner-receipt.boot.js';
import { IntakeOutcomeLog } from './services/v3/ticket-intake-log.js';
import { getSlackService } from './services/slack/slack.service.js';
import { getSlackTypingPlaceholderService } from './services/slack/slack-typing-placeholder.service.js';
import { getSlackAutoWorkingService } from './services/slack/slack-auto-working.service.js';
import { getSlackAgentDmService } from './services/slack/slack-agent-dm.service.js';
import { sendBootAnnouncement, isFirstBoot, markBooted } from './services/boot/boot-announce.service.js';
import { SubAgentMessageQueue } from './services/messaging/sub-agent-message-queue.service.js';
import { InProcessTurnFailureService, setInProcessTurnFailureService } from './services/agent/in-process-turn-failure.service.js';
import { LivenessMonitorService } from './services/monitoring/liveness-monitor.service.js';
import { getOwnerMessageWatchdog } from './services/messaging/owner-message-watchdog.service.js';
import { getOwnerThreadSentinel, reportOwnerThreadBlocking } from './services/messaging/owner-thread-sentinel.service.js';
import { parseInboundOrigin } from './services/orc/orc-reply-route.service.js';
import { parseSlackThreadKey } from './services/slack/slack-thread-key.js';
import { LIVENESS_MONITOR_CONSTANTS, INPUT_CIRCUIT_CONSTANTS, INPUT_BLOCKED_RETRY_CONSTANTS } from './constants.js';
import { InputBlockedRetryService } from './services/messaging/input-blocked-retry.service.js';
import { driveCapabilities } from './services/drive/drive-agent.service.js';
import { SUB_AGENT_QUEUE_CONSTANTS, CHAT_CONTEXT_CONSTANTS, SAFE_RESTART, AUTO_UPDATE_CONSTANTS, PROCESS_EXIT_CODES, CLAUDE_STARTUP_CONSTANTS, WEB_CONSTANTS, TICKET_CONSTANTS, UNASSIGNED_ROUTE_CONSTANTS, CLOUD_TALK_CONSTANTS, STANDING_ANSWERS_CONSTANTS, TICKET_AUTOPILOT_CONSTANTS, TICKET_HYGIENE_CONSTANTS, EXPERIMENT_CONSTANTS, WORK_ITEM_DESTINATION_CONSTANTS, CODEX_USAGE_SYNC_CONSTANTS, ANTIGRAVITY_USAGE_SYNC_CONSTANTS, OWNER_AUTH_CONSTANTS, CREWLY_APPS_CONSTANTS, SLACK_AGENT_DM_CONSTANTS, BRIEFING_CONSTANTS, DRIVE_CONSTANTS } from './constants.js';
import { randomUUID } from 'crypto';
import { PtyActivityTrackerService } from './services/agent/pty-activity-tracker.service.js';
import { InFlightTurnTracker } from './services/restart/in-flight-turn-tracker.service.js';
import {
	TicketIntakeService,
	setTicketIntakeService,
	resolveTicketIdForSession,
} from './services/v3/ticket-intake.service.js';
import { createChatV2ReceiptSink } from './services/v3/ticket-channel-hooks.js';
import { TicketReviewService, setTicketReviewService, getTicketReviewService } from './services/v3/ticket-review.service.js';
import { initialDecider, nextDecider } from './services/task-pool/untargeted-router.js';
import { activeAcceptance, formatTicketMarker, formatTicketNumber } from './types/v2/ticket.types.js';
import type { RequestPriority } from './types/v2/request.types.js';
import { createWorkItem, TERMINAL_WORK_ITEM_STATUSES } from './types/v2/work-item.types.js';
import type { ChatMessageDTO } from './services/chat-v2/types.js';
import { runPoolArchiveMigration } from './services/task-pool/pool-archive-migration.js';
import { createPtyTurnProbe } from './services/restart/turn-probe.js';
import {
	RestartDrainService,
	resolveRestartDrainMs,
	resolveBackgroundDrainMs,
	type GracefulShutdownRequest,
} from './services/restart/restart-drain.service.js';
import {
	interruptedTurnsPath,
	loadInterruptedTurns,
	saveInterruptedTurns,
	writeInterruptedTurns,
	resumeInterruptedTurns,
	planCommitmentNotes,
	type InterruptedTurnEntry,
} from './services/restart/interrupted-turns.js';
import type { OwedCommitment } from './services/open-items/open-items.service.js';
import { AgentTurnStateService } from './services/monitoring/agent-turn-state.js';
import { DeferredIdleSettle } from './services/monitoring/deferred-idle-settle.js';
import { resolveSupervisorStopBudgetMs, capDrainToSupervisor } from './services/restart/supervisor-stop-budget.js';
import { findClaudeTranscript, defaultClaudeHome } from './services/agent/runtime-session-recovery.js';
import { DeviceIdentityService } from './services/cloud/device-identity.service.js';
import { CloudSyncService } from './services/cloud/cloud-sync.service.js';
import { SlackThreadStoreService, setSlackThreadStore, getSlackThreadStore } from './services/slack/slack-thread-store.service.js';
import { GoogleChatThreadStoreService, setGchatThreadStore } from './services/messaging/gchat-thread-store.service.js';
import { SlackImageService, setSlackImageService } from './services/slack/slack-image.service.js';
import { NotifyReconciliationService } from './services/slack/notify-reconciliation.service.js';
import { setEventBusService as setEventBusControllerService } from './controllers/event-bus/event-bus.controller.js';
import { setTeamControllerEventBusService } from './controllers/team/team.controller.js';
import { SkillCatalogService } from './services/skill/skill-catalog.service.js';
import { createEventBusRouter } from './controllers/event-bus/event-bus.routes.js';
import { setMessageQueueService as setChatMessageQueueService, setThreadStatusQueueService as setChatThreadStatusQueueService } from './controllers/chat/chat.controller.js';
import { setMessageQueueService as setMessagingControllerQueueService } from './controllers/messaging/messaging.controller.js';
import { createMessagingRouter } from './controllers/messaging/messaging.routes.js';
import { SystemResourceAlertService } from './services/monitoring/system-resource-alert.service.js';
import { TokenUsageService } from './services/monitoring/token-usage.service.js';
import { agentHeartbeatMiddleware } from './middleware/agent-heartbeat.middleware.js';
import { agentOriginMiddleware, liveSessionPids } from './middleware/agent-origin.middleware.js';
import { createCallerIdentityMiddleware } from './middleware/caller-identity.middleware.js';
import { bodyParserExcept } from './middleware/body-parser-except.js';
import { PeerProcessService } from './services/core/peer-process.service.js';
import { createOwnerSessionPageMiddleware, createOwnerSessionRouter } from './controllers/auth/owner-session.controller.js';
import { dashboardBuildHeader, dashboardBuildMessage, loadDashboardEntry } from './services/core/dashboard-build.js';
import {
	apiTokenMiddleware,
	healthGateMiddleware,
	socketIoAllowRequest,
	installWebSocketGate,
} from './middleware/api-token.middleware.js';
import { getApiTokenFilePath, mirrorEnvTokenToFile, resolveApiToken } from './services/core/api-token.service.js';
import { CredentialGuardAlertService } from './services/monitoring/credential-guard-alerts.js';
import { isCredentialGuardEnabled, prepareCredentialGuard, syncAntigravityCredentialHook } from './services/agent/credential-guard.service.js';
import { isHeadlessEnvironment, describeNetworkExposure } from './utils/network-exposure.utils.js';
import { RedisCacheService } from './services/cache/redis-cache.service.js';
import { OrchestratorRestartService } from './services/orchestrator/orchestrator-restart.service.js';
import { setOrchestratorSetupDependencies } from './services/orchestrator/orchestrator-setup.service.js';
import { IdleDetectionService } from './services/agent/idle-detection.service.js';
import { AgentSuspendService } from './services/agent/agent-suspend.service.js';
import { AgentHeartbeatMonitorService } from './services/agent/agent-heartbeat-monitor.service.js';
import { OrchestratorHeartbeatMonitorService } from './services/orchestrator/orchestrator-heartbeat-monitor.service.js';
import { RuntimeExitMonitorService } from './services/agent/runtime-exit-monitor.service.js';
import { ContextWindowMonitorService } from './services/agent/context-window-monitor.service.js';
import { OAuthReloginMonitorService } from './services/agent/oauth-relogin-monitor.service.js';
import { OrcReplyRouteService } from './services/orc/orc-reply-route.service.js';
import { buildTriggerOrigin } from './services/orc/work-item-destination.js';
import { ReloginAgentResumerService } from './services/agent/relogin-agent-resumer.service.js';
import { getHarnessReloginService, harnessCommandWord } from './services/harness/harness-relogin.service.js';
import { getHarnessService } from './services/harness/harness.service.js';
import { SlackReloginDmService, createReloginReplyInterceptor } from './services/slack/slack-relogin-dm.service.js';
import { startBackendRuntimeFallback } from './services/runtime-fallback/runtime-fallback.wiring.js';
import { getRuntimeFallbackService } from './services/runtime-fallback/runtime-fallback.service.js';
import { getSlackAgentIdentityService } from './services/slack/slack-agent-identity.service.js';
import { getChatV2Service } from './services/chat-v2/chat-v2.singleton.js';
import { isOwnerStopped } from './services/agent/owner-stopped.registry.js';
import { createFollowThrough, settleFollowThrough, idlePendingWorkCheck, releaseWorkForStop } from './services/agent/follow-through.wiring.js';
import { isSessionPaused } from './services/team/team-pause.registry.js';
import { findPackageRoot } from './utils/package-root.js';
import { getLocalApiBaseUrl, setLocalApiPort } from './utils/local-api-url.utils.js';
import { assertBuildProvenance } from './utils/build-provenance.js';
import { isNativeBindingFatalError } from './utils/native-binding.utils.js';
import { VersionCheckService } from './services/system/version-check.service.js';
import { AutoUpdateService, createAutoUpdateService } from './services/system/auto-update.service.js';
import { detectInstall, resolveRunningPackageRoot, safeProcessCwd } from './services/system/auto-update.utils.js';
import { SystemControlService } from './services/system/system-control.service.js';
import { WindDownService } from './services/system/wind-down.service.js';
import { clearShutdownMarker, writeShutdownMarker } from './services/system/shutdown-marker.js';
import { withQueueMeta } from './services/messaging/queue-priority.js';
import { collectLiveViews, runInputGuardCheck, type InputGuardReport } from './services/system/input-guard-release-check.js';
import { detectRunningSupervisor } from './services/system/supervisor-detect.js';
import { buildReplacementPlan, spawnReplacementLauncher } from './services/system/restart-replacement.js';
import {
	type CloudDisconnectNoticeService,
	createCloudDisconnectNoticeService,
} from './services/cloud/cloud-disconnect-notice.service.js';
import { isNoticeEnabled } from './services/cloud/cloud-disconnect-notice.utils.js';
import { createOwnerDirectDm } from './services/slack/slack-owner-direct-dm.js';
import { LogRotationService } from './services/session/log-rotation.service.js';
import { WorktreeJanitorService } from './services/worktree/worktree-janitor.service.js';
import { AuditorSchedulerService } from './services/agent/auditor-scheduler.service.js';
import { setAuditorSchedulerService } from './controllers/auditor/auditor.controller.js';
import { AddonLoaderService } from './services/addon/addon-loader.service.js';
import { CronTaskService } from './services/workflow/cron-task.service.js';
import { ReconcilerService, type ReconcilerDataProvider } from './services/reconciler/reconciler.service.js';
import { LiveReconcilerDataProvider } from './services/reconciler/reconciler-data-provider.js';
import { setReconcilerService } from './controllers/reconciler/reconciler.controller.js';
import { FissionGuardService, type FissionDataProvider, type BudgetChecker, createFailOpenBudgetChecker } from './services/fission/fission-guard.service.js';
import { BudgetService } from './services/autonomous/budget.service.js';
import { setFissionGuardService } from './controllers/fission/fission.controller.js';
import { TaskPoolService } from './services/task-pool/task-pool.service.js';
import { createProtectedReason } from './services/agent/resource-mode-protection.js';
import { ProjectTicketWorkflowService } from './services/project-tickets/project-ticket-workflow.service.js';
import { WorkItemWorktreeService } from './services/worktree/workitem-worktree.service.js';
import { WorkItemWorktreeSubscriber, createTerminalNotifier } from './services/worktree/workitem-worktree.subscriber.js';
import { ResourceModeService, RESOURCE_MODE_CONSTANTS, type RunningAgent } from './services/agent/resource-mode.service.js';
import { getRestoreQueue, RESTORE_TIER, type RestoreEntry } from './services/agent/restore-queue.js';
import { sessionsToRestore, type RestoreWorkItem } from './services/agent/restore-filter.js';
import { ProjectMemoryService } from './services/memory/project-memory.service.js';
import { TaskHistorySubscriber } from './services/memory/task-history.subscriber.js';
import {
	TeamHealthWatchdogService,
	LiveTeamHealthDataProvider,
	loadTeamHealthConfig,
	setTeamHealthWatchdogSingleton,
	getTeamHealthWatchdogSingleton,
	type AlertSink,
	type AlertDecision,
} from './services/team-health/index.js';
import { createTeamHealthRouter } from './controllers/team-health/team-health.routes.js';
import { traceHarness, traceTurnActivity } from './services/trace/trace-recorder.js';
import { inputCircuitStats, setInputCircuitOpenListener } from './services/session/input-circuit-breaker.js';
import { harnessPastesSinceOutsideInput, shownMarkers } from './services/session/input-ledger.js';

// ESM __dirname equivalent using import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Safely parses an integer from a string with validation and fallback.
 *
 * @param value - The string value to parse, or undefined
 * @param defaultValue - The default value to return if parsing fails or value is invalid
 * @param envVarName - Optional name of the environment variable for logging purposes
 * @returns The parsed integer or the default value if parsing fails
 */
function parseIntWithFallback(value: string | undefined, defaultValue: number, envVarName?: string): number {
	if (value === undefined || value === '') {
		return defaultValue;
	}

	const parsed = parseInt(value, 10);

	// Check if parsing resulted in NaN or if the value contains non-numeric characters
	// that would be silently ignored by parseInt (e.g., "3000abc" -> 3000)
	if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
		const logger = LoggerService.getInstance().createComponentLogger('ConfigParser');
		logger.warn('Invalid numeric environment variable value, using default', {
			envVar: envVarName,
			value,
			defaultValue,
		});
		return defaultValue;
	}

	// Validate that the entire string was a valid number (no trailing non-numeric chars)
	if (String(parsed) !== value.trim()) {
		const logger = LoggerService.getInstance().createComponentLogger('ConfigParser');
		logger.warn('Environment variable contains non-numeric characters, using parsed value', {
			envVar: envVarName,
			originalValue: value,
			parsedValue: parsed,
		});
	}

	return parsed;
}

/**
 * `/health` block for the Cloud connection: sync state plus relay queue
 * registration. Heartbeats can succeed while the relay refuses this machine
 * a queue (429 quota_exceeded, 2026-10-02) — then nothing, Slack included,
 * arrives here, and this is where that shows.
 *
 * @returns Cloud health, or `{ status: 'unknown' }` when it cannot be read
 */
function cloudHealthBlock(): Record<string, unknown> {
	try {
		const health = CloudSyncService.getInstance().getHealth();
		const queue = health.relayQueue;
		const receiving = health.state === 'syncing' && !!queue?.queueId;
		return {
			status: health.state === 'stopped' ? 'off' : receiving ? 'ok' : 'degraded',
			state: health.state,
			lastContactAt: health.lastContactAt,
			relayQueue: queue ?? null,
		};
	} catch {
		return { status: 'unknown' };
	}
}

/**
 * Send an alert to the owner as a Slack notification. Shared by the disk
 * janitor's low-disk notice, critical system alerts (#991) and repeated
 * runtime startup exits (#989), so they all reach an away owner the same way.
 *
 * @param notice - Title, message and whether it is urgent
 * @returns True when it was sent, false when Slack is not connected
 */
async function slackOwnerAlertNotifier(notice: { title: string; message: string; urgent: boolean }): Promise<boolean> {
	const slack = getSlackService();
	if (!slack.isConnected()) return false;
	await slack.sendNotification({
		type: 'alert',
		title: notice.title,
		message: notice.message,
		urgency: notice.urgent ? 'critical' : 'normal',
		timestamp: new Date().toISOString(),
	});
	return true;
}

export class CrewlyServer {
	private app: express.Application;
	private httpServer: ReturnType<typeof createServer>;
	private io: SocketIOServer;
	/** Entry script of the dashboard build this backend serves (null: none built) */
	private dashboardEntry: string | null = null;
	private config: StartupConfig;
	private logger = LoggerService.getInstance().createComponentLogger('CrewlyServer');
	/** Offline-replay summary from this boot, surfaced in the boot announcement. */
	private lastOfflineReplay?: { offlineDurationMs?: number; replayedCount?: number };

	private storageService!: StorageService;
	private tmuxService!: TmuxService;
	private schedulerService!: SchedulerService;
	private messageSchedulerService!: MessageSchedulerService;
	private activityMonitorService!: ActivityMonitorService;
	private teamActivityWebSocketService!: TeamActivityWebSocketService;
	private teamsJsonWatcherService!: TeamsJsonWatcherService;
	private apiController!: ApiController;
	private terminalGateway!: TerminalGateway;
	private messageQueueService!: MessageQueueService;
	private queueProcessorService!: QueueProcessorService;
	private threadStatusQueueService!: ThreadStatusQueueService;
	private eventBusService!: EventBusService;
	/** BRIDGE-1: subscribes to autonomy events and creates WorkItems. */
	private eventToWorkItemBridge: EventToWorkItemBridge | null = null;
	private krCompletionSubscriber: KRCompletionSubscriber | null = null;
	private fallbackTriggerCleanup: FallbackTriggerCleanupSubscriber | null = null;
	private escalationService: EscalationService | null = null;
	private hierarchyEscalationMonitor: HierarchyEscalationMonitor | null = null;
	/** LEARN-1: subscribes to terminal task / mission:replanned events and auto-records learnings. */
	private autoLearningSubscriber: AutoLearningSubscriber | null = null;
	// DF-1 #438 — symmetric to AutoLearningSubscriber; surfaces milestones
	// to orc's chat queue.
	private milestoneNotificationSubscriber: MilestoneNotificationSubscriber | null = null;
	/** INBOUND-1: subscribes to request:created and tracks 5/10 min SLA on respond_to_user WIs. */
	private requestSlaSubscriber: RequestSlaSubscriber | null = null;
	/** Pipeline-#4 follow-up: subscribes to request:created and auto-decomposes actionable L2 Requests via plan() → addToPool. */
	private requestDecomposeSubscriber: RequestDecomposeSubscriber | null = null;
	private requestStatusUpdateSubscriber: RequestStatusUpdateSubscriber | null = null;
	private requestCascadeSubscriber: RequestCascadeSubscriber | null = null;
	private notifyReconciliationService!: NotifyReconciliationService;
	private systemResourceAlertService!: SystemResourceAlertService;
	private reconcilerService: ReconcilerService | null = null;
	private teamHealthWatchdog: TeamHealthWatchdogService | null = null;
	/** Owner-configured interval commands (null until started) */
	private scheduledCommands: import("./services/system/scheduled-commands.service.js").ScheduledCommandsService | null = null;

	// Chat MVP Phase 1 — initialized lazily in `start()` after the HTTP
	// server is created. Kept as fields so the shutdown path can close
	// them cleanly and tests can reach in with a reference.
	private chatV2Gateway: import('./websocket/chat-v2.gateway.js').ChatV2Gateway | null = null;
	private chatV2Dispatcher:
		| import('./services/chat-v2/chat-v2.dispatcher.service.js').ChatV2DispatcherService
		| null = null;

	// Shutdown state
	private isShuttingDown = false;
	/** Tells the owner on Slack when this machine loses Crewly Cloud */
	private cloudDisconnectNotice: CloudDisconnectNoticeService | null = null;
	private conversationCloudSync: import('./services/cloud/conversation-cloud-sync.service.js').ConversationCloudSyncService | null = null;
	/** Gaps in this backend's life are told to the owner (crewly#1015 §12) */
	private livenessMonitor: LivenessMonitorService | null = null;
	private waitingItemsSync: import('./services/cloud/waiting-items-sync.service.js').WaitingItemsSyncService | null = null;
	/** Epoch ms of the last shutdown signal acted on (dedups process-group delivery) */
	private lastShutdownSignalAt = 0;
	/** Interrupted turns loaded at boot, resumed once their agents are back */
	private interruptedTurnsAtBoot: InterruptedTurnEntry[] = [];
	/** Supervisor's SIGTERM→SIGKILL budget (systemd TimeoutStopUSec), read at boot; null = none / unknown */
	private supervisorStopBudgetMs: number | null = null;
	/**
	 * End-of-turn settling skipped while an agent still had background work,
	 * re-checked until that work is gone (specs/2026-10-02-restart-busy-and-resume.md).
	 */
	private readonly deferredIdleSettle = new DeferredIdleSettle({
		hasBackgroundWork: (sessionName) => AgentTurnStateService.getInstance().hasBackgroundWork(sessionName),
		isMidTurn: (sessionName) => AgentTurnStateService.getInstance().getVerdict(sessionName).state === 'turn',
		settle: (sessionName) => this.settleAfterTurn(sessionName),
		intervalMs: TURN_STATE_CONSTANTS.SETTLE_RECHECK_MS,
		maxWaitMs: TURN_STATE_CONSTANTS.OPEN_WORK_MAX_MS,
	});
	/** Owner promises past due and never nudged at boot; their agents are restored and reminded once */
	private openCommitmentsAtBoot: OwedCommitment[] = [];
	private healthMonitoringInterval: NodeJS.Timeout | null = null;

	constructor(config?: Partial<StartupConfig>) {
		// Resolve ~ to actual home directory
		const resolveHomePath = (inputPath: string) => {
			if (inputPath.startsWith('~/')) {
				return path.join(os.homedir(), inputPath.slice(2));
			}
			if (inputPath === '~') {
				return os.homedir();
			}
			return inputPath;
		};

		const defaultAgentmuxHome =
			config?.crewlyHome || process.env.CREWLY_HOME || '~/.crewly';

		this.config = {
			webPort: config?.webPort || parseIntWithFallback(process.env.WEB_PORT, WEB_CONSTANTS.PORTS.BACKEND, 'WEB_PORT'),
			crewlyHome: resolveHomePath(defaultAgentmuxHome),
			defaultCheckInterval:
				config?.defaultCheckInterval ||
				parseIntWithFallback(process.env.DEFAULT_CHECK_INTERVAL, 30, 'DEFAULT_CHECK_INTERVAL'),
			autoCommitInterval:
				config?.autoCommitInterval || parseIntWithFallback(process.env.AUTO_COMMIT_INTERVAL, 30, 'AUTO_COMMIT_INTERVAL'),
			headless: config?.headless ?? process.env.CREWLY_HEADLESS === 'true',
			bindHost:
				config?.bindHost ||
				process.env[API_SECURITY_CONSTANTS.ENV.BIND_HOST] ||
				API_SECURITY_CONSTANTS.DEFAULT_BIND_HOST,
		};
		// Single source of truth for "where is this instance's API": agents get
		// it as CREWLY_API_URL and internal self-calls use it (#777).
		setLocalApiPort(this.config.webPort);

		this.app = express();
		this.httpServer = createServer(this.app);
		this.io = new SocketIOServer(this.httpServer, {
			cors: {
				origin: process.env.NODE_ENV === 'production'
					? ['https://crewlyai.com', 'https://www.crewlyai.com']
					: '*',
				methods: ['GET', 'POST'],
			},
			// Configure ping/pong to keep connections alive
			pingInterval: 10000, // Send ping every 10 seconds
			pingTimeout: 5000, // Wait 5 seconds for pong response
			// Prefer WebSocket transport for lower latency
			transports: ['websocket', 'polling'],
			// Allow transport upgrade from polling to websocket
			allowUpgrades: true,
			// Increase buffer size for large terminal output
			maxHttpBufferSize: 5 * 1024 * 1024, // 5MB
			perMessageDeflate: false,
			// CRITICAL: Prevent Engine.IO from destroying non-matching upgrade requests.
			// Crewly in Chrome (BrowserBridgeService) shares this httpServer and handles /ws/browser upgrades.
			// Without this, Engine.IO sets a 1-second timer to socket.end() any upgrade
			// that doesn't match /socket.io/ — killing Crewly in Chrome connections before
			// any data is exchanged (manifests as "Invalid frame header" errors).
			destroyUpgrade: false,
			// Non-loopback clients must present the API token (query `token`
			// or the `crewly_token` cookie). Engine.IO's polling handshake
			// bypasses Express, so the gate has to live here as well.
			allowRequest: socketIoAllowRequest,
		});

		this.initializeServices();
		this.configureMiddleware();
		this.configureRoutes();
		this.configureWebSocket();
	}

	private initializeServices(): void {
		// Rescue per-project state (missions, escalations, requests, triggers…)
		// that earlier versions wrote under `<cwd>/.crewly` while cwd was the
		// npm package directory — `npm i -g crewly` replaces that tree and
		// deleted a day's OKRs on steamfun-ops (2026-09-18). Runs before any
		// store is opened; a no-op once the safe location is populated.
		try {
			const legacy = path.join(process.cwd(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);
			const safe = resolveProjectDataDir(process.cwd());
			const copied = migrateLegacyProjectData(legacy, safe);
			if (copied.length > 0) {
				this.logger.warn('Migrated project state out of the package tree', { from: legacy, to: safe, stores: copied });
			}
		} catch (err) {
			this.logger.warn('Legacy project-state migration failed (non-fatal)', {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		this.storageService = StorageService.getInstance(this.config.crewlyHome);
		this.tmuxService = new TmuxService();
		this.schedulerService = new SchedulerService(this.storageService);
		this.messageSchedulerService = new MessageSchedulerService(
			this.tmuxService,
			this.storageService
		);
		this.activityMonitorService = ActivityMonitorService.getInstance();
		// V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
		// TaskTrackingService is deleted; in-progress task data and lifecycle
		// events come from TaskPoolService + EventBusService respectively.
		this.teamActivityWebSocketService = new TeamActivityWebSocketService(
			this.storageService,
			this.tmuxService,
		);
		this.teamsJsonWatcherService = new TeamsJsonWatcherService();
		this.apiController = new ApiController(
			this.storageService,
			this.tmuxService,
			this.schedulerService,
			this.messageSchedulerService
		);

		// Wire up reliable delivery: both schedulers use AgentRegistrationService
		// for retry + progressive verification + background stuck-detection
		this.messageSchedulerService.setAgentRegistrationService(
			this.apiController.agentRegistrationService
		);
		this.schedulerService.setAgentRegistrationService(
			this.apiController.agentRegistrationService
		);
		// Initialize message queue services (with disk persistence)
		// NOTE: Must be created before services that depend on them (scheduler, thread status queue)
		this.messageQueueService = new MessageQueueService(this.config.crewlyHome);
		const responseRouter = new ResponseRouterService();
		this.queueProcessorService = new QueueProcessorService(
			this.messageQueueService,
			responseRouter,
			this.apiController.agentRegistrationService
		);

		// Initialize event bus service for agent lifecycle pub/sub
		// NOTE: Must be created before services that depend on it (agent registration, thread status queue)
		this.eventBusService = new EventBusService();
		this.eventBusService.setMessageQueueService(this.messageQueueService);

		// Now wire services that depend on messageQueueService and eventBusService
		this.schedulerService.setMessageQueueService(this.messageQueueService);
		this.schedulerService.setActivityMonitor(this.activityMonitorService);

		// #167: Wire scheduler into agent registration for DLQ drain on activation
		this.apiController.agentRegistrationService.setSchedulerService(this.schedulerService);

		// Architecture Upgrade Phase 6: Wire EventBusService for standing task subscriptions
		this.apiController.agentRegistrationService.setEventBusService(this.eventBusService);

		this.terminalGateway = new TerminalGateway(this.io);
		// An orchestrator on the in-process runtime has no PTY; without this
		// the gateway retried five times and then logged an ERROR saying its
		// output was lost (2026-09-21).
		this.terminalGateway.setInProcessRuntimeCheck((sessionName) =>
			this.apiController.agentRegistrationService.isInProcessRuntimeActive(sessionName),
		);

		// Set terminal gateway singleton for chat integration
		setTerminalGateway(this.terminalGateway);

		// Initialize ChatGateway for chat message forwarding
		// This sets up the event listeners that forward chat messages to WebSocket clients
		initializeChatGateway(this.io).catch((error) => {
			this.logger.error('Failed to initialize ChatGateway', {
				error: error instanceof Error ? error.message : String(error),
			});
		});

		// Connect WebSocket service to terminal gateway for broadcasting
		this.teamActivityWebSocketService.setTerminalGateway(this.terminalGateway);

		// Connect teams.json watcher to team activity service for real-time updates
		this.teamsJsonWatcherService.setTeamActivityService(this.teamActivityWebSocketService);

		// Initialize thread status queue for tracking inbound message lifecycle
		this.threadStatusQueueService = new ThreadStatusQueueService(this.config.crewlyHome);
		responseRouter.setThreadStatusQueue(this.threadStatusQueueService);
		this.queueProcessorService.setThreadStatusQueue(this.threadStatusQueueService);

		// INBOUND-1.f1: Wire EventBus into the TaskPool singleton so addToPool
		// can publish `workitem:queued` events. Must run before any code path
		// triggers addToPool — the slack listener / TaskPool router below both
		// depend on this for the auto-close path b chain. Idempotent.
		TaskPoolService.getInstance().setEventBusService(this.eventBusService);
		// task:blocked / task:failed carry the worker's real team so its lead's
		// standing subscription (filtered by teamId) receives them (#842).
		TaskPoolService.getInstance().setSessionTeamResolver(async (sessionName) => {
			const found = await this.storageService.findMemberBySessionName(sessionName);
			return found
				? { teamId: found.team.id, teamName: found.team.name, memberId: found.member.id, memberName: found.member.name }
				: null;
		});

		// Team budget gate (Team.budget was stored + prompt-injected but never
		// evaluated). Enforced in claimFromPool + WorkItemDispatchSubscriber;
		// here we give it the bus + queue so cap crossings reach the owner.
		const teamBudgetGate = TeamBudgetGateService.getInstance();
		teamBudgetGate.setNotifiers({
			eventBus: this.eventBusService,
			messageQueue: this.messageQueueService,
		});
		TaskPoolService.getInstance().setTeamBudgetGate(teamBudgetGate);

		// Memory: TaskHistorySubscriber listens on the bus for
		// task:done_by_worker / task:rejected / task:cancelled and writes
		// the resulting TaskHistoryEntry into ProjectMemory. This is the
		// load-bearing write path behind "who in my team has done X?" —
		// the orchestrator queries via recall(capability:...). Must run
		// AFTER TaskPoolService is wired to the bus (above) so the events
		// it publishes have a subscriber to consume them.
		const taskHistorySubscriber = new TaskHistorySubscriber({
			eventBus: this.eventBusService,
			projectMemoryService: ProjectMemoryService.getInstance(),
			taskPoolService: TaskPoolService.getInstance(),
		});
		taskHistorySubscriber.start();

		// Per-WorkItem git worktrees (#814): observes WorkItem events only
		// (no status writes). Opt-in per project (Project.worktrees = 'on');
		// Team.worktrees = 'off' and CREWLY_WORKTREES=off opt out.
		try {
			const pool = TaskPoolService.getInstance();
			const worktreeService = new WorkItemWorktreeService({ pool, storage: this.storageService, notify: createTerminalNotifier() });
			const worktreeSubscriber = new WorkItemWorktreeSubscriber({
				service: worktreeService,
				events: this.eventBusService,
				pool,
			});
			worktreeSubscriber.start();
			// So the FIRST [CREWLY-DISPATCH] brief can already name the workdir
			// (git worktree add can take seconds — long enough for a separate,
			// later "worktree ready" message to arrive after the agent has
			// already started in the shared checkout; #829 review).
			void import('./services/v3/workitem-dispatch.subscriber.js')
				.then(({ WorkItemDispatchSubscriber }) => {
					WorkItemDispatchSubscriber.getInstance().setWorktreeHintResolver(worktreeService);
				})
				.catch((err) => {
					this.logger.warn('Could not wire worktree hints into WorkItemDispatchSubscriber (non-fatal)', {
						error: (err as Error).message,
					});
				});
		} catch (worktreeErr) {
			this.logger.warn('Per-WorkItem worktrees failed to start (non-fatal)', {
				error: (worktreeErr as Error).message,
			});
		}

		// P1 Bug B (Pool umbrella WI 72ca743a): Wire RequestService into the
		// TaskPool singleton so addToPool intrinsically links new WIs into
		// their parent Request.workItemIds[] — independent of the
		// subscriber-driven path (request-sla.subscriber, V3DataService).
		// Pre-fix, manual / programmatic / cron callers that bypassed the
		// event chain left Requests with empty workItemIds[]. The linker is
		// idempotent (request.service.ts:328 short-circuits on duplicate id)
		// so subscriber-driven linking stays as belt-and-suspenders.
		TaskPoolService.getInstance().setRequestService(RequestService.getInstance());

		// P1 Bug C (Pool umbrella WI 72ca743a, sub-WI Bug C): Wire the inverse
		// dependency — RequestService → TaskPool — so RequestService.update
		// can refuse `Request → done` when any child WorkItem is still in a
		// non-terminal state. Bug B (above) makes Request.workItemIds[]
		// authoritative on every addToPool; Bug C makes the closure honor
		// that data. The setter is duck-typed on IWorkItemQueryable so
		// neither side needs a static import of the other.
		RequestService.getInstance().setTaskPoolService(TaskPoolService.getInstance());

		// Ticket loop (specs/ticket-loop.md, Phase 1): the single intake for
		// owner messages on every channel, the chat-v2 receipt poster (the
		// Slack one is wired in slack-initializer once Slack is up), and the
		// WorkItem → ticket link through the creating agent's in-flight turn.
		// Failure-isolated: tickets are an addition — messages are delivered
		// whether or not this is wired.
		try {
			// #828 coverage: every owner message's fate, for the receipt's coverage line.
			const intakeOutcomeLog = new IntakeOutcomeLog(RequestService.getInstance().getRequestsDir());
			const ticketIntake = new TicketIntakeService({
				requests: RequestService.getInstance(),
				findWorkItem: (id) => TaskPoolService.getInstance().findWorkItem(id),
				outcomeLog: intakeOutcomeLog,
			});
			ticketIntake.setReceiptSink(
				'chat-v2',
				createChatV2ReceiptSink({
					chat: {
						recordTurn: (input) => getChatV2Service().recordTurn(input),
						updateSystemMessage: (id, content, patch) => getChatV2Service().updateSystemMessage(id, content, patch),
					},
					// Lazy, like the rest of the chat-v2 realtime wiring (the gateway
					// only exists once the HTTP server is up).
					broadcast: (message) => {
						void Promise.all([
							import('./services/chat-v2/chat-v2.realtime-holder.js'),
							import('./websocket/chat-v2.gateway.js'),
						])
							.then(([{ getChatV2RealtimeDeps }, { buildMessageEvent }]) => {
								getChatV2RealtimeDeps().gateway?.broadcast(message.channelId, buildMessageEvent(message.channelId, message));
							})
							.catch(() => undefined);
					},
				}),
			);
			setTicketIntakeService(ticketIntake);

			// #828: the owner's nightly receipt — built from tickets + WorkItems,
			// DMed at his local time (default 21:00, can be turned off), and the
			// same data at GET /api/owner-receipt for the dashboard.
			{
				const receipt = new OwnerReceiptService({
					listRequests: () => RequestService.getInstance().listAll(),
					listWorkItems: () => TaskPoolService.getInstance().getAllItems(),
					loadTeamIndex: async () => teamIndexOf(await StorageService.getInstance().getTeams()),
					loadTeamLeadIndex: async () => teamLeadIndexOf(await StorageService.getInstance().getTeams()),
					loadAgentNameIndex: async () => agentNameIndexOf(await StorageService.getInstance().getTeams()),
					sender: createSlackOwnerSender(() => getSlackService()),
					readIntakeLog: () => intakeOutcomeLog.read(),
				});
				setOwnerReceiptService(receipt);
				// #856 follow-up: while the receipt is off, show the owner one real
				// sample on a decision card and let him choose (never turned on for him).
				void (async () => {
					const [{ OwnerReceiptFormatAsk }, { DecisionService }] = await Promise.all([
						import('./services/v3/owner-receipt/owner-receipt-format-ask.js'),
						import('./services/decisions/decision.service.js'),
					]);
					const formatAsk = new OwnerReceiptFormatAsk({
						receipt,
						decisions: () => DecisionService.getInstance(),
						logger: LoggerService.getInstance().createComponentLogger('OwnerReceiptFormat'),
					});
					DecisionService.registerKindHandler('owner_receipt_format', formatAsk);
					startOwnerReceiptSchedule({
						tick: async () => {
							const sent = await receipt.tick();
							await formatAsk.tick();
							return sent;
						},
					});
				})().catch((err: unknown) => {
					this.logger.warn('Owner receipt format ask not wired; the receipt runs without it', { error: err instanceof Error ? err.message : String(err) });
					startOwnerReceiptSchedule(receipt);
				});
			}
			TaskPoolService.getInstance().setTicketResolver((sessionName) =>
				resolveTicketIdForSession(InFlightTurnTracker.getInstance(), sessionName),
			);

			// Phase 2: answered → 待验收 → 验过了 / 打回 / silence accepts.
			const ticketReview = new TicketReviewService({
				requests: RequestService.getInstance(),
				fallbackAgent: ORCHESTRATOR_SESSION_NAME,
				// Live work only: a rejected verify superseded by its retry, or a
				// failed attempt, no longer means somebody is on it (TKT-017/021/053
				// sat for days behind `rejected` WorkItems).
				openWorkItemCount: async (requestId) =>
					(await TaskPoolService.getInstance().getAllItems()).filter(
						(wi) =>
							wi.requestId === requestId &&
							!TERMINAL_WORK_ITEM_STATUSES.has(wi.status) &&
							!TICKET_CONSTANTS.DEAD_WORK_ITEM_STATUSES.includes(wi.status),
					).length,
				createRework: async ({ ticket, reason, target }) => {
					const tkt = formatTicketNumber(ticket.ticketNumber ?? 0);
					const criteria = activeAcceptance(ticket.acceptance).map((a) => `- ${a.text}`).join('\n');
					const wi = createWorkItem({
						type: 'delegate',
						owner: 'system',
						target,
						requestId: ticket.id,
						title: TICKET_CONSTANTS.REVIEW.REWORK_TITLE(tkt),
						description:
							`${formatTicketMarker(ticket)} The owner sent ${tkt} back: ${reason}\n\n` +
							`Original ask: ${ticket.description}\n` +
							(ticket.reply ? `Your last answer: ${ticket.reply.excerpt}\n` : '') +
							(criteria ? `\nAcceptance criteria:\n${criteria}\n` : '') +
							`\nFix it and answer in the ticket's conversation.`,
						metadata: { ticketRework: true },
					});
					await TaskPoolService.getInstance().addToPool(wi);
					return wi.id;
				},
				markReceiptDone: (ticket) => ticketIntake.markReceiptDone(ticket),
				// The agent that answered follows up with the owner itself.
				nudgeAgent: async (agentSession, text) => {
					await this.apiController.agentRegistrationService.sendMessageToAgent(agentSession, text);
				},
			});
			setTicketReviewService(ticketReview);
			ticketIntake.setReviewHandler(ticketReview);

			// Unassigned work goes to a decider, and one level up when not taken
			// (owner, 2026-09-24): ticket owner → team lead → creator's lead → orc.
			{
				const teamsNow = () => this.storageService.getTeams().catch(() => []);
				TaskPoolService.getInstance().setUntargetedRouter({
					decide: async (wi, creatorSession) => {
						let ticketAssignee: string | undefined;
						if (wi.requestId) {
							const r = await RequestService.getInstance().getById(wi.requestId).catch(() => null);
							if (r && typeof r.ticketNumber === 'number' && r.assignee) ticketAssignee = r.assignee;
						}
						const teamId = typeof wi.metadata?.teamId === 'string' ? (wi.metadata.teamId as string) : undefined;
						return initialDecider({
							teams: await teamsNow(),
							orchestrator: ORCHESTRATOR_SESSION_NAME,
							...(creatorSession ? { creatorSession } : {}),
							...(ticketAssignee ? { ticketAssignee } : {}),
							...(teamId ? { teamId } : {}),
						});
					},
					next: async (current) => nextDecider(current, await teamsNow(), ORCHESTRATOR_SESSION_NAME),
				});
				const routeSweep = setInterval(() => {
					void (async () => {
						const moved = await TaskPoolService.getInstance().escalateUnassigned(UNASSIGNED_ROUTE_CONSTANTS.ESCALATE_AFTER_MS);
						if (moved.length === 0) return;
						const { WorkItemDispatchSubscriber } = await import('./services/v3/workitem-dispatch.subscriber.js');
						for (const m of moved) {
							const wi = await TaskPoolService.getInstance().findWorkItem(m.id);
							if (wi) await WorkItemDispatchSubscriber.getInstance().dispatchTo(wi).catch(() => false);
						}
					})().catch((routeErr: unknown) => {
						this.logger.warn('Unassigned-work sweep failed', {
							error: routeErr instanceof Error ? routeErr.message : String(routeErr),
						});
					});
				}, UNASSIGNED_ROUTE_CONSTANTS.SWEEP_INTERVAL_MS);
				routeSweep.unref?.();
			}

			// Phase 3: claim order (own rejected → own unblocked → queue
			// rejected → P0..P3) and one ticket per agent, for every claim path.
			TaskPoolService.getInstance().setTicketClaimPolicy({
				snapshot: async () => {
					const out = new Map<string, { id: string; priority: RequestPriority; assignee?: string }>();
					for (const r of await RequestService.getInstance().listAll()) {
						if (typeof r.ticketNumber !== 'number' || r.status === 'done' || r.status === 'cancelled') continue;
						out.set(r.id, { id: r.id, priority: r.priority, ...(r.assignee ? { assignee: r.assignee } : {}) });
					}
					return out;
				},
				onSelfClaimed: async (requestId, agentId) => {
					const r = await RequestService.getInstance().getById(requestId);
					if (r && typeof r.ticketNumber === 'number' && !r.assignee) {
						await RequestService.getInstance().update(requestId, { assignee: agentId });
					}
				},
			});
			getChatV2Service().on('chat_message', (dto: ChatMessageDTO) => {
				// Open items read the same message after the review recorded it, so
				// the two never write the ticket at once (specs/2026-10-01-reply-open-items.md).
				void ticketReview
					.onChatMessage(dto)
					.catch(() => undefined)
					.then(async () => {
						const { OpenItemsService } = await import('./services/open-items/open-items.service.js');
						await OpenItemsService.getInstance()?.onAgentMessage(dto);
					})
					.catch(() => undefined);
			});
			const reviewSweep = setInterval(() => {
				void ticketReview.sweep().catch((sweepErr: unknown) => {
					this.logger.warn('Ticket review sweep failed', {
						error: sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
					});
				});
			}, TICKET_CONSTANTS.REVIEW.SWEEP_INTERVAL_MS);
			reviewSweep.unref?.();
		} catch (ticketBootErr) {
			this.logger.error('Ticket intake boot failed — messages are still delivered, no tickets filed', {
				error: ticketBootErr instanceof Error ? ticketBootErr.message : String(ticketBootErr),
			});
		}

		// Ticket loop §4: one-time archive of old WorkItems (marker file makes
		// it run once). Through the pool's own storage cache, so no later
		// flush can write the archived items back. Never deletes.
		void runPoolArchiveMigration(TaskPoolService.getInstance().getStorage(), {
			logger: LoggerService.getInstance().createComponentLogger('PoolArchive'),
		}).catch((archiveErr: unknown) => {
			this.logger.warn('Task pool one-time archive failed (pool left as is; retried next boot)', {
				error: archiveErr instanceof Error ? archiveErr.message : String(archiveErr),
			});
		});

		// Atlas 2026-05-23 fix: wire the agent-liveness gate so claimFromPool /
		// claimSpecificItem refuse to put a WI into `running` when the requesting
		// agent's session is dead. delegate-task's "self-heal fix #1" used to
		// pre-claim WIs for inactive targets, which short-circuited the
		// reconciler's wake-rule and left WIs blocked indefinitely. With this
		// probe wired, rejected pre-claims leave the WI in `queued` so the
		// reconciler can fire detectUnclaimedTasks → start-agent → the agent
		// auto-claims when it boots. The probe is the same lightweight check
		// (PTY session exists + child process alive) used by chat-v2 and slack.
		// Wrapped in async-IIFE because initializeServices() is sync.
		void (async () => {
			const { isAgentActive } = await import('./services/orchestrator/orchestrator-status.service.js');
			TaskPoolService.getInstance().setIsAgentActive(isAgentActive);
		})();

		// Wire Task Pool router so [TASK]-prefixed messages route through the pool
		this.queueProcessorService.setTaskPoolRouter(async (messageContent: string, targetSession: string) => {
			const { createWorkItem } = await import('./types/v2/work-item.types.js');
			const taskPool = TaskPoolService.getInstance();
			const workItem = createWorkItem({
				type: 'delegate',
				owner: 'orchestrator',
				target: targetSession,
				title: messageContent.slice(0, 100),
				description: messageContent,
			});
			await taskPool.addToPool(workItem);
			const claimed = await taskPool.claimFromPool(targetSession);
			return claimed !== null;
		});

		// Wire thread status queue with scheduler and event bus for follow-up tracking
		this.threadStatusQueueService.setSchedulerService(this.schedulerService);
		this.threadStatusQueueService.setEventBusService(this.eventBusService);

		// Wire queue service into controllers
		setChatMessageQueueService(this.messageQueueService);
		setChatThreadStatusQueueService(this.threadStatusQueueService);
		setMessagingControllerQueueService(this.messageQueueService);

		// LLM-wiki bookkeep trigger (Steve 2026-05-22 design point #5):
		// every 30 minutes (configurable via CREWLY_WIKI_BOOKKEEP_INTERVAL_MS),
		// scan every known vault. When recentMd ≥ threshold OR there are
		// duplicate clusters, enqueue a [BOOKKEEP] message to ORC so it can
		// run wiki-bookkeep + decide which pages to consolidate.
void (async () => {
			try {
				const { WikiBookkeepTriggerService } = await import(
					'./services/wiki/wiki-bookkeep-trigger.service.js'
				);
				// Parse a positive-integer ms env override; fall back to the default
				// when the value is missing or malformed (a NaN would coerce to a
				// 0ms setInterval — a hot loop).
				const posIntMs = (raw: string | undefined, fallback: number): number => {
					const n = Number(raw);
					return Number.isFinite(n) && n > 0 ? n : fallback;
				};
				const intervalMs = posIntMs(process.env['CREWLY_WIKI_BOOKKEEP_INTERVAL_MS'], 30 * 60 * 1000);
				const debounceMs = posIntMs(process.env['CREWLY_WIKI_BOOKKEEP_DEBOUNCE_MS'], 6 * 3600 * 1000);
				const trigger = new WikiBookkeepTriggerService({
					intervalMs,
					debounceMs,
					// One message per tick listing every vault, not one per vault:
					// each queued message is a full model turn for ORC.
					batchFireFn: async (fires) => {
						if (!this.messageQueueService) return;
						const lines = fires.map(
							({ vaultPath, report }) =>
								`  - vault=${vaultPath} | ${report.netNewMdCount} net-new md(s) since last pass (threshold ${report.threshold}) | duplicates=${report.duplicateCandidates.length} | pending-queue=${report.queue.pending}`,
						);
						const summary = [
							`[BOOKKEEP] ${fires.length} vault(s) need bookkeeping — handle all of them in this turn:`,
							...lines,
							'Run wiki-bookkeep for each vault listed to drain.',
						].join('\n');
						this.messageQueueService.enqueue({
							content: summary,
							conversationId: 'system:wiki-bookkeep',
							source: 'system_event',
						});
					},
				});
				WikiBookkeepTriggerService.setInstance(trigger);
				trigger.start();
			} catch (bookkeepErr) {
				this.logger.warn('Wiki bookkeep trigger failed to start (non-fatal)', {
					error: (bookkeepErr as Error).message,
				});
			}

			// LLM-wiki reflect trigger (2026-05-24): if a vault has had zero
			// wiki-queue-add fires in the last `quietWindowMs`, ping ORC with
			// a `[REFLECT-WIKI]` message so it sweeps recent conversation
			// for worth-saving content. Solves the "the queue is never used"
			// problem found during the 2026-05-24 audit.
			try {
				const { WikiReflectTriggerService } = await import(
					'./services/wiki/wiki-reflect-trigger.service.js'
				);
				const posIntMs = (raw: string | undefined, fallback: number): number => {
					const n = Number(raw);
					return Number.isFinite(n) && n > 0 ? n : fallback;
				};
				const reflectInterval = posIntMs(process.env['CREWLY_WIKI_REFLECT_INTERVAL_MS'], 60 * 60 * 1000);
				const reflectQuiet = posIntMs(process.env['CREWLY_WIKI_REFLECT_QUIET_WINDOW_MS'], 4 * 60 * 60 * 1000);
				const reflectDebounce = posIntMs(process.env['CREWLY_WIKI_REFLECT_DEBOUNCE_MS'], 4 * 60 * 60 * 1000);
				const reflectTrigger = new WikiReflectTriggerService({
					intervalMs: reflectInterval,
					quietWindowMs: reflectQuiet,
					debounceMs: reflectDebounce,
					// Only wake ORC when someone has actually said something since
					// the last nudge — the sweep is over recent conversation, and an
					// hourly nudge with nothing to sweep was the largest remaining
					// full-price wake-up after the 2026-09-16 fixes.
					hasConversationSince: async (sinceMs) => {
						const { getChatV2Service } = await import('./services/chat-v2/chat-v2.singleton.js');
						return getChatV2Service().hasConversationSince(sinceMs);
					},
					// One message per tick listing every quiet vault, not one per
					// vault: six vaults used to cost ORC six model turns per cycle.
					batchFireFn: async (metas) => {
						if (!this.messageQueueService) return;
						const lines = metas.map((meta) => {
							const lastAddText =
								meta.msSinceLastQueueAdd === Number.POSITIVE_INFINITY
									? 'never'
									: `${Math.floor(meta.msSinceLastQueueAdd / (60 * 60 * 1000))}h ago`;
							return `  - vault=${meta.vaultPath} | last wiki-queue-add: ${lastAddText} | total queue items: ${meta.totalQueueItems}`;
						});
						const summary = [
							`[REFLECT-WIKI] ${metas.length} vault(s) have had no wiki-queue-add recently:`,
							...lines,
							'Sweep the recent conversation ONCE for worth-saving content (decisions, customer facts, learnings) and call wiki-queue-add for each item against the right vault, OR reply "nothing this period" once if there genuinely is nothing.',
						].join('\n');
						this.messageQueueService.enqueue({
							content: summary,
							conversationId: 'system:wiki-reflect',
							source: 'system_event',
						});
					},
				});
				WikiReflectTriggerService.setInstance(reflectTrigger);
				reflectTrigger.start();
			} catch (reflectErr) {
				this.logger.warn('Wiki reflect trigger failed to start (non-fatal)', {
					error: (reflectErr as Error).message,
				});
			}

			try {
				// Standing-answer refresh (#816) on the reflect cadence: raise a
				// refresh WorkItem for a standing page only when the memory
				// behind it has moved. No LLM here; the WorkItem's agent writes.
				// Agent pages are only checked for members that are active, so a
				// stopped agent is never woken for its own page.
				// CREWLY_STANDING_REFRESH=false disables it.
				if (process.env['CREWLY_STANDING_REFRESH'] !== 'false') {
					const { StandingRefreshService } = await import('./services/memory/standing-refresh.service.js');
					const { resolveWikiOwner } = await import('./services/wiki/wiki-owner.resolver.js');
					const standingRefresh = new StandingRefreshService({
						pool: TaskPoolService.getInstance(),
						agentSkillsPath: path.join(findPackageRoot(__dirname), 'config', 'skills', 'agent'),
						listProjects: async () => (await this.storageService.getProjects()).map((p) => p.path).filter(Boolean),
						listAgents: async () =>
							(await this.storageService.getTeams())
								.flatMap((t) => t.members ?? [])
								.filter((m) => m.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE && m.sessionName)
								.map((m) => m.sessionName),
						resolveProjectTarget: (projectPath) => resolveWikiOwner(this.storageService, projectPath),
						// Never queue a refresh for a stopped agent / dormant team:
						// the only way to work it would be a wake the owner never
						// asked for. The orchestrator has its own recovery.
						isTargetAwake: async (sessionName) => {
							if (sessionName === ORCHESTRATOR_SESSION_NAME) return true;
							const member = (await this.storageService.getTeams())
								.flatMap((t) => t.members ?? [])
								.find((m) => m.sessionName === sessionName);
							return member?.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE;
						},
					});
					// Same cadence as the reflect trigger above.
					const reflectEvery = Number(process.env['CREWLY_WIKI_REFLECT_INTERVAL_MS']);
					standingRefresh.start(reflectEvery > 0 ? reflectEvery : STANDING_ANSWERS_CONSTANTS.REFRESH_INTERVAL_MS);
				}
			} catch (standingErr) {
				this.logger.warn('Standing-answer refresh failed to start (non-fatal)', {
					error: (standingErr as Error).message,
				});
			}

			// Daily memory consolidation (self-improvement wiring): the
			// MemoryConsolidationService existed but nothing ever called
			// consolidate(), so no agent ever had a consolidation.json. Run it
			// for every active member once per day, with a boot-time catch-up
			// when the last recorded sweep (CREWLY_HOME/self-improvement-
			// state.json) is older than the interval. Non-fatal throughout.
			try {
				const { ConsolidationSchedulerService } = await import(
					'./services/ai/self-improvement/consolidation-scheduler.service.js'
				);
				const { createMemoryConsolidationService } = await import(
					'./services/ai/self-improvement/agent-memory-provider.js'
				);
				const { SELF_IMPROVEMENT_CONSTANTS } = await import('./constants.js');
				const posIntMs = (raw: string | undefined, fallback: number): number => {
					const n = Number(raw);
					return Number.isFinite(n) && n > 0 ? n : fallback;
				};
				const consolidation = createMemoryConsolidationService();
				const scheduler = new ConsolidationSchedulerService({
					intervalMs: posIntMs(
						process.env[SELF_IMPROVEMENT_CONSTANTS.CONSOLIDATION_INTERVAL_ENV],
						SELF_IMPROVEMENT_CONSTANTS.CONSOLIDATION_INTERVAL_MS,
					),
					consolidate: (sessionName) => consolidation.consolidate(sessionName),
					listActiveSessions: async () => {
						const sessions: string[] = [];
						const orc = await this.storageService.getOrchestratorStatus();
						if (orc && orc.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE) sessions.push(orc.sessionName);
						const teams = await this.storageService.getTeams();
						for (const team of teams) {
							for (const member of team.members ?? []) {
								if (member.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE && member.sessionName) {
									sessions.push(member.sessionName);
								}
							}
						}
						return sessions;
					},
				});
				ConsolidationSchedulerService.setInstance(scheduler);
				scheduler.start();
			} catch (consolidationErr) {
				this.logger.warn('Memory consolidation scheduler failed to start (non-fatal)', {
					error: (consolidationErr as Error).message,
				});
			}

			// LLM-wiki → WorkItem bridge (2026-05-27): pending wiki queue
			// items + legacy migration candidates become claimable
			// WorkItems in the V3 pool. Replaces the bookkeep/reflect
			// "shouldFire ≥ threshold" model — even 1 pending item now
			// surfaces in /work-items and idle agents drain it through the
			// standard claim loop. PR-1: target=crewly-orc for both kinds
			// because the wiki-process-queue / wiki-migrate skills live
			// under `config/skills/orchestrator/` today.
			try {
				const { WikiWorkItemBridgeService } = await import(
					'./services/wiki/wiki-workitem-bridge.service.js'
				);
				const intervalMs = Number(
					process.env['CREWLY_WIKI_BRIDGE_INTERVAL_MS'] ?? 10 * 60 * 1000,
				);
				const targetAgent = process.env['CREWLY_WIKI_BRIDGE_TARGET'] ?? 'crewly-orc';
				const maxCreatesPerTick = Number(
					process.env['CREWLY_WIKI_BRIDGE_MAX_PER_TICK'] ?? 2,
				);
				const cooldownMs = Number(
					process.env['CREWLY_WIKI_BRIDGE_COOLDOWN_MS'] ?? 30 * 60 * 1000,
				);
				const { resolveWikiOwner } = await import('./services/wiki/wiki-owner.resolver.js');
				const bridge = new WikiWorkItemBridgeService({
					intervalMs,
					targetAgent,
					maxCreatesPerTick,
					cooldownMs,
					// Team leaders own their vault's curation; the global vault stays with the orchestrator.
					resolveTarget: (key) => resolveWikiOwner(this.storageService, key),
					// Briefs are read raw by the claimant (often a TL), so the
					// skill path must be real, not a placeholder (#914).
					orchestratorSkillsPath: path.join(findPackageRoot(__dirname), 'config', 'skills', 'orchestrator'),
					// Stale queue (oldest pending item > N days) → owner, same
					// channel auto-update uses.
					notifyOwner: (title, message) =>
						getSlackService().sendNotification({
							type: 'project_update',
							title,
							message,
							urgency: 'normal',
							timestamp: new Date().toISOString(),
						}),
				});
				WikiWorkItemBridgeService.setInstance(bridge);
				bridge.start();
			} catch (bridgeErr) {
				this.logger.warn('Wiki work-item bridge failed to start (non-fatal)', {
					error: (bridgeErr as Error).message,
				});
			}

			// ORC delivery enforcer (2026-05-23 incident fix): watches for
			// agent `[DONE]` posts to slack threads that ORC hasn't yet
			// forwarded via reply-slack. Fires `[DELIVER_REQUIRED]` nudges
			// at 3 / 10 / 30 min after the agent finished, until ORC
			// actually delivers OR the budget is exhausted.
			try {
				const { OrcDeliveryEnforcerService } = await import(
					'./services/orc/orc-delivery-enforcer.service.js'
				);
				const [{ getChatV2Service }, { synthesizeSlackConversationId }] = await Promise.all([
					import('./services/chat-v2/chat-v2.singleton.js'),
					import('./services/chat-v2/legacy-dto.utils.js'),
				]);
				const enforcer = new OrcDeliveryEnforcerService({
					reminderSink: ({ conversationId, text }) => {
						if (!this.messageQueueService) return;
						this.messageQueueService.enqueue({
							content: text,
							conversationId,
							source: 'system_event',
						});
					},
					// Issue #731: let the enforcer see the thread's real activity
					// (owner silence → don't track; reply via any path → stop).
					// Every Slack thread is a chat-v2 channel keyed by its
					// synthesized conversation id, and every outbound Slack
					// reply is mirrored into it.
					threadActivityProvider: ({ channelId, threadTs }) =>
						getChatV2Service().getChannelActivity(
							synthesizeSlackConversationId(channelId, threadTs),
						),
				});
				OrcDeliveryEnforcerService.setInstance(enforcer);
				enforcer.start();
			} catch (enforcerErr) {
				this.logger.warn('OrcDeliveryEnforcer failed to start (non-fatal)', {
					error: (enforcerErr as Error).message,
				});
			}
		})();

		// Initialize system resource alert service for proactive monitoring
		this.systemResourceAlertService = new SystemResourceAlertService();
		this.teamsJsonWatcherService.setEventBusService(this.eventBusService);
		this.activityMonitorService.setEventBusService(this.eventBusService);
		setEventBusControllerService(this.eventBusService);
		setTeamControllerEventBusService(this.eventBusService);

		// Wire team-activity-websocket to EventBus so it reacts to V3
		// WorkItem lifecycle events (replaces the legacy
		// TaskTrackingService.on('task_workflow_event') bridge that was
		// deleted with the v1 task-management subsystem).
		this.teamActivityWebSocketService.setEventBus(this.eventBusService);
		// V3-only autonomy: AgentAutoClaimService (started later in boot)
		// is the single autonomy loop. The legacy AutoAssignService has
		// been retired — see spec 2026-05-06-task-management-v1-deprecation.md.

		// BRIDGE-1: subscribe to autonomy events (task:done_by_worker,
		// task:rejected, task:blocked, team:all_tasks_done, mission:*) and
		// create the appropriate WorkItem(s) — verification WI for TL on
		// done_by_worker, retry WI / escalation WI on rejected, review WI on
		// blocked / mission events. See `event-to-workitem-bridge.service.ts`
		// for idempotency contract + retry cap + cron-recursion guard.
		this.eventToWorkItemBridge = EventToWorkItemBridge.boot(this.eventBusService);
		this.eventToWorkItemBridge.start();

		// OKR loop closure: auto-measure `task_completion` KRs from task:done /
		// task:verified and publish `team:all_tasks_done` when a mission has no
		// active WorkItems left (the bridge turns that into a review WI). See
		// `kr-completion.subscriber.ts`.
		this.krCompletionSubscriber = KRCompletionSubscriber.boot(this.eventBusService);
		this.krCompletionSubscriber.start();

		// A delegation's fallback timer is cancelled the moment its WorkItem
		// finishes, so the orchestrator stops being woken to "check" work that
		// is already verified (26 of 65 WorkItems on steamfun-ops, 2026-09-18).
		this.fallbackTriggerCleanup = FallbackTriggerCleanupSubscriber.boot(this.eventBusService);
		this.fallbackTriggerCleanup.start();

		// OKR loop closure: give the reminder sweep (mission:stale) and the
		// review service (mission:replanned) a bus to publish on. Both were
		// declared + bridged events with no publisher before this.
		MissionReminderService.getInstance().setEventBusService(this.eventBusService);
		OKRReviewService.getInstance().setEventBusService(this.eventBusService);

		// Owner guidance for the goal layer: a pending OKR proposal is pushed to
		// the owner (Slack via the orchestrator bridge + a line in the orc's
		// queue) instead of waiting to be discovered on the Missions page, and
		// a weekly digest summarises every mission. Runs inside the sweep.
		{
			const guidance = new OKROwnerGuidanceService({
				listKeyResults: (missionId) => KRTrackingService.getInstance().listByMission(missionId),
			});
			guidance.setNotifiers(
				async ({ title, message, urgency, metadata }) => {
					const bridge = getSlackOrchestratorBridge();
					if (!bridge) return;
					await bridge.sendNotification({
						type: 'okr_reminder',
						title,
						message,
						urgency,
						timestamp: new Date().toISOString(),
						metadata,
					});
				},
				(content) => {
					this.messageQueueService?.enqueue({ content, conversationId: 'system:okr', source: 'system_event' });
				},
			);
			OKROwnerGuidanceService.setInstance(guidance);
		}

		// Hierarchy escalation: a TL that has not acted on a worker's
		// verification handoff within 15 min triggers the documented bypass to
		// the orchestrator (`hierarchy:escalation` + [ESCALATION] queue message).
		// HierarchyEscalationService had the rules but no runtime consumer.
		this.hierarchyEscalationMonitor = HierarchyEscalationMonitor.boot(
			this.eventBusService,
			this.messageQueueService,
		);
		this.hierarchyEscalationMonitor.start();

		// LEARN-1: subscribe to terminal task / mission:replanned events and
		// auto-record a learning entry via MemoryService.recordLearning. Closes
		// the prompt-driven "agents-forget-to-record" gap. See
		// `auto-learning.subscriber.ts` for category mapping + idempotency
		// contract (V1) and the V7/V9 self-checks in the co-located test.
		this.autoLearningSubscriber = AutoLearningSubscriber.boot(this.eventBusService);
		this.autoLearningSubscriber.start();

		// DF-1 #438: symmetric notification subscriber. Same architectural
		// pattern as AutoLearningSubscriber — listens to terminal lifecycle
		// events (`task:verified`, `mission:replanned`) and enqueues a
		// `[MILESTONE]` envelope into orc's chat queue. The QW-3 row in
		// `config/roles/orchestrator/prompt.md` (#436) handles the
		// always-forward-to-owner rule on the orc side; this subscriber
		// closes the gap where an agent ships work but forgets to call
		// `report-status --status milestone` (the agent-side QW-1 path).
		this.milestoneNotificationSubscriber = new MilestoneNotificationSubscriber({
			eventBus: this.eventBusService,
			messageQueueService: this.messageQueueService,
		});
		this.milestoneNotificationSubscriber.start();

		// INBOUND-1 + Pipeline-#4 follow-up: wire RequestService → bus, then
		// boot both v3 subscribers (SLA tracker + auto-decompose). Order
		// matters within the block: setRequestServiceEventBus must run
		// BEFORE any code path can call RequestService.create() — the slack
		// listener at line ~370 is the first hot caller, but the slack
		// service hasn't been initialised yet at this point in boot, so
		// we're safe.
		//
		// Failure-isolated (issue #465): the entire v3 subscriber boot is
		// wrapped in try/catch so a wiring failure logs + continues rather
		// than crashing the whole backend. Neither subscriber is essential
		// to API liveness — degrading them is preferable to losing the
		// process. A single catch block treats both as a unit because the
		// failure mode is "wiring is broken, fix the deploy" not
		// "intermittently flaky"; partial recovery would be unnecessary
		// complexity for v1. B0 broadcast (line ~2336) and TriggerEngine
		// boot (line ~1464) already have equivalent isolation; this brings
		// the v3 subscriber block in line with that pattern.
		try {
			setRequestServiceEventBus(this.eventBusService);
			this.requestSlaSubscriber = RequestSlaSubscriber.boot(
				this.eventBusService,
				RequestService.getInstance(),
				TaskPoolService.getInstance(),
				async ({ channelId, threadTs, messageText }) => {
					// Production wiring of the 10-min escalation hook: nudge the user
					// in the same Slack thread so they're never blind to the miss.
					const slack = getSlackService();
					await slack.sendMessage({
						channelId,
						threadTs,
						text: messageText,
					});
				},
			);
			this.requestSlaSubscriber.start();
			setRequestSlaSubscriber(this.requestSlaSubscriber);

			// Pipeline-#4 follow-up: auto-decompose actionable L2 Requests on
			// request:created. Sequenced AFTER the SLA subscriber so the
			// respond_to_user WI seeding still runs first when both fire on
			// the same event (deterministic listener-attach order; both run
			// via the same in-process bus). Side note: order is semantically
			// irrelevant — the linkWorkItem path keys on workitem:queued, not
			// on relative listener position — but predictable startup ordering
			// helps debug.
			this.requestDecomposeSubscriber = RequestDecomposeSubscriber.boot(
				this.eventBusService,
				RequestService.getInstance(),
				TaskPoolService.getInstance(),
			);
			this.requestDecomposeSubscriber.start();
			setRequestDecomposeSubscriber(this.requestDecomposeSubscriber);

			// Status-update subscriber: posts progress on Slack-originated
			// Requests as their child WIs reach milestones, plus a heartbeat
			// while work is still in flight. Closes the "long silence after
			// orc's first ack" UX gap. Idempotent — duplicate boots are no-ops.
			this.requestStatusUpdateSubscriber = new RequestStatusUpdateSubscriber({
				eventBus: this.eventBusService,
				requestService: RequestService.getInstance(),
				taskPool: TaskPoolService.getInstance(),
				slackPoster: async ({ channelId, text, threadTs }) => {
					// Post via the in-process SlackService to avoid a self-HTTP
					// hop. The /api/slack/send route's other side-effects (chat
					// persistence, thread-status replied marker) don't apply
					// to mid-thread heartbeat updates — those are only for
					// the user's direct reply, not for orc's progress pings.
					const slack = getSlackService();
					if (!slack.isConnected()) return;
					await slack.sendMessage({ channelId, text, threadTs });
				},
				heartbeatMinutes: 30,
			});
			this.requestStatusUpdateSubscriber.start();

			// Cascade subscriber: keeps Request.status in sync with the
			// aggregate state of its child WIs by reacting to live task
			// lifecycle events. Closes the gap left by V3DataService's
			// retired `v3:task_*` subscriptions (see 2026-05-09 dogfood
			// note in request-cascade.subscriber.ts).
			this.requestCascadeSubscriber = new RequestCascadeSubscriber({
				eventBus: this.eventBusService,
				requestService: RequestService.getInstance(),
				taskPool: TaskPoolService.getInstance(),
				notifier: this.eventBusService,
			});
			this.requestCascadeSubscriber.start();
		} catch (subscriberBootErr) {
			// Degraded mode: SLA tracking + auto-decompose are off, but the
			// API surface and rest of the backend continue to serve. Ops can
			// grep for `v3 subscriber boot failed` in logs to triage.
			this.logger.error(
				'v3 subscriber boot failed — degrading SLA + auto-decompose paths, continuing backend startup',
				{
					error:
						subscriberBootErr instanceof Error
							? subscriberBootErr.message
							: String(subscriberBootErr),
				},
			);
			// Best-effort cleanup of any partial wiring so a later restart
			// doesn't see stale singletons. The setters are idempotent.
			setRequestSlaSubscriber(null);
			setRequestDecomposeSubscriber(null);
			setRequestServiceEventBus(null);
			this.requestSlaSubscriber = null;
			this.requestDecomposeSubscriber = null;
			if (this.requestStatusUpdateSubscriber) {
				try { this.requestStatusUpdateSubscriber.stop(); } catch { /* best-effort */ }
				this.requestStatusUpdateSubscriber = null;
			}
			if (this.requestCascadeSubscriber) {
				try { this.requestCascadeSubscriber.stop(); } catch { /* best-effort */ }
				this.requestCascadeSubscriber = null;
			}
		}

		// Initialize Slack thread store for persistent thread conversations
		const slackThreadStore = new SlackThreadStoreService(this.config.crewlyHome);
		setSlackThreadStore(slackThreadStore);
		this.eventBusService.setSlackThreadStore(slackThreadStore);

		// Initialize Google Chat thread store for persistent thread conversations
		const gchatThreadStore = new GoogleChatThreadStoreService(this.config.crewlyHome);
		setGchatThreadStore(gchatThreadStore);

		// Initialize Slack image service for downloading images from Slack messages
		const slackImageService = new SlackImageService(this.config.crewlyHome);
		setSlackImageService(slackImageService);

		// Wire agent:idle events to thread status queue for delegation completion
		this.eventBusService.on('eventPublished', (event: { type: string; sessionName?: string }) => {
			if (event.type === 'agent:inactive' && event.sessionName) {
				this.wakeIfMessagesQueued(event.sessionName);
			}
			// A turn started: the harness's "working on it" watch may be waiting
			// for it (the ActivityMonitor tells it sooner; this covers other
			// busy sources). Repeats are harmless — a watch ends on first use.
			if (event.type === 'agent:busy' && event.sessionName) {
				getSlackAutoWorkingService()?.noteBusy(event.sessionName);
			}
			// Work an agent promised the owner may now be ready to deliver
			// (specs/2026-10-01-reply-open-items.md).
			const finished = event as { type: string; workItemId?: string };
			if ((finished.type === 'task:verified' || finished.type === 'task:done') && finished.workItemId) {
				const workItemId = finished.workItemId;
				void import('./services/open-items/open-items.service.js')
					.then(({ OpenItemsService }) => OpenItemsService.getInstance()?.onWorkItemSettled(workItemId))
					.catch(() => undefined);
			}
			if (event.type === 'agent:idle' && event.sessionName) {
				try {
					const waitingThreads = this.threadStatusQueueService.getByStatus('replied_waiting_actions');
					for (const entry of waitingThreads) {
						if (entry.delegatedAgents?.includes(event.sessionName)) {
							this.threadStatusQueueService.markDelegationsComplete(entry.threadKey);
						}
					}
				} catch (err) {
					this.logger.warn('Failed to check thread delegation completion on agent:idle', {
						sessionName: event.sessionName,
						error: err instanceof Error ? err.message : String(err),
					});
				}

				// #236 queued a message "for delivery when the agent becomes
				// idle", but nothing ever drained on idle: the only flush ran
				// inside registerMemberStatus, so a message re-queued *after*
				// that flush waited for the next registration — in practice, a
				// restart. The owner asked a second question while the agent
				// was mid-answer and never got a reply; the message was still
				// in the queue an hour later (2026-09-21, Ella).
				//
				// An agent whose turn ended with a subagent or background task
				// still running is not done: the turn that delivers comes when
				// that work finishes. Leave its placeholders and tickets alone
				// (2026-10-02, Eve: "the data inventory is still running").
				// A re-check settles later, once the background work is gone.
				// An idle while the runtime still reports a turn (a silent
				// screen, a forced reset) is not a turn end at all: settle
				// nothing and flush nothing into the live turn; the turn's own
				// end publishes agent:idle again (PR #1013 review).
				const idleOutcome = this.deferredIdleSettle.onIdle(event.sessionName);
				// A paused team's queued messages wait for the owner to resume it
				// (specs/2026-10-04-team-pause.md).
				if (idleOutcome !== 'turn' && !isSessionPaused(event.sessionName)) {
					setImmediate(() => void this.flushQueuedAgentMessages(event.sessionName as string));
				}

				// V3: Auto-close open Requests when the orchestrator goes idle
				// Handles direct responses (no WorkItem delegation)
				if (event.sessionName === ORCHESTRATOR_SESSION_NAME && idleOutcome !== 'turn') {
					setImmediate(() => this.autoCloseOpenRequests());
				}
			}
		});

		this.wireSafeRestart();
		this.wireInputBlockedRetry();
		this.wireInProcessTurnFailure();
		this.startLivenessMonitor();
		// Remote MCP sign-ins the owner has not finished yet keep being watched
		// across restarts (the link in Slack stays valid for a day).
		void import('./services/connector/remote-mcp-auth.service.js')
			.then(({ RemoteMcpAuthService }) => RemoteMcpAuthService.getInstance().resumePending())
			.catch((error) => this.logger.warn('Remote MCP sign-ins not resumed (non-fatal)', { error: error instanceof Error ? error.message : String(error) }));

		// Shared LiveReconcilerDataProvider instance used by both the
		// Reconciler service and the TeamHealthWatchdog data provider.
		// Sharing is required so the memory-pressure broadcast state
		// (`consecutivePressureSkips` / `lastPressureNotifiedAt`) is
		// counted ONCE per sustained pressure episode. Two separate
		// instances would each cross the 5-skip threshold around the same
		// time and publish two `system:memory_pressure` events with
		// distinct `event.id` values (no debounce match), so orc would
		// receive duplicates. See follow-up #5 from PR #543 review.
		const liveDataProvider = new LiveReconcilerDataProvider();
		liveDataProvider.setEventBus(this.eventBusService);
		// Wire AgentRegistrationService so the memory-pressure eviction
		// path can terminate idle agents to free wake slots (issue surfaced
		// 2026-05-16: queued WIs for inactive Atlas could not get woken
		// because the floor was held by idle product/marketing agents).
		liveDataProvider.setAgentRegistrationService(this.apiController.agentRegistrationService);

		// Initialize Reconciler Service (V2 — system truth recomputation)
		{
			const reconcilerLogger = LoggerService.getInstance().createComponentLogger('ReconcilerInit');

			// Live data provider — connects Reconciler to Task Pool, Claim Service,
			// Storage Service, and Agent Suspend for real reconciliation including
			// Hybrid Wake (auto-rehydrating suspended agents when tasks go unclaimed).
			this.reconcilerService = new ReconcilerService(liveDataProvider);
			setReconcilerService(this.reconcilerService);
			// A worker that goes quiet holding a running WorkItem is reported to
			// its team lead once (#842).
			this.reconcilerService.setIdleHolderReporting({
				loadTeams: () => this.storageService.getTeams(),
				addToPool: (wi) => TaskPoolService.getInstance().addToPool(wi),
				stamp: (id, patch) => TaskPoolService.getInstance().mergeItemMetadata(id, patch),
			});

			// Subscribe EventBus events for targeted reconciliation
			if (this.reconcilerService) {
				const reconciler = this.reconcilerService;

				// 2026-05-15 Steve dogfood: the prior `subscribe({ subscriberSession:
				// '__reconciler__' })` loop here was redundant AND wrong. The
				// subscribe path routes critical events through
				// `MessageQueueService.enqueue` keyed by `targetSession`, which
				// then fails noisily because `__reconciler__` is not a PTY
				// session ("Session '__reconciler__' does not exist", every
				// reconciler tick). The in-process `event_published` listener
				// below already drives the reconciler — no second wiring needed.
				// Removed the subscribe-block; if a future change needs persistent
				// metadata for the reconciler subscription, attach it as a real
				// in-process subscriber via `onInProcess` rather than the
				// session-targeted `subscribe` API.

				// Listen for all published events and trigger targeted reconciliation
				this.eventBusService.on('event_published', (payload: { eventType: string; sessionName: string }) => {
					const targetedEventTypes = ['task:completed', 'task:failed', 'agent:idle', 'agent:inactive'];
					if (targetedEventTypes.includes(payload.eventType)) {
						reconciler.runFast().catch((err) => {
							reconcilerLogger.warn('Event-triggered fast reconcile failed', {
								eventType: payload.eventType,
								error: err instanceof Error ? err.message : String(err),
							});
						});
					}
				});
			}

			reconcilerLogger.info('ReconcilerService initialized and wired to EventBus');
		}

		// Initialize Team-Health-Watchdog (THW) — Layer 4 liveness aggregator
		// Lazy singleton wiring per Sam's etiquette nudge: no module-load
		// side effects; controller and /api/health resolve via accessor.
		{
			const thwLogger = LoggerService.getInstance().createComponentLogger('TeamHealthInit');
			try {
				const config = loadTeamHealthConfig({
					warn: (msg, meta) => thwLogger.warn(msg, meta ?? {}),
					info: (msg, meta) => thwLogger.info(msg, meta ?? {}),
				});

				if (!config.enabled) {
					thwLogger.info('TeamHealthWatchdog disabled by config; skipping init.');
				} else if (!this.reconcilerService) {
					thwLogger.warn('Reconciler not available; skipping TeamHealthWatchdog init.');
				} else {
					// Reuse the shared LiveReconcilerDataProvider declared
					// above (follow-up #5 from PR #543 review) — instantiating
					// a second copy would double-broadcast memory-pressure.
					const dataProvider = new LiveTeamHealthDataProvider({
						reconcilerProvider: liveDataProvider,
						getTeams: async () => StorageService.getInstance().getTeams(),
						bootedAt: new Date(),
					});

					// Phase 0 alert sink: log-only. Slack delivery wires up
					// in Phase 1 (per §G phasing). Shadow-mode is the
					// default config.json setting, so this sink is mostly
					// invoked for the recovery announcement path.
					const alertSink: AlertSink = {
						deliver: async (decision: AlertDecision) => {
							thwLogger.info('THW alert (Phase 0 log-only sink)', {
								teamId: decision.detection.teamId,
								verdict: decision.effectiveVerdict,
								channel: decision.channel,
								message: decision.message,
							});
						},
					};

					this.teamHealthWatchdog = new TeamHealthWatchdogService({
						config,
						dataProvider,
						alertSink,
						bootedAt: new Date(),
						logger: {
							info: (msg, meta) => thwLogger.info(msg, meta ?? {}),
							warn: (msg, meta) => thwLogger.warn(msg, meta ?? {}),
							error: (msg, meta) => thwLogger.error(msg, meta ?? {}),
						},
					});
					setTeamHealthWatchdogSingleton(this.teamHealthWatchdog);
					this.teamHealthWatchdog.start();
					thwLogger.info('TeamHealthWatchdog initialized', {
						shadowMode: config.shadowMode,
						sweepIntervalMs: config.sweepIntervalMs,
					});
				}
			} catch (err) {
				thwLogger.error('Failed to initialize TeamHealthWatchdog (continuing without it)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Initialize Fission Guard Service
		{
			const fissionLogger = LoggerService.getInstance().createComponentLogger('FissionInit');
			try {
				const taskPool = TaskPoolService.getInstance();

				// FissionDataProvider backed by TaskPoolService storage
				const fissionDataProvider: FissionDataProvider = {
					async getWorkItemById(id: string) {
						const items = await taskPool.getAllItems();
						return items.find((i) => i.id === id) ?? null;
					},
					async countMissionWorkItems(missionId: string) {
						const items = await taskPool.getAllItems();
						return items.filter((i) => i.missionId === missionId).length;
					},
					async countChildWorkItems(parentWorkItemId: string) {
						const items = await taskPool.getAllItems();
						return items.filter((i) => i.parentWorkItemId === parentWorkItemId).length;
					},
				};

				// P5 budget ceiling: wire the BudgetService into the fission budget
				// gate so an unattended run can't create unbounded (and unbounded-cost)
				// sub-tasks. Fail-open on a budget-service error so a transient hiccup
				// never halts all work; a real over-budget verdict hard-stops creation.
				let budgetChecker: BudgetChecker | undefined;
				try {
					const budgetSvc = BudgetService.getInstance();
					// Fire-and-forget init — the checker fails open until it completes,
					// so we don't need to (and can't, in this sync block) await it.
					void budgetSvc.initialize().catch(() => { /* fail-open */ });
					budgetChecker = createFailOpenBudgetChecker(budgetSvc);
					fissionLogger.info('Fission budget gate wired to BudgetService');
				} catch (budgetErr) {
					fissionLogger.warn('BudgetService unavailable — fission budget gate stays open', {
						error: budgetErr instanceof Error ? budgetErr.message : String(budgetErr),
					});
				}

				const fissionService = FissionGuardService.init(fissionDataProvider, budgetChecker);
				setFissionGuardService(fissionService);
				fissionLogger.info('FissionGuardService initialized');
			} catch (fissionErr) {
				fissionLogger.warn('FissionGuardService initialization failed (non-fatal)', {
					error: fissionErr instanceof Error ? fissionErr.message : String(fissionErr),
				});
			}
		}

		// Broadcast queue events via Socket.IO
		this.messageQueueService.on('enqueued', (msg) => {
			this.io.emit(MESSAGE_QUEUE_CONSTANTS.SOCKET_EVENTS.MESSAGE_ENQUEUED, msg);
		});
		this.messageQueueService.on('processing', (msg) => {
			this.io.emit(MESSAGE_QUEUE_CONSTANTS.SOCKET_EVENTS.MESSAGE_PROCESSING, msg);
		});
		this.messageQueueService.on('completed', (msg) => {
			this.io.emit(MESSAGE_QUEUE_CONSTANTS.SOCKET_EVENTS.MESSAGE_COMPLETED, msg);
		});
		this.messageQueueService.on('failed', (msg) => {
			this.io.emit(MESSAGE_QUEUE_CONSTANTS.SOCKET_EVENTS.MESSAGE_FAILED, msg);
		});
		this.messageQueueService.on('statusUpdate', (status) => {
			this.io.emit(MESSAGE_QUEUE_CONSTANTS.SOCKET_EVENTS.STATUS_UPDATE, status);
		});
	}

	private configureMiddleware(): void {
		// Security middleware
		this.app.use(
			helmet({
				contentSecurityPolicy: {
					directives: {
						defaultSrc: ["'self'"],
						styleSrc: ["'self'", "'unsafe-inline'"],
						scriptSrc: ["'self'", "'unsafe-eval'"],
						imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
						connectSrc: ["'self'", 'ws:', 'wss:', 'blob:'],
						// Disable upgrade-insecure-requests for HTTP-only deployments (ESTestNode)
						// Without this, browsers on HTTP upgrade all asset requests to HTTPS → ERR_SSL_PROTOCOL_ERROR
						upgradeInsecureRequests: null,
					},
				},
			})
		);

		// CORS — allow Cloud Console frontend and localhost OSS instances
		const CORS_ALLOWED_ORIGINS = process.env['CORS_ALLOWED_ORIGINS']
			? process.env['CORS_ALLOWED_ORIGINS'].split(',')
			: ['https://crewlyai.com', 'https://www.crewlyai.com', getLocalApiBaseUrl(), 'http://localhost:3000'];
		this.app.use(
			cors({
				origin: process.env.NODE_ENV === 'production'
					? CORS_ALLOWED_ORIGINS
					: '*',
				credentials: true,
			})
		);

		// Logging
		this.app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

		// Crewly Apps publish (a whole bundle as base64) is NOT parsed here:
		// these parsers run before authentication, so its router parses it with
		// a larger limit only after the caller is the owner or a verified agent.
		const unparsedHere = [CREWLY_APPS_CONSTANTS.PUBLISH_ROUTE];

		// Body parsing — `verify` captures the raw bytes so the error handler
		// below can log the exact payload when JSON parsing fails. Without this
		// we only see the position-of-failure, not the bytes.
		this.app.use(
			bodyParserExcept(
				unparsedHere,
				express.json({
					limit: '10mb',
					verify: (req, _res, buf) => {
						(req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
					},
				}),
			),
		);
		this.app.use(
			bodyParserExcept(
				unparsedHere,
				express.urlencoded({
					extended: true,
					limit: '10mb',
					// Slack's interactive `payload=` form is verified over the exact bytes.
					verify: (req, _res, buf) => {
						(req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
					},
				}),
			),
		);

		// Note: Static files are configured in configureRoutes() after API routes
	}

	private configureRoutes(): void {
		// API token gate — loopback callers (local skills, local dashboard)
		// pass; every other address must present the API token. Static assets
		// and the SPA shell are outside `/api` and stay open; `/health` has its
		// own gate below (#825).
		this.app.use('/api', apiTokenMiddleware);

		// Which dashboard build is served: a still-open tab running an older
		// bundle can tell it should reload (#1010 review).
		this.dashboardEntry = this.config.headless ? null : loadDashboardEntry(path.join(findPackageRoot(__dirname), 'frontend/dist/index.html'));
		this.app.use('/api', dashboardBuildHeader(this.dashboardEntry));

		// A skill's X-Agent-Session is checked against the agent PTY its process
		// really runs under (X-Agent-Pid) and corrected when it names another
		// agent — before the heartbeat and every controller read it.
		this.app.use('/api', agentOriginMiddleware);

		// Who is calling, from credentials (#999, specs/2026-10-03-owner-auth.md):
		// agent badge, owner session (+ CSRF), owner API token (checked against
		// the process tree when it comes from this machine), relay credential.
		// A request with none of these is anonymous — never the owner.
		const peerProcesses = new PeerProcessService({ listSessionPids: liveSessionPids });
		this.app.use('/api', createCallerIdentityMiddleware(peerProcesses));

		// Agent heartbeat middleware - any API call with X-Agent-Session header updates heartbeat
		this.app.use('/api', agentHeartbeatMiddleware);

		// The dashboard's owner session + CSRF token (GET /api/auth/session).
		this.app.use('/api', createOwnerSessionRouter(peerProcesses));

		// API routes
		this.app.use('/api', createApiRoutes(this.apiController));

		// Health check (enhanced with mode and agent info).
		// #825: non-loopback callers need the API token (or CREWLY_PUBLIC_HEALTH=1);
		// loopback reaches this handler exactly as before.
		this.app.get('/health', healthGateMiddleware, (req, res) => {
			const versionService = VersionCheckService.getInstance();
			const cachedCheck = versionService.getCachedCheckResult();

			// Count active agents from the session backend.
			// listSessions() returns names of all active sessions, so
			// total and active counts are equal (only live sessions are listed).
			let agentCount = 0;
			try {
				const sessionBackend = getSessionBackendSync();
				if (sessionBackend) {
					agentCount = sessionBackend.listSessions().length;
				}
			} catch {
				// Session backend may not be initialized yet
			}

			// #199: Safely resolve version — findPackageRoot may fail from global install paths
			let version = cachedCheck?.currentVersion ?? null;
			if (!version) {
				try {
					version = versionService.getLocalVersion();
				} catch {
					version = process.env.npm_package_version || 'unknown';
				}
			}

			// THW self-instrumentation (§F.3): surface last-sweep age + degraded
			// flag so the watchdog-watchdog (§E.8) bubbles up here. Fail-soft
			// per Sam's etiquette nudge — when the singleton isn't ready, return
			// status:"warming" rather than 5xx.
			const watchdog = getTeamHealthWatchdogSingleton();
			const teamHealthBlock = watchdog
				? {
						status: watchdog.isDegraded() ? 'degraded' : (watchdog.isActive() ? 'ok' : 'inactive'),
						last_sweep_age_ms: watchdog.getLastSweepAgeMs(),
						shadowMode: watchdog.getLastSweep()?.shadowMode ?? null,
				  }
				: { status: 'warming', last_sweep_age_ms: -1, shadowMode: null };

			// Orchestrator-liveness signal (issue #686). The silent 假死 symptom is
			// "inbound user messages queue but nobody answers": no active agent AND
			// outstanding `respond_to_user` SLA trackers. Surface it as a body block
			// — we deliberately keep top-level status:"healthy" / HTTP 200 so a load
			// balancer doesn't drop the node on this (the LB keys on the status code;
			// this signal is for dashboards/monitoring to read from the body).
			const slaSub = getRequestSlaSubscriber();
			const pendingUserRequests = slaSub ? slaSub.getPendingUserRequestCount() : 0;

			// "Down" — no active agent while user work is queued (issue #686).
			const orchestratorDown = agentCount === 0 && pendingUserRequests > 0;

			// "Up but hung" — the orchestrator process is alive yet its session keeps
			// claiming work and never heartbeats (claims get grace-revoked in a loop).
			// agentCount>0 hides this from the "down" check, so detect it explicitly
			// via the claim-service hung signal (the Irissair 假死).
			let orchestratorHung = false;
			try {
				orchestratorHung = TaskPoolService.getInstance()
					.getHungAgents()
					.includes(ORCHESTRATOR_SESSION_NAME);
			} catch {
				// Task pool not ready yet — treat as not-hung.
			}

			const orchestratorStalled = orchestratorDown || orchestratorHung;
			const orchestratorBlock = {
				status: orchestratorStalled ? 'degraded' : 'ok',
				activeAgents: agentCount,
				pendingUserRequests,
				hung: orchestratorHung,
				reason: orchestratorHung
					? 'orchestrator session is hung — claiming work but not heartbeating (repeated grace-revokes)'
					: orchestratorDown
						? `no active agent with ${pendingUserRequests} pending user request(s) — orchestrator may be down`
						: null,
			};

			res.json({
				status: 'healthy',
				timestamp: new Date().toISOString(),
				uptime: process.uptime(),
				version,
				latestVersion: cachedCheck?.latestVersion ?? null,
				updateAvailable: cachedCheck?.updateAvailable ?? false,
				mode: this.config.headless ? 'headless' : 'standard',
				// Which Crewly home this backend serves, so a CLI can tell its own
				// backend from another user's on the same port.
				homeId: getCrewlyHomeId(),
				agents: {
					active: agentCount,
					total: agentCount,
				},
				team_health: teamHealthBlock,
				orchestrator: orchestratorBlock,
				// Agents whose deliveries the input guard keeps refusing (crewly#1028).
				input_circuit: inputCircuitStats(),
				cloud: cloudHealthBlock(),
				// Boot restore progress (staggered restore queue).
				restoreQueue: getRestoreQueue().stats(),
				// Adaptive agent limits: normal | pressure, running count, cap.
				...ResourceModeService.getInstance().stats(),
			});
		});

		// H5 quick entry static page (served regardless of headless mode)
		{
			const projectRoot = findPackageRoot(__dirname);
			const h5StaticPath = path.join(projectRoot, 'backend/src/static/h5');
			this.app.use('/h5', express.static(h5StaticPath));
		}

		// Static files for frontend (skip in headless mode)
		if (!this.config.headless) {
			// Use findPackageRoot() so this works both in dev mode (backend/src/)
			// and in compiled/npm-installed mode (dist/backend/backend/src/)
			const projectRoot = findPackageRoot(__dirname);
			const frontendPath = path.join(projectRoot, 'frontend/dist');
			// A page load from the owner's browser gets the owner session cookie (#999).
			this.app.use(createOwnerSessionPageMiddleware(peerProcesses));
			this.app.use(express.static(frontendPath));

			// Serve frontend for all other routes (SPA)
			// Skip /api/ and /health paths so addon-registered API routes are reachable
			this.app.get('*', (req, res, next) => {
				if (req.path.startsWith('/api/') || req.path === '/health') {
					return next();
				}
				const frontendIndexPath = path.join(projectRoot, 'frontend/dist/index.html');
				res.sendFile(frontendIndexPath);
			});
		} else {
			this.logger.info('Headless mode: frontend serving disabled (API-only)');
		}

		// Error handling middleware
		this.app.use(
			(
				err: Error,
				req: express.Request,
				res: express.Response,
				next: express.NextFunction
			) => {
				const rawBody = (req as express.Request & { rawBody?: string }).rawBody;
				this.logger.error('Request error', {
					error: err.message,
					stack: err.stack,
					url: `${req.method} ${req.originalUrl}`,
					contentType: req.headers['content-type'],
					contentLength: req.headers['content-length'],
					rawBodyLength: rawBody?.length,
					rawBody: rawBody ? JSON.stringify(rawBody) : undefined,
				});
				const status = (err as { statusCode?: number; status?: number }).statusCode
					?? (err as { status?: number }).status
					?? 500;
				res.status(status).json({
					success: false,
					error:
						process.env.NODE_ENV === 'production'
							? 'Internal server error'
							: err.message,
				});
			}
		);

	}

	private configureWebSocket(): void {
		this.io.on('connection', (socket) => {
			this.logger.info('Client connected', { socketId: socket.id });
			// Tell the tab which dashboard build is served now (#1010 review).
			if (this.dashboardEntry) socket.emit(OWNER_AUTH_CONSTANTS.BUILD_EVENT, dashboardBuildMessage(this.dashboardEntry));

			socket.on('disconnect', () => {
				this.logger.info('Client disconnected', { socketId: socket.id });
			});
		});

		// Connect terminal output to WebSocket
		this.tmuxService.on('output', (output) => {
			this.io.emit('terminal_output', output);
		});

		// Forward scheduler events
		this.schedulerService.on('check_executed', (data) => {
			this.io.emit('check_executed', data);
		});

		this.schedulerService.on('check_scheduled', (data) => {
			this.io.emit('check_scheduled', data);
		});
	}

	async start(): Promise<void> {
		try {
			// Validate environment configuration (fail fast with clear errors)
			const { validateEnvConfig, logEnvValidation } = await import('./services/core/env.config.js');
			const envValidation = validateEnvConfig();
			logEnvValidation(envValidation);
			if (!envValidation.valid) {
				throw new Error('Environment configuration validation failed — see errors above');
			}

			this.prepareCredentialGuardFile();

			// Initialize OpenTelemetry tracing (early, before other services)
			const { TracingService } = await import('./services/core/tracing.service.js');
			TracingService.getInstance().initialize();

			// Expose queue instance for cross-machine message routing (used by MessageRouterService)
			const { setMessageQueueInstance } = await import('./services/messaging/index.js');
			setMessageQueueInstance(this.messageQueueService);

			this.logger.info('Starting Crewly server...');
			this.logger.info('Server startup info', {
				pid: process.pid,
				memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
				targetPort: this.config.webPort,
				headless: this.config.headless,
			});

			// Truncate service.log on startup — it's a raw stdout pipe duplicate of the
			// daily crewly-YYYY-MM-DD.log files and grows unbounded otherwise.
			try {
				const serviceLogPath = path.join(this.config.crewlyHome, 'logs', 'service.log');
				const { stat, truncate } = await import('fs/promises');
				const logStat = await stat(serviceLogPath).catch(() => null);
				if (logStat && logStat.size > 10 * 1024 * 1024) { // truncate if > 10MB
					await truncate(serviceLogPath, 0);
					this.logger.info('Truncated service.log on startup', {
						previousSizeMB: Math.round(logStat.size / 1024 / 1024),
					});
				}
			} catch {
				// Non-critical
			}

			if (this.config.headless) {
				this.logger.info('Headless mode active: API-only, no frontend serving');
			}

			// Check for pending self-improvement (hot-reload recovery)
			await this.checkPendingSelfImprovement();

			// Check if port is already in use
			await this.checkPortAvailability();

			// Skip tmux initialization since we're using PTY session backend
			// Note: TmuxService is kept for backward compatibility but PTY is the active backend
			try {
				await this.tmuxService.initialize();
			} catch (error) {
				// Ignore tmux initialization errors - PTY backend is primary
			}

			// Reset orchestrator status to inactive on startup.
			// The persisted status file may still say "active" from the previous session,
			// but a fresh app start has no running agent. Without this reset, the UI
			// would show "Active" for a bare shell that has no Claude running inside it.
			try {
				await this.storageService.updateOrchestratorStatus(CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE);
				this.logger.info('Reset orchestrator status to inactive on startup');
			} catch (resetErr) {
				this.logger.warn('Failed to reset orchestrator status on startup', {
					error: resetErr instanceof Error ? resetErr.message : String(resetErr),
				});
			}

			// Initialize PTY session backend.
			// We load persisted session metadata (including Claude session IDs) so that
			// when agents are re-started, they can resume their previous conversations
			// using --resume. The actual PTY sessions are NOT restored here — they are
			// recreated when the user starts teams again.
			this.logger.info('Initializing PTY session backend...');
			await getSessionBackend();

			// Load persisted session metadata for resume-on-restart support
			try {
				const persistence = getSessionStatePersistence();
				const savedState = await persistence.loadState();
				if (savedState && savedState.sessions.length > 0) {
					for (const sessionInfo of savedState.sessions) {
						persistence.registerSession(sessionInfo.name, {
							cwd: sessionInfo.cwd,
							command: sessionInfo.command,
							args: sessionInfo.args,
							env: sessionInfo.env,
						}, sessionInfo.runtimeType, sessionInfo.role, sessionInfo.teamId, sessionInfo.memberId);
						if (sessionInfo.claudeSessionId) {
							persistence.updateSessionId(sessionInfo.name, sessionInfo.claudeSessionId);
						}
					}
					this.logger.info('Loaded persisted session metadata for resume support', {
						count: savedState.sessions.length,
						sessionsWithResumeId: savedState.sessions.filter(s => s.claudeSessionId).length,
					});
					await this.pruneUnboundPersistedSessions(savedState.sessions);
				}
			} catch (loadError) {
				this.logger.debug('No persisted session state to load (first run or cleared)', {
					error: loadError instanceof Error ? loadError.message : String(loadError),
				});
			}

			// Initialize Redis cache (non-blocking — falls back to memory if Redis is unavailable)
			try {
				const redisConnected = await RedisCacheService.getInstance().connect();
				this.logger.info('Redis cache initialized', { connected: redisConnected, backend: redisConnected ? 'redis' : 'memory' });
			} catch (cacheErr) {
				this.logger.info('Redis cache not available, using in-memory fallback', {
					error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
				});
			}

			// Start message scheduler
			this.logger.info('Starting message scheduler...');
			await this.messageSchedulerService.start();

			// Restore persisted scheduled checks (non-critical — don't block startup)
			try {
				this.logger.info('Restoring persisted scheduled checks...');
				const [recurringRestored, oneTimeRestored] = await Promise.all([
					this.schedulerService.restoreRecurringChecks(),
					this.schedulerService.restoreOneTimeChecks(),
				]);
				if (recurringRestored > 0 || oneTimeRestored > 0) {
					this.logger.info('Restored scheduled checks', { recurringRestored, oneTimeRestored });
				}
			} catch (restoreError) {
				this.logger.warn('Failed to restore scheduled checks (non-critical)', {
					error: restoreError instanceof Error ? restoreError.message : String(restoreError),
				});
			}

			// Start activity monitoring
			this.logger.info('Starting activity monitoring...');
			// Turn busy periods for the autonomy metrics (#984): one `turn.ended`
			// trace event per PTY turn, from the undelayed status listener.
			this.activityMonitorService.onWorkingStatusChange((session, status) => {
				traceTurnActivity(session, status === 'in_progress', 'pty');
			});
			this.activityMonitorService.startPolling();

			// Start idle detection for agent suspension
			this.logger.info('Starting idle detection service...');
			const idleDetection = IdleDetectionService.getInstance();
			idleDetection.setAgentRegistrationService(this.apiController.agentRegistrationService);
			// Follow-through guard: "I'm doing X now" must be followed by action
			// (specs/2026-10-10-agent-follow-through.md).
			createFollowThrough({
				crewlyHome: this.config.crewlyHome,
				sendToAgent: (session, text) => this.apiController.agentRegistrationService.sendMessageToAgent(session, text),
			});
			// An agent that owes work — a WorkItem (queued, accepted or running),
			// an assigned ticket, a promise to the owner, an unfulfilled "doing X
			// now" — is never idle-stopped. Under memory pressure it still can
			// be, but its work goes back to the queue first and is redelivered.
			idleDetection.setPendingWorkCheck(idlePendingWorkCheck());
			idleDetection.setWorkReleaser((sessionName, why) => releaseWorkForStop(sessionName, why));
			idleDetection.start();

			// Adaptive agent limits (pressure mode cap + start queue).
			const resourceMode = ResourceModeService.getInstance();
			const agentRegistration = this.apiController.agentRegistrationService;
			resourceMode.setDeps({
				limits: async () => {
					const g = (await getSettingsService().getSettings()).general;
					return {
						maxRunning: Math.max(1, g.pressureMaxRunningAgents ?? RESOURCE_MODE_CONSTANTS.DEFAULT_MAX_RUNNING_AGENTS),
						idleTimeoutMinutes: g.pressureIdleTimeoutMinutes ?? RESOURCE_MODE_CONSTANTS.DEFAULT_IDLE_TIMEOUT_MINUTES,
					};
				},
				listRunning: async () => {
					const teams = await StorageService.getInstance().getTeams();
					const tracker = PtyActivityTrackerService.getInstance();
					const out: RunningAgent[] = [];
					for (const t of teams) {
						for (const m of t.members || []) {
							if (m.agentStatus !== CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE && m.agentStatus !== CREWLY_CONSTANTS.AGENT_STATUSES.STARTED) continue;
							if (m.sessionName === ORCHESTRATOR_SESSION_NAME || AGENT_SUSPEND_CONSTANTS.ALWAYS_ON_ROLES.includes(m.role as typeof AGENT_SUSPEND_CONSTANTS.ALWAYS_ON_ROLES[number])) continue;
							let busy = m.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.STARTED;
							try {
								busy = busy || (await this.activityMonitorService.getWorkingStatusForSession(m.sessionName)) === 'in_progress';
							} catch { /* unknown status: treat as not busy */ }
							out.push({ sessionName: m.sessionName, role: m.role, idleMs: tracker.getIdleTimeMs(m.sessionName), busy });
						}
					}
					return out;
				},
				hasOwnerMessage: (name) => SubAgentMessageQueue.getInstance().peek(name).some((m) => m.meta?.owner === true),
				// Pending work, open tickets and open delegations keep an agent running.
				protectedReason: createProtectedReason({
					getWorkItems: () => TaskPoolService.getInstance().getAllItems(),
					listTickets: async (name) => {
						const workflow = ProjectTicketWorkflowService.getInstance();
						if (!workflow) return [];
						return (await workflow.listForSession(name)).flatMap((p) => p.tickets);
					},
				}),
				// An agent mid-conversation with the owner is the last one stopped
				// for a slot, and its owner thread hears when it is
				// (specs/2026-10-08-owner-thread-sentinel.md).
				owesOwnerThread: (name) => getOwnerThreadSentinel()?.owesRecently(name) === true,
				onStoppedForSlot: (name) => reportOwnerThreadBlocking(name, { kind: 'stopped', why: 'slot' }),
				onStartDeferred: (name) => reportOwnerThreadBlocking(name, { kind: 'start_deferred' }),
				stopAgent: async (name, role) => {
					// Its work survives the stop: back in the queue, redelivered on the next start.
					await releaseWorkForStop(name, 'stopped to free a running-agent slot');
					await agentRegistration.terminateAgentSession(name, role);
					await StorageService.getInstance().updateAgentStatus(name, CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE as any, 'idle_exit');
				},
			});
			resourceMode.start();

			// Wire OrchestratorRestartService with dependencies for auto-restart
			try {
				const sessionBackend = getSessionBackendSync();
				if (sessionBackend) {
					const restartService = OrchestratorRestartService.getInstance();
					restartService.setDependencies(
						this.apiController.agentRegistrationService,
						sessionBackend,
						this.io
					);
					this.logger.info('OrchestratorRestartService wired with dependencies');
				}
			} catch (error) {
				this.logger.warn('Failed to wire OrchestratorRestartService (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Wire orchestrator-setup service for SlackBridge auto-recovery (B0).
			// Without this, the bridge's auto-recovery path returns "deps not
			// initialized" and falls through to the offline branch.
			try {
				setOrchestratorSetupDependencies({
					agentRegistrationService: this.apiController.agentRegistrationService,
					storageService: this.storageService,
				});
				this.logger.info('OrchestratorSetupService wired with dependencies');
			} catch (error) {
				this.logger.warn('Failed to wire OrchestratorSetupService (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Wire and start OrchestratorHeartbeatMonitorService for auto-restart
			try {
				const orchHbSessionBackend = getSessionBackendSync();
				if (orchHbSessionBackend) {
					const orchHeartbeatMonitor = OrchestratorHeartbeatMonitorService.getInstance();
					orchHeartbeatMonitor.setDependencies(
						orchHbSessionBackend,
						() => this.messageQueueService.hasPending() || this.queueProcessorService.isProcessingMessage()
					);
					orchHeartbeatMonitor.start();
					this.logger.info('OrchestratorHeartbeatMonitorService started');
				}
			} catch (error) {
				this.logger.warn('Failed to start OrchestratorHeartbeatMonitorService (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Wire AgentSuspendService with registration service for rehydration
			try {
				AgentSuspendService.getInstance().setDependencies(
					this.apiController.agentRegistrationService
				);
				this.logger.info('AgentSuspendService wired with dependencies');
			} catch (error) {
				this.logger.warn('Failed to wire AgentSuspendService (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Wire and start AgentHeartbeatMonitorService
			try {
				const agentHbSessionBackend = getSessionBackendSync();
				if (agentHbSessionBackend) {
					const agentHeartbeatMonitor = AgentHeartbeatMonitorService.getInstance();
					agentHeartbeatMonitor.setDependencies(
						agentHbSessionBackend,
						this.apiController.agentRegistrationService,
						this.storageService,
					);
					agentHeartbeatMonitor.start();
					this.logger.info('AgentHeartbeatMonitorService started');
				}
			} catch (error) {
				this.logger.warn('Failed to start AgentHeartbeatMonitorService (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Wire and start ContextWindowMonitorService
			try {
				const ctxSessionBackend = getSessionBackendSync();
				if (ctxSessionBackend) {
					const contextWindowMonitor = ContextWindowMonitorService.getInstance();
					contextWindowMonitor.setDependencies(
						ctxSessionBackend,
						this.apiController.agentRegistrationService,
						this.storageService,
						this.eventBusService
					);
					contextWindowMonitor.start();
					this.logger.info('ContextWindowMonitorService started');
				}
			} catch (error) {
				this.logger.warn('Failed to start ContextWindowMonitorService (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Wire OAuthReloginMonitorService: event bus, orchestrator queue,
			// chat + Slack sinks for the owner-facing login notice, and the
			// boot-level sign-in-screen sweep (server-install finding 7).
			try {
				const oauthMonitor = OAuthReloginMonitorService.getInstance();
				oauthMonitor.setEventBusService(this.eventBusService);
				oauthMonitor.setNoticeQueue(this.messageQueueService);
				oauthMonitor.setAgentNameResolver(async (sessionName) =>
					(await this.storageService.findMemberBySessionName(sessionName))?.member.name ?? null);
				oauthMonitor.setSlackProvider(async () => {
					const slack = getSlackService();
					return slack.isConnected() ? slack : null;
				});
				oauthMonitor.setChatProvider(() => {
					const gateway = this.terminalGateway;
					if (!gateway) return null;
					return {
						getActiveConversationId: () => gateway.getActiveConversationId(),
						recordSystemTurn: (conversationId: string, content: string) => {
							const chatV2 = getChatV2Service();
							const channel = chatV2.ensureChannelForLegacyConversation({
								conversationId,
								agentSession: ORCHESTRATOR_SESSION_NAME,
							});
							chatV2.recordTurn({
								channelId: channel.id,
								senderType: 'system',
								senderId: 'system',
								content,
								metadata: { source: 'system' },
							});
						},
						broadcastSystemNotification: (message: string, type: 'warning') =>
							gateway.broadcastSystemNotification(message, type),
					};
				});
				oauthMonitor.start();
			} catch (error) {
				this.logger.warn('Failed to wire OAuthReloginMonitorService (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Re-login over Slack (onboarding Phase 2): expired Claude Code /
			// Codex logins go to one coordinator that runs a broker login per
			// harness, DMs the owner, takes their DM reply (Claude's code) and
			// restarts the stuck agents once the login is back.
			try {
				const relogin = getHarnessReloginService();
				// Answers to an owner-requested login go into the thread it was
				// asked in — for the orc's own-bot DM that needs the orc bot's token.
				const reloginDm = new SlackReloginDmService(
					() => getSlackService(),
					undefined,
					(agentSession) => getSlackAgentIdentityService()?.getInstalled(agentSession)?.botToken ?? null,
				);
				relogin.setNotifier(reloginDm);
				relogin.setResumer(new ReloginAgentResumerService({
					getBackend: () => getSessionBackendSync(),
					getPersistence: () => getSessionStatePersistence(),
					getAgentRegistration: () => this.apiController.agentRegistrationService,
					restartOrchestrator: () => OrchestratorRestartService.getInstance().attemptRestart(),
					stopExitMonitoring: (sessionName) => RuntimeExitMonitorService.getInstance().stopMonitoring(sessionName),
					clearActivity: (sessionName) => PtyActivityTrackerService.getInstance().clearSession(sessionName),
				}));
				OAuthReloginMonitorService.getInstance().setHarnessExpiryHandler((report) => relogin.reportExpiry(report));
				// Agent-free re-login: every configured agent (running or not)
				// counts, so a machine whose agents are all stopped or stuck is
				// still checked; agents flagged at a sign-in screen are resumed
				// after a dashboard sign-in; what waited is re-delivered.
				relogin.setAgentLister(async () => {
					const agents: Array<{ sessionName: string; harnessId: string; displayName?: string }> = [];
					const orcHarness = await getHarnessService().orc.get().catch(() => null);
					if (orcHarness) agents.push({ sessionName: ORCHESTRATOR_SESSION_NAME, harnessId: orcHarness, displayName: 'Crewly Orc' });
					for (const team of await this.storageService.getTeams()) {
						for (const m of team.members ?? []) {
							if (m.sessionName && m.runtimeType) agents.push({ sessionName: m.sessionName, harnessId: m.runtimeType, displayName: m.name });
						}
					}
					return agents;
				});
				relogin.setSessionNeedsLogin((sessionName) => Boolean(OAuthReloginMonitorService.getInstance().getLoginRequired(sessionName)));
				relogin.setLoginRestoredHandler(async (harnessId, resumed) => {
					const { getOwnerMessageWatchdog } = await import('./services/messaging/owner-message-watchdog.service.js');
					return (await getOwnerMessageWatchdog()?.resumeAfterLogin({ runtimeCmd: harnessCommandWord(harnessId), sessions: resumed })) ?? 0;
				});
				getSlackOrchestratorBridge().setInboundInterceptor(createReloginReplyInterceptor(reloginDm, relogin));
				relogin.start();
				this.logger.info('Harness re-login over Slack wired');
			} catch (error) {
				this.logger.warn('Failed to wire harness re-login over Slack (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Runtime fallback: an agent whose runtime runs out of usage moves to
			// the next runtime of its chain until the limit resets; the owner is
			// told once over the machine's orc-bot DM.
			// specs/2026-10-01-runtime-fallback.md
			try {
				const fallbackDm = new SlackReloginDmService(
					() => getSlackService(),
					undefined,
					(agentSession) => getSlackAgentIdentityService()?.getInstalled(agentSession)?.botToken ?? null,
				);
				startBackendRuntimeFallback({
					crewlyHome: this.config.crewlyHome,
					storage: this.storageService,
					registration: () => this.apiController.agentRegistrationService,
					sessionExists: (sessionName) => getSessionBackendSync()?.sessionExists(sessionName) ?? false,
					notifier: () => fallbackDm,
					machineName: () => os.hostname().replace(/\.local$/, ''),
					logger: LoggerService.getInstance().createComponentLogger('RuntimeFallback'),
				});
				this.logger.info('Runtime fallback wired');
			} catch (error) {
				this.logger.warn('Failed to wire runtime fallback (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Temporary team pause: index from storage, auto-resume sweep, and the
			// owner's "pause <team>" / "resume <team>" DM commands (specs/2026-10-04-team-pause.md).
			try {
				const { startTeamPause } = await import('./services/team/team-pause.wiring.js');
				await startTeamPause({
					context: this.apiController,
					logger: LoggerService.getInstance().createComponentLogger('TeamPause'),
				});
			} catch (error) {
				this.logger.warn('Failed to wire the team pause (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Daily token caps (agent / team / total) + boosts, hard stop (specs/2026-10-02-spend-cap.md).
			// Caps are off until the owner sets one.
			try {
				const { startSpendCaps } = await import('./services/spend/spend-cap.wiring.js');
				await startSpendCaps({
					crewlyHome: this.config.crewlyHome,
					storage: this.storageService,
					registration: () => this.apiController.agentRegistrationService,
					sessionExists: (sessionName) => getSessionBackendSync()?.sessionExists(sessionName) ?? false,
					activate: async (sessionName) => {
						const { activateAgentBySession } = await import('./controllers/team/team.controller.js');
						return activateAgentBySession(this.apiController, sessionName);
					},
					logger: LoggerService.getInstance().createComponentLogger('SpendCap'),
				});
				this.logger.info('Token caps wired');
			} catch (error) {
				this.logger.warn('Failed to wire token caps (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Wire RuntimeExitMonitorService dependencies for task-aware restart
			try {
				const runtimeExitMonitor = RuntimeExitMonitorService.getInstance();
				runtimeExitMonitor.setAgentRegistrationService(this.apiController.agentRegistrationService);
				runtimeExitMonitor.setEventBusService(this.eventBusService);
				// #989: a runtime that keeps dying at start is told to the owner once.
				runtimeExitMonitor.setOwnerNotifier(slackOwnerAlertNotifier);
				// Credential-guard blocks: owner told once per agent per day (specs/2026-10-04-agent-credential-isolation.md).
				CredentialGuardAlertService.getInstance().setOwnerNotifier(slackOwnerAlertNotifier);
			} catch (error) {
				this.logger.warn('Failed to wire RuntimeExitMonitorService dependencies (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Start Crewly in Chrome WebSocket bridge
			try {
				const { BrowserBridgeService } = await import('./services/browser/browser-bridge.service.js');
				const browserBridge = BrowserBridgeService.getInstance();
				browserBridge.attach(this.httpServer);
				this.logger.info('Crewly in Chrome WebSocket bridge started');

				// Live browser view: make each agent's browser work watchable.
				// The capturer is injected rather than imported by the session
				// service so transport selection (direct WS vs relay) stays in
				// one place — here and in the browser controller.
				const { getBrowserSessions, createBoundTabCapturer } = await import('./services/browser/browser-session.service.js');
				const browserSessions = getBrowserSessions();
				browserSessions.setCapturer(createBoundTabCapturer({
					getBoundTabId: (agentSession) => browserBridge.getBinding(agentSession)?.tabId,
					sendScreenshot: async (params) => {
						const { BrowserProxyService } = await import('./services/browser/browser-proxy.service.js');
						const proxy = BrowserProxyService.getInstance();
						if (browserBridge.isConnected()) return browserBridge.sendCommand('screenshot', params);
						if (proxy.isAvailable()) return proxy.sendCommand('screenshot', params);
						return null;
					},
				}));
				browserSessions.start();

				// Let the browser controller reach agents, so taking the wheel
				// and answering a held action actually tell the agent what
				// happened instead of leaving it retrying into a 409.
				const { setBrowserControlDeps } = await import('./controllers/browser/browser.controller.js');
				setBrowserControlDeps({
					sendMessageToAgent: (sessionName, message) =>
						this.apiController.agentRegistrationService.sendMessageToAgent(sessionName, message),
				});

				// Held irreversible actions: ask the owner with a Slack decision
				// card in the agent's work thread, persist the hold, and apply the
				// answer from any surface (card, reaction, reply, dashboard, portal).
				try {
					const { BrowserApprovalService } = await import('./services/browser/browser-approval.service.js');
					const { HeldActionStore } = await import('./services/browser/held-action-store.js');
					const { DecisionService } = await import('./services/decisions/decision.service.js');
					const approvals = new BrowserApprovalService({
						store: HeldActionStore.inHome(this.config.crewlyHome),
						sessions: browserSessions,
						decisions: () => DecisionService.getInstance(),
						canAskInSlack: () => !!DecisionService.getInstance() && getSlackService().isConnected(),
						tellAgent: (sessionName, message) =>
							this.apiController.agentRegistrationService.sendMessageToAgent(sessionName, message),
						agentNameOf: async (sessionName) => {
							const teams = await this.storageService.getTeams().catch(() => []);
							return teams.flatMap((t) => t.members ?? []).find((m) => m.sessionName === sessionName)?.name;
						},
						boundTabOf: (sessionName) => {
							const binding = browserBridge.getBinding(sessionName);
							return binding ? { tabId: binding.tabId, ...(binding.instanceId ? { instanceId: binding.instanceId } : {}) } : undefined;
						},
						adoptTab: (sessionName, tabId, instanceId) => browserBridge.adoptTab(sessionName, tabId, instanceId),
					});
					BrowserApprovalService.setInstance(approvals);
					DecisionService.registerKindHandler('browser_action', approvals);
					browserSessions.setHoldListener(approvals);
					browserBridge.onTabInventory((tabs, instanceId) => approvals.onTabInventory(tabs, instanceId));
					// Restored holds expire through their cards, so restore once
					// decision cards run (startDecisionCards) — or now, if they do.
					if (DecisionService.getInstance()) await approvals.restore();
					approvals.start();
				} catch (error) {
					this.logger.warn('Browser approval cards not started', {
						error: error instanceof Error ? error.message : String(error),
					});
				}

				this.logger.info('Live browser view started');
			} catch (error) {
				this.logger.warn('Failed to start Crewly in Chrome bridge (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Start chat-v2 WebSocket gateway + dispatcher (Phase 1 Chat MVP).
			// The gateway fans `message`/`presence` frames to subscribers of
			// `/ws/chat?channelId=...`. The dispatcher pushes user-origin
			// messages into the bound agent session so it can reply via the
			// `reply-channel` skill. See chat-v2.gateway.ts for the contract.
			try {
				const [
					{ ChatV2Gateway, devAnonymousTokenVerifier },
					{ ChatV2DispatcherService, agentAuthorOf },
					{ ChatV2MentionResolver },
					{ getChatV2Service },
					{ setChatV2RealtimeDeps },
					{ verifyHs256Token },
				] = await Promise.all([
					import('./websocket/chat-v2.gateway.js'),
					import('./services/chat-v2/chat-v2.dispatcher.service.js'),
					import('./services/chat-v2/chat-v2.mention-resolver.js'),
					import('./services/chat-v2/chat-v2.singleton.js'),
					import('./services/chat-v2/chat-v2.realtime-holder.js'),
					import('./middleware/require-auth.middleware.js'),
				]);
				const chatService = getChatV2Service();
				const jwtSecret = process.env['CREWLY_JWT_SECRET'];
				const verifyToken = jwtSecret
					? async (token: string | null) => {
						if (!token) return null;
						const payload = verifyHs256Token(token, jwtSecret);
						if (!payload?.sub) return null;
						return { userId: payload.sub };
					}
					: devAnonymousTokenVerifier;
				const chatGateway = new ChatV2Gateway({ service: chatService, verifyToken });
				chatGateway.attach(this.httpServer);
				// Phase C BE.3 — inject the mention resolver so type='channel'
				// messages fan out to @-mentioned recipients instead of
				// short-circuiting with strategy='skip' at the dispatcher.
				// Pattern matches LiveTeamHealthDataProvider wiring (~line 487):
				// `getTeams: async () => StorageService.getInstance().getTeams()`.
				const chatMentionResolver = new ChatV2MentionResolver({
					loadTeams: async () => StorageService.getInstance().getTeams(),
				});
				const { isOwnerChatTurn } = await import('./services/messaging/owner-message-watchdog.wiring.js');
				const chatDispatcher = new ChatV2DispatcherService({
					agentSink: this.apiController.agentRegistrationService,
					// An owner message that waits for a busy agent goes to the
					// front of its queue (2026-10-05, D-270: behind 6 reminders).
					isOwnerMessage: (message) => isOwnerChatTurn(message, getSlackService().getOwnerUserId?.() ?? null),
					mentionResolver: chatMentionResolver,
					// Issue #968: an agent dedicated to one person never gets (or
					// is woken by) anyone else's Slack message.
					// A post another agent wrote (colleague's Slack post, or a
					// local agent's user turn) is never declined.
					refuseDelivery: async (sessionName, message) =>
						(
							await dedicatedDecisionFor(StorageService.getInstance(), sessionName, {
								slackUserId: typeof message.metadata?.slackUserId === 'string' ? (message.metadata.slackUserId as string) : null,
								authorAgentSession: agentAuthorOf(message),
							})
						).decline,
					// Phase B-2 — huddle roster lookup. ChatV2Service owns
					// the chat_channel_members table; the dispatcher just
					// needs the list of session names for a given channel
					// to fan-out a user message to every huddle member.
					huddleMembersFor: (channelId) =>
						chatService.queryHuddleMembersForDispatch(channelId),
					// Thread follow-ups reach the agents already in the thread
					// without another @.
					threadParticipantsFor: (channelId, threadId) =>
						chatService.queryThreadParticipantsForDispatch(channelId, threadId),
					// …but only the one that spoke last must answer a bare follow-up.
					lastThreadSpeakerFor: (channelId, threadId) =>
						chatService.queryLastThreadSpeakerForDispatch(channelId, threadId),
					// What was said before this message. Without it an agent
					// @-mentioned into a channel sees one line and cannot tell
					// whether a colleague already answered — nor check its own
					// account of what it was told, which is how one of them
					// came to cite an instruction that did not exist.
					recentTurnsFor: (channelId, threadId) =>
						chatService.queryRecentTurnsForDispatch(
							channelId,
							threadId,
							Math.max(CHAT_CONTEXT_CONSTANTS.THREAD_MAX, CHAT_CONTEXT_CONSTANTS.CHANNEL_MAX, CHAT_CONTEXT_CONSTANTS.TOP_LEVEL_OWNER_MAX),
						),
					// A message that addresses nobody goes to the team leader alone
					// (optional reply); the team is found by the huddle's roster.
					huddleLeaderFor: async (channelId) => {
						const members = new Set(chatService.queryHuddleMembersForDispatch(channelId));
						if (members.size === 0) return null;
						const { resolveHuddleLeader } = await import('./services/chat-v2/huddle-leader.js');
						return resolveHuddleLeader(await this.storageService.getTeams(), members);
					},
					// Activate-on-send: messaging an offline agent wakes it, then
					// the dispatcher retries delivery. User-initiated, so it uses
					// the wake-gate-free activation path.
					activateAgent: async (agentSession: string) => {
						const { activateAgentBySession } = await import(
							'./controllers/team/team.controller.js'
						);
						const res = await activateAgentBySession(this.apiController, agentSession);
						return res.success;
					},
					// Every owner message that reached an agent is watched until
					// it is answered (specs/2026-09-30-owner-message-guarantee.md).
					onDispatched: async (channel, message, result) => {
						const { getOwnerMessageWatchdog } = await import('./services/messaging/owner-message-watchdog.service.js');
						const watchdog = getOwnerMessageWatchdog();
						if (!watchdog || !result.dispatched) return;
						const { trackInputFromDispatch } = await import('./services/messaging/owner-message-watchdog.wiring.js');
						let leader: string | null = null;
						if (channel.type === 'huddle') {
							const members = new Set(chatService.queryHuddleMembersForDispatch(channel.id));
							const { resolveHuddleLeader } = await import('./services/chat-v2/huddle-leader.js');
							leader = members.size > 0 ? await resolveHuddleLeader(await this.storageService.getTeams(), members) : null;
						}
						const input = trackInputFromDispatch(channel, message, result, {
							ownerSlackUserId: getSlackService().getOwnerUserId?.() ?? null,
							leader,
						});
						if (input) watchdog.track(input);
					},
				});
				// An agent's answer in a thread makes a queued colleague message or
				// reminder there stale (dropped at flush). Never an owner message.
				{
					const { noteAgentChatTurn } = await import('./services/messaging/queue-priority.js');
					chatService.on('chat_message', (dto: import('./services/chat-v2/types.js').ChatMessageDTO) => noteAgentChatTurn(dto));
				}
				await this.startOwnerMessageWatchdog(chatService);
				await this.startOwnerCompletionReport(chatService);
				this.chatV2Gateway = chatGateway;
				this.chatV2Dispatcher = chatDispatcher;
				// The chat-v2 router mounted earlier reads realtime deps from
				// this holder at request time, so it picks up broadcast +
				// dispatch without a re-mount.
				setChatV2RealtimeDeps({ gateway: chatGateway, dispatcher: chatDispatcher });
				// Drive mode briefing (specs/2026-10-08-drive-mode.md): the owner's
				// queue across agents for the phone's voice briefer. Answers reuse the
				// existing paths — the decision service, the agent's conversation (a
				// Talk-style owner turn tagged voice) and the ticket review.
				try {
					const [
						{ BriefingService, setBriefingService },
						{ BriefingStateStore },
						{ DecisionService },
						{ OpenItemsService },
						{ getTicketIntakeService },
						{ getTicketReviewService },
						{ buildAgentRoster },
						{ intakeChatV2OwnerMessage },
					] = await Promise.all([
						import('./services/briefing/briefing.service.js'),
						import('./services/briefing/briefing-state.store.js'),
						import('./services/decisions/decision.service.js'),
						import('./services/open-items/open-items.service.js'),
						import('./services/v3/ticket-intake.service.js'),
						import('./services/v3/ticket-review.service.js'),
						import('./services/cloud/agent-roster.utils.js'),
						import('./services/v3/ticket-channel-hooks.js'),
					]);
					const owner = { userId: SLACK_AGENT_DM_CONSTANTS.OWNER_USER_ID, source: 'oss' as const };
					setBriefingService(
						new BriefingService({
							decisions: () => DecisionService.getInstance(),
							listRequests: () => RequestService.getInstance().listAll(),
							listReviewTickets: async () => {
								const intake = getTicketIntakeService();
								if (!intake) return [];
								const candidates = (await RequestService.getInstance().listAll()).filter(
									(r) => typeof r.ticketNumber === 'number' && r.requiresConfirmation && r.status !== 'done' && r.status !== 'cancelled',
								);
								const rows = await Promise.all(candidates.map((r) => intake.toListItem(r)));
								// Only work waiting for the owner's OK. A ticket in awaiting_followup
								// is held by its own open items (a question or a promise with its own
								// card) and has no accept deadline, so listing it left it there for days.
								return rows.filter((row) => row.column === 'to_review' && row.status === 'waiting_confirmation');
							},
							review: () => getTicketReviewService(),
							dismissOpenItem: async (requestId, itemId) => {
								const openItems = OpenItemsService.getInstance();
								if (!openItems) throw new Error('open items are not ready');
								return openItems.skipItem(requestId, itemId);
							},
							roster: async () => buildAgentRoster(await this.storageService.getTeams()),
							// Items the owner already answered in their conversation are left out.
							ownerTurns: async () => chatService.getOwnerTurnMarks(),
							postOwnerMessage: async (target, text) => {
								const channelId = target.channelId ?? chatService.ensureDmChannel({ agentSession: target.agentSession, principal: owner }).channel.id;
								const { message } = chatService.recordTurn({
									channelId,
									senderType: 'user',
									senderId: owner.userId,
									content: text,
									...(target.threadId ? { threadId: target.threadId } : {}),
									clientMessageId: `voice-${randomUUID()}`,
									// Talk's source keeps the reply on the owner's Talk surface; `inputMode` says it was spoken.
									metadata: { source: 'cloud-talk', inputMode: 'voice', via: 'drive-mode' },
								});
								const channel = chatService.getChannel(channelId, owner);
								const toDispatch = await intakeChatV2OwnerMessage(getTicketIntakeService(), channel, message, CLOUD_TALK_CONSTANTS.INTAKE_ORIGIN);
								await chatDispatcher.dispatchMessage(channel, toDispatch);
								return { channelId, ...(message.threadId ? { threadId: message.threadId } : {}) };
							},
							findAgentReply: async (agentSession, channelId, threadId, sinceMs) => {
								const { items } = chatService.getAgentTimeline({ agentSession, principal: owner, limit: BRIEFING_CONSTANTS.LOOKUP_SCAN_LIMIT });
								const reply = items
									.filter((m) => m.channelId === channelId && m.senderType === 'agent' && m.createdAt > sinceMs && (!threadId || m.threadId === threadId || m.id === threadId))
									.sort((a, b) => a.createdAt - b.createdAt)[0];
								return reply ? { text: reply.content, at: new Date(reply.createdAt).toISOString() } : null;
							},
							// A card whose project ticket is already done / cancelled waits on nothing.
							isCardTicketClosed: async (ticket) => {
								const { ProjectTicketService } = await import('./services/project-tickets/project-ticket.service.js');
								const found = await ProjectTicketService.getInstance().get(ticket.projectPath, ticket.id);
								return found?.status === 'done' || found?.status === 'cancelled';
							},
							store: new BriefingStateStore(),
						}),
					);
				} catch (briefingErr) {
					this.logger.warn('Drive mode briefing wiring skipped', {
						error: briefingErr instanceof Error ? briefingErr.message : String(briefingErr),
					});
				}
				this.logger.info('chat-v2 WebSocket gateway + dispatcher started', {
					path: '/ws/chat',
					authMode: jwtSecret ? 'jwt' : 'dev-anonymous',
				});

				// LLM-wiki Phase 1 (redesign 2026-05-22): the prior auto-write
				// subscriber was REMOVED. Steve's direction: agents decide what
				// is wiki-worthy from inside the conversation and call the
				// `wiki-queue-add` skill explicitly. No keyword routing, no
				// blanket "every chat → log.md." See WikiQueueService for the
				// queue + the orchestrator system prompt for the agent rule.

				// Cloud Portal relay bridge — gives the Crewly Portal at
				// crewlyai.com the same /agents experience by tunnelling chat-v2
				// RPC calls through the Cloud relay queue + forwarding gateway
				// broadcasts as `chat_event` messages. Only wired when Cloud Sync
				// is running (BrowserRelayAdapter pattern).
				try {
					const { ChatV2RelayAdapter } = await import(
						'./services/chat-v2/chat-v2.relay-adapter.service.js'
					);
					const { CloudSyncService } = await import(
						'./services/cloud/cloud-sync.service.js'
					);
					const {
						createOssAgentDirectoryProvider,
						createOssAgentPresenceProvider,
					} = await import(
						'./services/chat-v2/chat-v2.providers.js'
					);
					const sync = CloudSyncService.getInstance();
					if (sync) {
						const chatRelayAdapter = new ChatV2RelayAdapter({
							service: chatService,
							gateway: chatGateway,
							cloudSync: sync,
							// Wire the dispatcher so Portal-sent user messages also fire the
							// agent-side prompt (parity with the HTTP controller path).
							// Without this, Portal user-messages persist but the bound agent
							// never receives the `[CHAT:<id>]` prompt — orc/etc. stay silent.
							dispatcher: chatDispatcher,
							directory: createOssAgentDirectoryProvider(this.storageService),
							presence: createOssAgentPresenceProvider(this.storageService),
						});
						chatRelayAdapter.start();
						this.logger.info('ChatV2RelayAdapter started — Cloud Portal can now drive chat-v2 via relay');

						// Cloud Talk (specs/unified-conversations-cloud-store.md §D.3):
						// Cloud pushes `talk_message`; the handler fetches the text with
						// this machine's token, records it in the agent's DM as
						// `cloud-talk` and hands it to the agent like a Crewly Chat DM.
						// Starting it is what advertises `talk_message` to Cloud.
						try {
							const [
								{ CloudTalkInboundService },
								{ CloudClientService },
								{ buildAgentRoster },
								{ intakeChatV2OwnerMessage },
								{ getTicketIntakeService },
							] = await Promise.all([
								import('./services/cloud/cloud-talk-inbound.service.js'),
								import('./services/cloud/cloud-client.service.js'),
								import('./services/cloud/agent-roster.utils.js'),
								import('./services/v3/ticket-channel-hooks.js'),
								import('./services/v3/ticket-intake.service.js'),
							]);
							const cloudClient = CloudClientService.getInstance();
							const talkInbound = new CloudTalkInboundService({
								source: sync,
								cloud: {
									getToken: () => cloudClient.getToken(),
									getCloudUrl: () => cloudClient.getCloudUrl(),
									tryRefreshToken: () => cloudClient.tryRefreshToken(),
								},
								chat: chatService,
								identity: async () => {
									const id = await DeviceIdentityService.getInstance().getOrCreateIdentity();
									return { instanceId: id.deviceId, deviceName: id.deviceName };
								},
								deliver: async (channel, message) => {
									const toDispatch = await intakeChatV2OwnerMessage(
										getTicketIntakeService(),
										channel,
										message,
										CLOUD_TALK_CONSTANTS.INTAKE_ORIGIN,
									);
									await chatDispatcher.dispatchMessage(channel, toDispatch);
								},
								agentExists: async (agentSession) =>
									buildAgentRoster(await this.storageService.getTeams()).some((a) => a.agentSession === agentSession),
							});
							talkInbound.start();
						} catch (talkErr) {
							this.logger.warn('Cloud Talk handler wiring skipped', {
								error: talkErr instanceof Error ? talkErr.message : String(talkErr),
							});
						}

						// "Let me check with the teams" (Drive kickoff): set below, once the
						// status snapshot sync exists, and read by the Drive handler at run time.
						let driveStatusCheck: { run: () => Promise<unknown> } | null = null;

						// Drive mode (specs/2026-10-08-drive-mode.md §7): Crewly Cloud hosts
						// the voice session; this machine delivers the owner's words to its
						// agents (tagged drive-mode, kept off Slack), carries their
						// `reply --drive` answers to Cloud, answers recalls and posts each
						// agent's one recap. Starting it advertises `drive_message`.
						try {
							const [
								{ DriveAgentService, setDriveAgentService },
								{ DriveConversationStore },
								{ CloudClientService },
								{ buildAgentRoster },
								{ getSlackAgentDmService },
								{ getSlackTeamChannelService },
								{ getSlackAgentIdentityService },
								{ getOwnerMessageWatchdog },
							] = await Promise.all([
								import('./services/drive/drive-agent.service.js'),
								import('./services/drive/drive-conversation.store.js'),
								import('./services/cloud/cloud-client.service.js'),
								import('./services/cloud/agent-roster.utils.js'),
								import('./services/slack/slack-agent-dm.service.js'),
								import('./services/slack/slack-team-channel.service.js'),
								import('./services/slack/slack-agent-identity.service.js'),
								import('./services/messaging/owner-message-watchdog.service.js'),
							]);
							const cloudClient = CloudClientService.getInstance();
							const owner = { userId: SLACK_AGENT_DM_CONSTANTS.OWNER_USER_ID, source: 'oss' as const };
							const botTokenOf = (session: string): string | undefined => getSlackAgentIdentityService()?.getInstalled(session)?.botToken;
							const drive = new DriveAgentService({
								source: sync,
								cloud: {
									getToken: () => cloudClient.getToken(),
									getCloudUrl: () => cloudClient.getCloudUrl(),
									tryRefreshToken: () => cloudClient.tryRefreshToken(),
								},
								identity: async () => ({ instanceId: (await DeviceIdentityService.getInstance().getOrCreateIdentity()).deviceId }),
								deliverOwnerTurn: async ({ kind, agentSession, slackChannelId, channelId, threadId, text }) => {
									// A team channel → its room; an agent or a team → the (lead's) DM.
									const room = kind === 'channel' && slackChannelId ? getSlackTeamChannelService()?.findBySlackChannelId(slackChannelId)?.chatChannelId : undefined;
									const chId = channelId ?? room ?? chatService.ensureDmChannel({ agentSession, principal: owner }).channel.id;
									const { message } = chatService.recordTurn({
										channelId: chId,
										senderType: 'user',
										senderId: owner.userId,
										content: text,
										...(threadId ? { threadId } : {}),
										clientMessageId: `drive-${randomUUID()}`,
										metadata: { source: 'cloud-talk', inputMode: 'voice', via: DRIVE_CONSTANTS.VIA },
									});
									await chatDispatcher.dispatchMessage(chatService.getChannel(chId, owner), message);
									// A room conversation is one thread, rooted at its first turn.
									const root = chatService.getChannel(chId, owner).type === 'dm' ? undefined : (threadId ?? message.id);
									return { channelId: chId, ...(root ? { threadId: root } : {}) };
								},
								recordAgentTurn: async ({ agentSession, channelId, threadId, text, interim, sessionId }) => {
									chatService.recordTurn({
										channelId,
										senderType: 'agent',
										senderId: agentSession,
										content: text,
										...(threadId ? { threadId } : {}),
										metadata: { source: 'reply-tool', via: DRIVE_CONSTANTS.VIA, driveSessionId: sessionId, ...(interim ? { interim: true } : {}) },
									});
								},
								notifyAgent: async (session, text) => {
									let exists = false;
									try {
										exists = getSessionBackendSync()?.sessionExists(session) ?? false;
									} catch {
										exists = false;
									}
									if (!exists) {
										const { activateAgentBySession } = await import('./controllers/team/team.controller.js');
										await activateAgentBySession(this.apiController, session).catch(() => undefined);
									}
									return (await this.apiController.agentRegistrationService.sendMessageToAgent(session, text)).success;
								},
								postRecap: async ({ conversation, agentSession, text, nextStep }) => {
									// Recorded where the conversation belongs (top level), then posted to its Slack place.
									chatService.recordTurn({
										channelId: conversation.channelId,
										senderType: 'agent',
										senderId: agentSession,
										content: text,
										metadata: { source: 'reply-tool', via: DRIVE_CONSTANTS.VIA, driveSessionId: conversation.sessionId, driveRecap: true, driveNextStep: nextStep },
									});
									const slack = getSlackService();
									if (!slack.isConnected()) return { where: 'crewly-chat' };
									const dm = getSlackAgentDmService()?.findByChatChannelId(conversation.channelId);
									const room = dm ? null : getSlackTeamChannelService()?.findByChatChannelId(conversation.channelId);
									const slackChannelId = dm?.slackChannelId ?? room?.slackChannelId;
									if (!slackChannelId) return { where: 'crewly-chat' };
									const token = botTokenOf(agentSession);
									// The agent's DM belongs to its own bot (the workspace bot cannot post there).
									if (dm && !token) return { where: 'crewly-chat' };
									await slack.sendMessage({ channelId: slackChannelId, text, skipChatV2Mirror: true, ...(token ? { botToken: token } : {}) });
									return { where: dm ? 'slack-dm' : 'slack-channel' };
								},
								ownerFeed: async (sinceMs) => {
									const feed = chatService.getOwnerFeed({ sinceMs, limit: DRIVE_CONSTANTS.RECALL_SCAN_LIMIT });
									return { messages: feed.messages, ownerTurns: feed.ownerTurns };
								},
								closeTracking: (agentSession, channelId) => {
									getOwnerMessageWatchdog()?.closeByAgent(agentSession, { chatChannelId: channelId });
								},
								agentExists: async (agentSession) =>
									buildAgentRoster(await this.storageService.getTeams()).some((a) => a.agentSession === agentSession),
								store: new DriveConversationStore(),
								refreshStatus: async () => {
									await driveStatusCheck?.run();
								},
								// Keep-warm (specs/2026-10-09-drive-mode-v3.md §5): an agent the owner
								// names is started now if stopped; while warm its start goes ahead of
								// ordinary starts and nothing stops it for being idle.
								prestart: async (session) => {
									let exists = false;
									try {
										exists = getSessionBackendSync()?.sessionExists(session) ?? false;
									} catch {
										exists = false;
									}
									if (exists) return;
									const { activateAgentBySession } = await import('./controllers/team/team.controller.js');
									await activateAgentBySession(this.apiController, session).catch(() => undefined);
								},
							});
							drive.start();
							setDriveAgentService(drive);
							// A plain `reply` in a Drive mode conversation still reaches the phone.
							chatService.on('chat_message', (dto: import('./services/chat-v2/types.js').ChatMessageDTO) => {
								void drive.noteChatTurn(dto);
							});
						} catch (driveErr) {
							this.logger.warn('Drive mode (machine side) wiring skipped', {
								error: driveErr instanceof Error ? driveErr.message : String(driveErr),
							});
						}

						// Drive mode v3 status briefing (specs/2026-10-09-drive-mode-v3.md §1):
						// a compact per-team / per-agent snapshot rebuilt from tickets, work
						// items, live owner items and the agents' messages to the owner on
						// every change (debounced, no LLM call) and pushed to Cloud, so the
						// voice answers status questions with no agent round trip.
						try {
							const [
								{ DriveBriefingSyncService },
								{ buildBriefingSnapshot },
								{ collectSnapshotSources, SnapshotSourceCache },
								{ getBriefingService },
								{ ProjectTicketService },
								{ CloudClientService },
							] = await Promise.all([
								import('./services/drive/drive-briefing-sync.service.js'),
								import('./services/drive/drive-briefing-snapshot.js'),
								import('./services/drive/drive-briefing.wiring.js'),
								import('./services/briefing/briefing.service.js'),
								import('./services/project-tickets/project-ticket.service.js'),
								import('./services/cloud/cloud-client.service.js'),
							]);
							const cloudClient = CloudClientService.getInstance();
							// Tickets / pool are re-read only after a change event (or a TTL), not every rebuild.
							const sourceCache = new SnapshotSourceCache();
							const cachedReads = sourceCache.wrap({
								listTickets: async (projectPath) => (await ProjectTicketService.getInstance().list(projectPath)).tickets,
								listWorkItems: () => TaskPoolService.getInstance().getAllItems(),
							});
							const briefingSync = new DriveBriefingSyncService({
								build: async () =>
									buildBriefingSnapshot(
										await collectSnapshotSources({
											getTeams: () => this.storageService.getTeams(),
											getProjects: () => this.storageService.getProjects(),
											...cachedReads,
											waiting: async () => (await getBriefingService()?.queue())?.items ?? [],
											ownerFeed: (sinceMs, limit) => chatService.getOwnerFeed({ sinceMs, limit }),
											orchestratorRunning: () => getSessionBackendSync()?.sessionExists(ORCHESTRATOR_SESSION_NAME) ?? false,
											orchestratorName: CLOUD_TALK_CONSTANTS.ORCHESTRATOR_DISPLAY_NAME,
										}),
									),
								cloud: {
									getToken: () => cloudClient.getToken(),
									getCloudUrl: () => cloudClient.getCloudUrl(),
									tryRefreshToken: () => cloudClient.tryRefreshToken(),
								},
								identity: async () => ({ instanceId: (await DeviceIdentityService.getInstance().getOrCreateIdentity()).deviceId }),
								sources: [
									// A ticket changed status / labels.
									(listener) =>
										ProjectTicketService.getInstance().onChange((change) => {
											sourceCache.invalidateTickets(change.projectPath);
											listener();
										}),
									// A work item moved, a card was created or settled (event bus).
									(listener) => {
										const onEvent = (): void => {
											sourceCache.invalidatePool();
											listener();
										};
										this.eventBusService.on('event_published', onEvent);
										return () => this.eventBusService.off('event_published', onEvent);
									},
									// An agent wrote to the owner, or the owner answered.
									(listener) => {
										const onMessage = (dto: import('./services/chat-v2/types.js').ChatMessageDTO): void => {
											if (dto.senderType === 'agent' || dto.senderType === 'user') listener();
										};
										chatService.on('chat_message', onMessage);
										return () => chatService.off('chat_message', onMessage);
									},
								],
							});
							briefingSync.start();
							// Drive opened: ask the agents holding the owner's open items to
							// bring them up to date, then rebuild and upload (no caches).
							{
								const { DriveStatusCheck } = await import('./services/drive/drive-status-check.js');
								const checkAgents = this.apiController.agentRegistrationService;
								driveStatusCheck = new DriveStatusCheck({
									targets: async () => (await getBriefingService()?.statusCheckTargets()) ?? [],
									isRunning: (session) => {
										try {
											return getSessionBackendSync()?.sessionExists(session) ?? false;
										} catch {
											return false;
										}
									},
									nudge: async (session, text) => (await checkAgents.sendMessageToAgent(session, text)).success,
									rebuild: async () => {
										sourceCache.invalidatePool();
										sourceCache.invalidateTickets();
										await briefingSync.syncNow(true);
									},
								});
							}
						} catch (briefingSyncErr) {
							this.logger.warn('Drive mode status briefing wiring skipped', {
								error: briefingSyncErr instanceof Error ? briefingSyncErr.message : String(briefingSyncErr),
							});
						}

						// "Waiting on you" (specs/unified-conversations-cloud-store.md §F):
						// the owner's accept / send-back from the portal arrives as a
						// `waiting_action` push; the handler fetches it with this
						// machine's token and runs it through the ticket review.
						// Starting it is what advertises `waiting_actions` to Cloud.
						try {
							const [
								{ WaitingActionsInboundService },
								{ CloudClientService },
								{ getWaitingItemsSyncService },
							] = await Promise.all([
								import('./services/cloud/waiting-actions-inbound.service.js'),
								import('./services/cloud/cloud-client.service.js'),
								import('./services/cloud/waiting-items-sync.service.js'),
							]);
							const cloudClient = CloudClientService.getInstance();
							new WaitingActionsInboundService({
								source: sync,
								cloud: {
									getToken: () => cloudClient.getToken(),
									getCloudUrl: () => cloudClient.getCloudUrl(),
									tryRefreshToken: () => cloudClient.tryRefreshToken(),
								},
								review: () => getTicketReviewService(),
								identity: async () => {
									const id = await DeviceIdentityService.getInstance().getOrCreateIdentity();
									return { instanceId: id.deviceId, deviceName: id.deviceName };
								},
								requestResync: () => getWaitingItemsSyncService()?.requestSync(),
							}).start();
						} catch (waitingErr) {
							this.logger.warn('"Waiting on you" action handler wiring skipped', {
								error: waitingErr instanceof Error ? waitingErr.message : String(waitingErr),
							});
						}

						// Mobile app: generic allowlisted REST passthrough over the same
						// relay (api_request → local HTTP → api_response). Non-fatal.
						try {
							const { MobileApiRelayService } = await import(
								'./services/cloud/mobile-api-relay.service.js'
							);
							const mobileRelay = new MobileApiRelayService({
								cloudSync: sync,
								webPort: this.config.webPort,
							});
							mobileRelay.start();
						} catch (mobileErr) {
							this.logger.warn('MobileApiRelayService wiring skipped', {
								error: mobileErr instanceof Error ? mobileErr.message : String(mobileErr),
							});
						}
					}
				} catch (err) {
					// Adapter wiring failure is non-fatal — local OSS UI still works.
					this.logger.warn('ChatV2RelayAdapter wiring skipped', {
						error: err instanceof Error ? err.message : String(err),
					});
				}

				// Onboarding v3 (B1) — wire the cold-start detector with the
				// chat-v2 service we just stood up. The orc bootstrap path
				// (CrewlyAgentExternalRuntimeService.detectOnboardingMode) probes this
				// singleton; null means "skip the cold-start probe", so this
				// wiring is what flips onboarding mode on for the demo path.
				try {
					const { OnboardingBootstrapService, setOnboardingBootstrapService } =
						await import('./services/orchestrator/onboarding-bootstrap.service.js');
					setOnboardingBootstrapService(
						new OnboardingBootstrapService({
							storage: this.storageService,
							chat: { countAllMessages: () => chatService.countAllMessages() },
						}),
					);
					this.logger.info('OnboardingBootstrapService wired with storage + chat probes');
				} catch (wireErr) {
					this.logger.warn('Failed to wire OnboardingBootstrapService (non-critical)', {
						error: wireErr instanceof Error ? wireErr.message : String(wireErr),
					});
				}
			} catch (error) {
				// F-CYCLE7-1: a native-binding failure (e.g. better-sqlite3 built
				// for the wrong arch) MUST crash the boot rather than be downgraded
				// to a JSON-file fallback. The audit on 2026-05-07 caught this
				// exact path: chat.db went stale at 11:17Z because dlopen errors
				// were swallowed here as "non-critical", so operators had no signal
				// to run `npm rebuild better-sqlite3 --build-from-source`.
				//
				// `isNativeBindingFatalError` matches structurally (not just via
				// instanceof) so realm-boundary cases — same module loaded via
				// two require paths — still trip the rethrow.
				if (isNativeBindingFatalError(error)) {
					this.logger.error(
						'FATAL native binding failed at chat-v2 boot — refusing to downgrade to JSON fallback. Run the printed remediation and restart.',
						{ error: error.message },
					);
					throw error;
				}
				this.logger.warn('Failed to start chat-v2 WS gateway (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Connect BrowserProxyService to Cloud Relay (lazy — does not block startup)
			try {
				const { BrowserProxyService } = await import('./services/browser/browser-proxy.service.js');
				const { CloudClientService } = await import('./services/cloud/cloud-client.service.js');
				const cloudClient = CloudClientService.getInstance();
				const browserProxy = BrowserProxyService.getInstance();

				// Wire up token resolver so reconnects always use the freshest JWT
				// Reconnects must use the freshest RELAY token (NOT the access token,
				// per the RELAY-TOKEN-TYPE invariant). The relay only accepts a relay-
				// signed access JWT; the access token churns the socket.
				browserProxy.setTokenResolver(() => cloudClient.getRelayToken());

				// Subscribe to RELAY-token refresh events (distinct channel from the
				// access-token refresh) so the proxy re-registers in place with the
				// fresh relay token before its exp.
				cloudClient.onRelayTokenRefresh((newRelayToken: string) => {
					browserProxy.updateToken(newRelayToken);
				});

				const relayToken = cloudClient.getRelayToken();
				if (relayToken) {
					browserProxy.connect(relayToken);
					this.logger.info('BrowserProxyService connecting to Cloud Relay');
				} else {
					// No relay token yet (connectLocal mints it asynchronously). Defer
				// connect to the onRelayTokenRefresh callback above rather than
				// connecting with the wrong (access) token.
				this.logger.debug('BrowserProxyService deferred — no relay token yet, will connect on relay-token refresh');
				}
			} catch (error) {
				this.logger.warn('Failed to initialize BrowserProxyService (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Start team activity WebSocket service
			this.logger.info('Starting team activity WebSocket service...');
			this.teamActivityWebSocketService.start();

			// Start teams.json file watcher for real-time updates
			this.logger.info('Starting teams.json file watcher...');
			this.teamsJsonWatcherService.start();
			this.logger.info('Teams.json file watcher started for real-time updates');

			// Generate orchestrator skills catalog
			try {
				const skillCatalogProjectRoot = findPackageRoot(__dirname);
				const catalogService = SkillCatalogService.getInstance(skillCatalogProjectRoot);
				const catalogResult = await catalogService.generateCatalog();
				this.logger.info('Orchestrator skills catalog generated', {
					catalogPath: catalogResult.catalogPath,
					skillCount: catalogResult.skillCount,
				});

				const agentCatalogResult = await catalogService.generateAgentCatalog();
				this.logger.info('Agent skills catalog generated', {
					catalogPath: agentCatalogResult.catalogPath,
					skillCount: agentCatalogResult.skillCount,
				});
			} catch (error) {
				this.logger.warn('Failed to generate skills catalog (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Restore persisted message queue state (pending messages survive restarts)
			this.logger.info('Loading persisted message queue state...');
			try {
				await this.messageQueueService.loadPersistedState();
				const queueStatus = this.messageQueueService.getStatus();
				if (queueStatus.pendingCount > 0) {
					this.logger.info('Restored pending messages from previous session', {
						pendingCount: queueStatus.pendingCount,
					});
				}
			} catch (error) {
				this.logger.warn('Failed to load persisted queue state', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Load thread status queue from disk so replay can check terminal statuses
			try {
				await this.threadStatusQueueService.loadPersistedState();
			} catch (err) {
				this.logger.warn('Failed to load thread status queue state (non-critical)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}

			// Backfill: mark Slack threads for done Requests as terminal so the
			// resume notification won't re-send already-answered conversations.
			try {
				const { RequestService } = await import('./services/v3/request.service.js');
				const { extractSlackChannelId, extractSlackThreadTs } = await import('./services/v3/request-sla.subscriber.js');
				const reqSvc = RequestService.getInstance();
				const allReqs = await reqSvc.listAll();
				let backfilled = 0;
				for (const req of allReqs) {
					if (req.status !== 'done') continue;
					const scid = req.sourceConversationItemId || '';
					// `extractSlack*` strips the optional `-msg-{ts}` thread-reply
					// suffix before parsing, so both top-level and in-thread
					// Requests resolve to the canonical `{channelId}:{threadRoot}`.
					// Previously a local regex was used here and its greedy `.+`
					// swallowed the suffix, producing a malformed threadKey that
					// missed the dedup check and bloated the persistence file.
					const channelId = extractSlackChannelId(scid);
					const threadTs = extractSlackThreadTs(scid);
					if (!channelId || !threadTs) continue;
					const threadKey = `${channelId}:${threadTs}`;
					if (this.threadStatusQueueService.get(threadKey)) continue;
					this.threadStatusQueueService.trackInbound({
						threadKey,
						conversationId: scid,
						source: 'slack',
						messagePreview: req.title.slice(0, 200),
					});
					this.threadStatusQueueService.markReplied(threadKey, 'replied_completed');
					backfilled++;
				}
				if (backfilled > 0) {
					this.logger.info('Backfilled thread status for done Requests', { count: backfilled });
				}
			} catch (err) {
				this.logger.warn('Thread status backfill failed (non-critical)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}

			// #247: Replay pending messages that arrived while the orchestrator was offline.
			// This must happen after loadPersistedState() (so we know what's already queued)
			// but before the queue processor starts (so replayed messages are ready for delivery).
			try {
				const { MessageReplayService } = await import('./services/messaging/message-replay.service.js');
				const replayService = new MessageReplayService(
					this.messageQueueService,
					this.config.crewlyHome,
				);
				const replayResult = await replayService.replayPendingMessages();
				// Stash for the boot announcement (surfaced after the orchestrator starts).
				this.lastOfflineReplay = {
					offlineDurationMs: replayResult.offlineDurationMs,
					replayedCount: replayResult.replayedCount,
				};
				if (replayResult.replayedCount > 0) {
					this.logger.info('Replayed pending messages from offline period (#247)', {
						replayed: replayResult.replayedCount,
						found: replayResult.foundCount,
						skipped: replayResult.skippedDuplicate,
						offlineSince: replayResult.offlineSince,
						offlineDurationMs: replayResult.offlineDurationMs,
					});
				}
			} catch (replayErr) {
				this.logger.warn('Failed to replay pending messages (non-critical)', {
					error: replayErr instanceof Error ? replayErr.message : String(replayErr),
				});
			}

			// Start message queue processor
			this.logger.info('Starting message queue processor...');
			this.queueProcessorService.start();

			// A first task typed in `crewly onboard` while the backend was down
			// (onboarding Phase 3) goes to the orchestrator now; the queue holds
			// it until the orchestrator is up.
			void (async () => {
				try {
					const { getOnboardingChecklistService } = await import('./services/onboarding/onboarding-checklist.factory.js');
					const delivered = await getOnboardingChecklistService().deliverPendingFirstTask();
					if (delivered) {
						this.logger.info('Delivered the pending first task from setup', { forwarded: delivered.forwarded, teamId: delivered.teamId });
					}
				} catch (firstTaskErr) {
					this.logger.warn('Failed to deliver the pending first task (non-critical)', {
						error: firstTaskErr instanceof Error ? firstTaskErr.message : String(firstTaskErr),
					});
				}
			})();

			// Solution bundles: deliver first-week tasks when they are due and
			// finish deployments that waited for the backend or for Slack
			// (a `crewly deploy-bundle` run while Crewly was stopped).
			void (async () => {
				try {
					const { startBundleMaintenance } = await import('./services/bundle/bundle-apply.factory.js');
					startBundleMaintenance();
				} catch (bundleErr) {
					this.logger.warn('Failed to start bundle maintenance (non-critical)', {
						error: bundleErr instanceof Error ? bundleErr.message : String(bundleErr),
					});
				}
			})();

			// Thread Status Queue: load persisted state and recover pending threads
			try {
				const recoveryResult = await this.threadStatusQueueService.recoverPendingThreads(
					this.messageQueueService,
					{
						agentStatusChecker: {
							getAgentWorkingStatus: async (sessionName: string) => {
								const status = await this.activityMonitorService.getWorkingStatusForSession(sessionName);
								if (status === null) return 'unknown';
								return status;
							},
						},
					}
				);
				if (recoveryResult.reEnqueued > 0 || recoveryResult.followUpRestored > 0 || recoveryResult.delegationsCompleted > 0) {
					this.logger.info('Thread status queue recovery complete', recoveryResult);
				}
				if (recoveryResult.expired > 0 || recoveryResult.cleaned > 0) {
					this.logger.info('Thread status queue maintenance', {
						expired: recoveryResult.expired,
						cleaned: recoveryResult.cleaned,
					});
				}
			} catch (err) {
				this.logger.warn('Thread status queue recovery failed (non-critical)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}

			// #286/#678: Cron fires ENQUEUE a WorkItem into the task pool instead
			// of writing straight to the agent's terminal. The pool's wake-mesh
			// (WorkItemDispatchSubscriber push + AgentAutoClaim pull + reconciler
			// self-heal) then assigns + delivers it — so a cron firing for an
			// OFFLINE agent becomes a durable queued item that gets woken, instead
			// of being silently dropped (#678). No agent-status/auto-start callbacks
			// are wired: the cron now ALWAYS enqueues regardless of liveness, and
			// the pool owns online/offline delivery + recovery.
			try {
				const cronTaskService = CronTaskService.getInstance();
				const { TaskPoolService } = await import('./services/task-pool/task-pool.service.js');
				const { createWorkItem } = await import('./types/v2/work-item.types.js');

				cronTaskService.setExecutionCallback(async (task) => {
					// Deterministic id per fire slot: re-evaluating the same due slot
					// is a no-op (addToPool dedups by id), but each scheduled
					// occurrence is a fresh WorkItem. `task.nextRunAt` is still the
					// firing slot here — the service advances it AFTER this returns.
					const slot = task.nextRunAt ?? new Date().toISOString();
					const workItem = createWorkItem({
						id: `cron-${task.id}-${slot}`,
						type: 'cron_run',
						owner: 'orchestrator',
						target: task.targetAgent,
						title: `Cron: ${task.taskDescription.slice(0, 80)}`,
						description: task.taskDescription,
						metadata: {
							source: 'cron',
							cronTaskId: task.id,
							targetTeamId: task.targetTeamId,
							firedSlot: slot,
							[WORK_ITEM_DESTINATION_CONSTANTS.METADATA_KEY]: buildTriggerOrigin({
								cronTaskId: task.id,
								teamId: task.targetTeamId,
								topic: task.taskDescription,
							}),
						},
					});
					await TaskPoolService.getInstance().addToPool(workItem);
					this.logger.info('Cron task enqueued as WorkItem', {
						id: task.id,
						workItemId: workItem.id,
						target: task.targetAgent,
					});
				});
				// Self-heal stale nextRunAt values from pre-timezone-fix versions.
				// Never let it stop the loop: one bad cron file would otherwise
				// keep every team's schedule from firing until a restart.
				try {
					await cronTaskService.recalculateAllNextRunTimes();
				} catch (recalcErr) {
					this.logger.error('Cron nextRunAt recalculation failed; starting the scheduler anyway', {
						error: recalcErr instanceof Error ? recalcErr.message : String(recalcErr),
					});
				}
				cronTaskService.start();
				this.logger.info('CronTaskService started (cron fires → task pool WorkItems)');
			} catch (cronErr) {
				this.logger.warn('CronTaskService initialization failed (non-critical)', {
					error: cronErr instanceof Error ? cronErr.message : String(cronErr),
				});
			}

			// Owner-configured host commands (e.g. the crewly-web release script).
			// Reads ~/.crewly/scheduled-commands.json only; no file = off.
			try {
				const { ScheduledCommandsService } = await import('./services/system/scheduled-commands.service.js');
				const { SCHEDULED_COMMANDS } = await import('./constants.js');
				const home = getCrewlyHomePath();
				this.scheduledCommands = new ScheduledCommandsService({
					configPath: path.join(home, SCHEDULED_COMMANDS.CONFIG_FILE),
					logDir: path.join(home, SCHEDULED_COMMANDS.LOG_DIR),
					logger: LoggerService.getInstance().createComponentLogger('ScheduledCommands'),
				});
				this.scheduledCommands.start();
			} catch (schedErr) {
				this.logger.warn('ScheduledCommandsService initialization failed (non-critical)', {
					error: schedErr instanceof Error ? schedErr.message : String(schedErr),
				});
			}

			// Start TriggerEngine (V3 unified trigger system) and wire action handler
			try {
				const { TriggerEngine } = await import('./services/v3/trigger-engine.service.js');
				const { TaskProjectionService } = await import('./services/v3/task-projection.service.js');
				const triggerEngine = TriggerEngine.getInstance();
				const taskProjection = TaskProjectionService.getInstance();

				// Load TaskProjection state from disk
				await taskProjection.load();

				// Wire EventBus so signal triggers can subscribe to events
				triggerEngine.setEventBus(this.eventBusService);

				// Wire action handler — executes the effect when a trigger fires
				triggerEngine.setActionHandler(async (trigger, action) => {
					const triggerId = trigger.id;
					const logger = this.logger;
					// What this fire did, shown to the owner as the trigger's last result.
					let outcome: import('./types/v2/trigger.types.js').TriggerFireOutcome | undefined;

					// 1. sendMessage — enqueue a message to the orchestrator session
					if (action.sendMessage) {
						const { target, message } = action.sendMessage;
						try {
							// Format with trigger context so Agent knows why it was woken
							const formattedContent = `[SYSTEM ALERT] Trigger '${triggerId}' says: ${message}`;
							this.messageQueueService.enqueue({
								content: formattedContent,
								conversationId: target || 'system',
								source: 'system_event',
							});
							logger.info('TriggerEngine: sendMessage enqueued', { triggerId, target });
							outcome = { status: 'ok' };
						} catch (err) {
							outcome = { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
							logger.warn('TriggerEngine: sendMessage failed', {
								triggerId,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}

					// 2. createWorkItem — push a new WorkItem into the task pool
					if (action.createWorkItem) {
						try {
							const { TaskPoolService } = await import('./services/task-pool/task-pool.service.js');
							const { createWorkItem } = await import('./types/v2/work-item.types.js');
							const template = action.createWorkItem;
							// A stored target can go stale when its member is renamed (the
							// session name carries the name, the member id stays): map it to
							// the member's current session and fix the trigger, instead of
							// creating work for nobody every time it fires (2026-09-24).
							let target = template.target;
							if (target) {
								const { resolveCurrentSession } = await import('./utils/session-resolve.utils.js');
								const teams = await this.storageService.getTeams().catch(() => []);
								const resolved = resolveCurrentSession(target, teams);
								if (resolved?.renamed) {
									target = resolved.sessionName;
									await triggerEngine.retargetWorkItemAction(trigger.id, target).catch(() => false);
								}
							}
							const workItem = createWorkItem({
								title: template.title || `Triggered task (${trigger.id})`,
								description: template.description || `Auto-created by trigger ${trigger.id}`,
								type: template.type ?? 'delegate',
								owner: template.owner ?? 'orchestrator',
								target,
								triggerId,
								requestId: template.requestId,
								// Where this fire's output goes (specs/2026-10-01-decision-cards.md §6):
								// the trigger's destination, else a NEW top-level post in the
								// target's team channel — never the thread the agent was last asked in.
								metadata: {
									...(template.metadata ?? {}),
									[WORK_ITEM_DESTINATION_CONSTANTS.METADATA_KEY]: buildTriggerOrigin({
										triggerId,
										destination: trigger.destination,
										teamId: trigger.teamId,
										topic: template.title || trigger.name || 'Scheduled task',
									}),
								},
							});
							// Each fire is a full wake-up for the target. Skip it when the same
							// work is still open: an identical item from an earlier fire, or —
							// for an idle-verify watcher — the bridge's Verify item for that
							// worker (agent:idle_after_task fires on every busy→idle).
							const { findOpenDuplicateWorkItem, findCoveringVerifyItem } = await import('./utils/trigger-workitem-dedupe.utils.js');
							const poolItems = await TaskPoolService.getInstance().getAllItems().catch(() => []);
							const draft = { target: workItem.target, owner: workItem.owner, title: workItem.title };
							const duplicate = findOpenDuplicateWorkItem(poolItems, draft)
								?? findCoveringVerifyItem(poolItems, trigger, draft);
							if (duplicate) {
								outcome = { status: 'skipped', detail: 'same work still open', workItemId: duplicate.id };
								logger.debug('TriggerEngine: WorkItem skipped — same work already open', {
									triggerId,
									target: workItem.target,
									title: workItem.title,
									existingWorkItemId: duplicate.id,
								});
							} else {
								await TaskPoolService.getInstance().addToPool(workItem);

								// Project as a trigger_action TaskRecord
								await taskProjection.createRecord({
									title: workItem.title,
									type: 'trigger_action',
									ownerAgent: 'system',
									triggerId,
									workItemId: workItem.id,
								});
								logger.info('TriggerEngine: WorkItem enqueued', { triggerId, workItemId: workItem.id });
								outcome = { status: 'ok', workItemId: workItem.id };
							}
						} catch (err) {
							outcome = { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
							logger.warn('TriggerEngine: createWorkItem failed', {
								triggerId,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}

					// 3. wakeWorkItemId — re-queue a suspended/blocked WorkItem with context note
					if (action.wakeWorkItemId) {
						try {
							const { TaskPoolService } = await import('./services/task-pool/task-pool.service.js');
							const taskPool = TaskPoolService.getInstance();

							// Append system note to description so Agent knows why it was woken
							const wakeNote = `\n\n[SYSTEM NOTE] Woken automatically by Trigger '${triggerId}' at ${new Date().toISOString()}.`;
							await taskPool.updateItemStatus(action.wakeWorkItemId, 'queued', { role: 'system', via: 'trigger-wake' });
							// Append wake reason to WorkItem description via storage
							try {
								const item = (await taskPool.getAllItems()).find(wi => wi.id === action.wakeWorkItemId);
								if (item) {
									await taskPool.updateTokenUsage(action.wakeWorkItemId, item.inputTokens, item.outputTokens, item.cost);
									// We use the storage directly through the service — patch description via a minimal re-add isn't feasible,
									// so we write the note to the task projection instead:
									await taskProjection.createRecord({
										title: `[TRIGGER WAKE] ${item.title}`,
										type: 'trigger_action',
										ownerAgent: 'system',
										triggerId,
										workItemId: item.id,
										requestId: item.requestId,
									});
								}
							} catch { /* non-critical */ }

							logger.info('TriggerEngine: WorkItem woken', { triggerId, workItemId: action.wakeWorkItemId, note: wakeNote });
						} catch (err) {
							logger.warn('TriggerEngine: wakeWorkItemId failed', {
								triggerId,
								workItemId: action.wakeWorkItemId,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}

					// 4. runReconciler — trigger a targeted reconciliation cycle
					if (action.runReconciler && this.reconcilerService) {
						try {
							await this.reconcilerService.runFull();
							logger.info('TriggerEngine: Reconciler run triggered', { triggerId });
						} catch (err) {
							logger.warn('TriggerEngine: runReconciler failed', {
								triggerId,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}
					return outcome;
				});

				// Expiry heads-up: a capped recurring trigger close to its last
				// fire gets one work item to its team lead (renew or ask the
				// owner). Never renews anything itself.
				triggerEngine.setExpiryNotifier(async (trigger, _remaining, lastFireAt) => {
					const { TaskPoolService } = await import('./services/task-pool/task-pool.service.js');
					const { createWorkItem } = await import('./types/v2/work-item.types.js');
					const { buildExpiryNotice, resolveExpiryNoticeTarget } = await import('./services/v3/trigger-expiry.js');
					const teams = await this.storageService.getTeams().catch(() => []);
					const target = resolveExpiryNoticeTarget(trigger, teams);
					const notice = buildExpiryNotice(trigger, lastFireAt);
					await TaskPoolService.getInstance().addToPool(createWorkItem({
						title: notice.title,
						description: notice.description,
						type: 'delegate',
						owner: 'team_lead',
						target,
						triggerId: trigger.id,
					}));
					this.logger.info('TriggerEngine: expiry heads-up queued', { triggerId: trigger.id, target });
					return true;
				});

				await triggerEngine.start();
				this.logger.info('TriggerEngine started with action handler wired');

				// MissionPolicy escalation loop (every 5 min: cost/time/failure rules →
				// notify/pause/block). Sequenced AFTER the action handler above because
				// EscalationService.start() wraps the installed handler and delegates
				// non-escalation triggers back to it. Gated by CREWLY_ESCALATION_ENABLED
				// (default on); a no-op when no mission carries escalation rules.
				this.escalationService = await bootEscalationService({
					messageQueue: this.messageQueueService,
					logger: this.logger,
				});

				// Wire team-scoped triggers: reconcile declarative Team.triggers spec
				// against the running engine on every team save, and cancel all of a
				// team's triggers when it's deleted. Listener is fire-and-forget.
				try {
					const { TeamTriggerReconciler } = await import(
						'./services/v3/team-trigger-reconciler.service.js'
					);
					const reconciler = new TeamTriggerReconciler(triggerEngine);

					// Initial converge: reconcile every team that already exists on disk.
					const existingTeams = await this.storageService.getTeams();
					for (const team of existingTeams) {
						try {
							await reconciler.reconcile(team);
						} catch (recErr) {
							this.logger.warn('Initial team-trigger reconcile failed', {
								teamId: team.id,
								error: recErr instanceof Error ? recErr.message : String(recErr),
							});
						}
					}

					// Ongoing: subscribe to storage events.
					this.storageService.onStorageEvent(async (event) => {
						if (event.kind === 'team-saved') {
							await reconciler.reconcile(event.team);
						} else if (event.kind === 'team-deleted') {
							await reconciler.unregisterAll(event.teamId);
						}
					});

					this.logger.info('TeamTriggerReconciler subscribed to storage events', {
						initialTeams: existingTeams.length,
					});
				} catch (recErr) {
					this.logger.warn('TeamTriggerReconciler wiring failed (non-critical)', {
						error: recErr instanceof Error ? recErr.message : String(recErr),
					});
				}
			} catch (triggerErr) {
				this.logger.warn('TriggerEngine initialization failed (non-critical)', {
					error: triggerErr instanceof Error ? triggerErr.message : String(triggerErr),
				});
			}

			// Start V3DataService — listens for v3:task_delegated / v3:task_completed events
			// and links WorkItems to their parent Requests via requestService.linkWorkItem().
			// Must be initialized after EventBusService is ready.
			try {
				const { V3DataService } = await import('./services/v3/v3-data.service.js');
				new V3DataService(this.eventBusService, process.cwd());
				this.logger.info('V3DataService started — WorkItem↔Request linking active');
			} catch (v3Err) {
				this.logger.warn('V3DataService initialization failed (non-critical)', {
					error: v3Err instanceof Error ? v3Err.message : String(v3Err),
				});
			}

			// Start WorkItemDispatchSubscriber FIRST — AgentAutoClaim's recovery
			// path delegates to its dispatchTo() for the "active target session"
			// branch, so the singleton must be reachable when recovery fires.
			try {
				const { WorkItemDispatchSubscriber } = await import('./services/v3/workitem-dispatch.subscriber.js');
				const dispatchSubscriber = WorkItemDispatchSubscriber.getInstance();
				dispatchSubscriber.setTeamBudgetGate(TeamBudgetGateService.getInstance());
				dispatchSubscriber.initialize(this.eventBusService);
				dispatchSubscriber.start();
				this.logger.info('WorkItemDispatchSubscriber started — workitem:queued events push to target sessions');

				// Queued agent messages survive restarts. A dispatch notice whose
				// WorkItems have all finished since must not be replayed (#836).
				const { isStaleDispatchNotice } = await import('./services/v3/workitem-dispatch.subscriber.js');
				const agentMessageQueue = SubAgentMessageQueue.getInstance();
				agentMessageQueue.setStaleMessageCheck((data, sessionName) =>
					isStaleDispatchNotice(
						data,
						(id) => TaskPoolService.getInstance().findWorkItem(id),
						(id) => dispatchSubscriber.isDelivered(id, sessionName),
					),
				);
				// A batch reminder that waited on the queue drops the WorkItems the
				// agent finished meanwhile, so it never names completed work (CREW-266).
				const { refreshBatchDispatchNotice } = await import('./services/v3/workitem-dispatch.subscriber.js');
				agentMessageQueue.setMessageRefresher((data) =>
					refreshBatchDispatchNotice(data, (id) => TaskPoolService.getInstance().findWorkItem(id)),
				);
				// A dispatch notice delivered from the queue marks its WorkItems as
				// delivered to that agent, so a held brief for the same WorkItem is
				// dropped instead of briefing it twice (crewly#1015 follow-up).
				const { dispatchNoticeWorkItemIds } = await import('./services/v3/workitem-dispatch.subscriber.js');
				agentMessageQueue.setDeliveredListener((sessionName, data) => {
					for (const id of dispatchNoticeWorkItemIds(data) ?? []) dispatchSubscriber.noteDeliveredFromQueue(id, sessionName);
				});
				void agentMessageQueue.pruneStale().catch((pruneErr: unknown) => {
					this.logger.warn('Could not prune stale queued dispatch notices (non-critical)', {
						error: pruneErr instanceof Error ? pruneErr.message : String(pruneErr),
					});
				});
			} catch (dispatchErr) {
				this.logger.warn('WorkItemDispatchSubscriber initialization failed (non-critical)', {
					error: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
				});
			}

			// A message to a team member whose session is down is queued and starts
			// the agent, instead of failing with 404 (#929).
			try {
				const { setOfflineAgentWaker } = await import('./services/messaging/offline-agent-message.js');
				const { activateAgentBySession } = await import('./controllers/team/team.controller.js');
				setOfflineAgentWaker((sessionName) => activateAgentBySession(this.apiController, sessionName));
			} catch (wakerErr) {
				this.logger.warn('Offline-agent message waker not wired (non-critical)', {
					error: wakerErr instanceof Error ? wakerErr.message : String(wakerErr),
				});
			}

			// Idle-boundary context cap for Claude Code members: a long single
			// task keeps growing its conversation (sessions at 650k–965k per
			// turn); between turns, save + clear + re-orient it past the cap
			// (CREWLY_MEMBER_CONTEXT_CAP_TOKENS, default 300k, 0 disables).
			try {
				const { FreshTaskConversationService } = await import('./services/agent/fresh-task-conversation.service.js');
				FreshTaskConversationService.getInstance().startContextCapSweep();
			} catch (capErr) {
				this.logger.warn('Member context-cap sweep failed to start (non-critical)', {
					error: capErr instanceof Error ? capErr.message : String(capErr),
				});
			}

			// Bootstrap SOPService at boot (F8 — fix/f8-get-sops-graceful-fallback).
			// This materialises `~/.crewly/sops/{system,custom}/` and seeds the
			// `index.json` so the get-sops skill — which sits on every agent's
			// session-startup hot path — never hits a missing-file 500.
			// SOPService.initialize is internally idempotent and the service has
			// graceful in-memory fallbacks, so this is non-critical: failures here
			// will be tolerated by the API layer at request time.
			try {
				const { SOPService } = await import('./services/sop/sop.service.js');
				await SOPService.getInstance().initialize();
				this.logger.info('SOPService bootstrapped — get-sops endpoint ready');
			} catch (sopErr) {
				this.logger.warn('SOPService bootstrap failed (non-critical, runtime fallback active)', {
					error: sopErr instanceof Error ? sopErr.message : String(sopErr),
				});
			}

			// Start AgentAutoClaimService — auto-assign work to idle agents
			try {
				const { AgentAutoClaimService } = await import('./services/v3/agent-auto-claim.service.js');
				const autoClaimService = AgentAutoClaimService.getInstance();
				autoClaimService.initialize(this.eventBusService);
				await autoClaimService.start();
				this.logger.info('AgentAutoClaimService started — idle agents will auto-claim work');

				// Project tickets (specs/2026-09-28-project-tickets.md): wire the
				// workflow singleton (claim / assign / AutoClaim fallback) and keep
				// tickets in step with their WorkItems — pool events plus a sweep.
				const { projectTicketWorkflow } = await import('./controllers/project-tickets/project-tickets.controller.js');
				projectTicketWorkflow().start(this.eventBusService);
				this.logger.info('Project ticket workflow started — tickets follow their WorkItems');

				// Ticket hygiene: an hourly sweep closes tickets whose work is done and
				// flags orphaned ones (no agent woken), and once a day each team lead
				// gets ONE batched WorkItem of its stale tickets. Kill switch:
				// CREWLY_TICKET_HYGIENE=0.
				if (process.env[TICKET_HYGIENE_CONSTANTS.ENV_SWITCH] !== '0') {
					const { createDefaultTicketHygiene } = await import('./controllers/project-tickets/project-tickets.controller.js');
					const { TicketHygieneService } = await import('./services/project-tickets/ticket-hygiene.service.js');
					TicketHygieneService.getInstance()?.stop();
					const hygiene = createDefaultTicketHygiene();
					TicketHygieneService.setInstance(hygiene);
					hygiene.start();
					this.logger.info('Ticket hygiene started (hourly sweep, daily lead review)');
				}

				// Ticket autopilot (specs/2026-09-30-ticket-autopilot.md): per-project
				// switch, default off. Wakes a project's lead to triage its backlog and
				// sends the owner batched questions + an evening digest through the
				// usual Slack owner-notification path. Kill switch: CREWLY_TICKET_AUTOPILOT=0.
				if (process.env[TICKET_AUTOPILOT_CONSTANTS.ENV_SWITCH] !== '0') {
					const { createDefaultTicketAutopilot } = await import('./controllers/project-tickets/project-tickets.controller.js');
					const { TicketAutopilotService } = await import('./services/project-tickets/ticket-autopilot.service.js');
					const autopilot = createDefaultTicketAutopilot(async ({ title, message, urgent }) => {
						const slack = getSlackService();
						if (!slack.isConnected()) return false;
						// Only a delivered notice counts: sendNotification resolves
						// false when there was no channel to send it to.
						return slack.sendNotification({
							type: 'project_update',
							title,
							message,
							urgency: urgent ? 'high' : 'normal',
							timestamp: new Date().toISOString(),
						});
					});
					TicketAutopilotService.getInstance()?.stop();
					TicketAutopilotService.setInstance(autopilot);
					// Budgets are tokens now (specs/2026-10-02-spend-cap.md): convert
					// any pre-token USD budget once, logged per project.
					await autopilot.migrateUsdBudgets().catch((err) =>
						this.logger.warn('Ticket autopilot USD→token budget migration failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) }),
					);
					autopilot.start();
					this.logger.info('Ticket autopilot started (acts only on projects that switched it on)');
					// The owner's "set <project> to rush|normal|chill" DM command
					// (specs/2026-10-04-autopilot-speed-modes.md §5).
					try {
						const { startAutopilotSpeedCommands } = await import('./services/project-tickets/autopilot-speed.wiring.js');
						const { ticketAutopilot } = await import('./controllers/project-tickets/project-tickets.controller.js');
						await startAutopilotSpeedCommands({
							getProjects: () => this.storageService.getProjects(),
							autopilot: () => ticketAutopilot(),
							logger: LoggerService.getInstance().createComponentLogger('AutopilotSpeed'),
						});
					} catch (error) {
						this.logger.warn('Failed to wire the autopilot speed commands (non-critical)', {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				} else {
					this.logger.info('Ticket autopilot off (CREWLY_TICKET_AUTOPILOT=0)');
				}
				// The one owner card per retro that approves its harness-gap tickets
				// (specs/2026-10-03-autopilot-experiments.md §4). Registered even with
				// the autopilot switched off, so a card answered later still lands.
				{
					const { DecisionService: RetroDecisions } = await import('./services/decisions/decision.service.js');
					const { ticketAutopilot } = await import('./controllers/project-tickets/project-tickets.controller.js');
					RetroDecisions.registerKindHandler(TICKET_AUTOPILOT_CONSTANTS.RETRO_DECISION_KIND, {
						onSettled: (d) => ticketAutopilot().onRetroDecision(d),
					});
				}

				// Experiment cards (specs/experiment-cards.md, issue #986): measure each
				// shipped experiment at the end of its window, label it, log it to the
				// wiki and tell the owner. Kill switch: CREWLY_EXPERIMENTS=0.
				if (process.env[EXPERIMENT_CONSTANTS.ENV_SWITCH] !== '0') try {
					const { createDefaultExperimentService } = await import('./services/experiments/experiment.wiring.js');
					const { ExperimentService } = await import('./services/experiments/experiment.service.js');
					const experiments = await createDefaultExperimentService(async ({ title, message, urgent }) => {
						const slack = getSlackService();
						if (!slack.isConnected()) return false;
						// Only a delivered notice counts: sendNotification resolves
						// false when there was no channel to send it to.
						return slack.sendNotification({
							type: 'project_update',
							title,
							message,
							urgency: urgent ? 'high' : 'normal',
							timestamp: new Date().toISOString(),
						});
					});
					experiments.setAgentNotifier(async (session, text) =>
						(await this.apiController.agentRegistrationService.sendMessageToAgent(session, text)).success,
					);
					ExperimentService.getInstance()?.stop();
					ExperimentService.setInstance(experiments);
					experiments.start();
					this.logger.info('Experiment cards started');
				} catch (experimentErr) {
					this.logger.warn('Experiment cards failed to start (non-fatal)', {
						error: experimentErr instanceof Error ? experimentErr.message : String(experimentErr),
					});
				}

				// Decision cards (specs/2026-10-01-decision-cards.md): structured owner
				// questions posted by the responsible agent's own bot, answered by
				// button / reaction / thread reply / dashboard; deadlines applied here.
				await this.startDecisionCards();
				// Crewly Apps (specs/2026-10-04-crewly-apps-p2.md): the owner's edits in
				// an app wake the agent that published it.
				await this.startCrewlyApps();
			} catch (autoClaimErr) {
				this.logger.warn('AgentAutoClaimService initialization failed (non-critical)', {
					error: autoClaimErr instanceof Error ? autoClaimErr.message : String(autoClaimErr),
				});
			}

			// Start TLAutoVerifyService — auto-trigger TL verification on worker task completion
			try {
				const { TLAutoVerifyService } = await import('./services/v3/tl-auto-verify.service.js');
				const tlVerifyService = TLAutoVerifyService.getInstance();
				tlVerifyService.initialize(this.eventBusService);
				tlVerifyService.start();
				this.logger.info('TLAutoVerifyService started — worker completions trigger TL verification');
			} catch (tlVerifyErr) {
				this.logger.warn('TLAutoVerifyService initialization failed (non-critical)', {
					error: tlVerifyErr instanceof Error ? tlVerifyErr.message : String(tlVerifyErr),
				});
			}

			// Initialize MissionExecutorService — Mission lifecycle + decomposition processing
			try {
				const { MissionExecutorService } = await import('./services/v3/mission-executor.service.js');
				MissionExecutorService.getInstance();
				this.logger.info('MissionExecutorService initialized — Mission decomposition + progress tracking ready');
			} catch (missionErr) {
				this.logger.warn('MissionExecutorService initialization failed (non-critical)', {
					error: missionErr instanceof Error ? missionErr.message : String(missionErr),
				});
			}

			// Start marketplace auto-update (check registry every 6 hours)
			try {
				const { startAutoUpdate } = await import('./services/marketplace/marketplace-auto-update.service.js');
				startAutoUpdate();
			} catch (autoUpdateErr) {
				this.logger.warn('Marketplace auto-update startup failed (non-fatal)', {
					error: autoUpdateErr instanceof Error ? autoUpdateErr.message : String(autoUpdateErr),
				});
			}

			// Start Slack image cleanup (download temp files)
			try {
				const { getSlackImageService: getImgService } = await import('./services/slack/slack-image.service.js');
				const imgService = getImgService();
				await imgService.cleanupOnStartup();
				imgService.startCleanup();
			} catch (err) {
				this.logger.warn('Failed to initialize Slack image service', {
					error: err instanceof Error ? err.message : String(err),
				});
			}

			// Initialize Slack if configured
			await this.initializeSlackIfConfigured();

			// Initialize WhatsApp if configured
			await this.initializeWhatsAppIfConfigured();

			// Initialize Google Chat if saved credentials exist
			await this.initializeGoogleChatIfConfigured();

			// Initialize Telegram if configured
			await this.initializeTelegramIfConfigured();

			// Restore Cloud connection from persisted config (non-blocking)
			initializeCloudIfConfigured().catch((err) => {
				this.logger.warn('Cloud initialization failed (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			});

			// Start NOTIFY reconciliation service (retries failed Slack deliveries)
			this.notifyReconciliationService = new NotifyReconciliationService();
			this.notifyReconciliationService.start();

			// Start system resource alert monitoring (proactive disk/memory/CPU alerts).
			// Critical disk/memory alerts and auto-stopped agents also reach the
			// owner over Slack (#991), through the same path as the low-disk notice.
			this.systemResourceAlertService.setOwnerNotifier(slackOwnerAlertNotifier);
			this.systemResourceAlertService.startMonitoring();

			// Fire-and-forget background version check (populates cache for /health)
			VersionCheckService.getInstance().checkForUpdate().catch(() => {
				// Silently ignore — version check is non-critical
			});

			// Automatic self-update (specs/auto-update.md). Started before the
			// orchestrator auto-start so an upgrade boot is known when the
			// "back online" announcement is composed.
			this.startAutoUpdate();
			// Owner Upgrade / Restart buttons (specs/2026-10-01-upgrade-restart-controls.md)
			this.startSystemControl();

			// Tell the owner (Slack DM, phone re-login link) when this machine
			// loses Crewly Cloud — inbound Slack then queues in Cloud unseen.
			this.startCloudDisconnectNotice();

			// Upload the conversation log to Crewly Cloud (unified conversations,
			// specs/unified-conversations-cloud-store.md §B). On by default for a
			// signed-in machine; CREWLY_CONVERSATION_SYNC=0 turns it off.
			void this.startConversationCloudSync();

			// "Waiting on you" (§F): tickets in 待验收 go to Crewly Cloud as text
			// snapshots, so the portal lists them for every machine.
			void this.startWaitingItemsSync();

			// V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
			// The legacy `TaskTrackingService.startAutoSync()` is gone — V3
			// task-pool reconciler owns lifecycle cleanup now.

			// Initialize token usage tracking: load persisted data and start periodic flush
			try {
				const tokenUsageService = TokenUsageService.getInstance();
				await tokenUsageService.loadFromDisk();
				tokenUsageService.startPeriodicFlush();

				// Read Claude Code's own session transcripts on an interval so
				// the Usage dashboard reflects claude-code agents, and so the
				// context monitor gets a real context size for them (Claude
				// Code never prints one to the PTY, so its percentage-parsing
				// path can never fire for these agents).
				const { getClaudeTranscriptSync } = await import('./services/monitoring/claude-transcript-sync.service.js');
				const transcriptSync = getClaudeTranscriptSync();
				transcriptSync.onContextReading(({ sessionName, contextTokens }) => {
					const monitor = ContextWindowMonitorService.getInstance();
					const before = monitor.getContextState(sessionName)?.contextPercent;
					monitor.updateContextTokens(sessionName, contextTokens);
					const after = monitor.getContextState(sessionName);
					if (after && after.contextPercent !== before) {
						this.logger.info('Agent context size measured', {
							sessionName,
							contextTokens,
							percentOfCeiling: after.contextPercent,
							level: after.level,
						});
					}
				});
				await transcriptSync.start();

				// Codex and Antigravity usage into the same ledger
				// (specs/2026-10-02-spend-cap.md §Sources).
				await this.startRuntimeUsageSyncs(tokenUsageService);
				this.logger.info('Token usage tracking initialized');
			} catch (tokenErr) {
				this.logger.warn('Token usage initialization failed (non-fatal)', {
					error: tokenErr instanceof Error ? tokenErr.message : String(tokenErr),
				});
			}

			// Start Reconciler: run initial full reconcile and start loops
			if (this.reconcilerService) {
				try {
					this.logger.info('Running initial full reconciliation...');
					const initialResult = await this.reconcilerService.runFull();
					this.logger.info('Initial reconciliation complete', {
						durationMs: initialResult.durationMs,
						corrections: initialResult.corrections.length,
						errors: initialResult.errors.length,
					});
					this.reconcilerService.start();
					this.logger.info('Reconciler loops started (fast: 10s, full: 60s)');
				} catch (reconcilerErr) {
					this.logger.warn('Reconciler startup failed (non-fatal)', {
						error: reconcilerErr instanceof Error ? reconcilerErr.message : String(reconcilerErr),
					});
				}
			}

			// C1 — boot-time state invariant check (Persistence P0 spec).
			// Refuses to start serving traffic if the live teams directory
			// is empty but a healthy backup snapshot exists. Override via
			// CREWLY_FORCE_EMPTY_BOOT=1 for legitimate fresh-install / reset.
			try {
				await this.storageService.verifyStateInvariantOnBoot();
			} catch (invariantErr) {
				const { StateInvariantViolation } = await import('./services/core/state-invariant.types.js');
				if (invariantErr instanceof StateInvariantViolation) {
					this.logger.error(
						'Boot aborted by state invariant check — refusing to serve traffic with wiped state',
						{
							currentTeamCount: invariantErr.currentTeamCount,
							backupTeamCount: invariantErr.backupTeamCount,
							backupTimestamp: invariantErr.backupTimestamp,
							message: invariantErr.message,
						}
					);
				}
				throw invariantErr;
			}

			// Start HTTP server with enhanced error handling
			await this.startHttpServer();

			// Load addons from ~/.crewly/addons/ (Pro features, extensions, etc.)
			try {
				const addonLoader = AddonLoaderService.getInstance();
				const loadedAddons = await addonLoader.loadAddons(this.app, this.httpServer);
				if (loadedAddons.length > 0) {
					this.logger.info('Addons loaded successfully', { addons: loadedAddons });
					// An addon that attaches its own WebSocket gateway wraps
					// `httpServer.emit` after our gate did; re-install so the
					// gate is outermost again (double-wrapping is harmless —
					// an allowed upgrade passes both, a refused one is
					// answered once by the outer wrapper).
					installWebSocketGate(this.httpServer);
				}
			} catch (addonErr) {
				this.logger.warn('Addon loading encountered an error (non-fatal)', {
					error: addonErr instanceof Error ? addonErr.message : String(addonErr),
				});
			}

			// Register cleanup handlers
			this.registerSignalHandlers();

			// Start health monitoring
			this.startHealthMonitoring();

			// Reap orphaned runtime processes left by a previous, non-graceful
			// backend death (crash / OOM / force-exit) BEFORE we spawn any new
			// sessions below — otherwise stray `gemini --yolo` / `claude` runtimes
			// accumulate across restarts and inflate the process table (#715).
			// Identity-verified: only kills recorded PIDs whose live cmdline still
			// matches, so it never touches an unrelated reused PID.
			try {
				const reaped = RuntimePidRegistry.getInstance().reapOrphans();
				if (reaped > 0) {
					this.logger.warn('Reaped orphaned runtime processes at startup', { reaped });
				}
			} catch (err) {
				this.logger.warn('Orphan runtime reap failed (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}

			// Turns a previous shutdown cut off (see services/restart). Loaded
			// before restore so their agents count as having work in hand.
			this.loadInterruptedTurnsAtBoot();

			// Permanent agent ids (one-time, idempotent): before anything starts
			// a session, so every member runs under an id a rename cannot move.
			await this.storageService.ensureAgentIds().catch((agentIdErr: unknown) => {
				this.logger.warn('Assigning permanent agent ids failed (sessions keep derived names)', {
					error: agentIdErr instanceof Error ? agentIdErr.message : String(agentIdErr),
				});
			});

			// Auto-start orchestrator if enabled in settings
			await this.autoStartOrchestratorIfEnabled();

			// Work age for the recovery below is measured at boot, not after the
			// restore: restoring a dozen agents on a loaded machine takes 30–50
			// minutes, and measuring afterwards dropped work that was minutes old
			// when the backend went down (CE-128 / CE-132, 2026-10-05).
			const recoveryReferenceMs = Date.now();

			// #166/#196: in-progress WorkItems to re-send after the restart (not
			// older than 1 hour at boot). Each restored agent gets its own recovery
			// messages right after it registers; agents outside the restore queue
			// (already live, or not restored) get theirs now.
			this.recoveryBySession = await this.collectRecoverableTasks(recoveryReferenceMs);

			// Auto-restore agent sessions that were running before the last shutdown.
			// Starts the staggered restore queue; it drains in the background.
			await this.autoRestoreAgentSessionsIfEnabled();

			// Re-deliver interrupted turns now that their agents are coming back.
			// Background: the orchestrator may take minutes to register.
			void this.resumeInterruptedTurnsAfterBoot();

			const queued = new Set(getRestoreQueue().stats().order);
			for (const session of [...this.recoveryBySession.keys()]) {
				if (!queued.has(session)) await this.sendRecoveryFor(session);
			}

			// Start log rotation service (non-critical — logs cleanup)
			try {
				const logRotation = LogRotationService.getInstance();
				const backend = getSessionBackendSync();
				const activeNames = backend ? backend.listSessions() : [];
				await logRotation.start(activeNames);
				this.logger.info('LogRotationService started');
			} catch (error) {
				this.logger.warn('Failed to start LogRotationService (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Disk janitor (non-critical): removes finished worktrees (merged +
			// clean + idle + nobody inside), stale Claude Code scratch dirs, and
			// watches free disk space — low-disk notices go to the owner through
			// the usual Slack owner-notification path. Kill switch:
			// CREWLY_WORKTREE_JANITOR=0.
			try {
				WorktreeJanitorService.getInstance().setLowDiskNotifier(slackOwnerAlertNotifier);
				if (WorktreeJanitorService.getInstance().start()) {
					this.logger.info('WorktreeJanitorService scheduled');
				} else {
					this.logger.info('WorktreeJanitorService disabled (CREWLY_WORKTREE_JANITOR)');
				}
			} catch (error) {
				this.logger.warn('Failed to start WorktreeJanitorService (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Start AuditorSchedulerService (non-critical — audit scheduling)
			// Priority: env var > settings.json > ENABLED_BY_DEFAULT constant
			const envValue = process.env[AUDITOR_CONSTANTS.ENV_VAR]?.toLowerCase();
			let auditorEnabled: boolean;
			if (envValue !== undefined) {
				// Env var explicitly set — use it
				auditorEnabled = envValue === 'true';
			} else {
				// Check persisted settings (settings.json)
				try {
					const settingsForAuditor = await getSettingsService().getSettings();
					auditorEnabled = settingsForAuditor.general.enableAuditor ?? AUDITOR_CONSTANTS.ENABLED_BY_DEFAULT;
				} catch {
					auditorEnabled = AUDITOR_CONSTANTS.ENABLED_BY_DEFAULT;
				}
			}
			if (auditorEnabled) {
				try {
					const auditorScheduler = AuditorSchedulerService.getInstance();
					auditorScheduler.setAgentRegistrationService(this.apiController.agentRegistrationService);
					auditorScheduler.setEventBusService(this.eventBusService);
					setAuditorSchedulerService(auditorScheduler);
					auditorScheduler.start();
					this.logger.info('AuditorSchedulerService started (Claude Code PTY mode)');
				} catch (error) {
					this.logger.warn('Failed to start AuditorSchedulerService (non-critical)', {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			} else {
				this.logger.info('Auditor disabled (enable via Settings > General or CREWLY_ENABLE_AUDITOR=true)');
			}

		} catch (error) {
			this.logger.error('Failed to start server', { error: error instanceof Error ? error.message : String(error) });
			if (error instanceof Error && error.message.includes('EADDRINUSE')) {
				this.logger.error('Port already in use', { port: this.config.webPort });
				this.logger.info('Try killing existing processes or use a different port');
				await this.handlePortConflict();
			}
			throw error;
		}
	}

	/**
	 * Initialize Slack integration if environment variables are configured.
	 * Gracefully handles missing configuration or connection failures.
	 */
	private async initializeSlackIfConfigured(): Promise<void> {
		// The people directory's owner is the Slack user who installed Crewly's
		// Slack app (issue #968); before Slack is set up it is "owner".
		setPeopleOwnerLookup(() => getSlackCloudConfigService()?.getConfig()?.workspace.installedBy || null);
		// Crewly's own bots (master bot, agent bots) are never people.
		setPeopleBotLookup(isCrewlyBotUserId);
		try {
			this.logger.info('Checking Slack configuration...');
			const result = await initializeSlackIfConfigured({
				messageQueueService: this.messageQueueService,
			});

			// Wire thread store into the bridge for persistent thread tracking.
			// Done regardless of the boot outcome: with Cloud-owned Slack the
			// connection can come up later (workspace installed from Settings)
			// and the bridge must already know its stores.
			const threadStore = getSlackThreadStore();
			if (threadStore) {
				const { getSlackOrchestratorBridge } = await import('./services/slack/slack-orchestrator-bridge.js');
				const bridge = getSlackOrchestratorBridge();
				bridge.setSlackThreadStore(threadStore);
				bridge.setThreadStatusQueue(this.threadStatusQueueService);
			}

			if (result.success) {
				this.logger.info('Slack integration initialized successfully');
			} else if (result.attempted) {
				this.logger.warn('Slack initialization failed', { error: result.error });
			} else {
				this.logger.info('Slack not configured, skipping initialization');
			}
		} catch (error) {
			this.logger.error('Error initializing Slack integration', {
				error: error instanceof Error ? error.message : String(error),
			});
			// Don't fail startup if Slack fails
		}
	}

	/**
	 * Initialize WhatsApp integration if environment variables are configured.
	 * Gracefully handles missing configuration or connection failures.
	 */
	private async initializeWhatsAppIfConfigured(): Promise<void> {
		try {
			this.logger.info('Checking WhatsApp configuration...');
			const result = await initializeWhatsAppIfConfigured({
				messageQueueService: this.messageQueueService,
			});

			if (result.success) {
				this.logger.info('WhatsApp integration initialized successfully');
			} else if (result.attempted) {
				this.logger.warn('WhatsApp initialization failed', { error: result.error });
			} else {
				this.logger.info('WhatsApp not configured, skipping initialization');
			}
		} catch (error) {
			this.logger.error('Error initializing WhatsApp integration', {
				error: error instanceof Error ? error.message : String(error),
			});
			// Don't fail startup if WhatsApp fails
		}
	}

	/**
	 * Initialize Google Chat adapter from saved credentials if available.
	 * Restarts the Pub/Sub pull loop automatically on backend restart.
	 */
	private async initializeGoogleChatIfConfigured(): Promise<void> {
		try {
			this.logger.info('Checking Google Chat saved credentials...');
			const result = await initializeGoogleChatIfConfigured({
				messageQueueService: this.messageQueueService,
			});

			if (result.success) {
				this.logger.info('Google Chat auto-reconnect successful');
			} else if (result.attempted) {
				this.logger.warn('Google Chat auto-reconnect failed', { error: result.error });
			} else {
				this.logger.info('Google Chat not configured, skipping initialization');
			}
		} catch (error) {
			this.logger.error('Error initializing Google Chat integration', {
				error: error instanceof Error ? error.message : String(error),
			});
			// Don't fail startup if Google Chat fails
		}
	}

	/**
	 * Initialize Telegram bot from environment variables or saved credentials.
	 * Starts long-polling for incoming messages automatically on backend restart.
	 */
	private async initializeTelegramIfConfigured(): Promise<void> {
		try {
			this.logger.info('Checking Telegram configuration...');
			const result = await initializeTelegramIfConfigured({
				messageQueueService: this.messageQueueService,
			});

			if (result.success) {
				this.logger.info('Telegram bot connected and polling started');
			} else if (result.attempted) {
				this.logger.warn('Telegram initialization failed', { error: result.error });
			} else {
				this.logger.info('Telegram not configured, skipping initialization');
			}
		} catch (error) {
			this.logger.error('Error initializing Telegram integration', {
				error: error instanceof Error ? error.message : String(error),
			});
			// Don't fail startup if Telegram fails
		}
	}

	/**
	 * Auto-start the orchestrator if the autoStartOrchestrator setting is enabled.
	 * Reads the setting from persistent storage and triggers orchestrator setup.
	 * Failures are logged but do not prevent the server from starting.
	 */
	private async autoStartOrchestratorIfEnabled(): Promise<void> {
		try {
			const settingsService = getSettingsService();
			const settings = await settingsService.getSettings();

			if (!settings.general.autoStartOrchestrator) {
				this.logger.info('Auto-start orchestrator is disabled, skipping');
				return;
			}

			this.logger.info('Auto-start orchestrator is enabled, starting orchestrator...');

			// Determine runtime type: env var OVERRIDES stored status > default (claude-code)
			// DEFAULT_RUNTIME env var is the authoritative config for Docker/headless deployments.
			let runtimeType: RuntimeType = RUNTIME_TYPES.CLAUDE_CODE;

			// Step 1: Check stored orchestrator status (user changed via UI in previous session)
			try {
				const orchestratorStatus = await this.storageService.getOrchestratorStatus();
				if (orchestratorStatus?.runtimeType) {
					runtimeType = orchestratorStatus.runtimeType as RuntimeType;
				}
			} catch {
				// Use default runtime type
			}

			// Step 2: DEFAULT_RUNTIME env var OVERRIDES stored status (product-level config)
			// This ensures Docker/headless deployments always use the configured runtime
			// regardless of what was stored from a previous (possibly different) deployment.
			const envRuntime = process.env.DEFAULT_RUNTIME;
			if (envRuntime && Object.values(RUNTIME_TYPES).includes(envRuntime as RuntimeType)) {
				const previousRuntime = runtimeType;
				runtimeType = envRuntime as RuntimeType;
				this.logger.info('DEFAULT_RUNTIME env overrides stored runtime', { runtimeType, previousRuntime });

				// #183: Persist the override so stored status stays in sync
				if (previousRuntime !== runtimeType) {
					try {
						await this.storageService.updateOrchestratorRuntimeType(runtimeType);
						this.logger.info('Synced orchestrator runtime to storage', { runtimeType });
					} catch {
						this.logger.warn('Failed to sync orchestrator runtime to storage');
					}
				}
			}

			// Create orchestrator agent session, with bounded retry + backoff.
			//
			// #686: a single `createAgentSession` failure here used to be a
			// one-shot WARN + return — the orchestrator then stayed inactive
			// with NO retry and NO health signal, leaving the system in a
			// silent "假死" state (inbound messages queue forever, /health still
			// reports healthy). Transient failures are common at boot (e.g. a
			// momentary PTY spawn-slot exhaustion like #611, or a downstream
			// dependency still warming up after a process restart), so we retry
			// with a linear backoff before giving up. The reconciler's
			// hybrid-wake is the longer-term self-heal (it now restarts the orc
			// via /orchestrator/setup, #679), but boot-time retry avoids leaving
			// the orc dead until the next inbound message arrives.
			const MAX_AUTOSTART_ATTEMPTS = 5;
			const AUTOSTART_BACKOFF_MS = 3_000;

			let autostartAttempts = 0;
			const result = await retryWithBackoff(
				() => (autostartAttempts++, this.apiController.agentRegistrationService.createAgentSession({
					sessionName: ORCHESTRATOR_SESSION_NAME,
					role: ORCHESTRATOR_ROLE,
					projectPath: this.config.crewlyHome,
					windowName: ORCHESTRATOR_WINDOW_NAME,
					runtimeType,
					forceRecreate: true,
				})),
				{
					maxAttempts: MAX_AUTOSTART_ATTEMPTS,
					backoffMs: AUTOSTART_BACKOFF_MS,
					isSuccess: r => r.success,
					// A start-up blocked on the user (Claude Code as root, or never
					// set up) cannot succeed on retry: stop and report it once.
					shouldStop: r => r.errorCode === CLAUDE_STARTUP_CONSTANTS.BLOCKED_ERROR_CODE,
					onRetry: ({ attempt, maxAttempts, retryInMs, result: r }) => {
						this.logger.warn('Auto-start orchestrator failed to create session — retrying', {
							error: r.error,
							attempt,
							maxAttempts,
							retryInMs,
						});
					},
				},
			);

			if (!result.success) {
				// Exhausted all retries. Log loudly at ERROR (not WARN) so the
				// failure is greppable in pm2/console output and not mistaken for
				// a benign skip. The orchestrator stays inactive; recovery now
				// falls to the reconciler's hybrid-wake on the next queued
				// inbound WorkItem (#679 routing fix).
				this.logger.error(
					result.errorCode === CLAUDE_STARTUP_CONSTANTS.BLOCKED_ERROR_CODE
						? 'Auto-start orchestrator BLOCKED — needs user action; orchestrator is INACTIVE'
						: 'Auto-start orchestrator FAILED after all retries — orchestrator is INACTIVE',
					{
						error: result.error,
						errorCode: result.errorCode,
						attempts: autostartAttempts,
					},
				);
				// Hand the reason to the restart service so the heartbeat
				// monitor does not start a second, endless retry loop on the
				// same failure (B8 D1) and the status endpoint can show it.
				OrchestratorRestartService.getInstance().markGaveUp(
					result.error || 'the orchestrator could not be started',
					{
						blocked: result.errorCode === CLAUDE_STARTUP_CONSTANTS.BLOCKED_ERROR_CODE,
						attempts: autostartAttempts,
					},
				);
				return;
			}

			// Initialize orchestrator memory
			try {
				const memoryService = MemoryService.getInstance();
				await memoryService.initializeForSession(
					ORCHESTRATOR_SESSION_NAME,
					ORCHESTRATOR_ROLE,
					this.config.crewlyHome
				);
			} catch (memoryError) {
				this.logger.warn('Failed to initialize orchestrator memory during auto-start', {
					error: memoryError instanceof Error ? memoryError.message : String(memoryError),
				});
			}

			// Start persistent chat monitoring
			if (this.terminalGateway) {
				this.terminalGateway.startOrchestratorChatMonitoring(ORCHESTRATOR_SESSION_NAME);
			}

			this.logger.info('Orchestrator auto-started successfully');

			// Announce "back online" to the owner's channel (best-effort, never
			// blocks boot). Deterministic system message — reports startup + the
			// running version, enriched with offline duration + replayed count.
			try {
				const settings = await getSettingsService().getSettings();
				// An auto-upgrade boot sends its own "upgraded to x.y.z" notice;
				// one message per upgrade, not two.
				const upgradeBoot = AutoUpdateService.getInstance()?.isUpgradeBoot() === true;
				if (settings.general.announceOnBoot && !upgradeBoot) {
					let version = 'unknown';
					try {
						version = VersionCheckService.getInstance().getLocalVersion();
					} catch {
						version = process.env.npm_package_version || 'unknown';
					}
					// First-ever boot → welcome; subsequent boots → "back online".
					const bootMarker = path.join(this.config.crewlyHome, '.boot-announced');
					const firstBoot = isFirstBoot(bootMarker);
					if (firstBoot) markBooted(bootMarker);
					// Several machines announce into one Slack workspace, so say
					// which one this is. Best-effort: an unnamed device just
					// keeps the old wording.
					let deviceName: string | undefined;
					try {
						deviceName = (await DeviceIdentityService.getInstance().getOrCreateIdentity()).deviceName;
					} catch {
						deviceName = undefined;
					}
					await sendBootAnnouncement(
						{
							version,
							firstBoot,
							...(deviceName ? { deviceName } : {}),
							offlineDurationMs: this.lastOfflineReplay?.offlineDurationMs,
							replayedCount: this.lastOfflineReplay?.replayedCount,
						},
						{
							isSlackConnected: () => getSlackService().isConnected(),
							sendSlack: (msg) =>
								getSlackService().sendNotification({
									type: 'project_update',
									title: msg.title,
									message: msg.message,
									urgency: 'normal',
									timestamp: new Date().toISOString(),
								}),
							logger: {
								info: (m, meta) => this.logger.info(m, meta),
								warn: (m, meta) => this.logger.warn(m, meta),
							},
						},
					);
				}
			} catch (announceErr) {
				this.logger.warn('Boot announce skipped (non-critical)', {
					error: announceErr instanceof Error ? announceErr.message : String(announceErr),
				});
			}
		} catch (error) {
			this.logger.error('Failed to auto-start orchestrator', {
				error: error instanceof Error ? error.message : String(error),
			});
			// Don't fail startup if auto-start fails
		}
	}

	/**
	 * Drop persisted team sessions whose name no team member is bound to.
	 *
	 * session-state.json caches what was running; the team config is the
	 * source of truth for each member's session name. An entry left under a
	 * member's old name (it was renamed) would otherwise stay in the Resume
	 * dialog and could be relaunched, running the member twice. Each unbound
	 * entry is unregistered (rewriting the state file without it) and its
	 * generated Claude Code agent file is removed. Failure to read the teams,
	 * or an empty team list, prunes nothing.
	 *
	 * @param sessions - Entries loaded from session-state.json.
	 */
	private async pruneUnboundPersistedSessions(sessions: ReadonlyArray<PersistedSessionInfo>): Promise<void> {
		try {
			const teams = await this.storageService.getTeams();
			// No teams at all is indistinguishable from a failed read: prune
			// nothing rather than drop every member's resume entry.
			if (teams.length === 0) return;
			const { unbound, rebound } = resolvePersistedSessions(sessions, teams);
			if (unbound.length === 0) return;
			const persistence = getSessionStatePersistence();
			const byName = new Map(sessions.map((s) => [s.name, s]));
			for (const name of unbound) {
				persistence.unregisterSession(name);
				await removeCrewlyAgentFile(byName.get(name)?.cwd, name);
			}
			this.logger.warn('Pruned persisted sessions whose name no team member is bound to', { unbound, rebound });
		} catch (error) {
			this.logger.warn('Could not check persisted sessions against team bindings (nothing pruned)', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** WorkItems to recover after boot, grouped by target session. */
	private recoveryBySession = new Map<string, Array<{ id: string; title: string; target?: string }>>();

	/**
	 * In-progress WorkItems worth re-sending after a restart: active status,
	 * with a target, touched within the last hour of `referenceMs`.
	 *
	 * @param referenceMs - Boot time (age is measured at boot, not after the restore)
	 * @returns Items grouped by target session
	 */
	private async collectRecoverableTasks(referenceMs: number): Promise<Map<string, Array<{ id: string; title: string; target?: string }>>> {
		const out = new Map<string, Array<{ id: string; title: string; target?: string }>>();
		try {
			const TASK_RECOVERY_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
			const allItems = await TaskPoolService.getInstance().getAllItems();
			for (const wi of allItems) {
				if (wi.status !== 'queued' && wi.status !== 'accepted' && wi.status !== 'running') continue;
				if (!wi.target) continue;
				// Last sign of life: a re-claim / status change counts, not only creation.
				const taskTime = Math.max(
					new Date(wi.startedAt || wi.createdAt || 0).getTime() || 0,
					new Date(wi.statusChangedAt || 0).getTime() || 0,
				);
				if (referenceMs - taskTime > TASK_RECOVERY_MAX_AGE_MS) {
					this.logger.info('Skipping stale task recovery (older than 1 hour)', {
						workItemId: wi.id,
						taskName: wi.title,
						age: `${Math.round((referenceMs - taskTime) / 60000)} minutes`,
					});
					continue;
				}
				const list = out.get(wi.target) ?? [];
				list.push(wi);
				out.set(wi.target, list);
			}
			if (out.size > 0) {
				this.logger.info('Found in-progress WorkItems to recover after restart', {
					count: [...out.values()].reduce((n, l) => n + l.length, 0),
				});
			}
		} catch (err) {
			this.logger.warn('Task auto-recovery failed (non-critical)', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return out;
	}

	/**
	 * Send the task-recovery messages of one session (once), e.g. right after
	 * that agent registered.
	 *
	 * @param sessionName - Target session
	 */
	private async sendRecoveryFor(sessionName: string): Promise<void> {
		const items = this.recoveryBySession.get(sessionName);
		this.recoveryBySession.delete(sessionName);
		for (const wi of items ?? []) {
			try {
				const recoveryMessage = `[SYSTEM — TASK RECOVERY] You were working on this task before the server restarted. Please continue:\n\nTask: ${wi.title}\nWorkItem: ${wi.id}\n\nFetch full brief: bash config/skills/agent/core/read-task/execute.sh '{"workItemId":"${wi.id}"}'\n\nPlease check the current state and continue working.`;
				await this.apiController.agentRegistrationService.sendMessageToAgent(
					sessionName,
					recoveryMessage,
					undefined as unknown as RuntimeType
				);
				this.logger.info('Task recovery message sent', { workItemId: wi.id, sessionName, taskName: wi.title });
			} catch (err) {
				// Agent might not be online yet — DLQ in scheduler will handle it
				this.logger.warn('Task recovery delivery deferred (agent may not be online yet)', {
					workItemId: wi.id,
					sessionName,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	/**
	 * Auto-restore agent sessions that were running before the last shutdown.
	 * Loads persisted session state and calls createAgentSession() for each
	 * non-orchestrator session. Gated by the autoResumeOnRestart setting.
	 * Runs after orchestrator auto-start so the orchestrator is available.
	 */
	private async autoRestoreAgentSessionsIfEnabled(): Promise<void> {
		try {
			const settingsService = getSettingsService();
			const settings = await settingsService.getSettings();

			if (!settings.general.autoResumeOnRestart) {
				this.logger.info('Auto-resume on restart is disabled, skipping agent session restore');
				return;
			}

			const persistence = getSessionStatePersistence();
			const state = await persistence.loadState();

			if (!state || state.sessions.length === 0) {
				this.logger.debug('No persisted agent sessions to restore');
				return;
			}

			// Filter out orchestrator sessions (already auto-started separately)
			// and auditor sessions when auditor is disabled
			const isAuditorEnabled = process.env[AUDITOR_CONSTANTS.ENV_VAR]?.toLowerCase() === 'true'
				|| (process.env[AUDITOR_CONSTANTS.ENV_VAR] === undefined && AUDITOR_CONSTANTS.ENABLED_BY_DEFAULT);
			const baselineSessions = state.sessions.filter(
				(s) => {
					if (s.role === ORCHESTRATOR_ROLE) return false;
					if (!isAuditorEnabled && s.name === AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME) return false;
					return true;
				}
			);

			// Relaunch team members only under the session name the team config
			// binds them to: a persisted entry under a stale name (the member was
			// renamed) is rebound through its memberId or dropped, never launched
			// under the stale name. Then gate by task-pool work.
			//
			// Work gate: only restore a session with work in hand (see
			// restore-filter) or whose turn the last restart cut off. Idle agents
			// stay down until work or a message wakes them (PR #574/#585).
			// Safety valve: if the pool lookup throws (e.g. SQLite not yet open
			// during early boot), skip the gate rather than strand work.
			let teams: Awaited<ReturnType<StorageService['getTeams']>> | null = null;
			try {
				teams = await this.storageService.getTeams();
			} catch (bindErr) {
				this.logger.warn('Auto-restore could not read team bindings; restoring only non-team sessions', {
					error: bindErr instanceof Error ? bindErr.message : String(bindErr),
				});
			}
			let targets: Set<string> | null = null;
			try {
				const allItems = await TaskPoolService.getInstance().getAllItems();
				// Work in hand only: active statuses, touched recently (see restore-filter),
				// plus agents whose turn the last restart cut off.
				const owed = await this.loadOwedWorkAtBoot();
				targets = sessionsToRestore(
					allItems as RestoreWorkItem[],
					[
						...this.interruptedTurnsAtBoot.map((t) => t.sessionName),
						// Agents with messages still waiting for them (restored from
						// disk by the queue) — someone is owed an answer.
						...SubAgentMessageQueue.getInstance().sessionsWithPending(),
						// Agents whose owner promise is past due and was never
						// nudged: idle or not, they come back to be reminded once
						// (2026-10-02, Eve). Not-yet-due and already-nudged
						// promises are left to the open-items sweep.
						...owed.map((c) => c.sessionName),
						// Agents an owner Slack thread waits on: a promised
						// follow-up, an unanswered owner message, or an owner
						// card they asked (2026-10-08: Atlas waited on a browser
						// approval in the owner's thread and was skipped as "no
						// work in hand").
						...(await this.ownerThreadSessionsAtBoot()),
					],
				);
			} catch (poolErr) {
				this.logger.warn(
					'Auto-restore could not query task pool; falling back to restoring every persisted session',
					{ error: poolErr instanceof Error ? poolErr.message : String(poolErr) },
				);
			}

			const selection = selectAutoRestoreSessions({ sessions: baselineSessions, teams, targets });
			if (selection.unbound.length > 0) {
				this.logger.warn('Not auto-restoring sessions whose name no team member is bound to', {
					unbound: selection.unbound,
					rebound: selection.rebound,
				});
			}
			if (selection.skippedNoWork.length > 0) {
				this.logger.info(
					'Skipping auto-restore for sessions with no work in hand (idle agents stay down until work or a message wakes them)',
					{
						skippedCount: selection.skippedNoWork.length,
						skipped: selection.skippedNoWork.slice(0, 20),
						truncated: selection.skippedNoWork.length > 20,
					},
				);
			}
			const agentSessions = selection.sessions;

			if (agentSessions.length === 0) {
				this.logger.info('No persisted agent sessions to restore (all idle, no pending WorkItems)');
				return;
			}

			this.logger.info('Auto-restoring agent sessions from persisted state', {
				count: agentSessions.length,
				sessions: agentSessions.map((s) => s.name),
			});

			// Staggered restore: one agent at a time (CREWLY_RESTORE_CONCURRENCY,
			// max 3), the next starts when the previous one registered or timed out.
			// Owner-waiting agents first, then orchestrator, leads, everyone else.
			const queueMessages = SubAgentMessageQueue.getInstance();
			const owedSince = new Map<string, number>();
			for (const c of this.openCommitmentsAtBoot) {
				const due = c.due ? Date.parse(c.due) : NaN;
				owedSince.set(c.sessionName, Math.min(owedSince.get(c.sessionName) ?? Infinity, Number.isFinite(due) ? due : 0));
			}
			const leadRoles: readonly string[] = TEAM_LEAD_CONSTANTS.LEAD_ROLES;
			const entries: RestoreEntry[] = agentSessions.map((session): RestoreEntry => {
				const ownerTimes = queueMessages.peek(session.name).filter((m) => m.meta?.owner === true).map((m) => m.queuedAt);
				if (owedSince.has(session.name)) ownerTimes.push(owedSince.get(session.name) as number);
				const base = {
					name: session.name,
					run: async (attempt: number) => {
						// PTYs live in this process, so none survive a restart: a session
						// that exists now was started this boot by another launcher (a
						// reconciler wake, a team start). forceRecreate would kill it and
						// resume the same conversation again — a second kickoff in one
						// chat (2026-09-25 startup-prompt loop). Leave it be.
						if (attempt === 0 && await this.apiController.agentRegistrationService.isSessionLiveOrLaunching(session.name)) {
							this.logger.info('Skipping restore — session already started this boot by another launcher', { name: session.name });
							return { success: true };
						}
						const result = await this.apiController.agentRegistrationService.createAgentSession({
							sessionName: session.name,
							role: session.role || 'developer',
							projectPath: session.cwd || process.cwd(),
							runtimeType: session.runtimeType,
							teamId: session.teamId,
							memberId: session.memberId,
							// A retry joins the launch still in flight instead of killing it.
							forceRecreate: attempt === 0,
						});
						if (!result.success) this.logger.warn('Failed to restore agent session', { name: session.name, error: result.error });
						return { success: result.success };
					},
					onReady: () => this.sendRecoveryFor(session.name),
				};
				if (ownerTimes.length > 0) {
					return { ...base, tier: RESTORE_TIER.OWNER, ownerSince: Math.min(...ownerTimes), reason: 'owner message waiting' };
				}
				if (session.role === ORCHESTRATOR_ROLE) return { ...base, tier: RESTORE_TIER.ORCHESTRATOR, reason: 'orchestrator' };
				if (leadRoles.includes(session.role ?? '')) return { ...base, tier: RESTORE_TIER.LEAD, reason: 'team lead with work in hand' };
				return { ...base, tier: RESTORE_TIER.OTHER, reason: 'work in hand' };
			});

			// Runs in the background; boot continues while agents come back.
			void getRestoreQueue()
				.start(entries)
				.then(async () => {
					// Clear persisted state after the restore to avoid double-restore
					await persistence.clearState();
				})
				.catch((error: unknown) => {
					this.logger.error('Restore queue failed', { error: error instanceof Error ? error.message : String(error) });
				});
		} catch (error) {
			this.logger.error('Failed to auto-restore agent sessions', {
				error: error instanceof Error ? error.message : String(error),
			});
			// Don't fail startup if auto-restore fails
		}
	}

	/**
	 * Check for and handle pending self-improvement from hot-reload.
	 * This runs at startup to validate or rollback any changes made
	 * before the process was restarted.
	 */
	private async checkPendingSelfImprovement(): Promise<void> {
		try {
			const startupService = getImprovementStartupService();
			const result = await startupService.runStartupCheck();

			if (result.hadPendingImprovement) {
				this.logger.info('Handled pending self-improvement', {
					improvementId: result.improvementId,
					action: result.action,
					validationPassed: result.validationPassed,
				});

				if (result.action === 'rolled_back') {
					this.logger.warn('Self-improvement rollback performed', {
						error: result.error,
					});
				}
			}
		} catch (error) {
			this.logger.error('Error checking pending self-improvement', {
				error: error instanceof Error ? error.message : String(error),
			});
			// Continue startup even if self-improvement check fails
		}
	}

	private async checkPortAvailability(): Promise<void> {
		const { createServer } = await import('net');
		const testServer = createServer();

		return new Promise<void>((resolve, reject) => {
			testServer.listen(this.config.webPort, this.config.bindHost, () => {
				testServer.close(() => {
					this.logger.info('Port is available', { port: this.config.webPort, host: this.config.bindHost });
					resolve();
				});
			});

			testServer.on('error', (error: NodeJS.ErrnoException) => {
				if (error.code === 'EADDRINUSE') {
					reject(new Error(`Port ${this.config.webPort} is already in use`));
				} else {
					reject(error);
				}
			});
		});
	}

	/**
	 * Write the credential guard's paths file at boot
	 * (specs/2026-10-04-agent-credential-isolation.md, layer 2), so agents
	 * started without a PTY launch (crewly-agent) find it too. Each PTY
	 * launch rewrites it. For agy, the kill switch also removes Crewly's
	 * entry from agy's global hooks file.
	 */
	private prepareCredentialGuardFile(): void {
		if (!isCredentialGuardEnabled()) {
			try {
				const removed = syncAntigravityCredentialHook(null);
				if (removed === 'removed') this.logger.info("Credential guard: off — removed Crewly's entry from agy's hooks file");
			} catch (error) {
				this.logger.warn("Credential guard: could not remove Crewly's entry from agy's hooks file", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		// The credential guard's paths file, so agents started without a PTY
		// launch (crewly-agent) find it too. Each PTY launch rewrites it.
		try {
			const files = prepareCredentialGuard(getCrewlyHomePath(), findPackageRoot(__dirname));
			this.logger.info('Credential guard: paths file written', { file: files.pathsFile, guardedPaths: files.guarded.length });
		} catch (error) {
			this.logger.warn('Credential guard: could not write its paths file', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Log where the API token lives and how reachable the API is.
	 *
	 * Resolving the token here also performs the first-boot generation so
	 * the file exists (0600) before the first non-loopback caller arrives.
	 * Emits a WARN for a headless install that binds every interface with
	 * neither `CREWLY_BIND_HOST` nor `CREWLY_API_TOKEN` set.
	 */
	private logNetworkExposure(): void {
		try {
			// A token pinned in the service environment is mirrored to the token
			// file, so the CLI on this machine can present it (#1010 review).
			const mirrored = mirrorEnvTokenToFile();
			if (mirrored === 'written' || mirrored === 'updated' || mirrored === 'failed') {
				this.logger[mirrored === 'failed' ? 'warn' : 'info'](`API token from ${API_SECURITY_CONSTANTS.ENV.API_TOKEN}: token file ${mirrored}`, {
					file: getApiTokenFilePath(),
				});
			}
			const token = resolveApiToken();
			const summary = describeNetworkExposure({
				bindHost: this.config.bindHost,
				port: this.config.webPort,
				bindHostExplicit: Boolean(process.env[API_SECURITY_CONSTANTS.ENV.BIND_HOST]),
				tokenSource: token.source,
				tokenFilePath: token.filePath,
				headless: this.config.headless || isHeadlessEnvironment(),
			});
			if (token.source === 'generated') {
				this.logger.info('Generated API token for non-loopback callers', {
					file: token.filePath,
					usage: 'crewly token | curl -H "X-Crewly-Token: $(crewly token)" http://<host>:<port>/api/teams',
				});
			}
			if (summary.level === 'warn') {
				this.logger.warn(summary.message, summary.details);
			} else {
				this.logger.info(summary.message, summary.details);
			}
		} catch (error) {
			this.logger.error('Failed to resolve API token', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async startHttpServer(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const startTime = Date.now();

			// Outermost upgrade wrapper: every gateway (Socket.IO, browser
			// bridge, chat-v2, terminal) has attached by now, so this gate
			// runs before any of them sees a non-loopback upgrade.
			installWebSocketGate(this.httpServer);

			this.httpServer.listen(this.config.webPort, this.config.bindHost, () => {
				const duration = Date.now() - startTime;
				this.logger.info('Crewly server started', {
					host: this.config.bindHost,
					port: this.config.webPort,
					listening: `${this.config.bindHost}:${this.config.webPort}`,
					durationMs: duration,
					dashboardUrl: `http://localhost:${this.config.webPort}`,
					websocketUrl: `ws://localhost:${this.config.webPort}`,
					home: this.config.crewlyHome
				});
				this.logNetworkExposure();

				// B0 (interim) per `.crewly/specs/2026-05-05-trigger-persistence-bug.md`:
				// Broadcast `system:backend_restarted` exactly once per boot. The
				// trigger engine (`backend/src/services/v3/trigger-engine.service.ts`)
				// stores all `schedule-followup` / `watch-for-event` triggers in an
				// in-memory `Map<string, Trigger>` that is wiped on every restart.
				// Subscribers (e.g. self-watch-scribe, any TL using §3.0 universal
				// delegator-rule) listen for this event as a freshness signal and
				// re-arm their watchdogs. Re-arm latency drops from "manual cycle"
				// to "next event tick" — closes the wipe-coverage-gap to seconds.
				// B1 (full fix) is disk-backed declarative trigger config per the
				// spec Path A; B0 is the unblock-first interim until B1 lands.
				try {
					// AgentEvent shape (`backend/src/types/event-bus.types.ts:198`)
					// requires a fixed set of string fields. For system-scoped
					// events we use 'system' for member/session and leave team
					// fields empty — subscribers MUST gate on `type` rather than
					// team/member identity. Boot diagnostics (port, duration) are
					// already in the preceding `Crewly server started` log;
					// callers needing them can correlate by `timestamp`.
					this.eventBusService.publish({
						id: `system-backend-restarted-${Date.now()}`,
						type: 'system:backend_restarted',
						timestamp: new Date().toISOString(),
						teamId: '',
						teamName: '',
						memberId: '',
						memberName: 'system',
						sessionName: 'system',
						previousValue: 'stopped',
						newValue: 'started',
						changedField: 'agentStatus'
					});
					this.logger.info('Broadcast system:backend_restarted event', {
						port: this.config.webPort,
						bootDurationMs: duration
					});
				} catch (emitError) {
					// Failure isolation — never block boot on this telemetry.
					this.logger.warn('Failed to broadcast system:backend_restarted (non-fatal)', {
						error: emitError instanceof Error ? emitError.message : String(emitError)
					});
				}

				resolve();
			});

			this.httpServer.on('error', (error: any) => {
				this.logger.error('HTTP Server error', { error: error.message, code: error.code });

				if (error.code === 'EADDRINUSE') {
					this.logger.error('Port already in use by another process', { port: this.config.webPort });
					this.logger.info('Suggestion: Kill the existing process or change the port');
				} else if (error.code === 'EACCES') {
					this.logger.error('Permission denied for port', { port: this.config.webPort });
					this.logger.info('Suggestion: Try a port above 1024 or run with appropriate permissions');
				}

				reject(error);
			});
		});
	}

	private async handlePortConflict(): Promise<void> {
		this.logger.info('Attempting to identify conflicting process...');

		try {
			const { execSync } = await import('child_process');
			const result = execSync(`lsof -ti :${this.config.webPort}`, { encoding: 'utf8' }).trim();

			if (result) {
				this.logger.info('Process using port identified', { port: this.config.webPort, pid: result });
				this.logger.info('To kill it manually', { command: `kill -9 ${result}` });
			}
		} catch (error) {
			this.logger.info('Could not identify the conflicting process');
		}
	}

	private sigintCount = 0;

	private registerSignalHandlers(): void {
		this.logger.info('Registering signal handlers...');

		process.on('SIGTERM', () => this.handleShutdownSignal('SIGTERM'));
		process.on('SIGINT', () => this.handleShutdownSignal('SIGINT'));

		process.on('uncaughtException', (error) => {
			this.logger.error('Uncaught exception', { error: error.message, stack: error.stack });
			this.logMemoryUsage();
			// A crashing process should not linger for the drain; its in-flight
			// turns are still persisted and resumed after the restart.
			this.shutdown({ reason: 'uncaughtException', drain: false, crashDetail: error.message });
		});

		process.on('unhandledRejection', (reason, promise) => {
			const message = unhandledRejectionMessage(reason);

			// Non-fatal rejections from third-party libraries (Slack Socket Mode
			// state machine errors, Slack platform errors such as invalid_auth)
			// are logged but must not trigger a full shutdown — the integration
			// goes degraded, the backend stays up. The pattern list lives in
			// NON_FATAL_UNHANDLED_REJECTION_PATTERNS (constants.ts).
			if (isNonFatalUnhandledRejection(reason)) {
				this.logger.warn('Non-fatal unhandled rejection (suppressed shutdown)', {
					reason: message,
				});
				return;
			}

			this.logger.error('Unhandled rejection', {
				reason: message,
				stack: reason instanceof Error ? reason.stack : undefined
			});
			this.logMemoryUsage();
			this.shutdown({ reason: 'unhandledRejection', drain: false, crashDetail: message });
		});
	}

	/**
	 * Handle SIGTERM / SIGINT with safe-restart semantics.
	 *
	 * - First signal: graceful shutdown, which first drains in-flight agent turns.
	 * - A repeat within SIGNAL_DEDUP_WINDOW_MS is the same request arriving twice
	 *   (Ctrl+C reaches the whole process group, and the CLI parent forwards it
	 *   too) and is ignored.
	 * - A later repeat during the drain skips the wait; interrupted turns are
	 *   persisted and resumed after the restart.
	 * - A later SIGINT after the drain forces an immediate exit, as before.
	 *
	 * @param signal - The signal received
	 */
	private handleShutdownSignal(signal: 'SIGTERM' | 'SIGINT'): void {
		const now = Date.now();
		if (!this.isShuttingDown) {
			this.lastShutdownSignalAt = now;
			this.logger.info(`Received ${signal} — shutting down; in-flight agent turns are drained first. Send ${signal} again to stop waiting.`);
			void this.shutdown({ reason: signal });
			return;
		}
		if (now - this.lastShutdownSignalAt < SAFE_RESTART.SIGNAL_DEDUP_WINDOW_MS) {
			this.logger.debug(`Duplicate ${signal} ignored (same shutdown request)`);
			return;
		}
		this.lastShutdownSignalAt = now;
		if (RestartDrainService.getInstance().requestSkip(`second ${signal}`)) {
			return;
		}
		if (signal === 'SIGINT') {
			this.sigintCount++;
			this.logger.info('Received another SIGINT after the drain - forcing immediate exit');
			process.exit(1);
		}
		this.logger.info(`Received ${signal} while shutdown is already past the drain; continuing`);
	}

	/**
	 * End-of-turn settling: take down "working on it" placeholders the agent
	 * never answered, settle its open DM threads, and submit the tickets it
	 * replied in. Never throws.
	 *
	 * @param sessionName - Agent whose turn ended
	 */
	private settleAfterTurn(sessionName: string): void {
		// The turn ended: a "working on it" it never answered means it chose
		// not to reply (an "ok", "好"). Take it down rather than leave a
		// "still working — the reply will follow" that never follows.
		void getSlackTypingPlaceholderService()
			?.settleTurnWithoutReply(sessionName)
			.catch(() => undefined);
		// Same rule for the DM threads it was owed an answer in: one it
		// chose not to answer must not pull a later unattributed answer
		// back into it (2026-09-28).
		void getSlackAgentDmService()
			?.settleOpenThreads(sessionName)
			.catch(() => undefined);
		// Follow-through: nudge a stated intent nothing followed, and give an
		// owner ticket with no WorkItem one — before the review looks at it.
		// Ticket loop Phase 2: an agent that finished its turn has answered
		// the tickets it replied in — submit them (待验收 or done).
		void settleFollowThrough(sessionName)
			.then(() => getTicketReviewService()?.onAgentIdle(sessionName))
			.catch(() => undefined);
	}

	/**
	 * Wire the safe-restart pieces: the turn probe, idle-event re-probing,
	 * readiness queue counting, and the graceful-shutdown hook used by
	 * POST /api/system/restart.
	 */
	private wireSafeRestart(): void {
		const tracker = InFlightTurnTracker.getInstance();
		const activity = PtyActivityTrackerService.getInstance();
		const turnState = AgentTurnStateService.getInstance();
		const persistence = getSessionStatePersistence();
		const metaOf = (sessionName: string): ReturnType<typeof persistence.getSessionMetadata> => {
			try {
				return persistence.getSessionMetadata(sessionName);
			} catch {
				return undefined;
			}
		};
		// The runtime's own turn state (specs/2026-10-02-restart-busy-and-resume.md):
		// Claude Code transcripts as the fallback behind its hooks.
		turnState.setTranscriptLocator((sessionName) => {
			const meta = metaOf(sessionName);
			if (!meta || meta.runtimeType !== RUNTIME_TYPES.CLAUDE_CODE || !meta.claudeSessionId || !meta.cwd) return null;
			const homes = [meta.env?.CLAUDE_CONFIG_DIR, defaultClaudeHome()].filter((h): h is string => typeof h === 'string' && h.length > 0);
			return findClaudeTranscript({ sessionId: meta.claudeSessionId, cwd: meta.cwd, claudeHomes: homes });
		});
		tracker.setProbe(
			createPtyTurnProbe({
				getBackend: () => getSessionBackendSync(),
				getIdleTimeMs: (sessionName) => (activity.hasActivity(sessionName) ? activity.getIdleTimeMs(sessionName) : null),
				getRuntimeVerdict: (sessionName) => turnState.getVerdict(sessionName),
				getLastHookEventAt: (sessionName) => turnState.lastHookEventAt(sessionName),
				getRuntimeType: (sessionName) => metaOf(sessionName)?.runtimeType ?? null,
			}),
		);
		// Turns no delivery started (a background subagent finishing) and
		// background work after a turn count as mid-turn too (2026-10-02, Eve).
		tracker.setRuntimeBusySource((now) => {
			const backend = getSessionBackendSync();
			const out: Array<{ sessionName: string; since: number | null; longRunning: boolean }> = [];
			for (const sessionName of turnState.knownSessions()) {
				if (!backend?.sessionExists(sessionName)) continue;
				// An exited runtime is not working, whatever its last hook said.
				if (backend.isChildProcessAlive?.(sessionName) === false) {
					turnState.forget(sessionName);
					continue;
				}
				const v = turnState.getVerdict(sessionName, now);
				if (v.state === 'turn' || v.state === 'background') out.push({ sessionName, since: v.since, longRunning: v.longRunning });
			}
			return out;
		});
		tracker.attachEventSource(this.eventBusService);
		// Under systemd, TimeoutStopSec decides when we are SIGKILLed: the drain
		// must end before it, or the interrupted turns are never saved.
		this.supervisorStopBudgetMs = resolveSupervisorStopBudgetMs();
		if (this.supervisorStopBudgetMs !== null) {
			const wanted = resolveBackgroundDrainMs(process.env);
			const capped = capDrainToSupervisor(wanted, this.supervisorStopBudgetMs, SAFE_RESTART.SHUTDOWN_MARGIN_MS);
			const log = capped < wanted ? this.logger.warn.bind(this.logger) : this.logger.info.bind(this.logger);
			log('Restart drain capped by the systemd stop timeout', {
				timeoutStopMs: this.supervisorStopBudgetMs,
				drainCapMs: capped,
				wantedMs: wanted,
				...(capped < wanted ? { fix: 'run "crewly service upgrade" (or "crewly service install --force") to regenerate the unit' } : {}),
			});
		}
		// A silent screen is not idle while the runtime reports a turn.
		this.activityMonitorService.setRuntimeTurnCheck((sessionName) => turnState.getVerdict(sessionName).state === 'turn');

		const drain = RestartDrainService.getInstance();
		drain.setQueueCounter(
			() => this.messageQueueService.pendingCount + SubAgentMessageQueue.getInstance().getTotalQueued(),
		);
		drain.setShutdownHandler((request: GracefulShutdownRequest) =>
			this.shutdown({ reason: request.reason, exitCode: request.exitCode, ...(request.drain === false ? { drain: false } : {}) }),
		);
	}

	/**
	 * Release input-guard check: read every live agent's input box from the
	 * real terminal buffers and classify it with the guard of the build at
	 * `build` (specs/2026-10-04-release-input-guard-check.md).
	 *
	 * @param build - Package root / dist of the build to check
	 * @returns The report
	 */
	private async checkInputGuardWithNewBuild(build: string): Promise<InputGuardReport> {
		const backend = getSessionBackendSync();
		if (!backend) {
			this.logger.warn('Input-guard check unavailable: no session backend is running');
			return { ok: true, unavailable: true, checkedAt: new Date().toISOString(), agents: [], error: 'no session backend is running: live agents were not checked' };
		}
		const persistence = getSessionStatePersistence();
		const views = collectLiveViews(backend, (name) => persistence.getSessionMetadata(name)?.runtimeType, (name) => ({
			pastes: harnessPastesSinceOutsideInput(name).map((p) => p.message),
			shownMarkers: shownMarkers(name),
		}));
		return runInputGuardCheck({ build, views });
	}

	/**
	 * Create the SystemControlService behind the owner's Upgrade / Restart
	 * buttons: the AutoUpdateService install path, the graceful drained
	 * restart, and the detached replacement launcher for a backend nothing
	 * else relaunches. Settles the record a previous boot left. Never throws.
	 */
	private startSystemControl(): void {
		try {
			const versionService = VersionCheckService.getInstance();
			const autoUpdate = AutoUpdateService.getInstance();
			const packageRoot = resolveRunningPackageRoot(process.argv[1], safeProcessCwd());
			const install = autoUpdate?.getInstallInfo() ?? detectInstall(packageRoot);
			let currentVersion = autoUpdate?.getCurrentVersion() ?? null;
			if (!currentVersion) {
				try {
					currentVersion = versionService.getLocalVersion();
				} catch {
					currentVersion = null;
				}
			}
			const crewlyHome = this.config.crewlyHome;
			const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
			// This boot is a start: a marker left by an earlier shutdown no longer applies.
			clearShutdownMarker(crewlyHome);
			const windDown = new WindDownService({
				listAgents: () => {
					const backend = getSessionBackendSync();
					if (!backend) return [];
					return backend.listSessions().filter((name) => backend.sessionExists(name) && backend.isChildProcessAlive?.(name) !== false);
				},
				getBusyAgents: () => RestartDrainService.getInstance().getReadiness().busyAgents.map((b) => b.session),
				// Owner priority: a busy agent gets it ahead of system traffic (#1105).
				deliver: (session, text) =>
					withQueueMeta(session, text, { owner: true, supersedeKey: 'wind-down' }, () =>
						this.apiController.agentRegistrationService.sendMessageToAgent(session, text),
					),
				now: Date.now,
				sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
				logger: LoggerService.getInstance().createComponentLogger('WindDown'),
			});
			WindDownService.setInstance(windDown);
			const service = new SystemControlService({
				crewlyHome,
				install,
				currentVersion,
				pid: process.pid,
				bootId: `${process.pid}-${startedAt}`,
				startedAt,
				getSupervisor: detectRunningSupervisor,
				fetchLatestVersion: async (maxAgeMs) => {
					const latest = await versionService.getLatestVersion(currentVersion ?? undefined, { maxAgeMs });
					if (currentVersion) versionService.recordCheckResult(currentVersion, latest);
					return latest;
				},
				getBusyAgents: () => RestartDrainService.getInstance().getReadiness().busyAgents,
				isShutdownInProgress: () => {
					const drain = RestartDrainService.getInstance();
					return this.isShuttingDown || drain.isDeliveryPaused() || drain.isDraining();
				},
				getInstaller: () => AutoUpdateService.getInstance(),
				checkInputGuard: (build) => this.checkInputGuardWithNewBuild(build),
				notifyOwner: (title, message) =>
					getSlackService().sendNotification({
						type: 'project_update',
						title,
						message,
						urgency: 'normal',
						timestamp: new Date().toISOString(),
					}),
				requestGracefulRestart: (reason, options) =>
					RestartDrainService.getInstance().requestGracefulShutdown({
						reason,
						exitCode: options?.exitCode ?? PROCESS_EXIT_CODES.RESTART_REQUESTED,
						...(options?.drain === false ? { drain: false } : {}),
					}),
				windDown,
				writeShutdownMarker: () => writeShutdownMarker(crewlyHome),
				clearShutdownMarker: () => clearShutdownMarker(crewlyHome),
				exit: (code) => process.exit(code),
				spawnReplacement: (supervisorUnknown) => {
					const cwd = install.packageRoot ?? safeProcessCwd() ?? crewlyHome;
					spawnReplacementLauncher(
						buildReplacementPlan({
							execPath: process.execPath,
							execArgv: process.execArgv,
							argv: process.argv,
							cwd,
							pid: process.pid,
							port: this.config.webPort,
							crewlyHome,
							supervisorUnknown,
						}),
						crewlyHome,
					);
				},
				logger: LoggerService.getInstance().createComponentLogger('SystemControl'),
				now: Date.now,
				sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			});
			SystemControlService.setInstance(service);
			service.handleBoot();
		} catch (error) {
			this.logger.warn('Upgrade/restart controls not started (non-fatal)', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Create and start the AutoUpdateService with the server's live hooks:
	 * the npm registry check (also refreshing `/health`), the quiet-window
	 * probe (turns in flight + active agents in_progress), the graceful
	 * restart, and the owner notification path (SlackService.sendNotification,
	 * which DMs the workspace owner). Never throws.
	 */
	private startAutoUpdate(): void {
		try {
			const versionService = VersionCheckService.getInstance();
			const service = createAutoUpdateService({
				crewlyHome: this.config.crewlyHome,
				getSettingEnabled: async () => (await getSettingsService().getSettings()).general.autoUpdate,
				fetchLatestVersion: async (currentVersion) => {
					const latest = await versionService.getLatestVersion(currentVersion, {
						maxAgeMs: AUTO_UPDATE_CONSTANTS.REGISTRY_MAX_AGE_MS,
					});
					versionService.recordCheckResult(currentVersion, latest);
					return latest;
				},
				isRestartInProgress: () => {
					const drain = RestartDrainService.getInstance();
					return (
						this.isShuttingDown ||
						drain.isDeliveryPaused() ||
						drain.isDraining() ||
						SystemControlService.getInstance()?.isActionInProgress() === true
					);
				},
				getBusy: async () => {
					const midTurn = InFlightTurnTracker.getInstance().getMidTurn().map((t) => t.sessionName);
					const inProgress: string[] = [];
					const isBusy = (agentStatus: string, workingStatus: string): boolean =>
						agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE &&
						workingStatus === CREWLY_CONSTANTS.WORKING_STATUSES.IN_PROGRESS;
					for (const team of await this.storageService.getTeams()) {
						for (const member of team.members ?? []) {
							if (isBusy(member.agentStatus, member.workingStatus)) inProgress.push(member.sessionName);
						}
					}
					const orc = await this.storageService.getOrchestratorStatus().catch(() => null);
					if (orc && isBusy(orc.agentStatus, orc.workingStatus)) inProgress.push(orc.sessionName);
					return { midTurn, inProgress };
				},
				requestRestart: (reason, exitCode) =>
					RestartDrainService.getInstance().requestGracefulShutdown({ reason, exitCode }),
				isNotifyReady: () => getSlackService().isConnected(),
				notifyOwner: (title, message) =>
					getSlackService().sendNotification({
						type: 'project_update',
						title,
						message,
						urgency: 'normal',
						timestamp: new Date().toISOString(),
					}),
				getDeviceName: async () => (await DeviceIdentityService.getInstance().getOrCreateIdentity()).deviceName,
				checkInputGuard: (build) => this.checkInputGuardWithNewBuild(build),
			});
			AutoUpdateService.setInstance(service);
			service.start();
		} catch (error) {
			this.logger.warn('Auto-update not started (non-fatal)', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Start the Cloud disconnect notice: DM the owner on Slack when this
	 * machine has lost Crewly Cloud (sign-in expired, Cloud unreachable), with
	 * a re-login link from `crewly cloud login` run by Crewly itself. The DM
	 * goes straight through the Slack Web API with the orchestrator's own bot
	 * (falling back to the workspace bot) — outbound Slack needs no Cloud.
	 * Off with `CREWLY_CLOUD_DISCONNECT_NOTICE=0`. Never throws.
	 */
	private startCloudDisconnectNotice(): void {
		if (!isNoticeEnabled(process.env[CLOUD_DISCONNECT_NOTICE_CONSTANTS.ENV_SWITCH])) {
			this.logger.info('Cloud disconnect notice off (CREWLY_CLOUD_DISCONNECT_NOTICE=0)');
			return;
		}
		try {
			const service = createCloudDisconnectNoticeService({
				crewlyHome: this.config.crewlyHome,
				getDm: () => {
					const slack = getSlackService();
					const ownerUserId = slack.getOwnerUserId?.() ?? null;
					const botToken =
						getSlackAgentIdentityService()?.getInstalled(ORCHESTRATOR_SESSION_NAME)?.botToken ?? slack.getBotToken();
					return ownerUserId && botToken ? createOwnerDirectDm({ botToken, ownerUserId }) : null;
				},
				reconnect: async () => {
					// The CLI already POSTed /api/cloud/connect; connect again from
					// the saved config so CloudSync surely runs on the new token
					// (the CLI may target another port, or sync was mid-error).
					const { CloudClientService } = await import('./services/cloud/cloud-client.service.js');
					const { CloudSyncService } = await import('./services/cloud/cloud-sync.service.js');
					const { performCloudConnect } = await import('./controllers/cloud/cloud.controller.js');
					const config = await CloudClientService.getInstance().loadPersistedConfig();
					if (!config) return false;
					CloudSyncService.getInstance().stop();
					await performCloudConnect({ cloudUrl: config.cloudUrl, token: config.token, refreshToken: config.refreshToken });
					return CloudSyncService.getInstance().getState() === 'syncing';
				},
				getDeviceName: async () => (await DeviceIdentityService.getInstance().getOrCreateIdentity()).deviceName,
			});
			service.start();
			this.cloudDisconnectNotice = service;
		} catch (error) {
			this.logger.warn('Cloud disconnect notice not started (non-fatal)', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Start the conversation uploader: drains chat.db's cloud_outbox to Crewly
	 * Cloud and backfills the plan window on first sign-in. The owner gets one
	 * Slack DM (straight through the Web API, like the disconnect notice) the
	 * first time history reaches Cloud. Never throws.
	 */
	private async startConversationCloudSync(): Promise<void> {
		try {
			const [
				{ ConversationCloudSyncService, setConversationCloudSyncService },
				{ CloudClientService },
				{ VersionCheckService },
				{ buildAgentRoster },
				{ cloudTalkCapabilities },
				{ waitingActionCapabilities },
				{ talkTranscribeCapabilities },
			] = await Promise.all([
				import('./services/cloud/conversation-cloud-sync.service.js'),
				import('./services/cloud/cloud-client.service.js'),
				import('./services/system/version-check.service.js'),
				import('./services/cloud/agent-roster.utils.js'),
				import('./services/cloud/cloud-talk-inbound.service.js'),
				import('./services/cloud/waiting-actions-inbound.service.js'),
				import('./services/talk/talk-transcribe.service.js'),
			]);
			const chat = getChatV2Service();
			const cloud = CloudClientService.getInstance();
			const service = new ConversationCloudSyncService({
				outbox: chat.getCloudOutbox(),
				cloud: {
					getToken: () => cloud.getToken(),
					getCloudUrl: () => cloud.getCloudUrl(),
					tryRefreshToken: () => cloud.tryRefreshToken(),
				},
				identity: async () => {
					const id = await DeviceIdentityService.getInstance().getOrCreateIdentity();
					return { instanceId: id.deviceId, deviceName: id.deviceName };
				},
				homeId: getCrewlyHomeId(this.config.crewlyHome),
				crewlyVersion: async () => VersionCheckService.getInstance().getLocalVersion(),
				// Cloud Talk: every agent (listed before it has messages) and
				// whether this machine takes `talk_message` — also for machines
				// without Slack, which never send the registry heartbeat.
				roster: async () => buildAgentRoster(await this.storageService.getTeams()),
				capabilities: () => [...cloudTalkCapabilities(), ...waitingActionCapabilities(), ...talkTranscribeCapabilities(), ...driveCapabilities()],
				onNewMessage: (listener) => {
					chat.on('chat_message', listener);
					return () => chat.off('chat_message', listener);
				},
				reclassifyOwnerRows: () => {
					const ownerSlackUserId = getSlackService().getOwnerUserId?.() ?? null;
					chat.reclassifyOwnerRows(() => ({ slackUserId: ownerSlackUserId }));
				},
				notifyOwner: async (text) => {
					const slack = getSlackService();
					const ownerUserId = slack.getOwnerUserId?.() ?? null;
					const botToken =
						getSlackAgentIdentityService()?.getInstalled(ORCHESTRATOR_SESSION_NAME)?.botToken ?? slack.getBotToken();
					if (!ownerUserId || !botToken) return false;
					await createOwnerDirectDm({ botToken, ownerUserId }).send(text);
					return true;
				},
			});
			setConversationCloudSyncService(service);
			service.start();
			this.conversationCloudSync = service;
		} catch (error) {
			this.logger.warn('Conversation cloud sync not started (non-fatal)', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}


	/**
	 * Start the "waiting on you" uploader: tickets in 待验收 go to Crewly Cloud
	 * as text snapshots when they change (and every 5 minutes), so the portal
	 * lists what waits on the owner across machines. Never throws.
	 */
	private async startWaitingItemsSync(): Promise<void> {
		try {
			const [
				{ WaitingItemsSyncService, setWaitingItemsSyncService },
				{ CloudClientService },
				{ VersionCheckService },
				{ buildAgentRoster },
				{ cloudTalkCapabilities },
				{ waitingActionCapabilities },
				{ talkTranscribeCapabilities },
				{ getTicketIntakeService },
			] = await Promise.all([
				import('./services/cloud/waiting-items-sync.service.js'),
				import('./services/cloud/cloud-client.service.js'),
				import('./services/system/version-check.service.js'),
				import('./services/cloud/agent-roster.utils.js'),
				import('./services/cloud/cloud-talk-inbound.service.js'),
				import('./services/cloud/waiting-actions-inbound.service.js'),
				import('./services/talk/talk-transcribe.service.js'),
				import('./services/v3/ticket-intake.service.js'),
			]);
			const cloud = CloudClientService.getInstance();
			const service = new WaitingItemsSyncService({
				listWaiting: async () => {
					const intake = getTicketIntakeService();
					// Never upload an empty set just because tickets are not wired yet.
					if (!intake) throw new Error('ticket service is not ready');
					// Only tickets that can be in 待验收 need their WorkItems looked up
					// (this runs every 30 s; done / cancelled / no-review tickets never are).
					const candidates = (await RequestService.getInstance().listAll()).filter(
						(r) => typeof r.ticketNumber === 'number' && r.requiresConfirmation && r.status !== 'done' && r.status !== 'cancelled',
					);
					const rows = await Promise.all(candidates.map((r) => intake.toListItem(r)));
					return rows.filter((row) => row.column === 'to_review');
				},
				cloud: {
					getToken: () => cloud.getToken(),
					getCloudUrl: () => cloud.getCloudUrl(),
					tryRefreshToken: () => cloud.tryRefreshToken(),
				},
				identity: async () => {
					const id = await DeviceIdentityService.getInstance().getOrCreateIdentity();
					return { instanceId: id.deviceId, deviceName: id.deviceName };
				},
				crewlyVersion: async () => VersionCheckService.getInstance().getLocalVersion(),
				agentNames: async () =>
					new Map(
						buildAgentRoster(await this.storageService.getTeams())
							.filter((a) => a.displayName)
							.map((a) => [a.agentSession, a.displayName as string]),
					),
				capabilities: () => [...cloudTalkCapabilities(), ...waitingActionCapabilities(), ...talkTranscribeCapabilities(), ...driveCapabilities()],
				onTicketChange: (listener) => RequestService.getInstance().onChange(() => listener()),
			});
			setWaitingItemsSyncService(service);
			service.start();
			this.waitingItemsSync = service;
		} catch (error) {
			this.logger.warn('"Waiting on you" sync not started (non-fatal)', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	/**
	 * Load interrupted turns left by the previous shutdown (fresh ones only).
	 */
	private loadInterruptedTurnsAtBoot(): void {
		try {
			const file = interruptedTurnsPath(this.config.crewlyHome);
			const { fresh, dropped } = loadInterruptedTurns(file);
			this.interruptedTurnsAtBoot = fresh;
			if (dropped > 0) {
				this.logger.info('Dropped stale interrupted turns from the previous run', { dropped });
			}
			if (fresh.length > 0) {
				this.logger.info('Found turns interrupted by the last restart; their agents will be restored and resumed', {
					count: fresh.length,
					sessions: [...new Set(fresh.map((t) => t.sessionName))],
				});
			} else if (dropped > 0) {
				writeInterruptedTurns(file, []);
			}
		} catch (error) {
			this.logger.warn('Could not read interrupted turns (non-fatal)', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Owner promises and owed answers left by the previous run. Their agents
	 * are restored on boot even when idle (specs/2026-10-02-restart-busy-and-resume.md).
	 * Never throws.
	 *
	 * @returns Open commitments and the agents owing an answer
	 */
	/**
	 * Sessions an owner thread waits on at boot: the owner-thread sentinel's
	 * persisted threads (promise / unanswered owner message / open card) and
	 * the askers of open owner cards from the last day. Read from disk: the
	 * restore can run before the sentinel and the decision service start.
	 *
	 * @returns Session names (never the orchestrator)
	 */
	private async ownerThreadSessionsAtBoot(): Promise<string[]> {
		const { ownerThreadSessionsAtBoot } = await import('./services/messaging/owner-thread-sentinel.wiring.js');
		const sessions = await ownerThreadSessionsAtBoot(this.config.crewlyHome, Date.now(), (msg, error) =>
			this.logger.warn(msg, { error: error instanceof Error ? error.message : String(error) }),
		);
		if (sessions.length > 0) this.logger.info('Owner threads wait on these agents; restoring them as work in hand', { sessions });
		return sessions;
	}

	private async loadOwedWorkAtBoot(): Promise<OwedCommitment[]> {
		let commitments: OwedCommitment[] = [];
		try {
			const { owedCommitments } = await import('./services/open-items/open-items.service.js');
			commitments = owedCommitments(await RequestService.getInstance().listAll(), new Date());
		} catch (error) {
			this.logger.warn('Could not read open owner promises at boot (non-fatal)', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this.openCommitmentsAtBoot = commitments;
		if (commitments.length > 0) {
			this.logger.info('Owner promises past due and never nudged; their agents will be restored and reminded once', {
				commitments: commitments.map((c) => ({ session: c.sessionName, ticket: c.ticket, due: c.due })),
			});
		}
		return commitments;
	}

	/**
	 * Remind restored agents of the owner promises they still owe, once each,
	 * skipping agents that already get an interrupted-turn note.
	 *
	 * @param interrupted - The interrupted entries being resumed
	 */
	private async remindOpenCommitmentsAfterBoot(interrupted: readonly InterruptedTurnEntry[]): Promise<void> {
		const commitments = this.openCommitmentsAtBoot;
		this.openCommitmentsAtBoot = [];
		if (commitments.length === 0) return;
		const registration = this.apiController.agentRegistrationService;
		const isRunning = (name: string): boolean =>
			Boolean(getSessionBackendSync()?.sessionExists(name)) || Boolean(registration.getInProcessRuntime(name));
		// One reminder per promise, ever: recorded (as the nudge) before it is
		// sent, so neither the next boot nor the sweep sends another.
		const { markRestartReminded, OpenItemsService } = await import('./services/open-items/open-items.service.js');
		// Through the service's queue when it runs: the sweep may be nudging the same promise.
		const openItems = OpenItemsService.getInstance();
		const markReminded = (requestId: string, itemId: string): Promise<boolean> =>
			openItems ? openItems.markRestartReminded(requestId, itemId) : markRestartReminded(RequestService.getInstance(), requestId, itemId);
		const covered = new Set(interrupted.map((e) => e.sessionName));
		const marked: OwedCommitment[] = [];
		for (const c of commitments) {
			if (covered.has(c.sessionName) || !isRunning(c.sessionName)) continue;
			try {
				if (await markReminded(c.requestId, c.itemId)) marked.push(c);
			} catch (error) {
				this.logger.warn('Could not record a restart reminder; not sending it', {
					sessionName: c.sessionName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const notes = planCommitmentNotes(marked, interrupted, isRunning);
		for (const note of notes) {
			try {
				const result = await registration.sendMessageToAgent(note.sessionName, note.text);
				this.logger.info('Reminded a restored agent of the owner promise it still owes', {
					sessionName: note.sessionName,
					delivered: result.success,
					queuedUntilRegistered: result.queued === true,
				});
			} catch (error) {
				this.logger.warn('Could not remind a restored agent of its owner promise', {
					sessionName: note.sessionName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/**
	 * Re-deliver the turns the previous shutdown cut off, then clear the file.
	 * The file is rewritten after each entry so a restart during this pass
	 * neither loses nor repeats work.
	 */
	private async resumeInterruptedTurnsAfterBoot(): Promise<void> {
		const entries = this.interruptedTurnsAtBoot;
		await this.remindOpenCommitmentsAfterBoot(entries);
		if (entries.length === 0) return;
		this.interruptedTurnsAtBoot = [];
		const file = interruptedTurnsPath(this.config.crewlyHome);
		const registration = this.apiController.agentRegistrationService;
		try {
			const summary = await resumeInterruptedTurns(entries, {
				orchestratorSession: ORCHESTRATOR_SESSION_NAME,
				isSessionRunning: (name) =>
					Boolean(getSessionBackendSync()?.sessionExists(name)) || Boolean(registration.getInProcessRuntime(name)),
				enqueue: (input) => {
					this.messageQueueService.enqueue(input);
				},
				sendMessageToAgent: (name, text) => registration.sendMessageToAgent(name, text),
				waitForOrchestratorActive: async () => {
					const deadline = Date.now() + SAFE_RESTART.RESUME_ORC_READY_TIMEOUT_MS;
					while (Date.now() < deadline) {
						if (this.isShuttingDown) return false;
						const status = await this.storageService.getOrchestratorStatus().catch(() => null);
						if (status?.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE) return true;
						await new Promise((resolve) => setTimeout(resolve, SAFE_RESTART.RESUME_ORC_POLL_MS));
					}
					return false;
				},
				onEntryHandled: (_entry, remaining) => {
					try {
						writeInterruptedTurns(file, remaining);
					} catch {
						// Best-effort bookkeeping; the in-memory pass continues.
					}
				},
				logger: this.logger,
			});
			this.logger.info('Interrupted-turn resume complete', { ...summary });
		} catch (error) {
			this.logger.warn('Interrupted-turn resume failed (non-fatal)', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Drain in-flight agent turns before the rest of shutdown, and persist
	 * whatever is still mid-turn when the drain ends.
	 *
	 * @param reason - Why we are shutting down (signal or caller)
	 * @param drainEnabled - False to skip the wait (crash paths)
	 */
	private async drainInFlightTurns(reason: string, drainEnabled: boolean): Promise<void> {
		try {
			const drain = RestartDrainService.getInstance();
			drain.pauseDelivery(reason);
			const budget = this.supervisorStopBudgetMs;
			const margin = SAFE_RESTART.SHUTDOWN_MARGIN_MS;
			const timeoutMs = drainEnabled ? capDrainToSupervisor(resolveRestartDrainMs(process.env), budget, margin) : 0;
			const backgroundTimeoutMs = drainEnabled ? capDrainToSupervisor(resolveBackgroundDrainMs(process.env), budget, margin) : 0;
			const result = await drain.drain({ timeoutMs, backgroundTimeoutMs });
			if (result.remaining.length > 0) {
				const saved = saveInterruptedTurns(
					interruptedTurnsPath(this.config.crewlyHome),
					result.remaining,
					`${reason}: ${result.outcome}`,
				);
				this.logger.warn('Persisted interrupted agent turns for resume after restart', {
					outcome: result.outcome,
					sessions: result.remaining.map((t) => t.sessionName),
					entries: saved,
				});
			}
		} catch (error) {
			// Never let the drain block shutdown.
			this.logger.error('Restart drain failed; continuing shutdown', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private startHealthMonitoring(): void {
		this.logger.info('Starting health monitoring...');

		// Monitor memory usage every 30 seconds
		this.healthMonitoringInterval = setInterval(() => {
			this.logMemoryUsage();
		}, 30000);

		// V3: Periodic TTL-based auto-close for open Requests (every 2 min)
		// Catches direct orchestrator responses that finish within a single poll cycle
		// and never trigger the EventBus agent:idle event
		setInterval(() => this.autoCloseOpenRequests(), 2 * 60 * 1000);

		// V3: Mission OKR Reminders (every hour)
		// Scans active missions and sends Slack alerts for off-track KRs
		setInterval(async () => {
			try {
				await MissionReminderService.getInstance().runSweep();
			} catch (err) {
				this.logger.warn('Mission OKR reminder sweep failed', { error: String(err) });
			}
		}, 60 * 60 * 1000);

		// Purge done Requests and WorkItems older than 24h (every hour)
		setInterval(() => this.purgeCompletedData(), 60 * 60 * 1000);
		// Run once at startup after a short delay
		setTimeout(() => this.purgeCompletedData(), 30 * 1000);
		setTimeout(async () => {
			try {
				await MissionReminderService.getInstance().runSweep();
			} catch (err) {
				// Non-critical
			}
		}, 60 * 1000);
	}

	/**
	 * Removes done/cancelled Requests older than 24h from disk,
	 * and purges done/cancelled/failed WorkItems from the task pool.
	 * Memory, knowledge, and learnings are never purged.
	 */
	private purgeCompletedData(): void {
		setImmediate(async () => {
			const RETENTION_MS = 24 * 60 * 60 * 1000;
			const cutoff = Date.now() - RETENTION_MS;

			// 1. Purge done Requests
			try {
				const { RequestService } = await import('./services/v3/request.service.js');
				const svc = RequestService.getInstance();
				const all = await svc.listAll();
				let purgedRequests = 0;
				const ticketCutoff = Date.now() - TICKET_CONSTANTS.ARCHIVE.AFTER_MS;
				let archivedTickets = 0;
				for (const req of all) {
					if (req.status !== 'done' && req.status !== 'cancelled') continue;
					const completedAt = req.completedAt ? new Date(req.completedAt).getTime() : 0;
					const createdAt = new Date(req.createdAt).getTime();
					const age = completedAt || createdAt;
					// Tickets are the owner's record of what they asked for: they
					// stay on the board for 30 days, then move to requests/archive/
					// — never deleted (ticket loop Phase 3). Before this, every
					// accepted ticket was deleted a day after it closed.
					if (typeof req.ticketNumber === 'number') {
						if (age < ticketCutoff && (await svc.archive(req.id))) archivedTickets++;
						continue;
					}
					if (age < cutoff) {
						await svc.delete(req.id);
						purgedRequests++;
					}
				}
				if (purgedRequests > 0 || archivedTickets > 0) {
					this.logger.info('Purged old completed Requests', { count: purgedRequests, archivedTickets });
				}
			} catch (err) {
				this.logger.warn('Request purge failed (non-critical)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}

			// 2. Purge done/cancelled/failed WorkItems from pool
			try {
				const { TaskPoolService } = await import('./services/task-pool/task-pool.service.js');
				const pool = TaskPoolService.getInstance();
				const allItems = await pool.getAllItems();
				const terminalStatuses = new Set(['done', 'cancelled', 'failed']);
				let purgedItems = 0;
				for (const wi of allItems) {
					if (!terminalStatuses.has(wi.status)) continue;
					const completedAt = wi.completedAt ? new Date(wi.completedAt).getTime() : 0;
					const createdAt = new Date(wi.createdAt).getTime();
					const age = completedAt || createdAt;
					if (age < cutoff) {
						await pool.removeItem(wi.id);
						purgedItems++;
					}
				}
				if (purgedItems > 0) {
					this.logger.info('Purged old completed WorkItems', { count: purgedItems });
				}
			} catch (err) {
				this.logger.warn('WorkItem purge failed (non-critical)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		});
	}

	/**
	 * Closes open Requests that were created within the last 10 minutes.
	 * Used to handle direct orchestrator responses that don't go through WorkItems.
	 * Also rolls up orchestrator token usage and sets ownerAgent for the Request.
	 *
	 * Token source varies by runtime:
	 *   - claude-code: reads session JSONL (TUI status bar not capturable from PTY)
	 *   - gemini-cli / codex-cli: reads from TokenUsageService (fed by PTY parser)
	 *   - crewly-agent: reads from TokenUsageService (fed by SDK)
	 */
	/**
	 * Deliver anything queued for an agent that has just gone idle.
	 *
	 * The queue is written whenever delivery finds the agent busy, but until
	 * now the only reader ran inside `registerMemberStatus`. A message
	 * re-queued after that flush therefore waited for the next registration,
	 * which in practice meant a restart — the owner's second question sat in
	 * the queue while the agent answered only the first (2026-09-21).
	 *
	 * Best-effort and self-limiting: a delivery that finds the agent busy
	 * again re-queues, and the next idle event picks it up.
	 *
	 * @param sessionName - The agent that just went idle
	 * @returns When every queued message has been attempted
	 */
	/** Last time a session was woken for queued messages (loop guard). */
	private readonly queuedWakeAt = new Map<string, number>();

	/**
	 * Start the unanswered-owner-message watchdog and feed it what the owner
	 * can see: Slack posts (any bot, any machine), chat-v2 agent turns,
	 * working-status changes. Placeholder answered/settled signals are wired
	 * where the placeholder service is built (slack-initializer).
	 * specs/2026-09-30-owner-message-guarantee.md
	 *
	 * @param chatV2 - The chat-v2 service (turn events, system notes)
	 */
	/**
	 * Start decision cards: the service, its Slack listeners and its deadline tick.
	 */
	/**
	 * Record Codex (rollout files) and Antigravity (conversation databases)
	 * usage in the shared token ledger, attributed to Crewly sessions.
	 *
	 * @param tokenUsage - The ledger
	 */
	private async startRuntimeUsageSyncs(tokenUsage: TokenUsageService): Promise<void> {
		const crewlyHome = this.config.crewlyHome;
		const sessions = () => getSessionStatePersistence().getRegisteredSessionsMap();
		try {
			const { CodexRolloutSyncService } = await import('./services/monitoring/codex-rollout-sync.service.js');
			const { defaultCodexHome } = await import('./services/agent/runtime-session-recovery.js');
			const codex = new CodexRolloutSyncService({
				codexHome: defaultCodexHome(),
				cursorFile: path.join(crewlyHome, CODEX_USAGE_SYNC_CONSTANTS.CURSOR_FILE),
				sessions,
				record: (session, e) =>
					tokenUsage.recordUsage(session, session, e.input, e.output, e.model, undefined, {
						cachedInput: e.cachedInput,
						timestamp: e.timestamp,
						runtime: RUNTIME_TYPES.CODEX_CLI,
					}),
				logger: LoggerService.getInstance().createComponentLogger('CodexUsageSync'),
			});
			await codex.start();
		} catch (err) {
			this.logger.warn('Codex usage sync not started (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
		}
		try {
			const { AntigravityUsageSyncService, sqliteStepReader } = await import('./services/monitoring/antigravity-usage-sync.service.js');
			const { getAntigravityConfigDir } = await import('./utils/antigravity-settings.utils.js');
			const { createBareModuleRequire } = await import('./utils/node-require.utils.js');
			const agy = new AntigravityUsageSyncService({
				configDir: getAntigravityConfigDir(),
				cursorFile: path.join(crewlyHome, ANTIGRAVITY_USAGE_SYNC_CONSTANTS.CURSOR_FILE),
				sessions,
				readSteps: sqliteStepReader(createBareModuleRequire(typeof require === 'function' ? require : null)),
				record: (session, e) =>
					tokenUsage.recordUsage(session, session, e.input, e.output, e.model, undefined, {
						timestamp: e.timestamp,
						runtime: RUNTIME_TYPES.ANTIGRAVITY_CLI,
					}),
				logger: LoggerService.getInstance().createComponentLogger('AntigravityUsageSync'),
			});
			await agy.start();
		} catch (err) {
			this.logger.warn('Antigravity usage sync not started (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
		}
	}

	private async startCrewlyApps(): Promise<void> {
		try {
			const { startAppWake } = await import('./services/apps/apps.wiring.js');
			startAppWake({
				skillsPath: path.join(findPackageRoot(__dirname), 'config', 'skills', 'agent'),
				getTeams: () => this.storageService.getTeams(),
				sessionExists: (session) => {
					try {
						return getSessionBackendSync()?.sessionExists(session) ?? false;
					} catch {
						return false;
					}
				},
				sendToAgent: async (session, text, activate) => {
					let exists = false;
					try {
						exists = getSessionBackendSync()?.sessionExists(session) ?? false;
					} catch {
						exists = false;
					}
					if (!exists) {
						// Only the app's publisher is started; an `ask` never starts a stopped agent.
						if (!activate) return false;
						const { activateAgentBySession } = await import('./controllers/team/team.controller.js');
						await activateAgentBySession(this.apiController, session).catch(() => undefined);
					}
					const result = await this.apiController.agentRegistrationService.sendMessageToAgent(session, text);
					return result.success;
				},
				sendToOrchestrator: async (text) => {
					this.messageQueueService.enqueue({ content: text, conversationId: 'system', source: 'system_event' });
					return true;
				},
			});
			this.logger.info('Crewly Apps change poller started');
			// App comments for apps owned by a team or channel go into that room;
			// agents' replies there are added to the app's comment (apps/SPEC.md §15).
			await import('./services/apps/apps.wiring.js')
				.then((m) => m.attachAppCommentRoom())
				.catch((err) => this.logger.warn('App comment rooms not wired (non-critical)', { error: err instanceof Error ? err.message : String(err) }));
		} catch (error) {
			this.logger.warn('Crewly Apps change poller not started (non-critical)', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async startDecisionCards(): Promise<void> {
		try {
			const { createDecisionService, attachDecisionSlackListeners, attachSkipAllCommand } = await import('./services/decisions/decision.wiring.js');
			const { DecisionService } = await import('./services/decisions/decision.service.js');
			const RUNNING: ReadonlySet<string> = new Set(['running', 'accepted', 'proposed']);
			const sendToAgent = async (session: string, text: string): Promise<boolean> => {
				let exists = false;
				try {
					exists = getSessionBackendSync()?.sessionExists(session) ?? false;
				} catch {
					exists = false;
				}
				if (!exists) {
					const { activateAgentBySession } = await import('./controllers/team/team.controller.js');
					await activateAgentBySession(this.apiController, session).catch(() => undefined);
				}
				const result = await this.apiController.agentRegistrationService.sendMessageToAgent(session, text);
				return result.success;
			};
			const decisions = createDecisionService({
				crewlyHome: this.config.crewlyHome,
				getTeams: () => this.storageService.getTeams(),
				sendToAgent,
				sendToOrchestrator: async (text) => {
					this.messageQueueService.enqueue({ content: text, conversationId: 'system', source: 'system_event' });
					return true;
				},
				// An answer the asker could not take now waits on its queue (crewly#1015 §9).
				queueForAgent: (session, text) => {
					SubAgentMessageQueue.getInstance().enqueue(session, text);
					return true;
				},
				currentWorkItemId: async (session) => {
					const items = await TaskPoolService.getInstance().getAllItems().catch(() => []);
					const mine = items
						.filter((wi) => wi.target === session && RUNNING.has(wi.status))
						.sort((a, b) => Date.parse(b.startedAt ?? b.createdAt) - Date.parse(a.startedAt ?? a.createdAt));
					return mine[0]?.id;
				},
				workDestination: async (session) => {
					try {
						const { resolveAgentSlackDestination } = await import('./services/orc/work-item-destination.wiring.js');
						return await resolveAgentSlackDestination(session);
					} catch {
						return null;
					}
				},
			});
			DecisionService.getInstance()?.stop();
			DecisionService.setInstance(decisions);
			attachDecisionSlackListeners(decisions);
			// "skip all old cards" / 「清掉旧卡片」 in the owner's orc DM.
			await attachSkipAllCommand(decisions).catch((err) =>
				this.logger.warn('Skip-all command not wired (non-critical)', { error: err instanceof Error ? err.message : String(err) }),
			);
			// The owner's replies in an App comment's Slack thread go to the comment.
			await import('./services/apps/apps.wiring.js')
				.then((m) => m.attachAppCommentsSlackInterceptor())
				.catch((err) => this.logger.warn('App comment Slack replies not wired (non-critical)', { error: err instanceof Error ? err.message : String(err) }));
			// Apps: an agent's request to add its team to an app becomes an owner card.
			await import('./services/apps/apps.wiring.js')
				.then((m) => m.attachAppCollaboratorDecisions(decisions, (kind, handler) => DecisionService.registerKindHandler(kind, handler)))
				.catch((err) => this.logger.warn('App collaborator cards not wired (non-critical)', { error: err instanceof Error ? err.message : String(err) }));
			// Model tiers (crewly#1173): the lead's weekly usage review and the
			// owner's one card per review that applies tier changes.
			await import('./services/model-tiers/model-tier.wiring.js')
				.then((m) => m.startModelTiers({ crewlyHome: this.config.crewlyHome, decisions, sendToAgent, packageRoot: findPackageRoot(__dirname) }))
				.catch((err) => this.logger.warn('Model tier reviews not wired (non-critical)', { error: err instanceof Error ? err.message : String(err) }));
			decisions.start();
			this.logger.info('Decision cards started');
			// Google reconnect cards: a Gmail/Drive call that fails for a missing
			// scope or an expired grant posts the owner a one-tap card in Slack
			// and tells the agent to retry once it lands (2026-10-08).
			try {
				const { startGoogleReauthNotifier } = await import('./services/google/google-reauth.wiring.js');
				startGoogleReauthNotifier({ sendToAgent });
			} catch (err) {
				this.logger.warn('Google reconnect cards not wired (non-critical)', { error: err instanceof Error ? err.message : String(err) });
			}
			// Daily signal digest (#987, specs/2026-10-03-signal-digest.md): Do / Skip
			// per action on one card; Do opens an experiment ticket.
			const { createSignalDigestService, attachSignalDigestSlackListeners } = await import('./services/signal-digest/signal-digest.wiring.js');
			const { SignalDigestService } = await import('./services/signal-digest/signal-digest.service.js');
			const signalDigests = createSignalDigestService({ crewlyHome: this.config.crewlyHome, getTeams: () => this.storageService.getTeams(), sendToAgent });
			SignalDigestService.setInstance(signalDigests);
			attachSignalDigestSlackListeners(signalDigests);
			// Runtime Terms consent (specs/2026-10-01-runtime-terms-consent.md): the
			// owner agrees to a runtime's first-run Terms from a Slack card.
			const { startRuntimeTerms } = await import('./services/runtime-terms/runtime-terms.wiring.js');
			startRuntimeTerms({ crewlyHome: this.config.crewlyHome, decisions, machineName: () => os.hostname().replace(/\.local$/, '') });
			// Open items (specs/2026-10-01-reply-open-items.md): commitments and
			// questions in agents' replies to the owner are tracked until done.
			const { startOpenItems } = await import('./services/open-items/open-items.wiring.js');
			startOpenItems({
				getTeams: () => this.storageService.getTeams(),
				sendToAgent: async (session, text) => {
					let exists = false;
					try {
						exists = getSessionBackendSync()?.sessionExists(session) ?? false;
					} catch {
						exists = false;
					}
					if (!exists) {
						const { activateAgentBySession } = await import('./controllers/team/team.controller.js');
						await activateAgentBySession(this.apiController, session).catch(() => undefined);
					}
					const result = await this.apiController.agentRegistrationService.sendMessageToAgent(session, text);
					return result.success;
				},
				recordChatNote: (chatChannelId, threadId, text) => {
					try {
						getChatV2Service().recordTurn({
							channelId: chatChannelId,
							senderType: 'system',
							senderId: 'crewly',
							content: text,
							...(threadId ? { threadId } : {}),
							metadata: { source: 'system' },
						});
						return true;
					} catch {
						return false;
					}
				},
			});
			this.logger.info('Open items started');
		} catch (error) {
			this.logger.warn('Decision cards not started', { error: error instanceof Error ? error.message : String(error) });
		}
		// Held browser actions from before the restart: re-attach or expire
		// (after the decision service, so expired cards are updated).
		try {
			const { BrowserApprovalService } = await import('./services/browser/browser-approval.service.js');
			await BrowserApprovalService.getInstance()?.restore();
		} catch (error) {
			this.logger.warn('Held browser actions not restored', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Finished owner-requested work is reported back where the owner asked
	 * (services/orc/owner-completion-report.service.ts). Best-effort: a
	 * failure here never affects boot.
	 *
	 * @param chatV2 - The chat-v2 service (agent posts count as answers)
	 */
	private async startOwnerCompletionReport(chatV2: import('./services/chat-v2/chat-v2.service.js').ChatV2Service): Promise<void> {
		try {
			const { OwnerCompletionReportService, setOwnerCompletionReport } = await import('./services/orc/owner-completion-report.service.js');
			const wiring = await import('./services/orc/owner-completion-report.wiring.js');
			const { getOwnerRequestContext } = await import('./services/orc/owner-request-context.js');
			const { ownerOriginFromTurn } = await import('./services/orc/work-item-destination.js');
			const apps = await import('./services/apps/apps.wiring.js');
			// A colleague's hand-over carries the sender's fresh owner chat turn.
			getOwnerRequestContext().setTurnLookup((session, now) => {
				const turn = OrcReplyRouteService.getInstance().getFreshOrigin(session, now);
				if (!turn) return null;
				const origin = ownerOriginFromTurn(turn, session);
				return origin.kind === 'owner' ? { origin, at: turn.receivedAt } : null;
			});
			const commentLink = async (appId: string, commentId: string) => {
				const links = apps.getAppCommentsSlack();
				await links.load();
				const link = links.linkOf(appId, commentId);
				return link?.channel && link.threadTs ? { slackChannelId: link.channel, threadTs: link.threadTs } : null;
			};
			getOwnerRequestContext().setAppCommentThreadResolver(commentLink);
			const names = new Map<string, string>();
			try {
				for (const team of await this.storageService.getTeams()) {
					for (const m of team.members ?? []) if (m.sessionName && m.name) names.set(m.sessionName, m.name);
				}
			} catch {
				/* names are cosmetic */
			}
			const skillsRoot = path.join(findPackageRoot(__dirname), 'config', 'skills', 'agent');
			const service = new OwnerCompletionReportService({
				crewlyHome: this.config.crewlyHome,
				listItems: () => TaskPoolService.getInstance().getAllItems(),
				deliver: async (session, text) => {
					try {
						const exists = getSessionBackendSync()?.sessionExists(session) ?? false;
						if (!exists) {
							const { activateAgentBySession } = await import('./controllers/team/team.controller.js');
							await activateAgentBySession(this.apiController, session).catch(() => undefined);
						}
						const res = await this.apiController.agentRegistrationService.sendMessageToAgent(session, text);
						return (res as { success?: boolean } | undefined)?.success !== false;
					} catch {
						return false;
					}
				},
				resolvePlace: (origin) => wiring.resolveReportPlace(origin, commentLink),
				postFallback: (place, agent, text) =>
					wiring.postReportFallback(place, agent, text, {
						replyComment: async (appId, commentId, agentSession, body) => {
							await apps.getAppsParts().service.replyComment(appId, commentId, body, { agentSession });
						},
						slackAsAgent: async (agentSession, channel, body, threadTs) => {
							const { getSlackAgentPostService } = await import('./services/slack/slack-agent-post.service.js');
							const svc = getSlackAgentPostService();
							if (!svc) throw new Error('Slack is not connected');
							await svc.post({ agentSession, target: channel, text: body, ...(threadTs ? { threadTs } : { newTopLevel: true }) });
						},
						slackAsCrewly: async (channel, body, threadTs) => {
							await getSlackService().sendMessage({ channelId: channel, text: body, ...(threadTs ? { threadTs } : {}) });
						},
						chatAsAgent: async (conversationId, agentSession, body) => {
							const { deliverAgentReplyToConversation } = await import('./controllers/chat/chat.controller.js');
							const id = await deliverAgentReplyToConversation({ conversationId, agentSession, content: body });
							if (!id) throw new Error('the conversation did not take the post');
						},
					}),
				displayNameOf: (session) => names.get(session) ?? session,
				appCommentsCmd: `bash ${skillsRoot}/core/app-comments/execute.sh`,
			});
			setOwnerCompletionReport(service);
			chatV2.on('chat_message', (dto: import('./services/chat-v2/types.js').ChatMessageDTO) => wiring.onChatRow(service, dto));
			const slack = getSlackService();
			slack.on('outbound', (post: { channelId: string; threadTs?: string; notAnAnswer?: boolean }) => wiring.onSlackOutboundPost(service, post));
			slack.on('message', (message: { channelId: string; threadTs?: string; authorAgentSession?: string }) => wiring.onSlackInboundPost(service, message));
			service.start();
			this.logger.info('Owner completion report started', { active: service.activeRecords.length });
		} catch (error) {
			this.logger.warn('Owner completion report not started', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * An owner Slack thread is never left silent: one status line per
	 * blocking event for the agent it waits on
	 * (services/messaging/owner-thread-sentinel.service.ts). Best-effort.
	 *
	 * @param watchdog - The owner message watchdog (owner messages feed the sentinel)
	 * @param names - Session → display name (kept fresh by the watchdog's refresh)
	 */
	private async startOwnerThreadSentinel(
		watchdog: import('./services/messaging/owner-message-watchdog.service.js').OwnerMessageWatchdogService,
		names: Map<string, string>,
	): Promise<void> {
		try {
			const wiring = await import('./services/messaging/owner-thread-sentinel.wiring.js');
			const { ActivityMonitorService } = await import('./services/monitoring/activity-monitor.service.js');
			const activity = ActivityMonitorService.getInstance();
			const sentinel = wiring.createOwnerThreadSentinel({
				crewlyHome: this.config.crewlyHome,
				slack: () => getSlackService(),
				agentDmBotToken: (slackChannelId) => {
					const link = getSlackAgentDmService()?.findBySlackChannelId(slackChannelId);
					return link ? getSlackAgentIdentityService()?.getInstalled(link.agentSession)?.botToken : undefined;
				},
				botTokenOf: (session) => getSlackAgentIdentityService()?.getInstalled(session)?.botToken,
				sendToAgent: (session, text) => this.apiController.agentRegistrationService.sendMessageToAgent(session, text),
				sessionExists: (session) => {
					try {
						return getSessionBackendSync()?.sessionExists(session) ?? false;
					} catch {
						return false;
					}
				},
				activate: async (session) => {
					const { activateAgentBySession } = await import('./controllers/team/team.controller.js');
					return activateAgentBySession(this.apiController, session);
				},
				displayNameOf: (session) => (session === ORCHESTRATOR_SESSION_NAME ? 'Orc' : names.get(session) ?? session),
				listItems: () => TaskPoolService.getInstance().getAllItems(),
				workingStatusOf: (session) => activity.getObservedWorkingStatus(session) ?? null,
			});
			watchdog.onTrack((entry) => wiring.onOwnerMessageTracked(sentinel, entry));
			this.logger.info('Owner thread sentinel started', { watched: sentinel.list().length });
		} catch (error) {
			this.logger.warn('Owner thread sentinel not started', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async startOwnerMessageWatchdog(chatV2: import('./services/chat-v2/chat-v2.service.js').ChatV2Service): Promise<void> {
		try {
			const wiring = await import('./services/messaging/owner-message-watchdog.wiring.js');
			const { ActivityMonitorService } = await import('./services/monitoring/activity-monitor.service.js');
			const activity = ActivityMonitorService.getInstance();
			const names = new Map<string, string>();
			const refreshNames = async (): Promise<void> => {
				try {
					for (const team of await this.storageService.getTeams()) {
						for (const m of team.members ?? []) if (m.sessionName && m.name) names.set(m.sessionName, m.name);
					}
				} catch {
					/* names are cosmetic */
				}
			};
			await refreshNames();
			const watchdog = wiring.createOwnerMessageWatchdog({
				crewlyHome: this.config.crewlyHome,
				sendToAgent: (session, text) => this.apiController.agentRegistrationService.sendMessageToAgent(session, text),
				sessionExists: (session) => {
					try {
						return getSessionBackendSync()?.sessionExists(session) ?? false;
					} catch {
						return false;
					}
				},
				activate: async (session) => {
					const { activateAgentBySession } = await import('./controllers/team/team.controller.js');
					return activateAgentBySession(this.apiController, session);
				},
				enqueueForOrchestrator: (input) => {
					this.messageQueueService.enqueue(input as Parameters<MessageQueueService['enqueue']>[0]);
				},
				isBusy: (session) => activity.getObservedWorkingStatus(session) === 'in_progress',
				// A live session at a sign-in screen, or any agent (even a stopped
				// one) whose harness is confirmed signed out: waking it would only
				// park it on the same dead login.
				loginRequired: (session) => {
					const flagged = OAuthReloginMonitorService.getInstance().getLoginRequired(session);
					if (flagged) return flagged;
					const harnessId = getHarnessReloginService().signedOutHarnessOf(session);
					return harnessId ? { runtimeType: harnessId } : null;
				},
				displayNameOf: (session) => (session === ORCHESTRATOR_SESSION_NAME ? 'Orc' : names.get(session) ?? session),
				inputHeld: (session) => InputBlockedRetryService.getInstance().holdOf(session),
				slack: () => getSlackService(),
				owesThread: (slackChannelId, threadTs) => getSlackTypingPlaceholderService()?.owesThread(slackChannelId, threadTs) ?? false,
				agentDmBotToken: (slackChannelId) => {
					const link = getSlackAgentDmService()?.findBySlackChannelId(slackChannelId);
					return link ? getSlackAgentIdentityService()?.getInstalled(link.agentSession)?.botToken : undefined;
				},
				botTokenOf: (session) => getSlackAgentIdentityService()?.getInstalled(session)?.botToken,
				recordChatNote: (chatChannelId, threadId, text) => {
					try {
						chatV2.recordTurn({
							channelId: chatChannelId,
							senderType: 'system',
							senderId: 'crewly',
							content: text,
							...(threadId ? { threadId } : {}),
							metadata: { source: 'system', [wiring.OWNER_WATCHDOG_NOTE_METADATA_KEY]: true },
						});
						return true;
					} catch {
						return false;
					}
				},
				noteOriginThread: (session, chatChannelId, threadId) =>
					OrcReplyRouteService.getInstance().noteOriginThread(session, chatChannelId, threadId),
			});
			// Names only appear in notes; a periodic refresh is plenty.
			const namesTimer = setInterval(() => void refreshNames(), OWNER_MESSAGE_WATCHDOG_CONSTANTS.NAME_REFRESH_MS);
			namesTimer.unref?.();
			chatV2.on('chat_message', (dto: import('./services/chat-v2/types.js').ChatMessageDTO) => wiring.onChatTurn(watchdog, dto));
			const slack = getSlackService();
			slack.on('outbound', (post: { channelId: string; threadTs?: string; notAnAnswer?: boolean; kind?: string }) =>
				wiring.onSlackOutbound(watchdog, post),
			);
			slack.on('message', (message: { channelId: string; threadTs?: string; authorAgentSession?: string }) =>
				wiring.onSlackInbound(watchdog, message),
			);
			activity.onWorkingStatusChange((session, status) => watchdog.noteAgentTurn(session, status === 'in_progress'));
			this.logger.info('Owner message watchdog started', { tracked: watchdog.size });
			await this.startOwnerThreadSentinel(watchdog, names);
		} catch (error) {
			this.logger.warn('Owner message watchdog not started', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * An agent went down with messages still queued for it: start it again so
	 * they are delivered (registration drains the queue). Without this the
	 * messages waited for the next message someone happened to send — four
	 * hours for the owner's question to Atlas on 2026-09-24. At most once per
	 * session per QUEUED_WAKE_COOLDOWN_MS, so a crashing agent is not relaunched
	 * in a loop.
	 *
	 * @param sessionName - The agent that became inactive
	 */
	private wakeIfMessagesQueued(sessionName: string): void {
		if (sessionName === ORCHESTRATOR_SESSION_NAME) return;
		if (!SubAgentMessageQueue.getInstance().hasPending(sessionName)) return;
		// Stopped on purpose: hold the queue until someone starts the agent.
		if (isOwnerStopped(sessionName)) {
			this.logger.info('Holding queued messages for an agent that was stopped on purpose (not waking it)', { sessionName });
			return;
		}
		const last = this.queuedWakeAt.get(sessionName) ?? 0;
		if (Date.now() - last < SUB_AGENT_QUEUE_CONSTANTS.QUEUED_WAKE_COOLDOWN_MS) return;
		this.queuedWakeAt.set(sessionName, Date.now());
		setTimeout(() => {
			void (async () => {
				try {
					const { activateAgentBySession } = await import('./controllers/team/team.controller.js');
					const res = await activateAgentBySession(this.apiController, sessionName);
					this.logger.info('Woke an agent that went down with messages queued for it', {
						sessionName,
						success: res.success,
					});
				} catch (err) {
					this.logger.warn('Could not wake an agent with queued messages', {
						sessionName,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			})();
		}, SUB_AGENT_QUEUE_CONSTANTS.QUEUED_WAKE_DELAY_MS);
	}

	/**
	 * Write a system note into the orchestrator's own chat (the conversation
	 * the owner last used with it), and flash it on open dashboards when there
	 * is no such conversation. Used when the orchestrator itself is the agent
	 * a notice is about, so it cannot relay the notice. Never throws.
	 *
	 * @param text - The note, in English
	 */
	private tellOrchestratorChat(text: string): void {
		try {
			const gateway = this.terminalGateway;
			const conversationId = gateway?.getActiveConversationId();
			if (conversationId) {
				const chatV2 = getChatV2Service();
				const channel = chatV2.ensureChannelForLegacyConversation({ conversationId, agentSession: ORCHESTRATOR_SESSION_NAME });
				chatV2.recordTurn({ channelId: channel.id, senderType: 'system', senderId: 'system', content: text, metadata: { source: 'system' } });
				return;
			}
			gateway?.broadcastSystemNotification(text, 'warning');
		} catch (err) {
			this.logger.warn('Could not write a notice to the orchestrator chat', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Tell someone about a problem with an agent's messages: the chat the
	 * message came from (when its header names one), and the orchestrator —
	 * which can reach the owner anywhere — unless the orchestrator itself is
	 * the agent: then the owner directly over Slack, and the orchestrator's
	 * own chat when Slack is not set up (or the notice could not be sent).
	 *
	 * @param sessionName - The agent the notice is about
	 * @param text - The notice (English harness text)
	 * @param opts - A sample message (its `[CHAT:…]` header), a kind for the orchestrator queue key, the Slack title for the orchestrator case
	 */
	private tellAboutAgent(sessionName: string, text: string, opts: { sample?: string; kind: string; title: string }): void {
		// In the chat the message came from, when it names one…
		const chat = opts.sample ? /^\s*\[CHAT:([^\]\s:]+)/.exec(opts.sample) : null;
		if (chat) {
			try {
				getChatV2Service().recordTurn({ channelId: chat[1], senderType: 'system', senderId: 'crewly', content: text, metadata: { source: 'system' } });
			} catch {
				// The channel may be gone; the orchestrator still hears below.
			}
		}
		// …and to the orchestrator, unless it is the one in trouble.
		if (sessionName !== ORCHESTRATOR_SESSION_NAME) {
			this.messageQueueService.enqueue({ content: `[SYSTEM]\n${text}\n[/SYSTEM]`, conversationId: `system:${opts.kind}:${sessionName}`, source: 'system_event' });
			return;
		}
		const slack = getSlackService();
		const viaSlack: Promise<boolean> = slack.isConnected()
			? slack
				.sendNotification({ type: 'project_update', title: opts.title, message: text, urgency: 'high', timestamp: new Date().toISOString() })
				.then((sent) => sent !== false, () => false)
			: Promise.resolve(false);
		void viaSlack.then((sent) => {
			if (sent || chat) return;
			this.tellOrchestratorChat(text);
		});
	}

	/**
	 * Liveness monitor (crewly#1015 §12): a gap in this backend's life (the
	 * computer asleep, a stuck event loop, a stop without a clean shutdown)
	 * is told to the owner by Slack DM once it is back.
	 */
	private startLivenessMonitor(): void {
		try {
			const dm = new SlackReloginDmService(
				() => getSlackService(),
				undefined,
				(agentSession) => getSlackAgentIdentityService()?.getInstalled(agentSession)?.botToken ?? null,
			);
			this.livenessMonitor = new LivenessMonitorService({
				storePath: path.join(this.config.crewlyHome, LIVENESS_MONITOR_CONSTANTS.STORE_FILENAME),
				notifyOwner: async (text) => !!(await dm.sendToOwner(text, null, { title: 'Crewly was offline' })),
				machineName: () => os.hostname().replace(/\.local$/, ''),
			});
			this.livenessMonitor.start();
		} catch (error) {
			this.logger.warn('Liveness monitor not started', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Failed turns of in-process agents (crewly#1015 §2): one re-delivery,
	 * then the owner messages the agent owes are parked by the watchdog (the
	 * owner told once) and the failure is reported — a member's to the
	 * orchestrator, the orchestrator's to the owner.
	 */
	private wireInProcessTurnFailure(): void {
		try {
			setInProcessTurnFailureService(
				new InProcessTurnFailureService({
					redeliver: (sessionName, message) => this.apiController.agentRegistrationService.sendMessageToAgent(sessionName, message),
					noteOwnerMessages: async (sessionName, detail, opts) => {
						const { getOwnerMessageWatchdog } = await import('./services/messaging/owner-message-watchdog.service.js');
						return (await getOwnerMessageWatchdog()?.noteTurnFailed(sessionName, detail, opts)) ?? 0;
					},
					isOwnerStopped: (sessionName) => isOwnerStopped(sessionName),
					isRunning: (sessionName) => this.apiController.agentRegistrationService.isInProcessRuntimeActive(sessionName),
					queueForAgent: (sessionName, message) => SubAgentMessageQueue.getInstance().enqueue(sessionName, message),
					answeredSince: (_sessionName, message, since) => {
						const origin = parseInboundOrigin(message);
						const watchdog = getOwnerMessageWatchdog();
						if (!origin || !watchdog) return false;
						const key = parseSlackThreadKey(origin.slackThreadKey);
						if (key) return watchdog.answeredSince(`slack:${key.slackChannelId}:${key.threadTs}`, since);
						if (origin.slackChannelId && origin.slackThreadTs) return watchdog.answeredSince(`slack:${origin.slackChannelId}:${origin.slackThreadTs}`, since);
						return watchdog.answeredSince(`chat:${origin.conversationId}:`, since);
					},
					resumeOwnerMessages: async (sessionName) => {
						const { getOwnerMessageWatchdog } = await import('./services/messaging/owner-message-watchdog.service.js');
						return (await getOwnerMessageWatchdog()?.resumeAfterRecovery(sessionName)) ?? 0;
					},
					report: (sessionName, text, sample) =>
						this.tellAboutAgent(sessionName, text, { sample, kind: 'turn-failed', title: 'Orchestrator runs failing' }),
					displayName: (sessionName) => (sessionName === ORCHESTRATOR_SESSION_NAME ? 'The orchestrator' : sessionName),
				}),
			);
		} catch (error) {
			this.logger.warn('In-process turn failure handling not wired', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Messages the input guard held back (crewly#1014) are retried on a timer
	 * while the agent is idle, and the owner/orchestrator is told once when an
	 * agent's input stays blocked. Messages the queue drops undelivered (aged
	 * out after a restart, or the oldest at capacity) are reported too —
	 * nothing expires silently.
	 */
	private wireInputBlockedRetry(): void {
		try {
			const queue = SubAgentMessageQueue.getInstance();
			// Two kinds of alert, said plainly in the title (2026-10-05): an agent
			// busy in a long turn needs nothing from the owner; a box Crewly
			// cannot read or type into does.
			const BUSY_TITLE = 'Orchestrator busy in a long turn (no action needed)';
			const BLOCKED_TITLE = 'Orchestrator input blocked (needs you)';
			const tell = (sessionName: string, text: string, sample?: string, title: string = BLOCKED_TITLE): void =>
				this.tellAboutAgent(sessionName, text, { sample, kind: 'input-blocked', title });
			// Our Enter submitted pastes that were sitting in an agent's box: drop
			// their queued copies so a held retry does not deliver them twice.
			SessionCommandHelper.onOwnPasteSubmitted = (sessionName, messages) => {
				for (const m of messages) queue.remove(sessionName, m);
			};
			// An idle agent's box held text we cannot attribute for a long time.
			SessionCommandHelper.onStuckInput = (sessionName, info) => {
				InputBlockedRetryService.getInstance().noteStuckInput(sessionName, info.inputLength, info.forMs);
			};
			// Every delivery refused for a while: automatic redelivery is slowed
			// to a probe now and then, and the owner told once (crewly#1028).
			setInputCircuitOpenListener((info) => {
				traceHarness('guard.block', {
					session: info.sessionName,
					summary: `Deliveries to ${info.sessionName} refused for ${Math.round(info.blockedForMs / 60000)} min (${info.refusals} times): automatic redelivery slowed`,
					outcome: 'blocked',
					data: { circuit: 'open', state: info.state, refusals: info.refusals, blockedForMs: info.blockedForMs },
				});
				InputBlockedRetryService.getInstance().noteCircuitOpen(info.sessionName, info);
			});
			// Last step of the unreadable ladder (2026-10-08 Ella): restart the
			// session the way a re-login does — stop exit monitoring, kill the
			// PTY, keep the conversation id, createAgentSession again (resumes
			// it, or starts fresh with a handover when it is too big). Queued
			// messages drain when the agent registers.
			const restarter = new ReloginAgentResumerService({
				getBackend: () => getSessionBackendSync(),
				getPersistence: () => getSessionStatePersistence(),
				getAgentRegistration: () => this.apiController.agentRegistrationService,
				restartOrchestrator: () => OrchestratorRestartService.getInstance().attemptRestart(),
				stopExitMonitoring: (sessionName) => RuntimeExitMonitorService.getInstance().stopMonitoring(sessionName),
				clearActivity: (sessionName) => PtyActivityTrackerService.getInstance().clearSession(sessionName),
			});
			InputBlockedRetryService.getInstance().setDeps({
				hasQueued: (session) => queue.hasPending(session),
				isIdle: (session) => this.activityMonitorService.getObservedWorkingStatus(session) !== 'in_progress',
				flush: (session) => this.flushQueuedAgentMessages(session),
				isMidTurn: (session) =>
					this.apiController.agentRegistrationService.isMidTurnForRecovery(session, INPUT_BLOCKED_RETRY_CONSTANTS.RESTART_QUIET_MS),
				restart: async (session) => {
					if (!getSessionBackendSync()?.sessionExists(session)) return false;
					const { resumed } = await restarter.resume([session]);
					return resumed.includes(session);
				},
				notify: async (notice) => {
					const minutes = Math.max(1, Math.round(notice.blockedForMs / 60000));
					// The owner thread waiting on this agent hears it too
					// (specs/2026-10-08-owner-thread-sentinel.md).
					{
						const { reportOwnerThreadBlocking } = await import('./services/messaging/owner-thread-sentinel.service.js');
						const why = notice.state === 'busy' ? 'busy' : notice.state === 'unknown' || notice.blockedState === 'unknown' ? 'unreadable' : notice.state === 'circuit-open' ? 'blocked' : 'foreign';
						reportOwnerThreadBlocking(notice.sessionName, { kind: 'delivery_held', why });
					}
					// The kind of content, never the text: a box can hold a password.
					if (notice.state === 'stuck') {
						tell(
							notice.sessionName,
							`Needs you: ${notice.sessionName} is idle, but its input box has held ${notice.inputLength} characters for ${minutes} min that Crewly cannot match to its own messages, and nobody typed into its terminal since Crewly's last message. Crewly did not submit it. Check the agent's terminal: submit or clear what is in the box.`,
							undefined,
						);
						return;
					}
					if (notice.state === 'circuit-open') {
						const what = notice.blockedState === 'unknown'
							? 'its input box cannot be read (a dialog or an unfamiliar screen)'
							: `its input box holds ${notice.inputLength} characters that Crewly did not write`;
						const maxMin = Math.round(INPUT_CIRCUIT_CONSTANTS.PROBE_MAX_MS / 60000);
						tell(
							notice.sessionName,
							`Needs you: ${notice.sessionName} has not received any message for ${minutes} min: ${what}, so Crewly refused to type over it (${notice.refusals} attempts). Crewly has stopped retrying every few seconds and now tries again only every few minutes (at most every ${maxMin} min). To fix it, open ${notice.sessionName}'s terminal and clear the input box (Ctrl+U), or press Enter if that text is yours. Delivery resumes on its own after that.`,
							notice.message || undefined,
						);
						return;
					}
					if (notice.state === 'busy') {
						tell(
							notice.sessionName,
							`No action needed: ${notice.sessionName} has been busy in a long turn for ${minutes} min (spinner or "esc to interrupt" on screen), so messages for it are waiting in its queue. They go out as soon as the turn ends. Its input box is fine. Only if it stays busy for over an hour might the turn be hung; then look at its terminal.`,
							notice.message,
							BUSY_TITLE,
						);
						return;
					}
					const what = notice.state === 'unknown'
						? 'its input box cannot be read (a dialog or an unfamiliar screen)'
						: `its input box holds ${notice.inputLength} characters of text not written by Crewly`;
					tell(
						notice.sessionName,
						`Needs you: messages to ${notice.sessionName} are waiting because ${what}. Crewly will not type over it. Tried ${notice.refusals} times over ${minutes} min; it keeps retrying. Clear the agent's input (or answer its screen) to let them through.`,
						notice.message,
					);
				},
			});
			// A WorkItem brief held by the restart drain gets its hand-over
			// (dispatcher dedup, fresh conversation) when it is delivered.
			queue.setHandOverPreparer(async (sessionName, workItemId, data) => {
				const { prepareWorkItemHandOver } = await import('./controllers/monitoring/terminal.controller.js');
				return prepareWorkItemHandOver(sessionName, workItemId, data);
			});
			queue.setDropListener((sessionName, dropped, reason) => {
				const why = reason === 'aged-out'
					? 'they were older than the queue keeps after a restart'
					: reason === 'undeliverable'
						? 'delivery kept failing (the agent session was gone or its runtime had exited)'
						: 'the queue was full';
				tell(sessionName, `${dropped.length} message(s) to ${sessionName} were dropped undelivered: ${why}.`, dropped[0]?.data);
			});
		} catch (error) {
			this.logger.warn('Input-blocked retry not wired', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async flushQueuedAgentMessages(sessionName: string): Promise<void> {
		const queue = SubAgentMessageQueue.getInstance();
		if (!queue.hasPending(sessionName)) return;
		const outcome = await queue.flush(
			sessionName,
			(data) => this.apiController.agentRegistrationService.sendMessageToAgent(sessionName, data),
			SUB_AGENT_QUEUE_CONSTANTS.FLUSH_INTER_MESSAGE_DELAY,
		);
		this.logger.info('Agent went idle — drained its queued messages', { sessionName, ...outcome });
	}

	private autoCloseOpenRequests(): void {
		setImmediate(async () => {
			try {
				const { RequestService } = await import('./services/v3/request.service.js');
				const { TokenUsageService } = await import('./services/monitoring/token-usage.service.js');
				const { getTokensSince } = await import('./services/monitoring/claude-session-tokens.service.js');
				const { getSessionStatePersistence } = await import('./services/session/session-state-persistence.js');
				const svc = RequestService.getInstance();
				const tokenSvc = TokenUsageService.getInstance();
				const all = await svc.listAll();
				const cutoff = Date.now() - 10 * 60 * 1000; // 10 min window
				const minAgeMs = 3 * 60 * 1000; // Don't close requests younger than 3 min — gives orchestrator time to delegate

				// Resolve orchestrator runtime type once per cycle
				const persistence = getSessionStatePersistence();
				const orcMeta = persistence.getSessionMetadata(ORCHESTRATOR_SESSION_NAME);
				const orcRuntimeType = orcMeta?.runtimeType || 'claude-code';

				for (const req of all) {
					if (req.status !== 'open') continue;
					// Tickets matched to their chat turn close when their answer
					// settles (TicketReviewService), not on a timer.
					if (req.chatRef) continue;
					const reqAge = Date.now() - new Date(req.createdAt).getTime();
					if (reqAge > 10 * 60 * 1000) continue; // older than 10 min — skip
					if (reqAge < minAgeMs) continue; // too young — orchestrator may still be delegating

					const update: Parameters<typeof svc.update>[1] = { status: 'done' };

					// Roll up orchestrator tokens only for direct responses (no WorkItem delegation)
					if (req.workItemIds.length === 0) {
						const since = new Date(req.createdAt);
						let inputTokens = 0;
						let outputTokens = 0;
						let cost = 0;

						if (orcRuntimeType === 'claude-code') {
							// Claude Code: read from session JSONL (ground truth from API)
							// Falls back to auto-detecting the latest session file if ID unknown.
							// Use current time as upper bound to avoid counting tokens from
							// subsequent requests in the same session.
							const sessionId = persistence.getSessionId(ORCHESTRATOR_SESSION_NAME) || null;
							// On another of the owner's Claude Code accounts the
							// transcript lives in that account's config dir (#942).
							const { effectiveClaudeAccount } = await import('./services/runtime-fallback/effective-runtime.js');
							const { claudeAccountConfigDir } = await import('./services/harness/claude-accounts.js');
							const orcAccount = effectiveClaudeAccount(ORCHESTRATOR_SESSION_NAME);
							const summary = await getTokensSince(
								this.config.crewlyHome,
								sessionId,
								since,
								new Date(), // upper bound — only count tokens within this request's window
								orcAccount ? [claudeAccountConfigDir(orcAccount)] : [],
							);
							if (summary && summary.turnCount > 0) {
								inputTokens = summary.inputTokens;
								outputTokens = summary.outputTokens;
								cost = summary.cost;
							}
						} else {
							// Gemini CLI / Codex CLI / crewly-agent: read from TokenUsageService
							// (fed by PTY terminal output parser or SDK)
							const usage = tokenSvc.getSessionUsageSince(
								ORCHESTRATOR_SESSION_NAME,
								since,
							);
							inputTokens = usage.inputTokens;
							outputTokens = usage.outputTokens;
							cost = usage.cost;
						}

						if (inputTokens > 0 || outputTokens > 0) {
							update.totalInputTokens = (req.totalInputTokens || 0) + inputTokens;
							update.totalOutputTokens = (req.totalOutputTokens || 0) + outputTokens;
							update.totalCost = (req.totalCost || 0) + cost;
						}
						update.ownerAgent = ORCHESTRATOR_SESSION_NAME;
					}

					await svc.update(req.id, update);

					// Mark the corresponding Slack/chat thread as terminal so the
					// SessionHandoff resume notification won't re-send it after restart.
					if (req.sourceConversationItemId.startsWith('slack-')) {
						try {
							const { ThreadStatusQueueService } = await import('./services/messaging/thread-status-queue.service.js');
							const { extractSlackChannelId, extractSlackThreadTs } = await import('./services/v3/request-sla.subscriber.js');
							const tsq = ThreadStatusQueueService.getInstance();
							// Use the canonical parser (handles both `slack-{ch}-{ts}` and
							// the thread-reply `slack-{ch}-{root}-msg-{msgTs}` shapes).
							const channelId = extractSlackChannelId(req.sourceConversationItemId);
							const threadTs = extractSlackThreadTs(req.sourceConversationItemId);
							if (channelId && threadTs) {
								const threadKey = `${channelId}:${threadTs}`;
								// Create entry if not tracked, then mark terminal
								if (!tsq.get(threadKey)) {
									tsq.trackInbound({
										threadKey,
										conversationId: req.sourceConversationItemId,
										source: 'slack',
										messagePreview: req.title,
									});
								}
								tsq.markReplied(threadKey, 'replied_completed');
							}
						} catch {
							// Non-critical — thread status is best-effort
						}
					}

					this.logger.debug('V3 Request auto-closed', {
						requestId: req.id,
						ownerAgent: update.ownerAgent,
						inputTokens: update.totalInputTokens,
						outputTokens: update.totalOutputTokens,
						cost: update.totalCost,
					});
				}
			} catch (err) {
				this.logger.warn('V3 Request auto-close failed (non-critical)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		});
	}

	private logMemoryUsage(): void {
		const usage = process.memoryUsage();
		const heapUsed = Math.round(usage.heapUsed / 1024 / 1024);
		const heapTotal = Math.round(usage.heapTotal / 1024 / 1024);
		const external = Math.round(usage.external / 1024 / 1024);

		this.logger.debug('Memory usage', { heapUsedMB: heapUsed, heapTotalMB: heapTotal, externalMB: external });

		// Warn if memory usage is high
		if (heapUsed > 500) {
			this.logger.warn('High memory usage detected', { heapUsedMB: heapUsed });
		}
	}

	/**
	 * Gracefully shut the server down.
	 *
	 * Drains in-flight agent turns first (see services/restart), while the
	 * HTTP API is still up so agents can finish and reply; everything after
	 * that runs under the hard force-exit timer.
	 *
	 * @param options - reason (for logs), drain=false to skip the wait, exitCode for process.exit
	 */
	async shutdown(options: { reason?: string; drain?: boolean; exitCode?: number; crashDetail?: string } = {}): Promise<void> {
		// Prevent double shutdown
		if (this.isShuttingDown) {
			this.logger.info('Shutdown already in progress, skipping...');
			return;
		}
		this.isShuttingDown = true;
		const exitCode = options.exitCode ?? PROCESS_EXIT_CODES.SUCCESS;
		// A shutdown on purpose: the next boot must not report an unclean stop.
		// A crash handler's shutdown is recorded as a crash, so the next boot
		// tells the owner (crewly#1015 §12).
		if (options.reason === 'uncaughtException' || options.reason === 'unhandledRejection') {
			this.livenessMonitor?.markCrash(options.crashDetail ? `${options.reason}: ${options.crashDetail}` : options.reason);
		} else {
			this.livenessMonitor?.markCleanShutdown();
		}
		this.logger.info('Shutting down Crewly server...', { reason: options.reason ?? 'unspecified' });

		AutoUpdateService.getInstance()?.stop();
		void import('./services/apps/apps.wiring.js').then((m) => m.stopAppWake()).catch(() => undefined);
		this.cloudDisconnectNotice?.stop();
		this.conversationCloudSync?.stop();
		this.waitingItemsSync?.stop();

		// Safe restart: stop delivering, wait for agents mid-turn, persist the rest.
		// Runs before the force-exit timer below, which only bounds the teardown.
		await this.drainInFlightTurns(options.reason ?? 'shutdown', options.drain !== false);

		// Set a hard timeout to force exit if graceful shutdown takes too long.
		// Use SIGKILL on self as the ultimate fallback — this is uncatchable and
		// guarantees death even if native node-pty handles keep the event loop alive.
		const isDev = process.env.NODE_ENV !== 'production';
		const timeoutMs = isDev ? 5000 : 10000;
		const forceExitTimeout = setTimeout(() => {
			this.logger.warn('Graceful shutdown timed out, sending SIGKILL to self...');
			process.kill(process.pid, 'SIGKILL');
		}, timeoutMs);

		try {
			// Clear health monitoring interval first
			if (this.healthMonitoringInterval) {
				clearInterval(this.healthMonitoringInterval);
				this.healthMonitoringInterval = null;
			}

			// Unload addons (call their unregister hooks)
			try {
				await AddonLoaderService.getInstance().unloadAddons();
			} catch (addonErr) {
				this.logger.warn('Error unloading addons during shutdown', {
					error: addonErr instanceof Error ? addonErr.message : String(addonErr),
				});
			}

			// Generate session handoff summary before killing processes
			// This captures active thread state and agent status for restart recovery
			try {
				const { SessionHandoffService } = await import('./services/session/session-handoff.service.js');
				await SessionHandoffService.getInstance().generateSummary(this.storageService);
			} catch (error) {
				this.logger.warn('Failed to generate session handoff summary', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Disconnect Redis cache
			try {
				RedisCacheService.getInstance().disconnect();
			} catch {
				// Non-critical — ignore
			}

			// Save PTY session state and force-kill all child processes
			this.logger.info('Saving PTY session state and force-killing child processes...');
			try {
				const sessionBackend = getSessionBackendSync();
				if (sessionBackend) {
					// Save state for resume-on-restart
					const persistence = getSessionStatePersistence();
					const savedCount = await persistence.saveState(sessionBackend);
					if (savedCount > 0) {
						this.logger.info('Saved PTY sessions for later restoration', { count: savedCount });
					}

					// Collect PIDs before destroying for belt-and-suspenders cleanup
					let collectedPids: number[] = [];
					if (sessionBackend instanceof PtySessionBackend) {
						collectedPids = sessionBackend.getAllSessionPids();
						this.logger.info('Collected PTY PIDs for shutdown', { pids: collectedPids });

						// Use forceDestroyAll for SIGTERM → SIGKILL escalation
						await sessionBackend.forceDestroyAll();
					} else {
						await sessionBackend.destroy();
					}

					// Belt-and-suspenders: SIGKILL any remaining PIDs
					for (const pid of collectedPids) {
						try {
							process.kill(pid, 'SIGKILL');
						} catch {
							// ESRCH = already dead, which is expected
						}
					}
				}
				// Clear the factory singleton
				await destroySessionBackend();
			} catch (error) {
				this.logger.warn('Failed to save PTY session state', { error: error instanceof Error ? error.message : String(error) });
			}

			// Flush message queue to disk before stopping processor
			this.logger.info('Flushing message queue to disk...');
			try {
				await this.messageQueueService.flushPersist();
			} catch (error) {
				this.logger.warn('Failed to flush message queue', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Flush thread status queue to disk
			try {
				await this.threadStatusQueueService.persist();
			} catch (error) {
				this.logger.warn('Failed to flush thread status queue', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Flush task pool (WorkItems) to disk — prevents data loss on restart
			try {
				const { TaskPoolService } = await import('./services/task-pool/task-pool.service.js');
				const pool = TaskPoolService.getInstance();
				await pool.flush();
				this.logger.info('Task pool flushed to disk');
			} catch (error) {
				this.logger.warn('Failed to flush task pool', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Stop system resource alert monitoring
			if (this.systemResourceAlertService) {
				this.systemResourceAlertService.stopMonitoring();
			}

			// Stop Reconciler loops (V2)
			if (this.reconcilerService) {
				this.reconcilerService.stop();
				this.logger.info('Reconciler stopped');
			}

			// Stop Team-Health-Watchdog sweep loop (Layer 4)
			// Stops the timers only; spawned commands are detached and keep running.
			this.scheduledCommands?.stop();
			if (this.teamHealthWatchdog) {
				this.teamHealthWatchdog.stop();
				this.logger.info('TeamHealthWatchdog stopped');
			}

			// Stop NOTIFY reconciliation service
			if (this.notifyReconciliationService) {
				this.notifyReconciliationService.stop();
			}

			// Stop message queue processor
			this.queueProcessorService.stop();

			// Stop the EventToWorkItemBridge BEFORE cleaning the event bus so
			// in-flight handler dispatches drain against a still-live bus.
			if (this.eventToWorkItemBridge) {
				this.eventToWorkItemBridge.stop();
				this.eventToWorkItemBridge = null;
			}
			if (this.krCompletionSubscriber) {
				this.krCompletionSubscriber.stop();
				this.krCompletionSubscriber = null;
			}
			if (this.fallbackTriggerCleanup) {
				this.fallbackTriggerCleanup.stop();
				this.fallbackTriggerCleanup = null;
			}
			if (this.escalationService) {
				try { await this.escalationService.stop(); } catch { /* best-effort */ }
				this.escalationService = null;
			}
			if (this.hierarchyEscalationMonitor) {
				this.hierarchyEscalationMonitor.stop();
				this.hierarchyEscalationMonitor = null;
			}

			// LEARN-1: stop the AutoLearningSubscriber on the same window as the
			// bridge so its in-flight recordLearning calls drain before the bus
			// is cleaned.
			if (this.autoLearningSubscriber) {
				this.autoLearningSubscriber.stop();
				this.autoLearningSubscriber = null;
			}

			// DF-1 #438: same shutdown window as auto-learning above.
			if (this.milestoneNotificationSubscriber) {
				this.milestoneNotificationSubscriber.stop();
				this.milestoneNotificationSubscriber = null;
			}

			// INBOUND-1: stop the SLA subscriber and unset the module-level
			// references so a follow-up start() doesn't see stale singletons.
			if (this.requestSlaSubscriber) {
				this.requestSlaSubscriber.stop();
				this.requestSlaSubscriber = null;
			}
			setRequestSlaSubscriber(null);

			// Pipeline-#4 follow-up: stop the decompose subscriber and clear
			// its module-level reference on the same shutdown window as SLA.
			if (this.requestDecomposeSubscriber) {
				this.requestDecomposeSubscriber.stop();
				this.requestDecomposeSubscriber = null;
			}
			setRequestDecomposeSubscriber(null);

			setRequestServiceEventBus(null);

			// Clean up event bus service
			this.eventBusService.cleanup();

			// Clean up schedulers
			this.schedulerService.cleanup();
			this.messageSchedulerService.cleanup();

			// Stop activity monitoring
			this.activityMonitorService.stopPolling();

			// Stop idle detection
			IdleDetectionService.getInstance().stop();

			// Stop agent heartbeat monitor
			AgentHeartbeatMonitorService.getInstance().stop();

			// Stop context window monitor
			ContextWindowMonitorService.getInstance().stop();

			// Stop OAuth relogin monitor and the Slack re-login status check
			OAuthReloginMonitorService.getInstance().destroy();
			getHarnessReloginService().stop();
			getRuntimeFallbackService()?.stop();

			// Stop orchestrator heartbeat monitor
			OrchestratorHeartbeatMonitorService.getInstance().stop();

			// Stop Crewly in Chrome WebSocket bridge
			try {
				const { BrowserBridgeService } = await import('./services/browser/browser-bridge.service.js');
				BrowserBridgeService.getInstance().stop();
			} catch {
				// May not have been initialized
			}

			// Stop the live browser view capture loop
			try {
				const { getBrowserSessions } = await import('./services/browser/browser-session.service.js');
				getBrowserSessions().stop();
			} catch {
				// Never block shutdown on a metrics loop.
			}

			// Disconnect BrowserProxyService from Cloud Relay
			try {
				const { BrowserProxyService } = await import('./services/browser/browser-proxy.service.js');
				BrowserProxyService.getInstance().disconnect();
			} catch {
				// May not have been initialized
			}

			// Stop team activity WebSocket service
			this.teamActivityWebSocketService.stop();

			// Stop teams.json file watcher
			this.teamsJsonWatcherService.stop();

			// Stop log rotation service
			LogRotationService.getInstance().stop();

			// Stop worktree janitor timers
			WorktreeJanitorService.getInstance().stop();

			// Stop auditor scheduler
			AuditorSchedulerService.getInstance().stop();

			// Persist the token ledger: it flushes every 5 minutes, so a restart
			// used to drop everything recorded since the last tick (2026-09-18).
			try {
				const ledger = TokenUsageService.getInstance();
				ledger.stopPeriodicFlush();
				await ledger.flushToDisk();
			} catch (flushErr) {
				this.logger.warn('Token ledger flush on shutdown failed (non-fatal)', {
					error: flushErr instanceof Error ? flushErr.message : String(flushErr),
				});
			}

			// Flush and shutdown OpenTelemetry tracing
			try {
				const { TracingService: TracingSvc } = await import('./services/core/tracing.service.js');
				await TracingSvc.getInstance().shutdown();
			} catch {
				// Ignore if not initialized
			}

			// Clean up tmux service resources
			this.tmuxService.destroy();

			// Stop Slack image cleanup timer
			try {
				const { getSlackImageService: getImgSvc } = await import('./services/slack/slack-image.service.js');
				getImgSvc().stopCleanup();
			} catch {
				// Ignore if not initialized
			}

			// Shutdown Slack integration
			this.logger.info('Shutting down Slack integration...');
			await shutdownSlack();

			// Shutdown WhatsApp integration
			this.logger.info('Shutting down WhatsApp integration...');
			await shutdownWhatsApp();

			// Shutdown Telegram integration
			this.logger.info('Shutting down Telegram integration...');
			await shutdownTelegram();

			// Note: Cloud Task Processor has been migrated to services/tasks/

			// Kill all tmux sessions
			const sessions = await this.tmuxService.listSessions();
			for (const session of sessions) {
				if (session.sessionName.startsWith('crewly_')) {
					await this.tmuxService.killSession(session.sessionName);
				}
			}

			// Close all socket.io connections
			this.logger.info('Closing WebSocket connections...');
			this.io.close();

			// Close HTTP server with timeout
			this.logger.info('Closing HTTP server...');
			await new Promise<void>((resolve) => {
				this.httpServer.close(() => {
					this.logger.info('Server shut down gracefully');
					resolve();
				});
				// If server doesn't close in 3 seconds, continue anyway
				setTimeout(resolve, 3000);
			});

			clearTimeout(forceExitTimeout);
			process.exit(exitCode);
		} catch (error) {
			this.logger.error('Error during shutdown', { error: error instanceof Error ? error.message : String(error) });
			clearTimeout(forceExitTimeout);
			process.exit(1);
		}
	}

	getConfig(): StartupConfig {
		return { ...this.config };
	}
}

// Start server if this file is run directly
const isMainModule = process.argv[1] && (
	process.argv[1].endsWith('/index.ts') || process.argv[1].endsWith('/index.js')
);
if (isMainModule) {
	const server = new CrewlyServer();
	const logger = LoggerService.getInstance().createComponentLogger('CrewlyServer');

	// Build provenance (WI 763c8e30). On 2026-08-21 this process was found
	// serving a `dist/` built months earlier: five merged fixes were not
	// executing and nothing said so, so every conclusion drawn from live
	// behaviour that day was produced by stale code. Verify BEFORE any
	// service starts, so a stale build is refused rather than half-run.
	//
	// A stale build throws here and stops startup — that is the point. Every
	// other outcome (unstamped build, no repository, skip flag set) only
	// warns, so this can never block a legitimate container deploy.
	let wrongBranchAlert: string | null = null;
	try {
		assertBuildProvenance({
			log: (message) => logger.info(message),
			warn: (message) => logger.warn(message),
			// Stale build because the live checkout sits on a non-main branch
			// with no local changes (an agent switched it): still refuse to
			// start, but tell the owner how to fix it instead of going quiet.
			onWrongBranch: (_state, line) => {
				wrongBranchAlert = line;
			},
		});
	} catch (error) {
		logger.error(error instanceof Error ? error.message : String(error));
		const alertLine = wrongBranchAlert as string | null;
		if (!alertLine) process.exit(1);
		void (async () => {
			try {
				const { loadSlackCredentials } = await import('./services/slack/slack-credentials.service.js');
				const { postBootOwnerAlert } = await import('./utils/boot-owner-alert.js');
				await postBootOwnerAlert(alertLine, getCrewlyHomePath(), async () => {
					const creds = await loadSlackCredentials();
					const channel = creds?.allowedUserIds?.[0] ?? creds?.defaultChannelId;
					return creds && channel ? { botToken: creds.botToken, channel } : null;
				});
			} catch {
				/* best effort */
			}
			process.exit(1);
		})();
	}

	server.start().catch((error) => {
		logger.error('Failed to start Crewly server', { error: error instanceof Error ? error.message : String(error) });
		process.exit(1);
	});
}

export default CrewlyServer;
