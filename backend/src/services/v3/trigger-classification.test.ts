/**
 * Tests for trigger classification (creator resolution + load migration).
 *
 * @module services/v3/trigger-classification.test
 */

import type { Trigger } from '../../types/v2/trigger.types.js';
import {
  resolveTriggerCreator,
  classifyTriggerOnLoad,
  isHarnessPlumbing,
} from './trigger-classification.js';

function row(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 't-1',
    type: 'time',
    config: { type: 'time', delayMs: 60_000 },
    action: { sendMessage: { target: 'crewly-orc', message: 'hi' } },
    status: 'active',
    createdBy: 'system',
    createdAt: '2026-09-01T00:00:00.000Z',
    fireCount: 0,
    maxIdleFires: 3,
    consecutiveIdleFires: 0,
    ...overrides,
  };
}

describe('resolveTriggerCreator', () => {
  it('attributes an agent-session call to that agent, even when the body says system', () => {
    expect(resolveTriggerCreator({ requestedCreatedBy: 'system', callerSession: 'ce-owen-ad0320ab' }))
      .toEqual({ createdBy: 'agent', createdBySession: 'ce-owen-ad0320ab', internal: false });
  });

  it('attributes the orchestrator session to the orchestrator', () => {
    expect(resolveTriggerCreator({ requestedCreatedBy: 'system', callerSession: 'crewly-orc', callerIsOrchestrator: true }))
      .toMatchObject({ createdBy: 'orchestrator', internal: false });
  });

  it('keeps delegate-task fallback checks internal', () => {
    expect(resolveTriggerCreator({ requestedCreatedBy: 'delegate-task', callerSession: 'crewly-orc', callerIsOrchestrator: true }))
      .toEqual({ createdBy: 'delegate-task', createdBySession: 'crewly-orc', internal: true });
  });

  it('honours an explicit internal flag from an agent call', () => {
    expect(resolveTriggerCreator({ requestedCreatedBy: 'system', requestedInternal: true, callerSession: 'a' }))
      .toEqual({ createdBy: 'system', createdBySession: 'a', internal: true });
  });

  it('treats the owner dashboard as user, never internal', () => {
    expect(resolveTriggerCreator({ requestedCreatedBy: 'system', requestedInternal: true, isOwnerDashboard: true }))
      .toEqual({ createdBy: 'user', internal: false });
  });

  it('keeps what a header-less server call sent, defaulting to user', () => {
    expect(resolveTriggerCreator({ requestedCreatedBy: 'system' })).toEqual({ createdBy: 'system', internal: true });
    expect(resolveTriggerCreator({})).toEqual({ createdBy: 'user', internal: false });
  });
});

describe('isHarnessPlumbing', () => {
  it('recognises escalation, system: names and delegate-task fallbacks', () => {
    expect(isHarnessPlumbing(row({ action: { runReconciler: true } }))).toBe(true);
    expect(isHarnessPlumbing(row({ name: 'system:escalation' }))).toBe(true);
    expect(isHarnessPlumbing(row({ createdBy: 'delegate-task', name: 'fallback-x-1' }))).toBe(true);
    // A lead's own "fallback check" follow-up is a reminder, not plumbing.
    expect(isHarnessPlumbing(row({ name: 'fallback-kai-tkt004' }))).toBe(false);
    expect(isHarnessPlumbing(row({ name: 'daily-ops-nightly-2230' }))).toBe(false);
  });
});

describe('classifyTriggerOnLoad', () => {
  it('makes the daily-ops nightly report owner-facing and re-attributes it to an agent', () => {
    const t = row({
      config: { type: 'time', cronExpression: '30 22 * * *', timezone: 'America/New_York' },
      action: { createWorkItem: { target: 'ce-owen-ad0320ab', title: 'Nightly ops report' } },
      teamId: '5ad0642a',
      name: 'daily-ops-nightly-2230',
      maxFires: 58,
      fireCount: 2,
    });
    expect(classifyTriggerOnLoad(t)).toBe(true);
    expect(t.internal).toBe(false);
    expect(t.createdBy).toBe('agent');
  });

  it('treats any one of name / recurring cron / teamId+createWorkItem as owner-facing', () => {
    const named = row({ name: 'followup:abcd' });
    const cron = row({ config: { type: 'time', cronExpression: '0 9 * * 1' } });
    const teamWork = row({ teamId: 'x', action: { createWorkItem: { title: 'a' } } });
    for (const t of [named, cron, teamWork]) {
      classifyTriggerOnLoad(t);
      expect(t.internal).toBe(false);
    }
  });

  it('gives team-spec rows to the owner', () => {
    const t = row({ name: 'weekly', managedBy: 'team-spec' });
    classifyTriggerOnLoad(t);
    expect(t).toMatchObject({ internal: false, createdBy: 'user' });
  });

  it('leaves the rest with its creator and marks system ones internal', () => {
    const sys = row();
    const user = row({ createdBy: 'user' });
    classifyTriggerOnLoad(sys);
    classifyTriggerOnLoad(user);
    expect(sys).toMatchObject({ internal: true, createdBy: 'system' });
    expect(user).toMatchObject({ internal: false, createdBy: 'user' });
  });

  it('is a no-op for rows that already carry the flag', () => {
    const t = row({ name: 'kept', internal: true });
    expect(classifyTriggerOnLoad(t)).toBe(false);
    expect(t).toMatchObject({ internal: true, createdBy: 'system' });
  });
});
