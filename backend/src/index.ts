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
	TaskTrackingService,
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
	type RuntimeType,
} from './constants.js';
import { getSettingsService } from './services/settings/index.js';
import { MemoryService } from './services/memory/memory.service.js';
import { getImprovementStartupService } from './services/orchestrator/improvement-startup.service.js';
import { initializeSlackIfConfigured, shutdownSlack } from './services/slack/index.js';
import { initializeWhatsAppIfConfigured, shutdownWhatsApp } from './services/whatsapp/index.js';
import { MessageQueueService, QueueProcessorService, ResponseRouterService } from './services/messaging/index.js';
import { EventBusService } from './services/event-bus/index.js';
import { SlackThreadStoreService, setSlackThreadStore, getSlackThreadStore } from './services/slack/slack-thread-store.service.js';
import { SlackImageService, setSlackImageService } from './services/slack/slack-image.service.js';
import { NotifyReconciliationService } from './services/slack/notify-reconciliation.service.js';
import { setEventBusService as setEventBusControllerService } from './controllers/event-bus/event-bus.controller.js';
import { setEventBusServiceForTaskCleanup } from './controllers/task-management/task-management.controller.js';
import { setTeamControllerEventBusService } from './controllers/team/team.controller.js';
import { SkillCatalogService } from './services/skill/skill-catalog.service.js';
import { createEventBusRouter } from './controllers/event-bus/event-bus.routes.js';
import { setMessageQueueService as setChatMessageQueueService } from './controllers/chat/chat.controller.js';
import { setMessageQueueService as setMessagingControllerQueueService } from './controllers/messaging/messaging.controller.js';
import { createMessagingRouter } from './controllers/messaging/messaging.routes.js';
import { SystemResourceAlertService } from './services/monitoring/system-resource-alert.service.js';
import { agentHeartbeatMiddleware } from './middleware/agent-heartbeat.middleware.js';
import { OrchestratorRestartService } from './services/orchestrator/orchestrator-restart.service.js';
import { IdleDetectionService } from './services/agent/idle-detection.service.js';
import { AgentSuspendService } from './services/agent/agent-suspend.service.js';
import { AgentHeartbeatMonitorService } from './services/agent/agent-heartbeat-monitor.service.js';
import { OrchestratorHeartbeatMonitorService } from './services/orchestrator/orchestrator-heartbeat-monitor.service.js';
import { RuntimeExitMonitorService } from './services/agent/runtime-exit-monitor.service.js';
import { ContextWindowMonitorService } from './services/agent/context-window-monitor.service.js';
import { findPackageRoot } from './utils/package-root.js';
import { VersionCheckService } from './services/system/version-check.service.js';

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
	private taskTrackingService!: TaskTrackingService;
	private teamActivityWebSocketService!: TeamActivityWebSocketService;
	private teamsJsonWatcherService!: TeamsJsonWatcherService;
	private apiController!: ApiController;
	private terminalGateway!: TerminalGateway;
	private messageQueueService!: MessageQueueService;
	private queueProcessorService!: QueueProcessorService;
	private eventBusService!: EventBusService;
	private notifyReconciliationService!: NotifyReconciliationService;
	private systemResourceAlertService!: SystemResourceAlertService;

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
		};

		this.app = express();
		this.httpServer = createServer(this.app);
		this.io = new SocketIOServer(this.httpServer, {
			cors: {
				origin: process.env.NODE_ENV === 'production' ? false : '*',
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
		this.taskTrackingService = new TaskTrackingService();
		this.teamActivityWebSocketService = new TeamActivityWebSocketService(
			this.storageService,
			this.tmuxService,
			this.taskTrackingService
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

		// Initialize message queue services (with disk persistence)
		this.messageQueueService = new MessageQueueService(this.config.crewlyHome);
		const responseRouter = new ResponseRouterService();
		this.queueProcessorService = new QueueProcessorService(
			this.messageQueueService,
			responseRouter,
			this.apiController.agentRegistrationService
		);

		// Wire queue service into controllers
		setChatMessageQueueService(this.messageQueueService);
		setMessagingControllerQueueService(this.messageQueueService);

		// Initialize system resource alert service for proactive monitoring
		this.systemResourceAlertService = new SystemResourceAlertService();

		// Initialize event bus service for agent lifecycle pub/sub
		this.eventBusService = new EventBusService();
		this.eventBusService.setMessageQueueService(this.messageQueueService);
		this.teamsJsonWatcherService.setEventBusService(this.eventBusService);
		this.activityMonitorService.setEventBusService(this.eventBusService);
		setEventBusControllerService(this.eventBusService);
		setTeamControllerEventBusService(this.eventBusService);
		setEventBusServiceForTaskCleanup(this.eventBusService);

		// Initialize Slack thread store for persistent thread conversations
		const slackThreadStore = new SlackThreadStoreService(this.config.crewlyHome);
		setSlackThreadStore(slackThreadStore);
		this.eventBusService.setSlackThreadStore(slackThreadStore);

		// Initialize Slack image service for downloading images from Slack messages
		const slackImageService = new SlackImageService(this.config.crewlyHome);
		setSlackImageService(slackImageService);

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
						scriptSrc: ["'self'"],
						imgSrc: ["'self'", 'data:', 'https:'],
						connectSrc: ["'self'", 'ws:', 'wss:'],
					},
				},
			})
		);

		// CORS
		this.app.use(
			cors({
				origin: process.env.NODE_ENV === 'production' ? false : '*',
				credentials: true,
			})
		);

		// Logging
		this.app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

		// Body parsing
		this.app.use(express.json({ limit: '10mb' }));
		this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

		// Note: Static files are configured in configureRoutes() after API routes
	}

	private configureRoutes(): void {
		// Agent heartbeat middleware - any API call with X-Agent-Session header updates heartbeat
		this.app.use('/api', agentHeartbeatMiddleware);

		// API routes
		this.app.use('/api', createApiRoutes(this.apiController));

		// Health check
		this.app.get('/health', (req, res) => {
			const versionService = VersionCheckService.getInstance();
			const cachedCheck = versionService.getCachedCheckResult();

			res.json({
				status: 'healthy',
				timestamp: new Date().toISOString(),
				uptime: process.uptime(),
				version: cachedCheck?.currentVersion ?? versionService.getLocalVersion(),
				latestVersion: cachedCheck?.latestVersion ?? null,
				updateAvailable: cachedCheck?.updateAvailable ?? false,
			});
		});

		// Static files for frontend (after API routes)
		// Use findPackageRoot() so this works both in dev mode (backend/src/)
		// and in compiled/npm-installed mode (dist/backend/backend/src/)
		const projectRoot = findPackageRoot(__dirname);
		const frontendPath = path.join(projectRoot, 'frontend/dist');
		this.app.use(express.static(frontendPath));

		// Serve frontend for all other routes (SPA)
		this.app.get('*', (req, res) => {
			const frontendIndexPath = path.join(projectRoot, 'frontend/dist/index.html');
			res.sendFile(frontendIndexPath);
		});

		// Error handling middleware
		this.app.use(
			(
				err: Error,
				req: express.Request,
				res: express.Response,
				next: express.NextFunction
			) => {
				this.logger.error('Request error', { error: err.message, stack: err.stack });
				res.status(500).json({
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
			this.logger.info('Starting Crewly server...');
			this.logger.info('Server startup info', {
				pid: process.pid,
				memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
				targetPort: this.config.webPort
			});

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
			IdleDetectionService.getInstance().start();

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
						this.taskTrackingService
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
						this.taskTrackingService,
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

			// Wire RuntimeExitMonitorService dependencies for task-aware restart
			try {
				const runtimeExitMonitor = RuntimeExitMonitorService.getInstance();
				runtimeExitMonitor.setAgentRegistrationService(this.apiController.agentRegistrationService);
				runtimeExitMonitor.setTaskTrackingService(this.taskTrackingService);
			} catch (error) {
				this.logger.warn('Failed to wire RuntimeExitMonitorService dependencies (non-critical)', {
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

			// Start message queue processor
			this.logger.info('Starting message queue processor...');
			this.queueProcessorService.start();

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

			// Start NOTIFY reconciliation service (retries failed Slack deliveries)
			this.notifyReconciliationService = new NotifyReconciliationService();
			this.notifyReconciliationService.start();

			// Start system resource alert monitoring (proactive disk/memory/CPU alerts)
			this.systemResourceAlertService.startMonitoring();

			// Fire-and-forget background version check (populates cache for /health)
			VersionCheckService.getInstance().checkForUpdate().catch(() => {
				// Silently ignore — version check is non-critical
			});

			// Start HTTP server with enhanced error handling
			await this.startHttpServer();

			// Register cleanup handlers
			this.registerSignalHandlers();

			// Start health monitoring
			this.startHealthMonitoring();

			// Auto-start orchestrator if enabled in settings
			await this.autoStartOrchestratorIfEnabled();

			// Auto-restore agent sessions that were running before the last shutdown
			await this.autoRestoreAgentSessionsIfEnabled();

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
					getSlackOrchestratorBridge().setSlackThreadStore(threadStore);
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

			// Determine runtime type from orchestrator status
			let runtimeType: RuntimeType = RUNTIME_TYPES.CLAUDE_CODE;
			try {
				const orchestratorStatus = await this.storageService.getOrchestratorStatus();
				if (orchestratorStatus?.runtimeType) {
					runtimeType = orchestratorStatus.runtimeType as RuntimeType;
				}
			} catch {
				// Use default runtime type
			}

			// Create orchestrator agent session
			const result = await this.apiController.agentRegistrationService.createAgentSession({
				sessionName: ORCHESTRATOR_SESSION_NAME,
				role: ORCHESTRATOR_ROLE,
				projectPath: process.cwd(),
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
					process.cwd()
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
			const agentSessions = state.sessions.filter(
				(s) => s.role !== ORCHESTRATOR_ROLE
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

			for (const session of agentSessions) {
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

			// Stop system resource alert monitoring
			if (this.systemResourceAlertService) {
				this.systemResourceAlertService.stopMonitoring();
			}

			// Stop NOTIFY reconciliation service
			if (this.notifyReconciliationService) {
				this.notifyReconciliationService.stop();
			}

			// Stop message queue processor
			this.queueProcessorService.stop();

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

			// Stop orchestrator heartbeat monitor
			OrchestratorHeartbeatMonitorService.getInstance().stop();

			// Stop team activity WebSocket service
			this.teamActivityWebSocketService.stop();

			// Stop teams.json file watcher
			this.teamsJsonWatcherService.stop();

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
