/**
 * Tests for the EscalationService boot wiring.
 *
 * @module services/v3/escalation-boot.test
 */

import { jest } from '@jest/globals';
import {
  bootEscalationService,
  isEscalationEnabled,
  createEscalationNotifier,
  formatEscalationEnvelope,
  ESCALATION_ENABLED_ENV,
  ESCALATION_CONVERSATION_ID,
} from './escalation-boot.js';
import { EscalationService } from './escalation.service.js';
import type { Mission, EscalationRule } from '../../types/v2/mission.types.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

jest.mock('../task-pool/task-pool.service.js', () => ({
  TaskPoolService: {
    getInstance: () => ({
      getAllItems: async () => [],
      updateItemStatus: async () => undefined,
    }),
  },
}));

jest.mock('./trigger-engine.service.js', () => ({
  TriggerEngine: {
    getInstance: () => ({
      create: async () => ({ id: 'trigger-esc' }),
      cancel: async () => true,
      setActionHandler: () => undefined,
    }),
  },
}));

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as never;

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'm-1',
    objective: 'Ship the thing',
    ownerTeamId: 'team-1',
    successCriteria: [],
    currentStrategy: '',
    activeProjectTaskIds: [],
    cadence: '',
    policy: {
      missionId: 'm-1',
      canCreateTasks: true,
      canReprioritizeTasks: true,
      canCloseTasks: true,
      canDeployToStaging: false,
      canDeployToProd: false,
      canSpendMoney: false,
      canChangeUserVisibleBehaviorWithoutReview: false,
      maxParallelExecutions: 1,
      escalationRules: [],
    },
    status: 'active',
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    learnings: [],
    ...overrides,
  } as Mission;
}

const rule: EscalationRule = {
  condition: 'cost_exceeded',
  threshold: 50,
  escalateTo: 'user',
  action: 'notify',
};

describe('escalation-boot', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ESCALATION_ENABLED_ENV];
    delete process.env[ESCALATION_ENABLED_ENV];
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ESCALATION_ENABLED_ENV];
    else process.env[ESCALATION_ENABLED_ENV] = saved;
  });

  describe('isEscalationEnabled', () => {
    it('defaults to true when unset', () => {
      expect(isEscalationEnabled()).toBe(true);
    });

    it('is false only for the literal "false"', () => {
      process.env[ESCALATION_ENABLED_ENV] = 'false';
      expect(isEscalationEnabled()).toBe(false);
      process.env[ESCALATION_ENABLED_ENV] = '0';
      expect(isEscalationEnabled()).toBe(true);
      process.env[ESCALATION_ENABLED_ENV] = 'true';
      expect(isEscalationEnabled()).toBe(true);
    });
  });

  describe('bootEscalationService', () => {
    function fakeService() {
      const svc = {
        setActionHandler: jest.fn(),
        start: jest.fn(async () => undefined),
        stop: jest.fn(async () => undefined),
      };
      return svc;
    }

    it('creates, wires the notifier and starts the service with the resolved project path', async () => {
      const svc = fakeService();
      const createService = jest.fn(() => svc as unknown as EscalationService);
      const messageQueue = { enqueue: jest.fn() };

      const result = await bootEscalationService({
        messageQueue,
        logger,
        projectPath: '/proj',
        createService,
      });

      expect(result).toBe(svc);
      expect(createService).toHaveBeenCalledWith('/proj');
      expect(svc.setActionHandler).toHaveBeenCalledTimes(1);
      expect(svc.start).toHaveBeenCalledTimes(1);
    });

    it('returns null and does not construct when disabled via env', async () => {
      process.env[ESCALATION_ENABLED_ENV] = 'false';
      const createService = jest.fn();
      const result = await bootEscalationService({
        messageQueue: { enqueue: jest.fn() },
        logger,
        createService: createService as never,
      });
      expect(result).toBeNull();
      expect(createService).not.toHaveBeenCalled();
    });

    it('returns null (and logs) instead of throwing when start() fails', async () => {
      const svc = fakeService();
      svc.start.mockRejectedValue(new Error('trigger engine down'));
      const result = await bootEscalationService({
        messageQueue: { enqueue: jest.fn() },
        logger,
        createService: () => svc as unknown as EscalationService,
      });
      expect(result).toBeNull();
      expect((logger as { warn: jest.Mock }).warn).toHaveBeenCalledWith(
        'EscalationService boot failed (non-fatal)',
        expect.objectContaining({ error: 'trigger engine down' }),
      );
    });
  });

  describe('createEscalationNotifier', () => {
    it('enqueues an [ESCALATION] system event to the orchestrator with rule metadata', async () => {
      const messageQueue = { enqueue: jest.fn() };
      const handler = createEscalationNotifier({ messageQueue, logger });

      await handler(makeMission(), rule, 'notify');

      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      const input = messageQueue.enqueue.mock.calls[0][0] as Record<string, unknown>;
      expect(input.source).toBe('system_event');
      expect(input.conversationId).toBe(ESCALATION_CONVERSATION_ID);
      expect(input.targetSession).toBe('crewly-orc');
      expect(String(input.content)).toMatch(/^\[ESCALATION\] Mission "Ship the thing" \(m-1\)/);
      expect(String(input.content)).toContain('cost_exceeded exceeded threshold 50');
      expect(input.sourceMetadata).toEqual(
        expect.objectContaining({ missionId: 'm-1', condition: 'cost_exceeded', action: 'notify' }),
      );
    });

    it('swallows enqueue failures', async () => {
      const messageQueue = {
        enqueue: jest.fn(() => {
          throw new Error('queue closed');
        }),
      };
      const handler = createEscalationNotifier({ messageQueue, logger });
      await expect(handler(makeMission(), rule, 'pause')).resolves.toBeUndefined();
      expect((logger as { warn: jest.Mock }).warn).toHaveBeenCalled();
    });
  });

  describe('real EscalationService against an empty store', () => {
    let dir: string;
    let savedMissionsDir: string | undefined;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'crewly-esc-boot-'));
      savedMissionsDir = process.env.CREWLY_MISSIONS_DIR;
      process.env.CREWLY_MISSIONS_DIR = join(dir, 'missions');
    });

    afterEach(() => {
      if (savedMissionsDir === undefined) delete process.env.CREWLY_MISSIONS_DIR;
      else process.env.CREWLY_MISSIONS_DIR = savedMissionsDir;
      rmSync(dir, { recursive: true, force: true });
    });

    it('boots, evaluates zero missions without side effects, and stops', async () => {
      const messageQueue = { enqueue: jest.fn() };
      const service = await bootEscalationService({ messageQueue, logger, projectPath: dir });
      expect(service).toBeInstanceOf(EscalationService);
      expect(service!.isStarted()).toBe(true);

      const summary = await service!.evaluate();
      expect(summary.missionsEvaluated).toBe(0);
      expect(summary.escalationsTriggered).toBe(0);
      expect(messageQueue.enqueue).not.toHaveBeenCalled();

      await service!.stop();
      expect(service!.isStarted()).toBe(false);
    });
  });

  describe('formatEscalationEnvelope', () => {
    it('describes pause and block outcomes and truncates long objectives', () => {
      const long = makeMission({ objective: 'x'.repeat(120) });
      expect(formatEscalationEnvelope(long, rule, 'pause')).toContain('paused');
      expect(formatEscalationEnvelope(long, rule, 'block')).toContain('blocked');
      expect(formatEscalationEnvelope(long, rule, 'notify')).toContain(`${'x'.repeat(80)}…`);
    });
  });
});
