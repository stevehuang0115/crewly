/**
 * Auditor Scheduler Service
 *
 * Manages the lifecycle and triggering of the Crewly Auditor agent.
 * The auditor runs as a Claude Code PTY session — initialized at server start
 * and kept alive until the service stops.
 *
 * Three trigger layers:
 *   L1 — Periodic: setInterval every AUDIT_INTERVAL_MS (15 min)
 *   L2 — Event-driven: EventBus events (agent:inactive, task:failed) with debounce
 *   L3 — API: POST /api/auditor/trigger manual trigger
 *
 * Additionally supports direct Slack conversation via handleUserMessage().
 *
 * @module services/agent/auditor-scheduler
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { AUDITOR_SCHEDULER_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { formatError } from '../../utils/format-error.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { AgentRegistrationService } from './agent-registration.service.js';

/**
 * Status of the AuditorSchedulerService.
 */
export type AuditorSchedulerStatus = 'stopped' | 'idle' | 'running_audit';

/**
 * Result from a trigger attempt.
 */
export interface AuditTriggerResult {
  /** Whether the audit was started */
  triggered: boolean;
  /** Reason if not triggered */
  reason?: string;
  /** Trigger source */
  source: 'periodic' | 'event' | 'api';
  /** Timestamp */
  timestamp: string;
}

/**
 * Slack context for user message routing.
 */
export interface SlackContext {
  channelId: string;
  threadTs: string;
}

/**
 * A scheduled audit item that may need catch-up on restart.
 */
export interface ScheduledAuditItem {
  /** Unique identifier */
  id: string;
  /** When the audit was scheduled to fire */
  scheduledTime: number;
  /** Source of the schedule */
  source: AuditTriggerResult['source'];
  /** Whether the audit was actually fired */
  fired: boolean;
}

/**
 * Scheduler service that orchestrates Auditor agent lifecycle via Claude Code PTY session.
 *
 * Always-active mode: the auditor PTY session is created at start()
 * and remains alive until stop(). Audit runs send messages to the existing session.
 *
 * Singleton — use AuditorSchedulerService.getInstance().
 *
 * @example
 * ```typescript
 * const scheduler = AuditorSchedulerService.getInstance();
 * scheduler.setAgentRegistrationService(agentRegService);
 * scheduler.setEventBusService(eventBus);
 * scheduler.start();
 * ```
 */
export class AuditorSchedulerService {
  private static instance: AuditorSchedulerService | null = null;

  private logger: ComponentLogger;
  private status: AuditorSchedulerStatus = 'stopped';

  // Dependencies
  private agentRegistrationService: AgentRegistrationService | null = null;
  private eventBusService: EventBusService | null = null;

  // L1: Periodic timer
  private periodicTimer: ReturnType<typeof setInterval> | null = null;

  // L2: Event-driven debounce
  private eventDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private eventListenerBound = false;

  // Session recovery timer: scheduled when auditor's own session goes inactive
  private sessionRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

  // Lifecycle: timeout protection
  private auditTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAuditStart: number = 0;
  private auditCount: number = 0;

  // PTY session tracking
  private sessionReady = false;
  private sessionInitializing = false;
  private sessionRetryCount = 0;
  private sessionCooldownUntil = 0;

