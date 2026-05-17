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
} from './services/session/index.js';
import { ApiController } from './controllers/api.controller.js';
import { createApiRoutes } from './routes/api.routes.js';
import { TerminalGateway, setTerminalGateway } from './websocket/terminal.gateway.js';
import { initializeChatGateway } from './websocket/chat.gateway.js';
import { StartupConfig } from './types/index.js';
import { LoggerService } from './services/core/logger.service.js';
import {
	CREWLY_CONSTANTS,
	ORCHESTRATOR_SESSION_NAME,
	ORCHESTRATOR_ROLE,
	ORCHESTRATOR_WINDOW_NAME,
	MESSAGE_QUEUE_CONSTANTS,
	RUNTIME_TYPES,
	AUDITOR_CONSTANTS,
	AUDITOR_SCHEDULER_CONSTANTS,
	type RuntimeType,
} from './constants.js';
import { getSettingsService } from './services/settings/index.js';
import { MemoryService } from './services/memory/memory.service.js';
import { getImprovementStartupService } from './services/orchestrator/improvement-startup.service.js';
import { initializeSlackIfConfigured, shutdownSlack } from './services/slack/index.js';
import { resolveTeamByIdOrSlug, slugifyTeamName } from './services/workflow/team-identifier-resolver.js';
import { initializeWhatsAppIfConfigured, shutdownWhatsApp } from './services/whatsapp/index.js';
import { initializeGoogleChatIfConfigured } from './services/messaging/google-chat-initializer.js';
import { initializeTelegramIfConfigured, shutdownTelegram } from './services/telegram/index.js';
import { initializeCloudIfConfigured } from './services/cloud/cloud-initializer.js';
import { MessageQueueService, QueueProcessorService, ResponseRouterService } from './services/messaging/index.js';
import { ThreadStatusQueueService } from './services/messaging/thread-status-queue.service.js';
import { EventBusService } from './services/event-bus/index.js';
import { EventToWorkItemBridge } from './services/event-bus/event-to-workitem-bridge.service.js';
import { AutoLearningSubscriber } from './services/memory/auto-learning.subscriber.js';
import { MilestoneNotificationSubscriber } from './services/notification/milestone-notification.subscriber.js';
import {
	RequestSlaSubscriber,
	setRequestSlaSubscriber,
} from './services/v3/request-sla.subscriber.js';
import {
	RequestDecomposeSubscriber,
	setRequestDecomposeSubscriber,
} from './services/v3/request-decompose.subscriber.js';
import { RequestStatusUpdateSubscriber } from './services/v3/request-status-update.subscriber.js';
import { RequestCascadeSubscriber } from './services/v3/request-cascade.subscriber.js';
import { setRequestServiceEventBus, RequestService } from './services/v3/request.service.js';
import { getSlackService } from './services/slack/slack.service.js';
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
import { findPackageRoot } from './utils/package-root.js';
import { isNativeBindingFatalError } from './utils/native-binding.utils.js';
import { VersionCheckService } from './services/system/version-check.service.js';
import { LogRotationService } from './services/session/log-rotation.service.js';
import { AuditorSchedulerService } from './services/agent/auditor-scheduler.service.js';
import { setAuditorSchedulerService } from './controllers/auditor/auditor.controller.js';
import { AddonLoaderService } from './services/addon/addon-loader.service.js';
import { CronTaskService } from './services/workflow/cron-task.service.js';
import { ReconcilerService, type ReconcilerDataProvider } from './services/reconciler/reconciler.service.js';
import { LiveReconcilerDataProvider } from './services/reconciler/reconciler-data-provider.js';
import { setReconcilerService } from './controllers/reconciler/reconciler.controller.js';
import { FissionGuardService, type FissionDataProvider } from './services/fission/fission-guard.service.js';
import { setFissionGuardService } from './controllers/fission/fission.controller.js';
import { TaskPoolService } from './services/task-pool/task-pool.service.js';
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

export class CrewlyServer {
	private app: express.Application;
	private httpServer: ReturnType<typeof createServer>;
	private io: SocketIOServer;
	private config: StartupConfig;
	private logger = LoggerService.getInstance().createComponentLogger('CrewlyServer');

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

	// Chat MVP Phase 1 — initialized lazily in `start()` after the HTTP
	// server is created. Kept as fields so the shutdown path can close
	// them cleanly and tests can reach in with a reference.
	private chatV2Gateway: import('./websocket/chat-v2.gateway.js').ChatV2Gateway | null = null;
	private chatV2Dispatcher:
		| import('./services/chat-v2/chat-v2.dispatcher.service.js').ChatV2DispatcherService
		| null = null;

