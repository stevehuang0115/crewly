/**
 * System Resource Alert Service
 *
 * Proactively monitors disk, CPU, and memory usage and sends user-facing
 * notifications when thresholds are exceeded. This prevents silent failures
 * like ENOSPC that can cause the orchestrator to become stuck.
 *
 * - Polls MonitoringService.getSystemMetrics() at a configurable interval
 * - Checks metrics against warning/critical thresholds
 * - Sends chat notifications via ChatService.addSystemMessage()
 * - Broadcasts WebSocket events for frontend toast/banner display
 * - Per-metric cooldown prevents notification spam
 * - Critical disk/memory alerts and auto-stopped agents also go to the owner
 *   over Slack (#991), at most once per OWNER_NOTICE_COOLDOWN per alert key;
 *   the last notice time is persisted so a restart does not re-send it
 *
 * @module system-resource-alert
 */

import * as fs from 'fs';
import * as path from 'path';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { atomicWriteJson } from '../../utils/file-io.utils.js';
import { MonitoringService } from './monitoring.service.js';
import { getTerminalGateway } from '../../websocket/terminal.gateway.js';
import { getChatV2Service } from '../chat-v2/chat-v2.singleton.js';
import { SYSTEM_RESOURCE_ALERT_CONSTANTS } from '../../constants.js';
import { IdleDetectionService } from '../agent/idle-detection.service.js';

const { THRESHOLDS } = SYSTEM_RESOURCE_ALERT_CONSTANTS;

/** Owner-facing titles for the alerts that reach the owner. */
const OWNER_NOTICE_TITLES: Record<string, string> = {
	disk_critical: 'Disk almost full',
	memory_critical: 'Memory critically high',
	agents_auto_stopped: 'Idle agents stopped to free memory',
};

/**
 * Delivers an alert to the owner (Slack). Resolves true when it was sent,
 * false when there was no way to reach the owner (e.g. Slack not connected).
 */
export type OwnerAlertNotifier = (notice: { title: string; message: string; urgent: boolean }) => Promise<boolean>;

/** Options for {@link SystemResourceAlertService}. */
export interface SystemResourceAlertOptions {
	/** Where the per-key owner-notice times are kept (default: CREWLY_HOME state file). */
	ownerNoticeStatePath?: string;
}

/**
 * Service that polls system resource metrics and sends proactive alerts
 * when disk, memory, or CPU usage exceeds configured thresholds.
 */
export class SystemResourceAlertService {
	private intervalId: NodeJS.Timeout | null = null;
	private lastAlertTimes: Map<string, number> = new Map();
	private logger: ComponentLogger;

	private readonly pollInterval: number;
	private readonly cooldownMs: number;
	private readonly ownerNoticeStatePath: string;
	private ownerNotifier: OwnerAlertNotifier | null = null;
	/** When the owner was last told, per alert key (ms epoch); loaded from disk once. */
	private ownerNoticeTimes: Record<string, number> | null = null;
	/** Serialises state-file writes so a slower write never overwrites a newer one. */
	private ownerNoticeWrite: Promise<void> = Promise.resolve();

	constructor(options: SystemResourceAlertOptions = {}) {
		this.logger = LoggerService.getInstance().createComponentLogger('SystemResourceAlert');
		this.pollInterval = SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL;
		this.cooldownMs = SYSTEM_RESOURCE_ALERT_CONSTANTS.ALERT_COOLDOWN;
		this.ownerNoticeStatePath = options.ownerNoticeStatePath
			?? path.join(getCrewlyHomePath(), SYSTEM_RESOURCE_ALERT_CONSTANTS.OWNER_NOTICE_STATE_FILENAME);
	}

	/**
	 * Set how critical alerts reach the owner (Slack). Without one, alerts
	 * only go to the dashboard chat and the WebSocket toast.
	 *
	 * @param notifier - Owner notifier, or null to stop owner notices
	 */
	setOwnerNotifier(notifier: OwnerAlertNotifier | null): void {
		this.ownerNotifier = notifier;
	}

