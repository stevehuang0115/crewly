import { findStatusWorkItem, isOrcDelegated, planOrcStatusRoute, statusMarkerOf, type OrcStatusRouteInput } from './orc-status-routing.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const isOrc = (n: string) => ['crewly-orc', 'orchestrator', 'orc'].includes(n.toLowerCase());

function wi(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi-1',
    type: 'delegate',
    owner: 'team_lead',
    target: 'vera',
    title: 'Draft the article',
    status: 'running',
    createdAt: new Date(NOW - 60 * 60_000).toISOString(),
    startedAt: new Date(NOW - 30 * 60_000).toISOString(),
    retryCount: 0,
    maxRetries: 3,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    ...over,
  } as WorkItem;
}

function input(over: Partial<OrcStatusRouteInput>): OrcStatusRouteInput {
  return {
    content: '[DONE] Agent vera: drafted',
    sender: 'vera',
    workItem: null,
    lead: 'owen',
    senderIsLead: false,
    deliveryOwed: false,
    isOrchestrator: isOrc,
    ...over,
  };
}

describe('statusMarkerOf', () => {
  it('reads the leading marker', () => {
    expect(statusMarkerOf('[done] Agent x: y')).toBe('DONE');
    expect(statusMarkerOf('  [STATUS REPORT] …')).toBe('STATUS REPORT');
    expect(statusMarkerOf('Here is the report')).toBeNull();
  });
});

describe('isOrcDelegated', () => {
  it('owner orchestrator, or the orchestrator as delegator/creator', () => {
    expect(isOrcDelegated(wi({ owner: 'orchestrator' }), isOrc)).toBe(true);
    expect(isOrcDelegated(wi({ metadata: { delegatedBy: 'crewly-orc' } }), isOrc)).toBe(true);
    expect(isOrcDelegated(wi({ metadata: { createdBy: 'crewly-orc' } }), isOrc)).toBe(true);
    expect(isOrcDelegated(wi({ metadata: { delegatedBy: 'owen' } }), isOrc)).toBe(false);
  });
});

