/**
 * Tests for trigger-workitem-dedupe.utils — skip trigger fires whose work is
 * already open in the pool.
 */

import { describe, it, expect } from '@jest/globals';
import { findCoveringVerifyItem, findOpenDuplicateWorkItem } from './trigger-workitem-dedupe.utils.js';
import type { WorkItem } from '../types/v2/work-item.types.js';

const wi = (overrides: Partial<WorkItem>): WorkItem =>
  ({
    id: 'wi',
    type: 'delegate',
    owner: 'team_lead',
    target: 'tl',
    title: 'Worker idle — verify-output gate',
    status: 'queued',
    createdAt: '',
    retryCount: 0,
    maxRetries: 3,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    ...overrides,
  } as WorkItem);

const draft = { target: 'tl', owner: 'team_lead', title: 'Worker idle — verify-output gate' };
const idleWatcher = { config: { type: 'signal', eventType: 'agent:idle_after_task', filter: { sessionName: 'worker' } } };

describe('findOpenDuplicateWorkItem', () => {
  it('finds an open item with the same target, owner and title', () => {
    const existing = wi({ id: 'a' });
    expect(findOpenDuplicateWorkItem([existing], draft)?.id).toBe('a');
  });
  it('ignores terminal items', () => {
    expect(findOpenDuplicateWorkItem([wi({ status: 'done' }), wi({ status: 'cancelled' }), wi({ status: 'verified' })], draft)).toBeNull();
  });
  it('ignores a different title or target', () => {
    expect(findOpenDuplicateWorkItem([wi({ title: 'Other' }), wi({ target: 'someone-else' })], draft)).toBeNull();
  });
  it('ignores a different owner', () => {
    expect(findOpenDuplicateWorkItem([wi({ owner: 'orchestrator' })], draft)).toBeNull();
  });
});

describe('findCoveringVerifyItem', () => {
  const source = wi({ id: 'task-1', target: 'worker', title: 'Build it', status: 'done_by_worker' });
  const verify = wi({ id: 'task-1:verify:task-1', target: 'tl', title: 'Verify: Build it', metadata: { verifyOf: 'task-1' } });

  it("idle-verify watcher is covered by the worker's open Verify item", () => {
    expect(findCoveringVerifyItem([source, verify], idleWatcher, draft)?.id).toBe(verify.id);
  });
  it('falls back to the id when verifyOf metadata is missing', () => {
    const noMeta = { ...verify, metadata: undefined };
    expect(findCoveringVerifyItem([source, noMeta], idleWatcher, draft)?.id).toBe(verify.id);
  });
  it('not covered once the Verify item is done', () => {
    expect(findCoveringVerifyItem([source, { ...verify, status: 'done' }], idleWatcher, draft)).toBeNull();
  });
  it("not covered by another worker's Verify item", () => {
    const other = { ...source, target: 'other-worker' };
    expect(findCoveringVerifyItem([other, verify], idleWatcher, draft)).toBeNull();
  });
  it('not covered when the Verify item is for another reviewer', () => {
    expect(findCoveringVerifyItem([source, { ...verify, target: 'other-tl' }], idleWatcher, draft)).toBeNull();
  });
  it('only applies to agent:idle_after_task watchers with a verify title', () => {
    const idle = { config: { type: 'signal', eventType: 'agent:idle', filter: { sessionName: 'worker' } } };
    expect(findCoveringVerifyItem([source, verify], idle, draft)).toBeNull();
    expect(findCoveringVerifyItem([source, verify], idleWatcher, { ...draft, title: 'Worker idle — ping' })).toBeNull();
    expect(findCoveringVerifyItem([source, verify], { config: { type: 'time' } }, draft)).toBeNull();
  });
});