	/**
	 * Start periodic resource monitoring.
	 */
	startMonitoring(): void {
		if (this.intervalId) {
			this.logger.warn('Resource alert monitoring already running');
			return;
		}

		this.intervalId = setInterval(() => {
			void this.checkResources().catch((error) => {
				this.logger.error('Error checking system resources', {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, this.pollInterval);

		this.logger.info('System resource alert monitoring started', {
			pollIntervalMs: this.pollInterval,
			cooldownMs: this.cooldownMs,
		});
	}

	/**
	 * Stop periodic resource monitoring.
	 */
	stopMonitoring(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			this.logger.info('System resource alert monitoring stopped');
		}
	}

	/**
	 * Check current resource metrics against thresholds and send alerts.
	 */
	private async checkResources(): Promise<void> {
		const metrics = MonitoringService.getInstance().getSystemMetrics();
		if (!metrics) {
			return;
		}

		// Check disk usage
		if (metrics.disk.total > 0) {
			const diskUsage = metrics.disk.usage;
			const freeGB = (metrics.disk.free / (1024 * 1024 * 1024)).toFixed(1);

			if (diskUsage >= THRESHOLDS.DISK_CRITICAL) {
				await this.sendAlert(
					'disk_critical',
					`Disk is ${diskUsage.toFixed(1)}% full (${freeGB} GB free). Actions like git commits, file writes, and log output may fail with ENOSPC. Free up disk space immediately.`,
					'critical'
				);
			} else if (diskUsage >= THRESHOLDS.DISK_WARNING) {
				await this.sendAlert(
					'disk_warning',
					`Disk usage at ${diskUsage.toFixed(1)}% (${freeGB} GB free). Consider freeing up space to prevent issues.`,
					'warning'
				);
			}
		}

		// Check memory usage
		const memUsage = metrics.memory.percentage;
		if (memUsage >= THRESHOLDS.MEMORY_CRITICAL) {
			// Auto-stop idle agents to free memory before the system OOMs
			const stoppedCount = await this.autoStopIdleAgents();
			const stoppedMsg = stoppedCount > 0
				? ` Auto-stopped ${stoppedCount} idle agent(s) to free memory.`
				: '';
			// Its own key when agents were stopped, so an earlier memory alert's
			// cooldown cannot hide that agents went down.
			await this.sendAlert(
				stoppedCount > 0 ? 'agents_auto_stopped' : 'memory_critical',
				`Memory usage at ${memUsage.toFixed(1)}%. System may start killing processes.${stoppedMsg}`,
				'critical'
			);
		} else if (memUsage >= THRESHOLDS.MEMORY_WARNING) {
			await this.sendAlert(
				'memory_warning',
				`Memory usage at ${memUsage.toFixed(1)}%. Performance may degrade if usage continues to rise.`,
				'warning'
			);
		}

		// Check CPU load (load average relative to number of cores)
		const loadAvg = metrics.cpu.loadAverage?.[0];
		if (loadAvg != null && metrics.cpu.cores > 0) {
			const cpuLoadPercent = (loadAvg / metrics.cpu.cores) * 100;
			if (cpuLoadPercent >= THRESHOLDS.CPU_CRITICAL) {
				await this.sendAlert(
					'cpu_critical',
					`CPU load at ${cpuLoadPercent.toFixed(0)}% of capacity (${loadAvg.toFixed(1)} load avg, ${metrics.cpu.cores} cores). System is overloaded.`,
					'critical'
				);
			} else if (cpuLoadPercent >= THRESHOLDS.CPU_WARNING) {
				await this.sendAlert(
					'cpu_warning',
					`CPU load at ${cpuLoadPercent.toFixed(0)}% of capacity. Consider reducing parallel workloads.`,
				'warning'
				);
			}
		}
	}

	/**
	 * Auto-stop idle agents to free memory during critical memory pressure.
	 * Only stops agents that are idle (not actively working on tasks).
	 *
	 * @returns Number of agents stopped
	 */
	private async autoStopIdleAgents(): Promise<number> {
		try {
			const idleDetection = IdleDetectionService.getInstance();
			const stoppedCount = await idleDetection.forceStopIdleAgents();
			if (stoppedCount > 0) {
				this.logger.warn('Auto-stopped idle agents due to memory pressure', { stoppedCount });
			}
			return stoppedCount;
		} catch (error) {
			this.logger.warn('Failed to auto-stop idle agents', {
				error: error instanceof Error ? error.message : String(error),
			});
			return 0;
		}
	}

	/**
	 * Send an alert if the cooldown period has elapsed for this alert key.
	 *
	 * @param alertKey - Unique identifier for the metric+severity (e.g. 'disk_critical')
	 * @param message - Human-readable alert message
	 * @param severity - Alert severity level ('warning' or 'critical')
	 */
	private async sendAlert(alertKey: string, message: string, severity: string): Promise<void> {
		const now = Date.now();
		const lastAlert = this.lastAlertTimes.get(alertKey) || 0;

		if (now - lastAlert < this.cooldownMs) {
			return;
		}

		this.lastAlertTimes.set(alertKey, now);
		const timestamp = new Date().toISOString();

		// Log the alert
		if (severity === 'critical') {
			this.logger.error(`[System Alert] ${message}`, { alertKey, severity });
		} else {
			this.logger.warn(`[System Alert] ${message}`, { alertKey, severity });
		}

		// Send to active chat conversation (if any)
		try {
			const terminalGateway = getTerminalGateway();
			const conversationId = terminalGateway?.getActiveConversationId();

			if (conversationId) {
				const chatV2 = getChatV2Service();
				const channel = chatV2.ensureChannelForLegacyConversation({
					conversationId,
					agentSession: 'crewly-orc',
				});
				chatV2.recordTurn({
					channelId: channel.id,
					senderType: 'system',
					senderId: 'system',
					content: `[System Alert] ${message}`,
					metadata: { source: 'system' },
				});
			}

			// Broadcast WebSocket event for frontend toast/banner
			if (terminalGateway) {
				terminalGateway.broadcastSystemResourceAlert({
					alertKey,
					message,
					severity,
					timestamp,
				});
			}
		} catch (error) {
			this.logger.warn('Failed to send resource alert notification', {
				alertKey,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		this.notifyOwnerIfDue(alertKey, message);
	}

	/**
	 * #991: Send a critical alert to the owner over Slack, at most once per
	 * OWNER_NOTICE_COOLDOWN per alert key. The slot is claimed before sending
	 * (so two quick alerts cannot both go out) and released when nothing was
	 * delivered, so a disconnected Slack is retried on the next alert instead
	 * of counting as sent. Fire-and-forget: Slack never delays the dashboard.
	 *
	 * @param alertKey - Alert key (only OWNER_NOTICE_KEYS are sent)
	 * @param message - Alert text
	 */
	private notifyOwnerIfDue(alertKey: string, message: string): void {
		const notifier = this.ownerNotifier;
		if (!notifier || !SYSTEM_RESOURCE_ALERT_CONSTANTS.OWNER_NOTICE_KEYS.includes(alertKey)) return;
		const times = this.loadOwnerNoticeTimes();
		const now = Date.now();
		const previous = times[alertKey];
		if (typeof previous === 'number' && now - previous < SYSTEM_RESOURCE_ALERT_CONSTANTS.OWNER_NOTICE_COOLDOWN) {
			this.logger.debug('Owner already told about this alert recently', { alertKey });
			return;
		}
		times[alertKey] = now;

		const release = (): void => {
			if (previous === undefined) delete times[alertKey];
			else times[alertKey] = previous;
		};
		void Promise.resolve()
			.then(() => notifier({ title: OWNER_NOTICE_TITLES[alertKey] ?? 'System alert', message, urgent: true }))
			.then((delivered) => {
				if (!delivered) {
					release();
					this.logger.warn('Could not send the system alert to the owner (no Slack connection)', { alertKey });
					return;
				}
				this.logger.info('Sent system alert to the owner', { alertKey });
				this.persistOwnerNoticeTimes();
			})
			.catch((error: unknown) => {
				release();
				this.logger.warn('Failed to send system alert to the owner', {
					alertKey,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	/**
	 * Owner-notice times, read from the state file on first use so a backend
	 * restart does not re-send a notice the owner already has.
	 *
	 * @returns The live per-key map
	 */
	private loadOwnerNoticeTimes(): Record<string, number> {
		if (this.ownerNoticeTimes) return this.ownerNoticeTimes;
		let loaded: Record<string, number> = {};
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.ownerNoticeStatePath, 'utf8'));
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
					if (typeof value === 'number' && Number.isFinite(value)) loaded[key] = value;
				}
			}
		} catch {
			loaded = {}; // missing or unreadable: nobody has been told yet
		}
		this.ownerNoticeTimes = loaded;
		return loaded;
	}

	/** Save the owner-notice times (queued behind any earlier write). */
	private persistOwnerNoticeTimes(): void {
		const snapshot = { ...this.loadOwnerNoticeTimes() };
		this.ownerNoticeWrite = this.ownerNoticeWrite
			.then(() => atomicWriteJson(this.ownerNoticeStatePath, snapshot))
			.catch((error: unknown) => {
				this.logger.warn('Could not save system alert owner-notice times', {
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}
}