describe('planOrcStatusRoute', () => {
  it.each(['[IN_PROGRESS]', '[ACTIVE]', '[READY]', '[WORKING]', '[IDLE]'])('%s is recorded only — never wakes anyone', (marker) => {
    expect(planOrcStatusRoute(input({ content: `${marker} Agent vera: …`, lead: null })).action).toBe('record');
    // Even when the owner waits on a delivery, a progress line is not it.
    expect(planOrcStatusRoute(input({ content: `${marker} Agent vera: …`, deliveryOwed: true })).action).toBe('record');
  });

  it('member [DONE] on TL-owned work does not wake the orchestrator (review path takes it)', () => {
    const route = planOrcStatusRoute(input({ workItem: wi({ owner: 'team_lead', metadata: { delegatedBy: 'owen' } }) }));
    expect(route.action).toBe('record');
  });

  it('[DONE] on orchestrator-delegated work wakes the orchestrator', () => {
    const route = planOrcStatusRoute(input({ workItem: wi({ owner: 'orchestrator', metadata: { delegatedBy: 'crewly-orc' } }) }));
    expect(route).toMatchObject({ action: 'orc', category: 'delegated-done' });
  });

  it('[DONE] the owner is waiting on the orchestrator to deliver wakes it, whoever owns the work', () => {
    const route = planOrcStatusRoute(input({ deliveryOwed: true, workItem: wi() }));
    expect(route).toMatchObject({ action: 'orc', category: 'owner' });
  });

  it('[DONE] with no work item: digest — actionable only when there is no lead', () => {
    expect(planOrcStatusRoute(input({ lead: 'owen' }))).toMatchObject({ action: 'digest', actionable: false });
    expect(planOrcStatusRoute(input({ lead: null }))).toMatchObject({ action: 'digest', actionable: true });
    // A lead reporting its own done with no work item: nobody above but the orchestrator.
    expect(planOrcStatusRoute(input({ sender: 'owen', lead: null, senderIsLead: true }))).toMatchObject({ action: 'digest', actionable: true });
  });

  it('[BLOCKED]/[FAILED] go to the lead first', () => {
    expect(planOrcStatusRoute(input({ content: '[BLOCKED] Agent vera: need creds' }))).toEqual(expect.objectContaining({ action: 'team-lead', lead: 'owen' }));
    expect(planOrcStatusRoute(input({ content: '[FAILED] Agent vera: build broke' }))).toEqual(expect.objectContaining({ action: 'team-lead', lead: 'owen' }));
  });

  it('[BLOCKED] escalates to the orchestrator when there is no lead, the lead sent it, or the lead is the orchestrator', () => {
    expect(planOrcStatusRoute(input({ content: '[BLOCKED] x', lead: null }))).toMatchObject({ action: 'orc', category: 'escalation' });
    expect(planOrcStatusRoute(input({ content: '[BLOCKED] x', sender: 'owen', lead: 'owen' }))).toMatchObject({ action: 'orc', category: 'escalation' });
    expect(planOrcStatusRoute(input({ content: '[BLOCKED] x', lead: 'crewly-orc' }))).toMatchObject({ action: 'orc', category: 'escalation' });
  });

  it('a lead with a parent member reports up to it, not to the orchestrator', () => {
    const route = planOrcStatusRoute(input({ content: '[BLOCKED] x', sender: 'owen', lead: 'director', senderIsLead: true }));
    expect(route).toEqual(expect.objectContaining({ action: 'team-lead', lead: 'director' }));
  });

  it('an answer with no marker still reaches the orchestrator (someone may be waiting)', () => {
    expect(planOrcStatusRoute(input({ content: 'Here is the comparison you asked for…' }))).toMatchObject({ action: 'orc', category: 'other' });
  });

  it('[MILESTONE] always reaches the orchestrator (it forwards milestones to the owner)', () => {
    expect(planOrcStatusRoute(input({ content: '[MILESTONE] Agent vera: PR merged' }))).toMatchObject({ action: 'orc' });
  });

  it('other markers go to the digest; actionable on orchestrator work', () => {
    expect(planOrcStatusRoute(input({ content: '[STATUS] Agent vera: halfway' }))).toMatchObject({ action: 'digest', actionable: false });
    expect(planOrcStatusRoute(input({ content: '[STATUS] Agent vera: halfway', workItem: wi({ owner: 'orchestrator' }) }))).toMatchObject({ action: 'digest', actionable: true });
  });
});

describe('findStatusWorkItem', () => {
  it('the named item wins', () => {
    const items = [wi({ id: 'a' }), wi({ id: 'b', target: 'someone-else' })];
    expect(findStatusWorkItem(items, 'vera', 'b', NOW)?.id).toBe('b');
  });

  it('else the newest running/accepted item of the sender', () => {
    const items = [
      wi({ id: 'old', startedAt: new Date(NOW - 50 * 60_000).toISOString() }),
      wi({ id: 'new', status: 'accepted', startedAt: new Date(NOW - 5 * 60_000).toISOString() }),
      wi({ id: 'other', target: 'nova' }),
    ];
    expect(findStatusWorkItem(items, 'vera', undefined, NOW)?.id).toBe('new');
  });

  it('else an item it finished in the last 30 minutes; older ones do not count', () => {
    const recent = wi({ id: 'recent', status: 'done_by_worker', completedAt: new Date(NOW - 5 * 60_000).toISOString() });
    const stale = wi({ id: 'stale', status: 'done', completedAt: new Date(NOW - 3 * 60 * 60_000).toISOString() });
    expect(findStatusWorkItem([stale, recent], 'vera', undefined, NOW)?.id).toBe('recent');
    expect(findStatusWorkItem([stale], 'vera', undefined, NOW)).toBeNull();
  });
});
