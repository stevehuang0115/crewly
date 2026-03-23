/**
 * Tests for UnifiedSchedulerService.
 *
 * Covers CRUD operations, schedule evaluation (cron/interval/idle),
 * auto-start, auto-pause, persistence, and health reporting.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { UnifiedSchedulerService } from './unified-scheduler.service.js';
import type { UnifiedSchedule, CreateScheduleRequest } from './unified-scheduler.types.js';

// =============================================================================
// Test Setup
// =============================================================================

const TEST_DIR = join(process.cwd(), `.test-unified-sched-${Date.now()}`);
const TEST_HOME = join(TEST_DIR, '.crewly');

const CRON_SCHEDULE: CreateScheduleRequest = {
  target: 'agent-session-1',
  type: 'cron',
  cron: '0 8,14,20 * * *',
  message: 'Time for your daily check-in',
};

const INTERVAL_SCHEDULE: CreateScheduleRequest = {
  target: 'agent-session-2',
  type: 'interval',
  intervalMinutes: 30,
  message: 'Interval check-in',
};

const IDLE_SCHEDULE: CreateScheduleRequest = {
  target: 'agent-session-3',
  type: 'idle',
  idleTimeoutMinutes: 15,
  message: 'You have been idle for 15 minutes',
};

describe('UnifiedSchedulerService', () => {
  let service: UnifiedSchedulerService;

  beforeEach(() => {
    UnifiedSchedulerService.resetInstance();
    mkdirSync(TEST_HOME, { recursive: true });
    service = UnifiedSchedulerService.getInstance(TEST_HOME);
  });

  afterEach(() => {
    UnifiedSchedulerService.resetInstance();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  describe('create', () => {
    it('creates a cron schedule with correct defaults', () => {
      const schedule = service.create(CRON_SCHEDULE);

      expect(schedule.id).toBeTruthy();
      expect(schedule.target).toBe('agent-session-1');
      expect(schedule.type).toBe('cron');
      expect(schedule.cron).toBe('0 8,14,20 * * *');
      expect(schedule.message).toBe('Time for your daily check-in');
      expect(schedule.enabled).toBe(true);
      expect(schedule.autoStart).toBe(true);
      expect(schedule.maxConsecutiveTriggers).toBe(10);
      expect(schedule.status).toBe('active');
      expect(schedule.triggerCount).toBe(0);
      expect(schedule.consecutiveTriggers).toBe(0);
      expect(schedule.lastTriggeredAt).toBeNull();
    });

    it('creates an interval schedule', () => {
      const schedule = service.create(INTERVAL_SCHEDULE);

      expect(schedule.type).toBe('interval');
      expect(schedule.intervalMinutes).toBe(30);
    });

    it('creates an idle schedule', () => {
      const schedule = service.create(IDLE_SCHEDULE);

      expect(schedule.type).toBe('idle');
      expect(schedule.idleTimeoutMinutes).toBe(15);
    });

    it('creates disabled schedule when enabled=false', () => {
      const schedule = service.create({ ...CRON_SCHEDULE, enabled: false });
      expect(schedule.enabled).toBe(false);
      expect(schedule.status).toBe('paused');
    });

    it('throws on missing target', () => {
      expect(() => service.create({ ...CRON_SCHEDULE, target: '' })).toThrow('target');
    });

    it('throws on missing message', () => {
      expect(() => service.create({ ...CRON_SCHEDULE, message: '' })).toThrow('message');
    });

    it('throws on invalid type', () => {
      expect(() => service.create({ ...CRON_SCHEDULE, type: 'invalid' as any })).toThrow('type');
    });

    it('throws on missing cron for type=cron', () => {
      expect(() => service.create({ ...CRON_SCHEDULE, cron: undefined })).toThrow('cron');
    });

    it('throws on invalid cron expression', () => {
      expect(() => service.create({ ...CRON_SCHEDULE, cron: 'not-a-cron' })).toThrow('Invalid cron');
    });

    it('throws on missing intervalMinutes for type=interval', () => {
      expect(() => service.create({ target: 'x', type: 'interval', message: 'hi' })).toThrow('intervalMinutes');
    });

    it('throws on missing idleTimeoutMinutes for type=idle', () => {
      expect(() => service.create({ target: 'x', type: 'idle', message: 'hi' })).toThrow('idleTimeoutMinutes');
    });

    it('generates unique IDs', () => {
      const s1 = service.create(CRON_SCHEDULE);
      const s2 = service.create(CRON_SCHEDULE);
      expect(s1.id).not.toBe(s2.id);
    });
  });

  describe('get', () => {
    it('returns existing schedule', () => {
      const created = service.create(CRON_SCHEDULE);
      const found = service.get(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('returns null for unknown ID', () => {
      expect(service.get('nonexistent')).toBeNull();
    });
  });

  describe('list', () => {
    it('returns all schedules', () => {
      service.create(CRON_SCHEDULE);
      service.create(INTERVAL_SCHEDULE);
      expect(service.list()).toHaveLength(2);
    });

    it('filters by target', () => {
      service.create(CRON_SCHEDULE);
      service.create(INTERVAL_SCHEDULE);
      const filtered = service.list('agent-session-1');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].target).toBe('agent-session-1');
    });

    it('returns empty for no matches', () => {
      service.create(CRON_SCHEDULE);
      expect(service.list('nonexistent')).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('updates message', () => {
      const created = service.create(CRON_SCHEDULE);
      const updated = service.update(created.id, { message: 'New message' });
      expect(updated).not.toBeNull();
      expect(updated!.message).toBe('New message');
    });

    it('updates enabled status', () => {
      const created = service.create(CRON_SCHEDULE);
      const updated = service.update(created.id, { enabled: false });
      expect(updated!.enabled).toBe(false);
      expect(updated!.status).toBe('paused');
    });

    it('returns null for unknown ID', () => {
      expect(service.update('nonexistent', { message: 'hi' })).toBeNull();
    });

    it('updates updatedAt timestamp', () => {
      const created = service.create(CRON_SCHEDULE);
      const updated = service.update(created.id, { message: 'Updated' });
      expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updatedAt).getTime()
      );
    });
  });

  describe('delete', () => {
    it('deletes existing schedule', () => {
      const created = service.create(CRON_SCHEDULE);
      expect(service.delete(created.id)).toBe(true);
      expect(service.get(created.id)).toBeNull();
    });

    it('returns false for unknown ID', () => {
      expect(service.delete('nonexistent')).toBe(false);
    });
  });

  describe('pause / resume', () => {
    it('pauses an active schedule', () => {
      const created = service.create(CRON_SCHEDULE);
      const paused = service.pause(created.id);
      expect(paused!.status).toBe('paused');
      expect(paused!.enabled).toBe(false);
    });

    it('resumes a paused schedule and resets consecutive triggers', () => {
      const created = service.create(CRON_SCHEDULE);
      service.pause(created.id);
      const resumed = service.resume(created.id);
      expect(resumed!.status).toBe('active');
      expect(resumed!.enabled).toBe(true);
      expect(resumed!.consecutiveTriggers).toBe(0);
    });

    it('returns null for unknown ID', () => {
      expect(service.pause('nonexistent')).toBeNull();
      expect(service.resume('nonexistent')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  describe('persistence', () => {
    it('persists schedules to disk on create', () => {
      service.create(CRON_SCHEDULE);
      const storagePath = join(TEST_HOME, 'unified-schedules.json');
      expect(existsSync(storagePath)).toBe(true);

      const data = JSON.parse(readFileSync(storagePath, 'utf-8'));
      expect(data.schedules).toHaveLength(1);
      expect(data.version).toBe('1.0.0');
    });

    it('loads schedules from disk on start', () => {
      // Create and persist
      service.create(CRON_SCHEDULE);
      service.create(INTERVAL_SCHEDULE);

      // Reset and reload
      UnifiedSchedulerService.resetInstance();
      const newService = UnifiedSchedulerService.getInstance(TEST_HOME);
      newService.start();

      expect(newService.list()).toHaveLength(2);
      newService.stop();
    });

    it('persists updates', () => {
      const created = service.create(CRON_SCHEDULE);
      service.update(created.id, { message: 'Updated msg' });

      const storagePath = join(TEST_HOME, 'unified-schedules.json');
      const data = JSON.parse(readFileSync(storagePath, 'utf-8'));
      expect(data.schedules[0].message).toBe('Updated msg');
    });

    it('persists deletes', () => {
      const created = service.create(CRON_SCHEDULE);
      service.delete(created.id);

      const storagePath = join(TEST_HOME, 'unified-schedules.json');
      const data = JSON.parse(readFileSync(storagePath, 'utf-8'));
      expect(data.schedules).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Evaluation — Interval
  // ---------------------------------------------------------------------------

  describe('interval evaluation', () => {
    it('triggers when interval has elapsed', async () => {
      const mockSend = jest.fn().mockResolvedValue({ success: true });
      service.setMessageCallback(mockSend);

      const schedule = service.create({
        ...INTERVAL_SCHEDULE,
        intervalMinutes: 1, // 1 minute
      });

      // Backdate createdAt to 2 minutes ago
      schedule.createdAt = new Date(Date.now() - 120_000).toISOString();
      schedule.lastTriggeredAt = null;

      await service.evaluate();

      expect(mockSend).toHaveBeenCalledWith('agent-session-2', 'Interval check-in');
      const updated = service.get(schedule.id)!;
      expect(updated.triggerCount).toBe(1);
      expect(updated.lastTriggeredAt).toBeTruthy();
    });

    it('does not trigger before interval elapses', async () => {
      const mockSend = jest.fn().mockResolvedValue({ success: true });
      service.setMessageCallback(mockSend);

      service.create(INTERVAL_SCHEDULE); // 30 min interval, just created

      await service.evaluate();

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Evaluation — Idle
  // ---------------------------------------------------------------------------

  describe('idle evaluation', () => {
    it('triggers when agent is idle past threshold', async () => {
      const mockSend = jest.fn().mockResolvedValue({ success: true });
      const mockIdle = jest.fn().mockResolvedValue({ idle: true, idleMinutes: 20 });
      service.setMessageCallback(mockSend);
      service.setIdleCheckCallback(mockIdle);

      service.create(IDLE_SCHEDULE); // 15 min idle timeout

      await service.evaluate();

      expect(mockIdle).toHaveBeenCalledWith('agent-session-3');
      expect(mockSend).toHaveBeenCalledWith('agent-session-3', 'You have been idle for 15 minutes');
    });

    it('does not trigger when agent is not idle enough', async () => {
      const mockSend = jest.fn().mockResolvedValue({ success: true });
      const mockIdle = jest.fn().mockResolvedValue({ idle: true, idleMinutes: 5 });
      service.setMessageCallback(mockSend);
      service.setIdleCheckCallback(mockIdle);

      service.create(IDLE_SCHEDULE); // 15 min timeout

      await service.evaluate();

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not trigger when agent is active', async () => {
      const mockSend = jest.fn().mockResolvedValue({ success: true });
      const mockIdle = jest.fn().mockResolvedValue({ idle: false, idleMinutes: 0 });
      service.setMessageCallback(mockSend);
      service.setIdleCheckCallback(mockIdle);

      service.create(IDLE_SCHEDULE);

      await service.evaluate();

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-Start
  // ---------------------------------------------------------------------------

  describe('auto-start', () => {
    it('auto-starts offline agent when autoStart=true', async () => {
      const mockSend = jest.fn().mockResolvedValue({ success: true });
      const mockStatus = jest.fn().mockResolvedValue(false); // offline
      const mockStart = jest.fn().mockResolvedValue(true); // start succeeds
      service.setMessageCallback(mockSend);
      service.setAgentStatusCallback(mockStatus);
      service.setAgentStartCallback(mockStart);

      const schedule = service.create({ ...INTERVAL_SCHEDULE, intervalMinutes: 1 });
      schedule.createdAt = new Date(Date.now() - 120_000).toISOString();

      await service.evaluate();

      expect(mockStart).toHaveBeenCalledWith('agent-session-2');
      expect(mockSend).toHaveBeenCalled();
    });

    it('skips trigger when auto-start fails', async () => {
      const mockSend = jest.fn().mockResolvedValue({ success: true });
      const mockStatus = jest.fn().mockResolvedValue(false);
      const mockStart = jest.fn().mockResolvedValue(false); // start fails
      service.setMessageCallback(mockSend);
      service.setAgentStatusCallback(mockStatus);
      service.setAgentStartCallback(mockStart);

      const schedule = service.create({ ...INTERVAL_SCHEDULE, intervalMinutes: 1 });
      schedule.createdAt = new Date(Date.now() - 120_000).toISOString();

      await service.evaluate();

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not auto-start when autoStart=false', async () => {
      const mockSend = jest.fn().mockResolvedValue({ success: true });
      const mockStatus = jest.fn().mockResolvedValue(false);
      const mockStart = jest.fn().mockResolvedValue(true);
      service.setMessageCallback(mockSend);
      service.setAgentStatusCallback(mockStatus);
      service.setAgentStartCallback(mockStart);

      const schedule = service.create({ ...INTERVAL_SCHEDULE, intervalMinutes: 1, autoStart: false });
      schedule.createdAt = new Date(Date.now() - 120_000).toISOString();

      await service.evaluate();

      expect(mockStart).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-Pause (consecutive trigger limit)
  // ---------------------------------------------------------------------------

  describe('auto-pause', () => {
    it('auto-pauses after maxConsecutiveTriggers', async () => {
      const mockSend = jest.fn().mockResolvedValue({ success: true });
      service.setMessageCallback(mockSend);

      const schedule = service.create({
        ...INTERVAL_SCHEDULE,
        intervalMinutes: 1,
        maxConsecutiveTriggers: 3,
      });
      schedule.createdAt = new Date(Date.now() - 120_000).toISOString();
      schedule.consecutiveTriggers = 2; // one more will trigger auto-pause

      await service.evaluate();

      const updated = service.get(schedule.id)!;
      expect(updated.status).toBe('paused');
      expect(updated.enabled).toBe(false);
      expect(updated.error).toContain('Auto-paused');
    });

    it('resetConsecutiveTriggers resets counter for target', () => {
      const schedule = service.create(CRON_SCHEDULE);
      // Simulate consecutive triggers
      const s = service.get(schedule.id)!;
      s.consecutiveTriggers = 5;

      service.resetConsecutiveTriggers('agent-session-1');

      const updated = service.get(schedule.id)!;
      expect(updated.consecutiveTriggers).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Manual Trigger
  // ---------------------------------------------------------------------------

  describe('triggerNow', () => {
    it('triggers immediately regardless of timing', async () => {
      const mockSend = jest.fn().mockResolvedValue({ success: true });
      service.setMessageCallback(mockSend);

      const schedule = service.create(INTERVAL_SCHEDULE); // 30 min interval, just created

      const result = await service.triggerNow(schedule.id);

      expect(result).toBe(true);
      expect(mockSend).toHaveBeenCalledWith('agent-session-2', 'Interval check-in');
    });

    it('returns false for unknown ID', async () => {
      const result = await service.triggerNow('nonexistent');
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  describe('getHealth', () => {
    it('returns correct health stats', () => {
      service.create(CRON_SCHEDULE);
      service.create(INTERVAL_SCHEDULE);
      const idle = service.create(IDLE_SCHEDULE);
      service.pause(idle.id);

      const health = service.getHealth();

      expect(health.running).toBe(false); // not started
      expect(health.activeCount).toBe(2);
      expect(health.pausedCount).toBe(1);
      expect(health.totalCount).toBe(3);
      expect(health.byType.cron).toBe(1);
      expect(health.byType.interval).toBe(1);
      expect(health.byType.idle).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  describe('start / stop', () => {
    it('starts and stops the evaluation loop', () => {
      service.start();
      expect(service.getHealth().running).toBe(true);

      service.stop();
      expect(service.getHealth().running).toBe(false);
    });

    it('loads persisted schedules on start', () => {
      // Create via fresh instance
      service.create(CRON_SCHEDULE);

      // New instance loads from disk
      UnifiedSchedulerService.resetInstance();
      const newService = UnifiedSchedulerService.getInstance(TEST_HOME);
      newService.start();

      expect(newService.list()).toHaveLength(1);
      newService.stop();
    });
  });

  // ---------------------------------------------------------------------------
  // Singleton
  // ---------------------------------------------------------------------------

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = UnifiedSchedulerService.getInstance(TEST_HOME);
      const b = UnifiedSchedulerService.getInstance(TEST_HOME);
      expect(a).toBe(b);
    });

    it('resets correctly', () => {
      const a = UnifiedSchedulerService.getInstance(TEST_HOME);
      UnifiedSchedulerService.resetInstance();
      const b = UnifiedSchedulerService.getInstance(TEST_HOME);
      expect(a).not.toBe(b);
    });
  });
});