  // Scheduled audit items for catch-up on restart
  private scheduledItems: ScheduledAuditItem[] = [];

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('AuditorScheduler');
  }

  /**
   * Get the singleton instance.
   *
   * @returns AuditorSchedulerService instance
   */
  static getInstance(): AuditorSchedulerService {
    if (!AuditorSchedulerService.instance) {
      AuditorSchedulerService.instance = new AuditorSchedulerService();
    }
    return AuditorSchedulerService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    if (AuditorSchedulerService.instance) {
      AuditorSchedulerService.instance.stop();
    }
    AuditorSchedulerService.instance = null;
  }

  /**
   * Set the AgentRegistrationService for PTY session management.
   *
   * @param service - The AgentRegistrationService instance
   */
  setAgentRegistrationService(service: AgentRegistrationService): void {
    this.agentRegistrationService = service;
  }

  /**
   * Set the EventBusService for L2 event-driven triggers.
   *
   * @param eventBus - The EventBusService instance
   */
  setEventBusService(eventBus: EventBusService): void {
    this.eventBusService = eventBus;
  }

  /**
   * Start all trigger layers and initialize the auditor PTY session.
   * The auditor session is created immediately (always-active mode).
   * L1: periodic interval. L2: EventBus listener.
   */
  start(): void {
    if (this.status !== 'stopped') {
      this.logger.warn('AuditorScheduler already started');
      return;
    }

    this.status = 'idle';
    this.logger.info('AuditorScheduler starting (Claude Code PTY mode)');

    // Initialize auditor PTY session immediately (always-active)
    void this.ensureAuditorSession();

    // Catch up any missed scheduled checks from before shutdown
    void this.catchUpMissedChecks();

    // L1: Periodic trigger
    this.periodicTimer = setInterval(() => {
      void this.trigger('periodic');
    }, AUDITOR_SCHEDULER_CONSTANTS.AUDIT_INTERVAL_MS);

    // L2: EventBus listener
    this.bindEventBusListener();

    this.logger.info('AuditorScheduler started', {
      intervalMs: AUDITOR_SCHEDULER_CONSTANTS.AUDIT_INTERVAL_MS,
      debounceMs: AUDITOR_SCHEDULER_CONSTANTS.EVENT_DEBOUNCE_MS,
      timeoutMs: AUDITOR_SCHEDULER_CONSTANTS.AUDIT_TIMEOUT_MS,
    });
  }

  /**
   * Stop all trigger layers, clean up timers, and terminate the PTY session.
   * Only called when the entire service is shutting down.
   */
  stop(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    if (this.eventDebounceTimer) {
      clearTimeout(this.eventDebounceTimer);
      this.eventDebounceTimer = null;
    }
    if (this.auditTimeoutTimer) {
      clearTimeout(this.auditTimeoutTimer);
      this.auditTimeoutTimer = null;
    }
    if (this.sessionRecoveryTimer) {
      clearTimeout(this.sessionRecoveryTimer);
      this.sessionRecoveryTimer = null;
    }

    // Terminate PTY session only on full service stop
    if (this.sessionReady && this.agentRegistrationService) {
      void this.agentRegistrationService.terminateAgentSession(
        AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME,
      ).catch((err) => {
        this.logger.error('Failed to terminate auditor session', { error: formatError(err) });
      });
    }

    this.sessionReady = false;
    this.sessionInitializing = false;
    this.sessionRetryCount = 0;
    this.sessionCooldownUntil = 0;
    this.scheduledItems = [];
    this.eventListenerBound = false;
    this.status = 'stopped';
    this.logger.info('AuditorScheduler stopped');
  }

  /**
   * Trigger an audit run.
   *
   * Checks if an audit is already running, ensures the auditor session exists,
   * sends the audit command via PTY, and keeps the session alive after completion.
   *
   * @param source - What triggered this audit ('periodic', 'event', 'api')
   * @returns Result indicating whether the audit was triggered
   */
  async trigger(source: AuditTriggerResult['source']): Promise<AuditTriggerResult> {
    const timestamp = new Date().toISOString();

    // Guard: already running
    if (this.status === 'running_audit') {
      this.logger.debug('Audit already running, skipping trigger', { source });
      return { triggered: false, reason: 'Audit already in progress', source, timestamp };
    }

    // Guard: stopped
    if (this.status === 'stopped') {
      return { triggered: false, reason: 'Scheduler is stopped', source, timestamp };
    }

    // Guard: no registration service
    if (!this.agentRegistrationService) {
      this.logger.warn('No agent registration service configured');
      return { triggered: false, reason: 'No agent registration service configured', source, timestamp };
    }

    this.logger.info('Triggering audit', { source });
    this.status = 'running_audit';
    this.lastAuditStart = Date.now();
    this.auditCount++;

    // Start timeout timer to prevent audit from hanging forever
    this.auditTimeoutTimer = setTimeout(() => {
      if (this.status === 'running_audit') {
        this.logger.error('Audit timed out, resetting to idle', {
          source,
          timeoutMs: AUDITOR_SCHEDULER_CONSTANTS.AUDIT_TIMEOUT_MS,
        });
        this.status = 'idle';
      }
    }, AUDITOR_SCHEDULER_CONSTANTS.AUDIT_TIMEOUT_MS);

    try {
      // Ensure auditor session exists
      await this.ensureAuditorSession();

      // Guard: session creation may have failed (retry exhaustion, cooldown, etc.)
      if (!this.sessionReady) {
        this.logger.warn('Auditor session not ready after ensureAuditorSession, skipping trigger', { source });
        this.status = 'idle';
        return { triggered: false, reason: 'Auditor session not ready', source, timestamp };
      }

      // Send audit command via PTY
      const auditCommand = AUDITOR_SCHEDULER_CONSTANTS.AUDIT_COMMAND;
      this.logger.info('Sending audit command via PTY', { command: auditCommand.substring(0, 80) });
      const result = await this.agentRegistrationService.sendMessageToAgent(
        AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME,
        auditCommand,
        RUNTIME_TYPES.CLAUDE_CODE,
      );

      if (!result.success) {
        this.logger.error('Failed to send audit command', { error: result.error });
        // Session may be dead — mark not ready so next trigger recreates
        this.sessionReady = false;
        this.status = 'idle';
        return { triggered: false, reason: `Send failed: ${result.error}`, source, timestamp };
      }

      this.logger.info('Audit command sent', {
        source,
        duration: Date.now() - this.lastAuditStart,
      });

      // Stay idle — do NOT terminate session (always-active mode)
      this.status = 'idle';

      return { triggered: true, source, timestamp };
    } catch (error) {
      const errMsg = formatError(error);
      this.logger.error('Audit failed', { source, error: errMsg });

      // Stay idle — do NOT terminate on error (always-active mode)
      this.status = 'idle';

      // Mark session as not ready so next trigger attempts to recreate
      this.sessionReady = false;

      return { triggered: false, reason: `Audit error: ${errMsg}`, source, timestamp };
    } finally {
      if (this.auditTimeoutTimer) {
        clearTimeout(this.auditTimeoutTimer);
        this.auditTimeoutTimer = null;
      }
    }
  }

  /**
   * Handle a user message routed from Slack.
   *
   * Passes the message to the auditor PTY session with Slack context
   * so the auditor can reply directly via the reply_slack tool.
   *
   * @param message - User message text (auditor prefix already stripped)
   * @param slackContext - Slack channel and thread identifiers
   * @returns Result indicating whether the message was handled
   */
  async handleUserMessage(
    message: string,
    slackContext: SlackContext,
  ): Promise<AuditTriggerResult> {
    const timestamp = new Date().toISOString();

    if (!this.agentRegistrationService) {
      return { triggered: false, reason: 'No agent registration service configured', source: 'api', timestamp };
    }

    // Ensure session is ready
    await this.ensureAuditorSession();

    if (!this.sessionReady) {
      return { triggered: false, reason: 'Failed to initialize auditor session', source: 'api', timestamp };
    }

    // Prefix message with Slack context so auditor can use reply_slack
    const slackPrefix = `[SLACK_CONTEXT:channelId=${slackContext.channelId},threadTs=${slackContext.threadTs}]\n`;

    try {
      this.logger.info('Handling user message via auditor PTY', {
        messageLength: message.length,
        channelId: slackContext.channelId,
      });

      const result = await this.agentRegistrationService.sendMessageToAgent(
        AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME,
        slackPrefix + message,
        RUNTIME_TYPES.CLAUDE_CODE,
      );

      if (!result.success) {
        this.sessionReady = false;
        return { triggered: false, reason: `Send failed: ${result.error}`, source: 'api', timestamp };
      }

      return { triggered: true, source: 'api', timestamp };
    } catch (error) {
      const errMsg = formatError(error);
      this.logger.error('Auditor user message failed', { error: errMsg });
      return { triggered: false, reason: `Auditor error: ${errMsg}`, source: 'api', timestamp };
    }
  }

  /**
   * Get the current scheduler status and statistics.
   *
   * @returns Status object
   */
  getStatus(): {
    status: AuditorSchedulerStatus;
    auditCount: number;
    lastAuditStart: string | null;
    periodicEnabled: boolean;
    eventListenerBound: boolean;
    runtimeReady: boolean;
  } {
    return {
      status: this.status,
      auditCount: this.auditCount,
      lastAuditStart: this.lastAuditStart
        ? new Date(this.lastAuditStart).toISOString()
        : null,
      periodicEnabled: this.periodicTimer !== null,
      eventListenerBound: this.eventListenerBound,
      runtimeReady: this.sessionReady,
    };
  }

  /**
   * Add a scheduled audit item for future tracking.
   * Items that are overdue at next startup will be caught up.
   *
   * @param scheduledTime - Unix timestamp when the audit should fire
   * @param source - Trigger source
   * @returns The created ScheduledAuditItem
   */
  addScheduledItem(scheduledTime: number, source: AuditTriggerResult['source']): ScheduledAuditItem {
    const item: ScheduledAuditItem = {
      id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      scheduledTime,
      source,
      fired: false,
    };
    this.scheduledItems.push(item);
    this.logger.debug('Added scheduled audit item', { id: item.id, scheduledTime: new Date(scheduledTime).toISOString(), source });
    return item;
  }

  /**
   * Get all scheduled items (for testing/diagnostics).
   *
   * @returns Copy of the scheduled items array
   */
  getScheduledItems(): ScheduledAuditItem[] {
    return [...this.scheduledItems];
  }

  /**
   * Check for scheduled items where scheduledTime < now and status !== fired,
   * then fire them immediately. Called on startup/restore to catch up on any
   * audits that were missed during downtime.
   *
   * @returns Number of missed checks that were caught up
   */
  async catchUpMissedChecks(): Promise<number> {
    const now = Date.now();
    const missedItems = this.scheduledItems.filter(
      (item) => item.scheduledTime < now && !item.fired
    );

    if (missedItems.length === 0) {
      this.logger.debug('No missed scheduled checks to catch up');
      return 0;
    }

    this.logger.info('Catching up missed scheduled checks', {
      missedCount: missedItems.length,
      oldestMs: now - Math.min(...missedItems.map((i) => i.scheduledTime)),
    });

    let firedCount = 0;
    for (const item of missedItems) {
      item.fired = true;
      const result = await this.trigger(item.source);
      if (result.triggered) {
        firedCount++;
        this.logger.info('Caught up missed check', {
          id: item.id,
          originalSchedule: new Date(item.scheduledTime).toISOString(),
          source: item.source,
        });
      }
    }

    this.logger.info('Missed check catch-up complete', {
      totalMissed: missedItems.length,
      successfullyFired: firedCount,
    });

    return firedCount;
  }

  // ===== Private helpers =====

  /**
   * Ensure the auditor Claude Code PTY session exists.
   * Creates a new session via AgentRegistrationService if not ready.
   * Guards against concurrent initialization and enforces retry limits
   * with exponential backoff to prevent restart loops.
   */
  private async ensureAuditorSession(): Promise<void> {
    if (this.sessionReady || this.sessionInitializing) return;
    if (!this.agentRegistrationService) return;

    // Check if in cooldown after max retries exhausted
    if (this.sessionCooldownUntil > Date.now()) {
      const remainingMs = this.sessionCooldownUntil - Date.now();
      this.logger.debug('Auditor session in retry cooldown', {
        remainingMs,
        retryCount: this.sessionRetryCount,
      });
      return;
    }

    // Reset retry count if cooldown has expired
    if (this.sessionCooldownUntil > 0 && Date.now() >= this.sessionCooldownUntil) {
      this.sessionRetryCount = 0;
      this.sessionCooldownUntil = 0;
      this.logger.info('Auditor session retry cooldown expired, resetting retry count');
    }

    // Check retry limit
    if (this.sessionRetryCount >= AUDITOR_SCHEDULER_CONSTANTS.MAX_SESSION_RETRIES) {
      this.sessionCooldownUntil = Date.now() + AUDITOR_SCHEDULER_CONSTANTS.SESSION_RETRY_COOLDOWN_MS;
      this.logger.warn('Auditor session max retries exhausted, entering cooldown', {
        retryCount: this.sessionRetryCount,
        cooldownMs: AUDITOR_SCHEDULER_CONSTANTS.SESSION_RETRY_COOLDOWN_MS,
      });
      return;
    }

    this.sessionInitializing = true;
    try {
      // Exponential backoff between retries
      if (this.sessionRetryCount > 0) {
        const backoffMs = Math.min(
          AUDITOR_SCHEDULER_CONSTANTS.SESSION_RETRY_INITIAL_BACKOFF_MS *
            Math.pow(AUDITOR_SCHEDULER_CONSTANTS.SESSION_RETRY_BACKOFF_MULTIPLIER, this.sessionRetryCount - 1),
          AUDITOR_SCHEDULER_CONSTANTS.SESSION_RETRY_COOLDOWN_MS,
        );
        this.logger.info('Waiting before auditor session retry', {
          retry: this.sessionRetryCount,
          backoffMs,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }

      const result = await this.agentRegistrationService.createAgentSession({
        sessionName: AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME,
        role: 'auditor',
        runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
        forceRecreate: true,
      });

      if (result.success) {
        this.sessionReady = true;
        this.sessionRetryCount = 0;
        this.sessionCooldownUntil = 0;
        this.logger.info('Auditor PTY session initialized (always-active mode)');
      } else {
        this.sessionRetryCount++;
        this.logger.error('Failed to create auditor PTY session', {
          error: result.error,
          retry: this.sessionRetryCount,
          maxRetries: AUDITOR_SCHEDULER_CONSTANTS.MAX_SESSION_RETRIES,
        });
      }
    } catch (error) {
      this.sessionRetryCount++;
      this.logger.error('Failed to initialize auditor session', {
        error: formatError(error),
        retry: this.sessionRetryCount,
        maxRetries: AUDITOR_SCHEDULER_CONSTANTS.MAX_SESSION_RETRIES,
      });
    } finally {
      this.sessionInitializing = false;
    }
  }

  /**
   * Bind the EventBus listener for L2 event-driven triggers.
   * Listens for agent:inactive and task:failed events with debounce.
   * Uses event_published (fires on ALL published events) instead of
   * event_delivered (only fires when a subscription match exists).
   */
  private bindEventBusListener(): void {
    if (!this.eventBusService || this.eventListenerBound) {
      return;
    }

    const triggerEvents = AUDITOR_SCHEDULER_CONSTANTS.TRIGGER_EVENT_TYPES;

    this.eventBusService.on('event_published', (payload: { eventType: string; sessionName?: string }) => {
      if (!triggerEvents.includes(payload.eventType)) {
        return;
      }

      // When the auditor's own session goes inactive (e.g., Claude Code exited after
      // context exhaustion), don't trigger a new audit immediately (self-loop).
      // Instead, schedule a delayed recovery that recreates the session and triggers
      // the next audit. Without this, the auditor would stay inactive until the L1
      // periodic timer fires (up to 15 min away).
      if (payload.sessionName === AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME) {
        this.logger.info('Auditor session went inactive, scheduling recovery', {
          eventType: payload.eventType,
          recoveryDelayMs: AUDITOR_SCHEDULER_CONSTANTS.SESSION_RECOVERY_DELAY_MS,
        });
        this.sessionReady = false;

        // Cancel any existing recovery timer to avoid stacking
        if (this.sessionRecoveryTimer) {
          clearTimeout(this.sessionRecoveryTimer);
        }

        this.sessionRecoveryTimer = setTimeout(() => {
          this.sessionRecoveryTimer = null;
          if (this.status !== 'stopped') {
            this.logger.info('Auditor session recovery: triggering session recreation');
            void this.trigger('event');
          }
        }, AUDITOR_SCHEDULER_CONSTANTS.SESSION_RECOVERY_DELAY_MS);

        return;
      }

      this.logger.debug('Audit-triggering event received, debouncing', {
        eventType: payload.eventType,
      });

      // Debounce: reset timer on each qualifying event
      if (this.eventDebounceTimer) {
        clearTimeout(this.eventDebounceTimer);
      }

      this.eventDebounceTimer = setTimeout(() => {
        this.eventDebounceTimer = null;
        void this.trigger('event');
      }, AUDITOR_SCHEDULER_CONSTANTS.EVENT_DEBOUNCE_MS);
    });

    this.eventListenerBound = true;
    this.logger.debug('EventBus listener bound', { triggerEvents });
  }
}