	// Shutdown state
	private isShuttingDown = false;
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
			webPort: config?.webPort || parseIntWithFallback(process.env.WEB_PORT, 8787, 'WEB_PORT'),
			crewlyHome: resolveHomePath(defaultAgentmuxHome),
			defaultCheckInterval:
				config?.defaultCheckInterval ||
				parseIntWithFallback(process.env.DEFAULT_CHECK_INTERVAL, 30, 'DEFAULT_CHECK_INTERVAL'),
			autoCommitInterval:
				config?.autoCommitInterval || parseIntWithFallback(process.env.AUTO_COMMIT_INTERVAL, 30, 'AUTO_COMMIT_INTERVAL'),
			headless: config?.headless ?? process.env.CREWLY_HEADLESS === 'true',
		};

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
		});

		this.initializeServices();
		this.configureMiddleware();
		this.configureRoutes();
		this.configureWebSocket();
	}

	private initializeServices(): void {
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

				// V3: Auto-close open Requests when the orchestrator goes idle
				// Handles direct responses (no WorkItem delegation)
				if (event.sessionName === ORCHESTRATOR_SESSION_NAME) {
					setImmediate(() => this.autoCloseOpenRequests());
				}
			}
		});

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

				const fissionService = FissionGuardService.init(fissionDataProvider);
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
			: ['https://crewlyai.com', 'https://www.crewlyai.com', 'http://localhost:8787', 'http://localhost:3000'];
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

		// Body parsing — `verify` captures the raw bytes so the error handler
		// below can log the exact payload when JSON parsing fails. Without this
		// we only see the position-of-failure, not the bytes.
		this.app.use(
			express.json({
				limit: '10mb',
				verify: (req, _res, buf) => {
					(req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
				},
			})
		);
		this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

		// Note: Static files are configured in configureRoutes() after API routes
	}

	private configureRoutes(): void {
		// Agent heartbeat middleware - any API call with X-Agent-Session header updates heartbeat
		this.app.use('/api', agentHeartbeatMiddleware);

		// API routes
		this.app.use('/api', createApiRoutes(this.apiController));

		// Health check (enhanced with mode and agent info)
		this.app.get('/health', (req, res) => {
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

			res.json({
				status: 'healthy',
				timestamp: new Date().toISOString(),
				uptime: process.uptime(),
				version,
				latestVersion: cachedCheck?.latestVersion ?? null,
				updateAvailable: cachedCheck?.updateAvailable ?? false,
				mode: this.config.headless ? 'headless' : 'standard',
				agents: {
					active: agentCount,
					total: agentCount,
				},
				team_health: teamHealthBlock,
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
						}, sessionInfo.runtimeType, sessionInfo.role, sessionInfo.teamId);
						if (sessionInfo.claudeSessionId) {
							persistence.updateSessionId(sessionInfo.name, sessionInfo.claudeSessionId);
						}
					}
					this.logger.info('Loaded persisted session metadata for resume support', {
						count: savedState.sessions.length,
						sessionsWithResumeId: savedState.sessions.filter(s => s.claudeSessionId).length,
					});
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
			this.activityMonitorService.startPolling();

			// Start idle detection for agent suspension
			this.logger.info('Starting idle detection service...');
			const idleDetection = IdleDetectionService.getInstance();
			idleDetection.setAgentRegistrationService(this.apiController.agentRegistrationService);
			idleDetection.start();

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

			// Wire OAuthReloginMonitorService EventBus dependency
			try {
				OAuthReloginMonitorService.getInstance().setEventBusService(this.eventBusService);
			} catch (error) {
				this.logger.warn('Failed to wire OAuthReloginMonitorService EventBus (non-critical)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Wire RuntimeExitMonitorService dependencies for task-aware restart
			try {
				const runtimeExitMonitor = RuntimeExitMonitorService.getInstance();
				runtimeExitMonitor.setAgentRegistrationService(this.apiController.agentRegistrationService);
				runtimeExitMonitor.setEventBusService(this.eventBusService);
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
					{ ChatV2DispatcherService },
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
				const chatDispatcher = new ChatV2DispatcherService({
					agentSink: this.apiController.agentRegistrationService,
					mentionResolver: chatMentionResolver,
				});
				this.chatV2Gateway = chatGateway;
				this.chatV2Dispatcher = chatDispatcher;
				// The chat-v2 router mounted earlier reads realtime deps from
				// this holder at request time, so it picks up broadcast +
				// dispatch without a re-mount.
				setChatV2RealtimeDeps({ gateway: chatGateway, dispatcher: chatDispatcher });
				this.logger.info('chat-v2 WebSocket gateway + dispatcher started', {
					path: '/ws/chat',
					authMode: jwtSecret ? 'jwt' : 'dev-anonymous',
				});

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
							directory: createOssAgentDirectoryProvider(this.storageService),
							presence: createOssAgentPresenceProvider(this.storageService),
						});
						chatRelayAdapter.start();
						this.logger.info('ChatV2RelayAdapter started — Cloud Portal can now drive chat-v2 via relay');
					}
				} catch (err) {
					// Adapter wiring failure is non-fatal — local OSS UI still works.
					this.logger.warn('ChatV2RelayAdapter wiring skipped', {
						error: err instanceof Error ? err.message : String(err),
					});
				}

				// Onboarding v3 (B1) — wire the cold-start detector with the
				// chat-v2 service we just stood up. The orc bootstrap path
				// (CrewlyAgentRuntimeService.detectOnboardingMode) probes this
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
				browserProxy.setTokenResolver(() => cloudClient.getToken());

				// Subscribe to token refresh events so the proxy updates in real-time
				cloudClient.onTokenRefresh((newToken: string) => {
					browserProxy.updateToken(newToken);
				});

				const relayToken = cloudClient.getToken();
				if (relayToken) {
					browserProxy.connect(relayToken);
					this.logger.info('BrowserProxyService connecting to Cloud Relay');
				} else {
					this.logger.debug('BrowserProxyService skipped — no cloud token available');
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

			// #286: Start cron task service with agent status/start callbacks
			try {
				const cronTaskService = CronTaskService.getInstance();
				const storageRef = this.storageService;
				const registrationRef = this.apiController.agentRegistrationService;

				cronTaskService.setExecutionCallback(async (task) => {
					this.logger.info('Executing cron task', { id: task.id, target: task.targetAgent });
					await registrationRef.sendMessageToAgent(
						task.targetAgent,
						`[CRON_TASK:${task.id}] ${task.taskDescription}`,
					);
				});
				// Issue #307: cron tasks created with `targetTeamId` set to a
				// name slug (e.g. "stock-ops-team") instead of the UUID would
				// silently 404 on every fire — `teams.find(t => t.id === teamId)`
				// returned undefined and both callbacks returned `false` with
				// no log surface. `resolveTeamByIdOrSlug` (imported statically
				// at the top of the file) tries UUID first, then falls back
				// to a slug match against `name`. Misses now surface a distinct
				// warn-log with the available slugs so the cause is visible
				// instead of hiding behind the generic "agent offline" warn
				// from cron-task.service.
				cronTaskService.setAgentStatusCallback(async (sessionName, teamId) => {
					// Handle orchestrator separately — it's not in regular teams
					if (sessionName === CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME || teamId === 'orchestrator') {
						const orchStatus = await storageRef.getOrchestratorStatus();
						return orchStatus?.agentStatus === 'active' || orchStatus?.agentStatus === 'started';
					}
					const teams = await storageRef.getTeams();
					const team = resolveTeamByIdOrSlug(teams, teamId);
					if (!team) {
						this.logger.warn('CronTask: targetTeamId resolves to no team', {
							sessionName,
							targetTeamId: teamId,
							availableSlugs: teams.slice(0, 10).map((t) => slugifyTeamName(t.name)),
							hint: 'Set targetTeamId to either the team UUID or one of availableSlugs (lowercase, spaces→-)',
						});
						return false;
					}
					const member = team.members.find((m) => m.sessionName === sessionName);
					if (!member) return false;
					// #286 Root Cause C: treat both 'active' and 'started' as online
					return member.agentStatus === 'active' || member.agentStatus === 'started';
				});
				cronTaskService.setAgentStartCallback(async (sessionName, teamId) => {
					try {
						const teams = await storageRef.getTeams();
						const team = resolveTeamByIdOrSlug(teams, teamId);
						if (!team) {
							this.logger.warn('CronTask auto-start: targetTeamId resolves to no team', {
								sessionName,
								targetTeamId: teamId,
								availableSlugs: teams.slice(0, 10).map((t) => slugifyTeamName(t.name)),
								hint: 'Set targetTeamId to either the team UUID or one of availableSlugs (lowercase, spaces→-)',
							});
							return false;
						}
						const member = team.members.find((m) => m.sessionName === sessionName);
						if (!member) return false;
						await registrationRef.createAgentSession({
							sessionName: member.sessionName,
							role: member.role,
							// Use the resolved team's UUID — not the user-supplied identifier
							// — so downstream agent-registration always sees the canonical id.
							teamId: team.id,
							memberId: member.id,
						});
						return true;
					} catch {
						return false;
					}
				});
				// Self-heal stale nextRunAt values from pre-timezone-fix versions
				await cronTaskService.recalculateAllNextRunTimes();
				cronTaskService.start();
				this.logger.info('CronTaskService started');
			} catch (cronErr) {
				this.logger.warn('CronTaskService initialization failed (non-critical)', {
					error: cronErr instanceof Error ? cronErr.message : String(cronErr),
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
						} catch (err) {
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
							const workItem = createWorkItem({
								title: template.title || `Triggered task (${trigger.id})`,
								description: template.description || `Auto-created by trigger ${trigger.id}`,
								type: template.type ?? 'delegate',
								owner: template.owner ?? 'orchestrator',
								target: template.target,
								triggerId,
								requestId: template.requestId,
							});
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
						} catch (err) {
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
							await taskPool.updateItemStatus(action.wakeWorkItemId, 'queued');
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
				});

				await triggerEngine.start();
				this.logger.info('TriggerEngine started with action handler wired');

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
				dispatchSubscriber.initialize(this.eventBusService);
				dispatchSubscriber.start();
				this.logger.info('WorkItemDispatchSubscriber started — workitem:queued events push to target sessions');
			} catch (dispatchErr) {
				this.logger.warn('WorkItemDispatchSubscriber initialization failed (non-critical)', {
					error: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
				});
			}

			// Start AgentAutoClaimService — auto-assign work to idle agents
			try {
				const { AgentAutoClaimService } = await import('./services/v3/agent-auto-claim.service.js');
				const autoClaimService = AgentAutoClaimService.getInstance();
				autoClaimService.initialize(this.eventBusService);
				await autoClaimService.start();
				this.logger.info('AgentAutoClaimService started — idle agents will auto-claim work');
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

			// Start system resource alert monitoring (proactive disk/memory/CPU alerts)
			this.systemResourceAlertService.startMonitoring();

			// Fire-and-forget background version check (populates cache for /health)
			VersionCheckService.getInstance().checkForUpdate().catch(() => {
				// Silently ignore — version check is non-critical
			});

			// V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
			// The legacy `TaskTrackingService.startAutoSync()` is gone — V3
			// task-pool reconciler owns lifecycle cleanup now.

			// Initialize token usage tracking: load persisted data and start periodic flush
			try {
				const tokenUsageService = TokenUsageService.getInstance();
				await tokenUsageService.loadFromDisk();
				tokenUsageService.startPeriodicFlush();

				// Sync Claude Code session JSONL files → TokenUsageService
				// so the Usage dashboard has data from claude-code runtime agents
				const { syncSessionsToTokenUsageService } = await import('./services/monitoring/claude-session-tokens.service.js');
				const synced = await syncSessionsToTokenUsageService(this.config.crewlyHome, 7);
				this.logger.info('Token usage tracking initialized', { syncedClaudeSessions: synced });
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

			// Auto-start orchestrator if enabled in settings
			await this.autoStartOrchestratorIfEnabled();

			// Auto-restore agent sessions that were running before the last shutdown
			await this.autoRestoreAgentSessionsIfEnabled();

			// #166: Auto-recover in-progress tasks after restart.
			// #196: Skip tasks older than 1 hour to avoid re-sending stale work.
			// V3-only as of spec 2026-05-06-task-management-v1-deprecation.md —
			// reads WorkItems from TaskPoolService (replaces the prior
			// `TaskTrackingService.getAllInProgressTasks()` call).
			try {
				const TASK_RECOVERY_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
				const { TaskPoolService } = await import('./services/task-pool/task-pool.service.js');
				const allItems = await TaskPoolService.getInstance().getAllItems();
				const now = Date.now();
				const activeTasks = allItems.filter(wi => {
					if (wi.status !== 'queued' && wi.status !== 'accepted' && wi.status !== 'running') return false;
					if (!wi.target) return false;
					// Skip stale tasks — startedAt/createdAt older than threshold
					const taskTime = new Date(wi.startedAt || wi.createdAt || 0).getTime();
					if (now - taskTime > TASK_RECOVERY_MAX_AGE_MS) {
						this.logger.info('Skipping stale task recovery (older than 1 hour)', {
							workItemId: wi.id,
							taskName: wi.title,
							age: `${Math.round((now - taskTime) / 60000)} minutes`,
						});
						return false;
					}
					return true;
				});
				if (activeTasks.length > 0) {
					this.logger.info('Found in-progress WorkItems to recover after restart', {
						count: activeTasks.length,
					});
					for (const wi of activeTasks) {
						try {
							const recoveryMessage = `[SYSTEM — TASK RECOVERY] You were working on this task before the server restarted. Please continue:\n\nTask: ${wi.title}\nWorkItem: ${wi.id}\n\nFetch full brief: bash config/skills/agent/core/read-task/execute.sh '{"workItemId":"${wi.id}"}'\n\nPlease check the current state and continue working.`;
							await this.apiController.agentRegistrationService.sendMessageToAgent(
								wi.target!,
								recoveryMessage,
								undefined as unknown as RuntimeType
							);
							this.logger.info('Task recovery message sent', {
								workItemId: wi.id,
								sessionName: wi.target,
								taskName: wi.title,
							});
						} catch (err) {
							// Agent might not be online yet — DLQ in scheduler will handle it
							this.logger.warn('Task recovery delivery deferred (agent may not be online yet)', {
								workItemId: wi.id,
								sessionName: wi.target,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}
				}
			} catch (err) {
				this.logger.warn('Task auto-recovery failed (non-critical)', {
					error: err instanceof Error ? err.message : String(err),
				});
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
		try {
			this.logger.info('Checking Slack configuration...');
			const result = await initializeSlackIfConfigured({
				messageQueueService: this.messageQueueService,
			});

			if (result.success) {
				// Wire thread store into the bridge for persistent thread tracking
				const threadStore = getSlackThreadStore();
				if (threadStore) {
					const { getSlackOrchestratorBridge } = await import('./services/slack/slack-orchestrator-bridge.js');
					const bridge = getSlackOrchestratorBridge();
					bridge.setSlackThreadStore(threadStore);
					bridge.setThreadStatusQueue(this.threadStatusQueueService);
				}
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

			// Create orchestrator agent session
			const result = await this.apiController.agentRegistrationService.createAgentSession({
				sessionName: ORCHESTRATOR_SESSION_NAME,
				role: ORCHESTRATOR_ROLE,
				projectPath: this.config.crewlyHome,
				windowName: ORCHESTRATOR_WINDOW_NAME,
				runtimeType,
				forceRecreate: true,
			});

			if (!result.success) {
				this.logger.warn('Auto-start orchestrator failed to create session', {
					error: result.error,
				});
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
		} catch (error) {
			this.logger.error('Failed to auto-start orchestrator', {
				error: error instanceof Error ? error.message : String(error),
			});
			// Don't fail startup if auto-start fails
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
			const agentSessions = state.sessions.filter(
				(s) => {
					if (s.role === ORCHESTRATOR_ROLE) return false;
					if (!isAuditorEnabled && s.name === AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME) return false;
					return true;
				}
			);

			if (agentSessions.length === 0) {
				this.logger.debug('No non-orchestrator sessions to restore');
				return;
			}

			this.logger.info('Auto-restoring agent sessions from persisted state', {
				count: agentSessions.length,
				sessions: agentSessions.map((s) => s.name),
			});

			let restored = 0;
			const failed: string[] = [];
			const RESTORE_DELAY_MS = 10_000; // 10 seconds between each session restore to avoid resource pressure

			for (let i = 0; i < agentSessions.length; i++) {
				const session = agentSessions[i];

				// Wait between session restores to avoid SIGTERM from resource pressure
				if (i > 0) {
					this.logger.info('Waiting before restoring next session to avoid resource pressure', {
						delayMs: RESTORE_DELAY_MS,
						nextSession: session.name,
						progress: `${i}/${agentSessions.length}`,
					});
					await new Promise((resolve) => setTimeout(resolve, RESTORE_DELAY_MS));
				}

				try {
					const result = await this.apiController.agentRegistrationService.createAgentSession({
						sessionName: session.name,
						role: session.role || 'developer',
						projectPath: session.cwd || process.cwd(),
						runtimeType: session.runtimeType,
						teamId: session.teamId,
						memberId: session.memberId,
						forceRecreate: true,
					});

					if (result.success) {
						restored++;
						this.logger.info('Restored agent session', {
							name: session.name,
							role: session.role,
							runtimeType: session.runtimeType,
							progress: `${restored}/${agentSessions.length}`,
						});
					} else {
						failed.push(session.name);
						this.logger.warn('Failed to restore agent session', {
							name: session.name,
							error: result.error,
						});
					}
				} catch (error) {
					failed.push(session.name);
					this.logger.error('Error restoring agent session', {
						name: session.name,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			this.logger.info('Agent session restore complete', {
				restored,
				total: agentSessions.length,
				failed: failed.length > 0 ? failed : undefined,
			});

			// Clear persisted state after restore attempt to avoid double-restore
			await persistence.clearState();
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
			testServer.listen(this.config.webPort, () => {
				testServer.close(() => {
					this.logger.info('Port is available', { port: this.config.webPort });
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

	private async startHttpServer(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const startTime = Date.now();

			this.httpServer.listen(this.config.webPort, () => {
				const duration = Date.now() - startTime;
				this.logger.info('Crewly server started', {
					port: this.config.webPort,
					durationMs: duration,
					dashboardUrl: `http://localhost:${this.config.webPort}`,
					websocketUrl: `ws://localhost:${this.config.webPort}`,
					home: this.config.crewlyHome
				});

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

		process.on('SIGTERM', () => {
			this.logger.info('Received SIGTERM signal');
			this.shutdown();
		});

		process.on('SIGINT', () => {
			this.sigintCount++;
			if (this.sigintCount === 1) {
				this.logger.info('Received SIGINT signal (Ctrl+C) - shutting down gracefully. Press Ctrl+C again to force exit.');
				this.shutdown();
			} else {
				this.logger.info('Received second SIGINT - forcing immediate exit');
				process.exit(1);
			}
		});

		process.on('uncaughtException', (error) => {
			this.logger.error('Uncaught exception', { error: error.message, stack: error.stack });
			this.logMemoryUsage();
			this.shutdown();
		});

		process.on('unhandledRejection', (reason, promise) => {
			const message = reason instanceof Error ? reason.message : String(reason);

			// Non-fatal rejections from third-party libraries (e.g., Slack Socket Mode
			// state machine errors) should be logged but not trigger a full shutdown.
			const nonFatalPatterns = [
				'Unhandled event',    // finity state machine (Slack Socket Mode)
				'socket hang up',     // transient network errors
				'ECONNRESET',         // connection reset by peer
			];
			const isNonFatal = nonFatalPatterns.some(p => message.includes(p));

			if (isNonFatal) {
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
			this.shutdown();
		});
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
				const { MissionReminderService } = await import('./services/v3/mission-reminder.service.js');
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
				const { MissionReminderService } = await import('./services/v3/mission-reminder.service.js');
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
				for (const req of all) {
					if (req.status !== 'done' && req.status !== 'cancelled') continue;
					const completedAt = req.completedAt ? new Date(req.completedAt).getTime() : 0;
					const createdAt = new Date(req.createdAt).getTime();
					const age = completedAt || createdAt;
					if (age < cutoff) {
						await svc.delete(req.id);
						purgedRequests++;
					}
				}
				if (purgedRequests > 0) {
					this.logger.info('Purged old completed Requests', { count: purgedRequests });
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
							const summary = await getTokensSince(
								this.config.crewlyHome,
								sessionId,
								since,
								new Date(), // upper bound — only count tokens within this request's window
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

	async shutdown(): Promise<void> {
		// Prevent double shutdown
		if (this.isShuttingDown) {
			this.logger.info('Shutdown already in progress, skipping...');
			return;
		}
		this.isShuttingDown = true;
		this.logger.info('Shutting down Crewly server...');

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

			// Stop OAuth relogin monitor
			OAuthReloginMonitorService.getInstance().destroy();

			// Stop orchestrator heartbeat monitor
			OrchestratorHeartbeatMonitorService.getInstance().stop();

			// Stop Crewly in Chrome WebSocket bridge
			try {
				const { BrowserBridgeService } = await import('./services/browser/browser-bridge.service.js');
				BrowserBridgeService.getInstance().stop();
			} catch {
				// May not have been initialized
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

			// Stop auditor scheduler
			AuditorSchedulerService.getInstance().stop();

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
			process.exit(0);
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
	server.start().catch((error) => {
		logger.error('Failed to start Crewly server', { error: error instanceof Error ? error.message : String(error) });
		process.exit(1);
	});
}

export default CrewlyServer;
