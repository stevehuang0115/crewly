/**
 * Unified Scheduler Service
 *
 * Consolidates cron, interval, and idle-based scheduling into a single
 * persistent service with agent auto-start capabilities.
 *
 * Features:
 * - Cron schedules: standard 5-field expressions
 * - Interval schedules: fixed-interval triggers
 * - Idle schedules: trigger when agent has been idle for N minutes
 * - Persistent storage in ~/.crewly/unified-schedules.json
 * - Auto-start agents that are offline when triggered
 * - Auto-pause after maxConsecutiveTriggers without agent response
 * - Manual trigger, pause, and resume
 *
 * Runs a 60-second evaluation loop that checks all active schedules
 * and triggers those that are due.
 *
 * @module services/workflow/unified-scheduler.service
 */

import { EventEmitter } from 'events';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type {
  UnifiedSchedule,
  CreateScheduleRequest,
  UpdateScheduleRequest,
  UnifiedScheduleStore,
  SchedulerHealth,
  ScheduleType,
} from './unified-scheduler.types.js';
import {
  UNIFIED_SCHEDULER_CONSTANTS,
  validateCreateRequest,
} from './unified-scheduler.types.js';

// =============================================================================
// Service
// =============================================================================

/**
 * UnifiedSchedulerService manages all schedule types (cron, interval, idle)
 * in a single persistent store with a 60-second evaluation loop.
 *
 * Uses sendMessageToAgent (via callback) for message delivery and
 * supports auto-starting offline agents.
 */
export class UnifiedSchedulerService extends EventEmitter {
  private static instance: UnifiedSchedulerService | null = null;
  private readonly logger: ComponentLogger;
  private readonly storagePath: string;

  /** All schedules indexed by ID */
  private schedules: Map<string, UnifiedSchedule> = new Map();
  /** Evaluation loop timer */
  private evalTimer: ReturnType<typeof setInterval> | null = null;
  /** Whether the eval loop is running */
  private running = false;
  /** Timestamp of last evaluation cycle */
  private lastEvaluatedAt: string | null = null;
  /** Total triggers since service start */
  private totalTriggersSinceStart = 0;

  /**
   * Callback for sending messages to agents.
   * Set via setMessageCallback() — decouples from AgentRegistrationService.
   */
  private messageCallback: ((sessionName: string, message: string) => Promise<{ success: boolean }>) | null = null;

  /**
   * Callback for checking if an agent is online.
   * Set via setAgentStatusCallback().
   */
  private agentStatusCallback: ((sessionName: string) => Promise<boolean>) | null = null;

  /**
   * Callback for starting an offline agent.
   * Set via setAgentStartCallback().
   */
  private agentStartCallback: ((sessionName: string) => Promise<boolean>) | null = null;

  /**
   * Callback for checking agent idle status.
   * Set via setIdleCheckCallback().
   */
  private idleCheckCallback: ((sessionName: string) => Promise<{ idle: boolean; idleMinutes: number }>) | null = null;

  private constructor(crewlyHome?: string) {
    super();
    this.logger = LoggerService.getInstance().createComponentLogger('UnifiedScheduler');
    const home = crewlyHome ?? join(homedir(), '.crewly');
    this.storagePath = join(home, UNIFIED_SCHEDULER_CONSTANTS.STORAGE_FILE);
  }

  /**
   * Get the singleton instance.
   *
   * @param crewlyHome - Override ~/.crewly path (for testing)
   * @returns Service instance
   */
  static getInstance(crewlyHome?: string): UnifiedSchedulerService {
    if (!UnifiedSchedulerService.instance) {
      UnifiedSchedulerService.instance = new UnifiedSchedulerService(crewlyHome);
    }
    return UnifiedSchedulerService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    if (UnifiedSchedulerService.instance) {
      UnifiedSchedulerService.instance.stop();
    }
    UnifiedSchedulerService.instance = null;
  }

  // ---------------------------------------------------------------------------
  // Dependency Injection (callbacks)
  // ---------------------------------------------------------------------------

