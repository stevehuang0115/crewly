/**
 * Tests for #841 give-up recovery, against a real TaskPoolService on temp
 * storage (so every transition goes through the real state machine).
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TaskPoolService } from '../task-pool.service.js';
import { PoolStorage } from '../pool-storage.js';
import { createWorkItem, getWorkItemDisposition } from '../../../types/v2/work-item.types.js';
import { detectRetryableFailedWorkItems } from '../../reconciler/reconcile-rules.js';
import type { Team } from '../../../types/index.js';
import { GiveUpRecoveryService, completionText, maxRetriesFor, giveUpMetaOf } from './give-up-recovery.service.js';
import { computeGiveUpStats } from './give-up-stats.js';

const WORKER = 'crewly-dev-1';
const LEAD = 'crewly-tl-1';
const GIVE_UP = 'The speed record cannot be beaten with this approach; it is impossible.';

/**
 * A team with the worker and its lead.
 *
 * @param giveUpMaxRetries - Team policy, or undefined for the default
 * @returns Team
 */
function team(giveUpMaxRetries?: number): Team {
  return {
    id: 'team-a',
    name: 'Team A',
    projectIds: [],
    createdAt: '',
    updatedAt: '',
    members: [
      { id: 'm-tl', name: 'Lead', role: 'team-leader', sessionName: LEAD, systemPrompt: '', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code', createdAt: '', updatedAt: '' },
      { id: 'm-dev', name: 'Dev', role: 'developer', sessionName: WORKER, parentMemberId: 'm-tl', systemPrompt: '', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code', createdAt: '', updatedAt: '' },
    ],
    ...(giveUpMaxRetries === undefined ? {} : { recoveryPolicy: { giveUpMaxRetries } }),
  } as unknown as Team;
}

describe('GiveUpRecoveryService (#841)', () => {
  let dir: string;
  let pool: TaskPoolService;
  let teams: Team[];
  let svc: GiveUpRecoveryService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'giveup-'));
    pool = new TaskPoolService(new PoolStorage({ dataDir: dir }));
    teams = [team()];
    svc = new GiveUpRecoveryService({ pool, loadTeams: async () => teams, now: () => new Date('2026-09-27T12:00:00Z') });
  });

  afterEach(async () => {
    TaskPoolService.resetInstance();
    await pool.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Add a delegate item for the worker and claim it (running). */
  async function running(overrides: Record<string, unknown> = {}): Promise<string> {
    const wi = createWorkItem({ type: 'delegate', owner: 'agent', title: 'Beat the record', description: 'Train GPT-2 faster than the record.', target: WORKER, parentWorkItemId: 'parent-1', ...overrides });
    await pool.addToPool(wi);
    const claim = await pool.claimSpecificItem(WORKER, wi.id);
    expect(claim).not.toBeNull();
    return wi.id;
  }

  /** Claim a queued item for the worker. */
  async function claim(id: string): Promise<void> {
    expect(await pool.claimSpecificItem(WORKER, id)).not.toBeNull();
  }

  const item = async (id: string) => (await pool.findWorkItem(id))!;

  it('a give-up block queues ONE retry for the same worker, with the attempt log and the instruction', async () => {
    const root = await running();
    const out = await svc.block(root, { agentId: WORKER, reason: GIVE_UP });

    expect(out).toMatchObject({ action: 'retry_queued', retryWorkItemId: `${root}:giveup:1`, attempt: 1, maxRetries: 2 });
    const retry = await item(`${root}:giveup:1`);
    expect(retry).toMatchObject({ status: 'queued', target: WORKER, type: 'delegate', parentWorkItemId: 'parent-1' });
    expect(retry.description).toContain('Train GPT-2 faster than the record.');
    expect(retry.description).toContain('materially different');
    expect(retry.description).toContain(GIVE_UP);
    expect(giveUpMetaOf(retry)).toMatchObject({ rootWorkItemId: root, attempt: 1, attempts: [{ workItemId: root, source: 'block' }] });

    const stopped = await item(root);
    expect(stopped.status).toBe('cancelled');
    expect(stopped.cancelReason).toContain(`superseded by ${root}:giveup:1`);
    expect(stopped.metadata?.['stop']).toMatchObject({ source: 'block', decision: 'retry', category: 'feasibility' });
  });

  it('is bounded per ROOT: after N retries the next stop escalates once, even if it says "impossible" again', async () => {
    const root = await running();
    await svc.block(root, { agentId: WORKER, reason: GIVE_UP }); // -> retry 1
    await claim(`${root}:giveup:1`);
    const second = await svc.block(`${root}:giveup:1`, { agentId: WORKER, reason: 'Still impossible, no way to do it.' }); // -> retry 2
    expect(second).toMatchObject({ action: 'retry_queued', retryWorkItemId: `${root}:giveup:2`, attempt: 2 });
    await claim(`${root}:giveup:2`);
    const third = await svc.fail(`${root}:giveup:2`, 'It is impossible, giving up.'); // -> escalate

    expect(third).toMatchObject({ action: 'escalated_to_lead', reviewWorkItemId: `${root}:review:gave_up`, attempt: 3, maxRetries: 2 });
    const all = await pool.getAllItems();
    expect(all.filter((w) => w.id.includes(':giveup:')).map((w) => w.id).sort()).toEqual([`${root}:giveup:1`, `${root}:giveup:2`]);
    expect(all.some((w) => w.id.includes(':giveup:1:giveup') || w.id.includes(':giveup:2:'))).toBe(false);

    const review = await item(`${root}:review:gave_up`);
    expect(review).toMatchObject({ type: 'review', owner: 'team_lead', target: LEAD, status: 'queued' });
    expect(review.metadata).toMatchObject({ reviewReason: 'gave_up', sourceWorkItemId: root });
    expect(giveUpMetaOf(review)!.attempts.map((a) => a.workItemId)).toEqual([root, `${root}:giveup:1`, `${root}:giveup:2`]);
    expect(review.description).toContain('Still impossible');

    // The last stopped item is handed to the review, so the reconciler does not requeue it too.
    const last = await item(`${root}:giveup:2`);
    expect(last.status).toBe('failed');
    expect(getWorkItemDisposition(last)).toMatchObject({ kind: 'succeeded_by', successorWorkItemId: `${root}:review:gave_up` });
    expect(detectRetryableFailedWorkItems([last]).corrections).toHaveLength(0);
  });

  it('the lead gets ONE escalation, not one per stop', async () => {
    teams = [team(0 + 1)];
    const root = await running();
    await svc.block(root, { agentId: WORKER, reason: GIVE_UP });
    await claim(`${root}:giveup:1`);
    await svc.block(`${root}:giveup:1`, { agentId: WORKER, reason: GIVE_UP });
    const reviews = (await pool.getAllItems()).filter((w) => w.id.endsWith(':review:gave_up'));
    expect(reviews).toHaveLength(1);
  });

  it('a stop that needs a human is only recorded: no retry, no escalation WI, the item stays blocked as today', async () => {
    const root = await running();
    const out = await svc.block(root, { agentId: WORKER, reason: "I can't reproduce the sermons verbatim; they are copyrighted. Which option do you want?" });
    expect(out).toMatchObject({ action: 'recorded', verdict: { decision: 'escalate', category: 'legal' } });
    expect((await pool.getAllItems()).map((w) => w.id)).toEqual([root]);
    const stopped = await item(root);
    expect(stopped.status).toBe('blocked');
    expect(stopped.metadata?.['stop']).toMatchObject({ decision: 'escalate', category: 'legal' });
  });

  describe('completions', () => {
    it('a completion whose outcome is a give-up (no delivery) becomes failed + retry, never done_by_worker', async () => {
      const root = await running();
      const out = await svc.complete(root, { summary: 'Could not get it under the target time. Gave up.' });
      expect(out).toMatchObject({ action: 'retry_queued', retryWorkItemId: `${root}:giveup:1` });
      const stopped = await item(root);
      expect(stopped.status).toBe('failed');
      expect(getWorkItemDisposition(stopped)).toMatchObject({ kind: 'succeeded_by', successorWorkItemId: `${root}:giveup:1` });
      expect(stopped.metadata?.['stop']).toMatchObject({ source: 'complete', decision: 'retry' });
    });

    it('a delivered completion that mentions "couldn\'t" completes exactly as today', async () => {
      const root = await running();
      const out = await svc.complete(root, { summary: "Done, PR opened; couldn't reproduce the flaky test, fixed it anyway." });
      expect(out.action).toBe('none');
      const done = await item(root);
      expect(done.status).toBe('done_by_worker');
      expect(done.metadata?.['stop']).toBeUndefined();
      expect((await pool.getAllItems())).toHaveLength(1);
    });

    it('with the team policy at 0 (feature off), a give-up completion also completes as today', async () => {
      teams = [team(0)];
      const root = await running();
      const out = await svc.complete(root, { summary: 'It is impossible. Gave up.' });
      expect(out.action).toBe('recorded');
      expect((await item(root)).status).toBe('done_by_worker');
      expect(await pool.getAllItems()).toHaveLength(1);
    });
  });

  it('a give-up failure with no team falls back to the default N and escalates to the orchestrator', async () => {
    teams = [];
    const agent = 'solo-agent';
    const wi = createWorkItem({ type: 'delegate', owner: 'agent', title: 'Solo task', target: agent });
    await pool.addToPool(wi);
    await pool.claimSpecificItem(agent, wi.id);
    await svc.fail(wi.id, GIVE_UP); // retry 1 (default N = 2)
    await pool.claimSpecificItem(agent, `${wi.id}:giveup:1`);
    await svc.fail(`${wi.id}:giveup:1`, GIVE_UP); // retry 2
    await pool.claimSpecificItem(agent, `${wi.id}:giveup:2`);
    const out = await svc.fail(`${wi.id}:giveup:2`, GIVE_UP); // escalate
    expect(out).toMatchObject({ action: 'escalated_to_lead', maxRetries: 2 });
    expect((await item(`${wi.id}:review:gave_up`)).target).toBe('crewly-orc');
  });

  it('metrics per team: give-ups, retries and the retry success rate', async () => {
    const root = await running();
    await svc.block(root, { agentId: WORKER, reason: GIVE_UP });
    await claim(`${root}:giveup:1`);
    await pool.completeItem(`${root}:giveup:1`, { summary: 'Done with a different optimizer; PR opened.' });
    const other = await running({ title: 'Other' });
    await svc.block(other, { agentId: WORKER, reason: 'Needs your approval to spend $40 on GPUs.' });

    let stats = computeGiveUpStats(await pool.getAllItems(), teams);
    expect(stats.examined).toBe(3);
    expect(stats.teams).toEqual([
      expect.objectContaining({
        teamId: 'team-a', giveUps: 1, retries: 1, retriesSucceeded: 0, retriesPending: 1, retrySuccessRate: null,
        escalations: 0, escalatedByCategory: { money: 1 },
      }),
    ]);
    // The lead verifies the retry: it now counts as a success.
    await pool.updateItemStatus(`${root}:giveup:1`, 'verified', 'system');
    stats = computeGiveUpStats(await pool.getAllItems(), teams);
    expect(stats.teams[0]).toMatchObject({ retriesSucceeded: 1, retriesPending: 0, retrySuccessRate: 1 });
    expect(computeGiveUpStats(await pool.getAllItems(), teams, 'nope').teams).toEqual([]);
  });
});

describe('helpers', () => {
  it('completionText reads the summary, else result/message', () => {
    expect(completionText({ summary: 's' })).toBe('s');
    expect(completionText({ result: 'r' })).toBe('r');
    expect(completionText(undefined)).toBe('');
    expect(completionText({ summary: 3 })).toBe('');
  });

  it('maxRetriesFor: team policy when valid, else the default 2', () => {
    expect(maxRetriesFor(null)).toBe(2);
    expect(maxRetriesFor(team(5))).toBe(5);
    expect(maxRetriesFor(team(0))).toBe(0);
    expect(maxRetriesFor(team(-1))).toBe(2);
    expect(maxRetriesFor(team(1.5))).toBe(2);
  });
});
