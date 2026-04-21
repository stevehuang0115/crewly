/**
 * TriggerEngine Service — Manages trigger lifecycle and execution.
 *
 * Handles three trigger types:
 * - TimeTriggers: cron-based or one-shot delay/fireAt scheduling
 * - SignalTriggers: EventBus event subscriptions with optional filters
 * - CompoundTriggers: AND/OR combinations of time+signal conditions
 *
 * Lifecycle management:
 * - Tracks fireCount, maxFires (auto-exhaust), maxIdleFires (auto-cancel on idle)
 * - Persists triggers to disk as JSON
 * - Supports pause/resume/cancel operations
 *
 * @module services/v3/trigger-engine.service
 */

import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { ensureDir, atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import {
  type Trigger,
  type TriggerStatus,
  type TriggerAction,
  type TriggerConfig,
  type TimeTriggerConfig,
  type SignalTriggerConfig,
  type CompoundTriggerConfig,
  type CreateTriggerInput,
  createTrigger,
  validateCreateTriggerInput,
  isValidTriggerConfig,
} from '../../types/v2/index.js';
import { getNextRunTime } from '../workflow/cron-task.service.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory name under .crewly for trigger storage. */
const TRIGGERS_DIR = 'triggers';

/** File name for persisted trigger store. */
const TRIGGERS_FILE = 'triggers.json';

/** How often to check time-based triggers (60 seconds). */
const TIME_CHECK_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback invoked when a trigger fires and produces an action.
 *
 * @param trigger - The trigger that fired
 * @param action - The action to execute
 */
export type TriggerActionHandler = (trigger: Trigger, action: TriggerAction) => Promise<void>;

/**
 * Result of a trigger fire attempt — indicates whether the fire was productive.
 */
export interface TriggerFireResult {
  /** The trigger that fired */
  triggerId: string;
  /** Whether the fire produced useful work (false = idle fire) */
  productive: boolean;
  /** ISO timestamp of the fire */
  firedAt: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * TriggerEngine manages the lifecycle of Trigger entities.
 *
 * Uses singleton pattern. Time triggers are evaluated on a polling interval.
 * Signal triggers subscribe to EventBus events. Compound triggers combine
 * both with AND/OR logic.
 *
 * @example
 * ```typescript
 * const engine = TriggerEngine.getInstance('/path/to/project');
 * engine.setEventBus(eventBusService);
 * engine.setActionHandler(async (trigger, action) => { ... });
 * await engine.start();
 * ```
 */
export class TriggerEngine {
  private static instance: TriggerEngine | null = null;

  private readonly logger: ComponentLogger;
  private readonly triggersDir: string;
  private readonly triggersFile: string;

  /** In-memory trigger store, keyed by trigger ID. */
  private triggers: Map<string, Trigger> = new Map();

  /** EventBus reference for signal triggers. */
  private eventBus: EventBusService | null = null;
  /**
   * Bound signal-listener reference kept so `stop()` can detach it and we
   * don't accumulate a new copy on every `start()`. Without this, repeated
   * start/stop cycles (dev reloads, tests, escalation restarts) would
   * register additional listeners that each fire independently.
   */
  private signalListener: ((eventData: { eventId: string; eventType: string; sessionName: string }) => void) | null = null;

  /** Callback for executing trigger actions. */
  private actionHandler: TriggerActionHandler | null = null;

  /** Interval handle for time trigger polling. */
  private timeCheckInterval: ReturnType<typeof setInterval> | null = null;

  /** Timeout handles for one-shot delay/fireAt triggers, keyed by trigger ID. */
  private oneShotTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Whether the engine is currently running. */
  private running = false;

  /**
   * Creates a new TriggerEngine.
   *
   * @param projectPath - Absolute path to the project root
   */
  private constructor(private readonly projectPath: string) {
    this.logger = LoggerService.getInstance().createComponentLogger('TriggerEngine');
    this.triggersDir = path.join(projectPath, '.crewly', TRIGGERS_DIR);
    this.triggersFile = path.join(this.triggersDir, TRIGGERS_FILE);
  }

  /**
   * Gets the singleton instance.
   *
   * @param projectPath - Absolute path to the project root
   * @returns The singleton TriggerEngine instance
   */
  public static getInstance(projectPath?: string): TriggerEngine {
    if (!TriggerEngine.instance) {
      const resolvedPath = projectPath || process.env.CREWLY_PROJECT_PATH || process.cwd();
      TriggerEngine.instance = new TriggerEngine(resolvedPath);
    }
    return TriggerEngine.instance;
  }

  /**
   * Resets the singleton instance. For test isolation only.
   */
  public static resetInstance(): void {
    if (TriggerEngine.instance) {
      TriggerEngine.instance.stop();
    }
    TriggerEngine.instance = null;
  }

  // ---------------------------------------------------------------------------
  // Dependency Injection
  // ---------------------------------------------------------------------------

  /**
   * Sets the EventBus for signal trigger subscriptions.
   *
   * @param eventBus - The EventBusService instance
   */
  public setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  /**
   * Sets the handler that executes trigger actions.
   *
   * @param handler - Callback invoked when a trigger fires
   */
  public setActionHandler(handler: TriggerActionHandler): void {
    this.actionHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Starts the TriggerEngine: loads persisted triggers from disk,
   * sets up time polling interval, and registers signal listeners.
   */
  public async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('TriggerEngine already running');
      return;
    }

    await this.loadTriggers();
    this.setupTimePolling();
    this.setupSignalListeners();
    this.setupOneShotTimers();
    this.running = true;
    this.logger.info('TriggerEngine started', { triggerCount: this.triggers.size });
  }

  /**
   * Stops the TriggerEngine: clears intervals, timers, and signal listeners.
   */
  public stop(): void {
    if (this.timeCheckInterval) {
      clearInterval(this.timeCheckInterval);
      this.timeCheckInterval = null;
    }

    for (const [, timer] of this.oneShotTimers) {
      clearTimeout(timer);
    }
    this.oneShotTimers.clear();

    this.teardownSignalListeners();

    this.running = false;
    this.logger.info('TriggerEngine stopped');
  }

  /**
   * Returns whether the engine is currently running.
   *
   * @returns True if the engine is running
   */
  public isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // CRUD Operations
  // ---------------------------------------------------------------------------

  /**
   * Creates a new trigger and persists it.
   *
   * @param input - Trigger creation input
   * @returns The created Trigger
   * @throws Error if input validation fails
   */
  public async create(input: CreateTriggerInput): Promise<Trigger> {
    const errors = validateCreateTriggerInput(input);
    if (errors.length > 0) {
      throw new Error(`Invalid trigger input: ${errors.join(', ')}`);
    }

    // Idempotency by (createdBy, name): if a named trigger with the same
    // owner+name already exists and is active, return it instead of
    // registering a duplicate. This prevents the accumulation bug where a
    // system cron (e.g. escalation-every-5-min) re-registered on every boot
    // would fire N times per interval after N restarts.
    if (input.name) {
      for (const existing of this.triggers.values()) {
        if (
          existing.status === 'active' &&
          existing.createdBy === input.createdBy &&
          existing.name === input.name
        ) {
          this.logger.debug('Trigger already registered, reusing existing', {
            id: existing.id,
            createdBy: existing.createdBy,
            name: existing.name,
          });
          return existing;
        }
      }
    }

    const trigger = createTrigger(input);
    this.triggers.set(trigger.id, trigger);

    // Calculate nextFireAt for time triggers
    if (trigger.config.type === 'time') {
      trigger.nextFireAt = this.calculateNextFireAt(trigger.config);
    }

    await this.persistTriggers();

    // Set up runtime hooks if engine is running
    if (this.running) {
      if (trigger.config.type === 'time' && (trigger.config.delayMs || trigger.config.fireAt)) {
        this.scheduleOneShot(trigger);
      }
    }

    this.logger.info('Trigger created', { id: trigger.id, type: trigger.type });
    return trigger;
  }

  /**
   * Gets a trigger by ID.
   *
   * @param id - Trigger UUID
   * @returns The trigger, or undefined if not found
   */
  public get(id: string): Trigger | undefined {
    return this.triggers.get(id);
  }

  /**
   * Lists all triggers, optionally filtered by status.
   *
   * @param status - Optional status filter
   * @returns Array of matching triggers
   */
  public list(status?: TriggerStatus): Trigger[] {
    const all = Array.from(this.triggers.values());
    if (status) {
      return all.filter((t) => t.status === status);
    }
    return all;
  }

  /**
   * Pauses an active trigger.
   *
   * @param id - Trigger UUID
   * @returns True if the trigger was paused
   */
  public async pause(id: string): Promise<boolean> {
    const trigger = this.triggers.get(id);
    if (!trigger || trigger.status !== 'active') {
      return false;
    }
    trigger.status = 'paused';
    this.clearOneShotTimer(id);
    await this.persistTriggers();
    this.logger.info('Trigger paused', { id });
    return true;
  }

  /**
   * Resumes a paused trigger.
   *
   * @param id - Trigger UUID
   * @returns True if the trigger was resumed
   */
  public async resume(id: string): Promise<boolean> {
    const trigger = this.triggers.get(id);
    if (!trigger || trigger.status !== 'paused') {
      return false;
    }
    trigger.status = 'active';

    // Recalculate nextFireAt for time triggers
    if (trigger.config.type === 'time') {
      trigger.nextFireAt = this.calculateNextFireAt(trigger.config);
      if (this.running && (trigger.config.delayMs || trigger.config.fireAt)) {
        this.scheduleOneShot(trigger);
      }
    }

    await this.persistTriggers();
    this.logger.info('Trigger resumed', { id });
    return true;
  }

  /**
   * Cancels a trigger permanently.
   *
   * @param id - Trigger UUID
   * @returns True if the trigger was cancelled
   */
  public async cancel(id: string): Promise<boolean> {
    const trigger = this.triggers.get(id);
    if (!trigger || trigger.status === 'cancelled') {
      return false;
    }
    trigger.status = 'cancelled';
    this.clearOneShotTimer(id);
    await this.persistTriggers();
    this.logger.info('Trigger cancelled', { id });
    return true;
  }

  /**
   * Deletes a trigger entirely (removes from store).
   *
   * @param id - Trigger UUID
   * @returns True if the trigger was deleted
   */
  public async delete(id: string): Promise<boolean> {
    if (!this.triggers.has(id)) {
      return false;
    }
    this.clearOneShotTimer(id);
    this.triggers.delete(id);
    await this.persistTriggers();
    this.logger.info('Trigger deleted', { id });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Fire Logic
  // ---------------------------------------------------------------------------

  /**
   * Fires a trigger: increments counters, executes action, manages lifecycle.
   *
   * @param trigger - The trigger to fire
   * @param productive - Whether this fire is considered productive (not idle)
   * @returns The fire result
   */
  public async fire(trigger: Trigger, productive = true): Promise<TriggerFireResult> {
    if (trigger.status !== 'active') {
      this.logger.warn('Attempted to fire non-active trigger', {
        id: trigger.id,
        status: trigger.status,
      });
      return { triggerId: trigger.id, productive: false, firedAt: new Date().toISOString() };
    }

    const now = new Date().toISOString();
    trigger.fireCount += 1;
    trigger.lastFiredAt = now;

    // Idle fire tracking
    if (!productive) {
      trigger.consecutiveIdleFires += 1;
    } else {
      trigger.consecutiveIdleFires = 0;
    }

    // Execute action
    if (this.actionHandler) {
      try {
        await this.actionHandler(trigger, trigger.action);
      } catch (err) {
        this.logger.error('Action handler failed', {
          triggerId: trigger.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Lifecycle checks
    if (trigger.maxFires !== undefined && trigger.fireCount >= trigger.maxFires) {
      trigger.status = 'exhausted';
      this.clearOneShotTimer(trigger.id);
      this.logger.info('Trigger exhausted (maxFires reached)', {
        id: trigger.id,
        fireCount: trigger.fireCount,
      });
    } else if (trigger.consecutiveIdleFires >= trigger.maxIdleFires) {
      trigger.status = 'cancelled';
      this.clearOneShotTimer(trigger.id);
      this.logger.info('Trigger cancelled (maxIdleFires reached)', {
        id: trigger.id,
        consecutiveIdleFires: trigger.consecutiveIdleFires,
      });
    } else if (trigger.config.type === 'time' && trigger.config.cronExpression) {
      // Recalculate next fire for cron triggers
      trigger.nextFireAt = this.calculateNextFireAt(trigger.config);
    }

    await this.persistTriggers();

    return { triggerId: trigger.id, productive, firedAt: now };
  }

  // ---------------------------------------------------------------------------
  // Time Trigger Handling
  // ---------------------------------------------------------------------------

  /**
   * Sets up the polling interval for cron-based time triggers.
   */
  private setupTimePolling(): void {
    this.timeCheckInterval = setInterval(() => {
      this.evaluateTimeTriggers().catch((err) => {
        this.logger.error('Time trigger evaluation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, TIME_CHECK_INTERVAL_MS);
  }

  /**
   * Evaluates all active cron-based time triggers against the current time.
   */
  public async evaluateTimeTriggers(): Promise<TriggerFireResult[]> {
    const results: TriggerFireResult[] = [];
    const now = new Date();

    for (const trigger of this.triggers.values()) {
      if (trigger.status !== 'active') continue;
      if (trigger.config.type !== 'time') continue;

      const config = trigger.config;

      // Only cron triggers are evaluated by polling; delay/fireAt use one-shot timers
      if (!config.cronExpression) continue;

      const timezone = config.timezone || 'UTC';
      if (this.cronMatchesNow(config.cronExpression, timezone, now)) {
        const result = await this.fire(trigger);
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Checks if a cron expression matches the current moment.
   *
   * @param cronExpression - Standard 5-field cron expression
   * @param timezone - IANA timezone string
   * @param now - Current time
   * @returns True if the cron matches
   */
  private cronMatchesNow(cronExpression: string, timezone: string, now: Date): boolean {
    try {
      // Use getNextRunTime and check if the next run is within the current minute
      const nextRun = getNextRunTime(cronExpression, timezone, new Date(now.getTime() - 60_000));
      const nextRunDate = new Date(nextRun);
      const diffMs = Math.abs(nextRunDate.getTime() - now.getTime());
      return diffMs < TIME_CHECK_INTERVAL_MS;
    } catch {
      this.logger.error('Invalid cron expression', { cronExpression });
      return false;
    }
  }

  /**
   * Sets up one-shot timers for delay/fireAt time triggers.
   */
  private setupOneShotTimers(): void {
    for (const trigger of this.triggers.values()) {
      if (trigger.status !== 'active') continue;
      if (trigger.config.type !== 'time') continue;
      if (trigger.config.delayMs || trigger.config.fireAt) {
        this.scheduleOneShot(trigger);
      }
    }
  }

  /**
   * Schedules a one-shot timer for a delay or fireAt trigger.
   *
   * @param trigger - The time trigger to schedule
   */
  private scheduleOneShot(trigger: Trigger): void {
    this.clearOneShotTimer(trigger.id);

    const config = trigger.config as TimeTriggerConfig;
    let delayMs: number;

    if (config.fireAt) {
      const fireAtDate = new Date(config.fireAt);
      delayMs = fireAtDate.getTime() - Date.now();
      if (delayMs <= 0) {
        // Already past — fire immediately
        this.fire(trigger).catch((err) => {
          this.logger.error('Immediate fire failed', { triggerId: trigger.id, error: String(err) });
        });
        return;
      }
    } else if (config.delayMs) {
      const createdAt = new Date(trigger.createdAt).getTime();
      delayMs = createdAt + config.delayMs - Date.now();
      if (delayMs <= 0) {
        this.fire(trigger).catch((err) => {
          this.logger.error('Immediate fire failed', { triggerId: trigger.id, error: String(err) });
        });
        return;
      }
    } else {
      return;
    }

    const timer = setTimeout(() => {
      this.oneShotTimers.delete(trigger.id);
      this.fire(trigger).catch((err) => {
        this.logger.error('One-shot fire failed', { triggerId: trigger.id, error: String(err) });
      });
    }, delayMs);

    this.oneShotTimers.set(trigger.id, timer);
  }

  /**
   * Clears a one-shot timer for a trigger.
   *
   * @param triggerId - The trigger ID
   */
  private clearOneShotTimer(triggerId: string): void {
    const timer = this.oneShotTimers.get(triggerId);
    if (timer) {
      clearTimeout(timer);
      this.oneShotTimers.delete(triggerId);
    }
  }

  /**
   * Calculates the next fire time for a time trigger config.
   *
   * @param config - Time trigger configuration
   * @returns ISO string of next fire time, or undefined
   */
  private calculateNextFireAt(config: TimeTriggerConfig): string | undefined {
    if (config.cronExpression) {
      try {
        return getNextRunTime(config.cronExpression, config.timezone || 'UTC');
      } catch {
        return undefined;
      }
    }
    if (config.fireAt) {
      return config.fireAt;
    }
    // delayMs — calculated relative to creation, not useful for nextFireAt
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Signal Trigger Handling
  // ---------------------------------------------------------------------------

  /**
   * Sets up EventBus listeners for signal triggers.
   * Listens to the 'event_published' event on the EventBus.
   */
  private setupSignalListeners(): void {
    if (!this.eventBus) {
      this.logger.warn('No EventBus set — signal triggers will not fire');
      return;
    }

    if (this.signalListener) {
      // Already registered — starting without stopping first would double up.
      return;
    }

    this.signalListener = (eventData) => {
      this.handleSignalEvent(eventData).catch((err) => {
        this.logger.error('Signal event handling failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    this.eventBus.on('event_published', this.signalListener);
  }

  /**
   * Detaches the signal listener registered in {@link setupSignalListeners}.
   * Safe to call when no listener is attached.
   */
  private teardownSignalListeners(): void {
    if (this.eventBus && this.signalListener) {
      this.eventBus.off('event_published', this.signalListener);
    }
    this.signalListener = null;
  }

  /**
   * Handles an EventBus event by checking all active signal triggers.
   *
   * @param eventData - The event data from EventBus
   */
  public async handleSignalEvent(eventData: {
    eventId: string;
    eventType: string;
    sessionName: string;
  }): Promise<TriggerFireResult[]> {
    const results: TriggerFireResult[] = [];

    for (const trigger of this.triggers.values()) {
      if (trigger.status !== 'active') continue;

      if (trigger.config.type === 'signal') {
        if (this.signalMatches(trigger.config, eventData)) {
          const result = await this.fire(trigger);
          results.push(result);
        }
      } else if (trigger.config.type === 'compound') {
        if (this.compoundSignalMatches(trigger.config, eventData)) {
          const result = await this.fire(trigger);
          results.push(result);
        }
      }
    }

    return results;
  }

  /**
   * Checks if an event matches a signal trigger's config.
   *
   * @param config - Signal trigger configuration
   * @param eventData - The event data to match against
   * @returns True if the event matches
   */
  private signalMatches(
    config: SignalTriggerConfig,
    eventData: { eventType: string; sessionName: string },
  ): boolean {
    if (config.eventType !== eventData.eventType) {
      return false;
    }

    // Apply filter if present
    if (config.filter) {
      for (const [key, value] of Object.entries(config.filter)) {
        if ((eventData as Record<string, unknown>)[key] !== value) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Checks if an event matches a compound trigger's signal conditions.
   * Only evaluates signal sub-conditions (time conditions are handled separately).
   *
   * @param config - Compound trigger configuration
   * @param eventData - The event data to match against
   * @returns True if the compound condition is satisfied
   */
  private compoundSignalMatches(
    config: CompoundTriggerConfig,
    eventData: { eventType: string; sessionName: string },
  ): boolean {
    const signalConditions = config.conditions.filter(
      (c): c is SignalTriggerConfig => c.type === 'signal',
    );

    if (signalConditions.length === 0) return false;

    if (config.operator === 'or') {
      return signalConditions.some((c) => this.signalMatches(c, eventData));
    }
    // 'and' — all signal conditions must match
    return signalConditions.every((c) => this.signalMatches(c, eventData));
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Loads triggers from disk and collapses accumulated duplicates.
   *
   * Historical accumulation: pre-fix, every boot called `create()` for
   * fixed system crons (e.g. EscalationService's 5-minute reconciler) with
   * no idempotency key, so the store grew by one duplicate each restart.
   * A single workspace was observed with 39 copies of the every-5-min
   * runReconciler, firing in parallel every interval.
   *
   * Policy:
   * - Two triggers are "duplicates" iff they share `createdBy`, `config`,
   *   and `action` (structural-JSON equality) AND both are `active`.
   * - Of each duplicate group, keep the one with the earliest `createdAt`
   *   (or lowest id as tiebreaker) and cancel the rest. We cancel rather
   *   than delete so any in-flight fire completes cleanly and the audit
   *   trail survives.
   */
  private async loadTriggers(): Promise<void> {
    await ensureDir(this.triggersDir);
    const data = await safeReadJson<Trigger[]>(this.triggersFile, []);
    this.triggers.clear();
    for (const trigger of data) {
      this.triggers.set(trigger.id, trigger);
    }

    const cancelledDuplicates = this.dedupeDuplicateTriggers();
    if (cancelledDuplicates > 0) {
      await this.persistTriggers();
    }

    this.logger.info('Loaded triggers from disk', {
      count: this.triggers.size,
      cancelledDuplicates,
    });
  }

  /**
   * Detects active triggers that are structurally identical (same owner,
   * same config, same action) and cancels all but the oldest in each group.
   *
   * Returns the number of triggers newly marked `cancelled`.
   */
  private dedupeDuplicateTriggers(): number {
    const groups = new Map<string, Trigger[]>();
    for (const trigger of this.triggers.values()) {
      if (trigger.status !== 'active') continue;
      const key = JSON.stringify({
        createdBy: trigger.createdBy,
        config: trigger.config,
        action: trigger.action,
      });
      const group = groups.get(key);
      if (group) {
        group.push(trigger);
      } else {
        groups.set(key, [trigger]);
      }
    }

    let cancelled = 0;
    for (const group of groups.values()) {
      if (group.length <= 1) continue;
      // Keep the earliest-created; tiebreak on id for stability.
      group.sort((a, b) => {
        const byDate = a.createdAt.localeCompare(b.createdAt);
        return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
      });
      const [keeper, ...duplicates] = group;
      for (const dup of duplicates) {
        dup.status = 'cancelled';
        cancelled += 1;
      }
      this.logger.warn('Collapsed duplicate triggers at startup', {
        kept: keeper.id,
        createdBy: keeper.createdBy,
        cancelledIds: duplicates.map((d) => d.id),
        count: duplicates.length,
      });
    }
    return cancelled;
  }

  /**
   * Persists all triggers to disk.
   */
  private async persistTriggers(): Promise<void> {
    await ensureDir(this.triggersDir);
    const data = Array.from(this.triggers.values());
    await atomicWriteJson(this.triggersFile, data);
  }

  // ---------------------------------------------------------------------------
  // Stats / Diagnostics
  // ---------------------------------------------------------------------------

  /**
   * Returns a summary of trigger engine state.
   *
   * @returns Object with counts by status and type
   */
  public getStatus(): {
    running: boolean;
    total: number;
    byStatus: Record<TriggerStatus, number>;
    byType: Record<string, number>;
  } {
    const byStatus: Record<TriggerStatus, number> = {
      active: 0,
      paused: 0,
      exhausted: 0,
      cancelled: 0,
    };
    const byType: Record<string, number> = {};

    for (const trigger of this.triggers.values()) {
      byStatus[trigger.status] = (byStatus[trigger.status] || 0) + 1;
      byType[trigger.type] = (byType[trigger.type] || 0) + 1;
    }

    return {
      running: this.running,
      total: this.triggers.size,
      byStatus,
      byType,
    };
  }
}