  /**
   * Set the callback for sending messages to agents.
   *
   * @param callback - Function that sends a message to an agent by session name
   */
  setMessageCallback(callback: (sessionName: string, message: string) => Promise<{ success: boolean }>): void {
    this.messageCallback = callback;
  }

  /**
   * Set the callback for checking if an agent is online.
   *
   * @param callback - Returns true if the agent is currently active
   */
  setAgentStatusCallback(callback: (sessionName: string) => Promise<boolean>): void {
    this.agentStatusCallback = callback;
  }

  /**
   * Set the callback for starting an offline agent.
   *
   * @param callback - Starts the agent and returns true if successful
   */
  setAgentStartCallback(callback: (sessionName: string) => Promise<boolean>): void {
    this.agentStartCallback = callback;
  }

  /**
   * Set the callback for checking agent idle status.
   *
   * @param callback - Returns idle status and idle duration
   */
  setIdleCheckCallback(callback: (sessionName: string) => Promise<{ idle: boolean; idleMinutes: number }>): void {
    this.idleCheckCallback = callback;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the scheduler evaluation loop.
   *
   * Loads persisted schedules from disk and begins the 60-second
   * evaluation cycle.
   */
  start(): void {
    if (this.running) return;

    this.loadFromDisk();
    this.running = true;
    this.evalTimer = setInterval(() => {
      this.evaluate().catch(err => {
        this.logger.error('Evaluation cycle failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, UNIFIED_SCHEDULER_CONSTANTS.EVAL_INTERVAL_MS);

    this.logger.info('Unified Scheduler started', {
      scheduleCount: this.schedules.size,
      activeCount: this.getActiveCount(),
    });
  }

  /**
   * Stop the scheduler evaluation loop.
   */
  stop(): void {
    if (this.evalTimer) {
      clearInterval(this.evalTimer);
      this.evalTimer = null;
    }
    this.running = false;
    this.logger.info('Unified Scheduler stopped');
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  /**
   * Create a new schedule.
   *
   * @param request - Schedule creation request
   * @returns Created schedule
   * @throws Error if validation fails
   */
  create(request: CreateScheduleRequest): UnifiedSchedule {
    const validationError = validateCreateRequest(request);
    if (validationError) {
      throw new Error(validationError);
    }

    const now = new Date().toISOString();
    const schedule: UnifiedSchedule = {
      id: randomUUID(),
      target: request.target,
      type: request.type,
      cron: request.cron,
      intervalMinutes: request.intervalMinutes,
      idleTimeoutMinutes: request.idleTimeoutMinutes,
      message: request.message,
      enabled: request.enabled !== false,
      autoStart: request.autoStart !== false,
      maxConsecutiveTriggers: request.maxConsecutiveTriggers ?? UNIFIED_SCHEDULER_CONSTANTS.DEFAULT_MAX_CONSECUTIVE,
      createdAt: now,
      updatedAt: now,
      lastTriggeredAt: null,
      triggerCount: 0,
      consecutiveTriggers: 0,
      status: (request.enabled !== false) ? 'active' : 'paused',
    };

    this.schedules.set(schedule.id, schedule);
    this.persist();

    this.logger.info('Schedule created', {
      id: schedule.id,
      type: schedule.type,
      target: schedule.target,
      status: schedule.status,
    });

    return schedule;
  }

  /**
   * Get a schedule by ID.
   *
   * @param id - Schedule ID
   * @returns Schedule or null
   */
  get(id: string): UnifiedSchedule | null {
    return this.schedules.get(id) ?? null;
  }

  /**
   * List all schedules, optionally filtered by target session.
   *
   * @param target - Optional session name filter
   * @returns Array of schedules
   */
  list(target?: string): UnifiedSchedule[] {
    const all = Array.from(this.schedules.values());
    if (target) {
      return all.filter(s => s.target === target);
    }
    return all;
  }

  /**
   * Update an existing schedule.
   *
   * @param id - Schedule ID
   * @param updates - Partial update fields
   * @returns Updated schedule or null if not found
   */
  update(id: string, updates: UpdateScheduleRequest): UnifiedSchedule | null {
    const schedule = this.schedules.get(id);
    if (!schedule) return null;

    if (updates.cron !== undefined) schedule.cron = updates.cron;
    if (updates.intervalMinutes !== undefined) schedule.intervalMinutes = updates.intervalMinutes;
    if (updates.idleTimeoutMinutes !== undefined) schedule.idleTimeoutMinutes = updates.idleTimeoutMinutes;
    if (updates.message !== undefined) schedule.message = updates.message;
    if (updates.autoStart !== undefined) schedule.autoStart = updates.autoStart;
    if (updates.maxConsecutiveTriggers !== undefined) schedule.maxConsecutiveTriggers = updates.maxConsecutiveTriggers;

    if (updates.enabled !== undefined) {
      schedule.enabled = updates.enabled;
      schedule.status = updates.enabled ? 'active' : 'paused';
    }

    schedule.updatedAt = new Date().toISOString();
    this.schedules.set(id, schedule);
    this.persist();

    return schedule;
  }

  /**
   * Delete a schedule.
   *
   * @param id - Schedule ID
   * @returns True if deleted
   */
  delete(id: string): boolean {
    const deleted = this.schedules.delete(id);
    if (deleted) {
      this.persist();
      this.logger.info('Schedule deleted', { id });
    }
    return deleted;
  }

  /**
   * Pause a schedule.
   *
   * @param id - Schedule ID
   * @returns Updated schedule or null
   */
  pause(id: string): UnifiedSchedule | null {
    const schedule = this.schedules.get(id);
    if (!schedule) return null;

    schedule.enabled = false;
    schedule.status = 'paused';
    schedule.updatedAt = new Date().toISOString();
    this.schedules.set(id, schedule);
    this.persist();

    this.logger.info('Schedule paused', { id, target: schedule.target });
    return schedule;
  }

  /**
   * Resume a paused schedule.
   *
   * @param id - Schedule ID
   * @returns Updated schedule or null
   */
  resume(id: string): UnifiedSchedule | null {
    const schedule = this.schedules.get(id);
    if (!schedule) return null;

    schedule.enabled = true;
    schedule.status = 'active';
    schedule.consecutiveTriggers = 0;
    schedule.updatedAt = new Date().toISOString();
    this.schedules.set(id, schedule);
    this.persist();

    this.logger.info('Schedule resumed', { id, target: schedule.target });
    return schedule;
  }

  /**
   * Manually trigger a schedule now, regardless of timing.
   *
   * @param id - Schedule ID
   * @returns True if triggered successfully
   */
  async triggerNow(id: string): Promise<boolean> {
    const schedule = this.schedules.get(id);
    if (!schedule) return false;

    return this.executeSchedule(schedule);
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  /**
   * Get scheduler health and statistics.
   *
   * @returns Health stats
   */
  getHealth(): SchedulerHealth {
    const all = Array.from(this.schedules.values());
    const byType: Record<ScheduleType, number> = { cron: 0, interval: 0, idle: 0 };
    let activeCount = 0;
    let pausedCount = 0;

    for (const s of all) {
      byType[s.type]++;
      if (s.status === 'active') activeCount++;
      if (s.status === 'paused') pausedCount++;
    }

    return {
      running: this.running,
      activeCount,
      pausedCount,
      totalCount: all.length,
      totalTriggers: this.totalTriggersSinceStart,
      lastEvaluatedAt: this.lastEvaluatedAt,
      byType,
    };
  }

  // ---------------------------------------------------------------------------
  // Evaluation Loop
  // ---------------------------------------------------------------------------

  /**
   * Evaluate all active schedules and trigger those that are due.
   *
   * Called every 60 seconds by the eval timer. Checks each schedule
   * type against its timing criteria and executes if due.
   */
  async evaluate(): Promise<void> {
    this.lastEvaluatedAt = new Date().toISOString();

    const actives = Array.from(this.schedules.values()).filter(
      s => s.enabled && s.status === 'active'
    );

    for (const schedule of actives) {
      try {
        const isDue = await this.isScheduleDue(schedule);
        if (isDue) {
          await this.executeSchedule(schedule);
        }
      } catch (err) {
        this.logger.error('Schedule evaluation failed', {
          id: schedule.id,
          type: schedule.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Check if a schedule is due for triggering.
   *
   * @param schedule - Schedule to check
   * @returns True if the schedule should trigger now
   */
  private async isScheduleDue(schedule: UnifiedSchedule): Promise<boolean> {
    const now = Date.now();

    switch (schedule.type) {
      case 'cron':
        return this.isCronDue(schedule);

      case 'interval': {
        if (!schedule.intervalMinutes) return false;
        const intervalMs = schedule.intervalMinutes * 60_000;
        const lastTrigger = schedule.lastTriggeredAt
          ? new Date(schedule.lastTriggeredAt).getTime()
          : new Date(schedule.createdAt).getTime();
        return (now - lastTrigger) >= intervalMs;
      }

      case 'idle': {
        if (!this.idleCheckCallback) return false;
        const timeout = schedule.idleTimeoutMinutes ?? UNIFIED_SCHEDULER_CONSTANTS.DEFAULT_IDLE_TIMEOUT_MINUTES;
        const { idle, idleMinutes } = await this.idleCheckCallback(schedule.target);
        return idle && idleMinutes >= timeout;
      }

      default:
        return false;
    }
  }

  /**
   * Check if a cron schedule is due (within the current evaluation window).
   *
   * Compares the cron expression against the current time.
   * Uses minute-level granularity (matches eval loop frequency).
   *
   * @param schedule - Cron schedule to check
   * @returns True if the current minute matches the cron expression
   */
  private isCronDue(schedule: UnifiedSchedule): boolean {
    if (!schedule.cron) return false;

    const now = new Date();
    const fields = schedule.cron.trim().split(/\s+/);
    if (fields.length !== 5) return false;

    const [minuteField, hourField, domField, monthField, dowField] = fields;

    const matchField = (field: string, value: number, max: number): boolean => {
      if (field === '*') return true;
      // Handle comma-separated values
      const parts = field.split(',');
      for (const part of parts) {
        // Handle range (e.g., 1-5)
        if (part.includes('-')) {
          const [start, end] = part.split('-').map(Number);
          if (value >= start && value <= end) return true;
        }
        // Handle step (e.g., */5)
        else if (part.includes('/')) {
          const [base, step] = part.split('/');
          const stepNum = Number(step);
          const baseNum = base === '*' ? 0 : Number(base);
          if (stepNum > 0 && (value - baseNum) % stepNum === 0 && value >= baseNum) return true;
        }
        // Exact match
        else if (Number(part) === value) {
          return true;
        }
      }
      return false;
    };

    const minute = now.getMinutes();
    const hour = now.getHours();
    const dom = now.getDate();
    const month = now.getMonth() + 1;
    const dow = now.getDay();

    if (!matchField(minuteField, minute, 59)) return false;
    if (!matchField(hourField, hour, 23)) return false;
    if (!matchField(domField, dom, 31)) return false;
    if (!matchField(monthField, month, 12)) return false;
    if (!matchField(dowField, dow, 6)) return false;

    // Prevent double-trigger in the same minute
    if (schedule.lastTriggeredAt) {
      const lastTrigger = new Date(schedule.lastTriggeredAt);
      if (
        lastTrigger.getMinutes() === minute &&
        lastTrigger.getHours() === hour &&
        lastTrigger.getDate() === dom
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * Execute a schedule: send message to agent, handle auto-start,
   * track consecutive triggers, and auto-pause if limit reached.
   *
   * @param schedule - Schedule to execute
   * @returns True if message was delivered successfully
   */
  private async executeSchedule(schedule: UnifiedSchedule): Promise<boolean> {
    this.logger.info('Triggering schedule', {
      id: schedule.id,
      type: schedule.type,
      target: schedule.target,
      triggerCount: schedule.triggerCount,
    });

    // Check if agent is online (if we have the callback)
    let agentOnline = true;
    if (this.agentStatusCallback) {
      agentOnline = await this.agentStatusCallback(schedule.target);
    }

    // Auto-start if offline and autoStart is enabled
    if (!agentOnline && schedule.autoStart && this.agentStartCallback) {
      this.logger.info('Auto-starting offline agent', { target: schedule.target });
      const started = await this.agentStartCallback(schedule.target);
      if (!started) {
        this.logger.warn('Failed to auto-start agent', { target: schedule.target });
        schedule.error = 'Agent auto-start failed';
        this.schedules.set(schedule.id, schedule);
        this.persist();
        return false;
      }
      agentOnline = true;
    }

    if (!agentOnline) {
      this.logger.warn('Agent offline, skipping trigger', { target: schedule.target });
      return false;
    }

    // Send message
    let success = false;
    if (this.messageCallback) {
      const result = await this.messageCallback(schedule.target, schedule.message);
      success = result.success;
    } else {
      this.logger.warn('No message callback set — cannot deliver message');
    }

    // Update tracking
    const now = new Date().toISOString();
    schedule.lastTriggeredAt = now;
    schedule.triggerCount++;
    schedule.updatedAt = now;
    this.totalTriggersSinceStart++;

    if (success) {
      schedule.consecutiveTriggers++;
    }

    // Auto-pause if consecutive trigger limit reached
    if (schedule.consecutiveTriggers >= schedule.maxConsecutiveTriggers) {
      schedule.status = 'paused';
      schedule.enabled = false;
      schedule.error = `Auto-paused after ${schedule.consecutiveTriggers} consecutive triggers without agent response`;
      this.logger.warn('Schedule auto-paused (max consecutive triggers)', {
        id: schedule.id,
        target: schedule.target,
        consecutiveTriggers: schedule.consecutiveTriggers,
      });
    }

    this.schedules.set(schedule.id, schedule);
    this.persist();

    this.emit('triggered', { scheduleId: schedule.id, target: schedule.target, success });
    return success;
  }

  /**
   * Reset the consecutive trigger counter for a target agent.
   *
   * Called when an agent shows activity (e.g., sends a message, completes a task).
   * This prevents auto-pausing schedules for responsive agents.
   *
   * @param target - Agent session name
   */
  resetConsecutiveTriggers(target: string): void {
    for (const schedule of this.schedules.values()) {
      if (schedule.target === target && schedule.consecutiveTriggers > 0) {
        schedule.consecutiveTriggers = 0;
        this.schedules.set(schedule.id, schedule);
      }
    }
    this.persist();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Save all schedules to disk.
   */
  private persist(): void {
    try {
      const dir = this.storagePath.replace(/\/[^/]+$/, '');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const store: UnifiedScheduleStore = {
        version: UNIFIED_SCHEDULER_CONSTANTS.SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        schedules: Array.from(this.schedules.values()),
      };

      writeFileSync(this.storagePath, JSON.stringify(store, null, 2), 'utf-8');
    } catch (err) {
      this.logger.error('Failed to persist schedules', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load schedules from disk.
   */
  private loadFromDisk(): void {
    try {
      if (!existsSync(this.storagePath)) return;

      const raw = readFileSync(this.storagePath, 'utf-8');
      const store = JSON.parse(raw) as UnifiedScheduleStore;

      this.schedules.clear();
      for (const schedule of store.schedules) {
        this.schedules.set(schedule.id, schedule);
      }

      this.logger.info('Loaded schedules from disk', {
        count: this.schedules.size,
      });
    } catch (err) {
      this.logger.error('Failed to load schedules from disk', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Get count of active schedules.
   */
  private getActiveCount(): number {
    return Array.from(this.schedules.values()).filter(s => s.status === 'active').length;
  }
}
