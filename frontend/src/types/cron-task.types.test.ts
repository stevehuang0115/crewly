/**
 * Tests for cron-task.types type guards
 *
 * @module types/cron-task.types.test
 */

import { describe, it, expect } from 'vitest';
import { isCronTask, isAgentHeartbeat } from './cron-task.types';

describe('isCronTask', () => {
  const validCronTask = {
    id: 'cron-0001',
    cronExpression: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    targetAgent: 'crewly-product-sam-217bfbbf',
    targetTeamId: 'team-001',
    taskDescription: 'Run daily standup',
    createdBy: 'user' as const,
    createdAt: '2026-03-23T00:00:00.000Z',
    enabled: true,
    lastRunAt: null,
    nextRunAt: '2026-03-24T01:00:00.000Z',
  };

  it('should return true for a valid CronTask', () => {
    expect(isCronTask(validCronTask)).toBe(true);
  });

  it('should return true for orchestrator-created tasks', () => {
    expect(isCronTask({ ...validCronTask, createdBy: 'orchestrator' })).toBe(true);
  });

  it('should return false for null', () => {
    expect(isCronTask(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isCronTask(undefined)).toBe(false);
  });

  it('should return false for a string', () => {
    expect(isCronTask('not-a-task')).toBe(false);
  });

  it('should return false when id is missing', () => {
    const { id: _, ...noId } = validCronTask;
    expect(isCronTask(noId)).toBe(false);
  });

  it('should return false when enabled is not boolean', () => {
    expect(isCronTask({ ...validCronTask, enabled: 'yes' })).toBe(false);
  });

  it('should return false for invalid createdBy', () => {
    expect(isCronTask({ ...validCronTask, createdBy: 'admin' })).toBe(false);
  });
});

describe('isAgentHeartbeat', () => {
  const validHeartbeat = {
    agentId: 'member-001',
    sessionName: 'crewly-product-sam-217bfbbf',
    agentStatus: 'active',
    lastActiveTime: '2026-03-23T10:00:00.000Z',
    createdAt: '2026-03-23T08:00:00.000Z',
    updatedAt: '2026-03-23T10:00:00.000Z',
  };

  it('should return true for a valid AgentHeartbeat', () => {
    expect(isAgentHeartbeat(validHeartbeat)).toBe(true);
  });

  it('should return true with optional teamMemberId', () => {
    expect(isAgentHeartbeat({ ...validHeartbeat, teamMemberId: 'tm-001' })).toBe(true);
  });

  it('should return false for null', () => {
    expect(isAgentHeartbeat(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isAgentHeartbeat(undefined)).toBe(false);
  });

  it('should return false when agentId is missing', () => {
    const { agentId: _, ...noAgentId } = validHeartbeat;
    expect(isAgentHeartbeat(noAgentId)).toBe(false);
  });

  it('should return false when lastActiveTime is missing', () => {
    const { lastActiveTime: _, ...noTime } = validHeartbeat;
    expect(isAgentHeartbeat(noTime)).toBe(false);
  });

  it('should return false for a number', () => {
    expect(isAgentHeartbeat(42)).toBe(false);
  });
});
