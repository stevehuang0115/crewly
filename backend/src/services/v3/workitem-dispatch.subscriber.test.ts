/**
 * Tests for WorkItemDispatchSubscriber.
 *
 * Covers the runtime path (workitem:queued event listener) and the dispatch
 * primitive used by both the subscriber and AgentAutoClaim's recovery.
 *
 * @module services/v3/workitem-dispatch.subscriber.test
 */

import axios from 'axios';
import { WorkItemDispatchSubscriber } from './workitem-dispatch.subscriber.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { createWorkItem } from '../../types/v2/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

/**
 * Builds a minimal WorkItem fixture. Spec-required fields only — tests
 * override what they care about.
 */
function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    ...createWorkItem({
      type: 'project_task',
      owner: 'agent',
      title: 'default title',
      target: 'crewly-product-leo-21a5477e',
    }),
    ...overrides,
  };
}

describe('WorkItemDispatchSubscriber', () => {
  beforeEach(() => {
    WorkItemDispatchSubscriber.resetInstance();
    jest.clearAllMocks();
    mockedAxios.post.mockResolvedValue({ status: 200, data: { success: true } });
  });

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = WorkItemDispatchSubscriber.getInstance();
      const b = WorkItemDispatchSubscriber.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('dispatchTo — team budget gate', () => {
    it('skips the push (and does not mark dispatched) when the target team is over budget', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      let allowed = false;
      svc.setTeamBudgetGate({
        checkForSession: async () => ({
          allowed,
          reason: allowed ? undefined : 'team_budget_exceeded',
          detail: 'over',
          level: allowed ? 'ok' : 'blocked',
          teamId: 't1',
          teamName: 'T',
          usage: { tokensToday: 0, usdThisMonth: 0, sessions: [] },
        }),
      });
      const wi = makeWorkItem({ id: 'wi-budget' });

      expect(await svc.dispatchTo(wi)).toBe(false);
      expect(mockedAxios.post).not.toHaveBeenCalled();

      // Budget window resets → the same WI dispatches on the next attempt.
      allowed = true;
      expect(await svc.dispatchTo(wi)).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('fails open when the gate throws', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      svc.setTeamBudgetGate({
        checkForSession: async () => {
          throw new Error('gate down');
        },
      });
      expect(await svc.dispatchTo(makeWorkItem({ id: 'wi-open' }))).toBe(true);
    });
  });

  describe('dispatchTo', () => {
    it('POSTs a [CREWLY-DISPATCH] message to the target session', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const wi = makeWorkItem({ id: 'wi-1', target: 'crewly-product-max-358c7cb7' });

      const ok = await svc.dispatchTo(wi);
      expect(ok).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);

      const [url, body, config] = mockedAxios.post.mock.calls[0];
      expect(url).toContain('/api/terminal/crewly-product-max-358c7cb7/write');
      expect((body as { mode: string }).mode).toBe('message');
      expect((body as { data: string }).data).toContain('[CREWLY-DISPATCH]');
      expect((body as { data: string }).data).toContain('wi-1');
      expect((body as { data: string }).data).toContain('poll-tasks');
      expect((config as { headers: { 'X-Agent-Session': string } }).headers['X-Agent-Session']).toBe('WorkItemDispatch');
    });

    it('skips WIs without a target', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const wi = makeWorkItem({ id: 'wi-no-target', target: undefined });

      const ok = await svc.dispatchTo(wi);
      expect(ok).toBe(false);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('skips SLA tracker WIs (respond_to_user pattern)', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const wi = makeWorkItem({
        id: 'request:abc-123:respond_to_user',
        target: 'crewly-orc',
      });

      const ok = await svc.dispatchTo(wi);
      expect(ok).toBe(false);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('is idempotent: a second call for the same WI is a no-op', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const wi = makeWorkItem({ id: 'wi-dup' });

      const first = await svc.dispatchTo(wi);
      const second = await svc.dispatchTo(wi);

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('does not mark dispatched on HTTP failure (allows retry)', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const wi = makeWorkItem({ id: 'wi-failing' });

      mockedAxios.post.mockRejectedValueOnce(new Error('connection refused'));
      const first = await svc.dispatchTo(wi);
      expect(first).toBe(false);

      // Now succeeds — should still be allowed (not blocked by dedup set)
      mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { success: true } });
      const retry = await svc.dispatchTo(wi);
      expect(retry).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('encodes session names with special characters into the URL', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const wi = makeWorkItem({ id: 'wi-encode', target: 'agent name with space' });

      await svc.dispatchTo(wi);
      const [url] = mockedAxios.post.mock.calls[0];
      expect(url).toContain(encodeURIComponent('agent name with space'));
    });

    it('re-dispatches the same WI to a different target (Steve 2026-05-15 dogfood)', async () => {
      // Concrete repro: WI 20a778bc was dispatched to ethan (claim
      // expired without ethan starting work, WI requeued), then
      // AutoClaim reassigned it to crewly-orc. Before this fix the
      // dispatched-set short-circuited on workItemId alone and orc
      // never received the [CREWLY-DISPATCH] message. Composite key
      // restores the second dispatch.
      const svc = WorkItemDispatchSubscriber.getInstance();
      const wi = makeWorkItem({ id: 'wi-reassigned', target: 'agent-ethan' });

      const first = await svc.dispatchTo(wi);
      expect(first).toBe(true);

      // Same WI, NEW target (reassignment scenario)
      const reassigned = { ...wi, target: 'crewly-orc' };
      const second = await svc.dispatchTo(reassigned);
      expect(second).toBe(true);

      // Confirm BOTH targets received the message
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
      const [url1] = mockedAxios.post.mock.calls[0];
      const [url2] = mockedAxios.post.mock.calls[1];
      expect(url1).toContain('agent-ethan');
      expect(url2).toContain('crewly-orc');
    });

    it('still dedups within (workItemId, target) — a third call to the SAME target is a no-op', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const wi = makeWorkItem({ id: 'wi-target-dedup', target: 'agent-foo' });

      await svc.dispatchTo(wi);
      await svc.dispatchTo(wi);
      const third = await svc.dispatchTo(wi);
      expect(third).toBe(false);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('redispatchMany (one reminder per agent)', () => {
    it('writes ONE [CREWLY-DISPATCH] message listing every WI and re-arms their dedup keys', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const a = makeWorkItem({ id: 'wi-a', target: 'sora', title: 'first item' });
      const b = makeWorkItem({ id: 'wi-b', target: 'sora', title: 'second item' });
      await svc.dispatchTo(a); // already dispatched once → dedup key set
      mockedAxios.post.mockClear();

      const ok = await svc.redispatchMany([a, b]);
      expect(ok).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const [url, body] = mockedAxios.post.mock.calls[0];
      expect(url).toContain('/api/terminal/sora/write');
      const text = (body as { data: string }).data;
      expect(text).toContain('[CREWLY-DISPATCH] 2 WorkItems');
      expect(text).toContain('1. wi-a');
      expect(text).toContain('2. wi-b');
      expect(text).toContain('second item');
      expect(text).toContain('"sessionName":"sora"');
    });

    it('drops items for other targets and SLA trackers, and delegates a single item to redispatch', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const a = makeWorkItem({ id: 'wi-a', target: 'sora' });
      const other = makeWorkItem({ id: 'wi-o', target: 'someone-else' });

      const ok = await svc.redispatchMany([a, other]);
      expect(ok).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const text = (mockedAxios.post.mock.calls[0][1] as { data: string }).data;
      expect(text).toContain('wi-a');
      expect(text).not.toContain('wi-o');
      expect(text).not.toContain('WorkItems are still queued'); // single-item format
    });

    it('returns false for an empty batch or one without a target', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      expect(await svc.redispatchMany([])).toBe(false);
      expect(await svc.redispatchMany([makeWorkItem({ id: 'wi-x', target: undefined })])).toBe(false);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('does not mark the batch dispatched when the write fails', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const a = makeWorkItem({ id: 'wi-a', target: 'sora' });
      const b = makeWorkItem({ id: 'wi-b', target: 'sora' });
      mockedAxios.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      expect(await svc.redispatchMany([a, b])).toBe(false);
      // A later plain dispatch of either item must still go through.
      mockedAxios.post.mockResolvedValue({ status: 200, data: { success: true } });
      expect(await svc.dispatchTo(a)).toBe(true);
    });
  });

  describe('event subscription', () => {
    it('warns when started without initialization', () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      expect(() => svc.start()).not.toThrow();
    });

    it('subscribes to event_published', () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const mockEventBus = { on: jest.fn() };
      svc.initialize(mockEventBus);
      svc.start();
      expect(mockEventBus.on).toHaveBeenCalledWith('event_published', expect.any(Function));
    });

    it('dispatches on workitem:queued, ignores other event types', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const mockEventBus = { on: jest.fn() };
      svc.initialize(mockEventBus);
      svc.start();

      const wi = makeWorkItem({ id: 'wi-from-event' });
      jest.spyOn(TaskPoolService, 'getInstance').mockReturnValue({
        findWorkItem: jest.fn().mockResolvedValue(wi),
      } as unknown as TaskPoolService);

      // Pull the registered handler
      const handler = mockEventBus.on.mock.calls[0][1];

      // Wrong event type — no dispatch
      await handler({ eventType: 'task:done', workItemId: 'wi-from-event' });
      expect(mockedAxios.post).not.toHaveBeenCalled();

      // Right event type — dispatch
      handler({ eventType: 'workitem:queued', workItemId: 'wi-from-event' });
      // handler is fire-and-forget; allow async settle
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('skips event dispatch when WI has already moved past queued', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const mockEventBus = { on: jest.fn() };
      svc.initialize(mockEventBus);
      svc.start();

      const movedWi = makeWorkItem({ id: 'wi-moved', status: 'running' });
      jest.spyOn(TaskPoolService, 'getInstance').mockReturnValue({
        findWorkItem: jest.fn().mockResolvedValue(movedWi),
      } as unknown as TaskPoolService);

      const handler = mockEventBus.on.mock.calls[0][1];
      handler({ eventType: 'workitem:queued', workItemId: 'wi-moved' });
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('message format', () => {
    it('truncates long titles to keep terminal lines bounded', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const longTitle = 'A'.repeat(200);
      const wi = makeWorkItem({ id: 'wi-long', title: longTitle });

      await svc.dispatchTo(wi);
      const body = mockedAxios.post.mock.calls[0][1] as { data: string };
      expect(body.data).toContain('A'.repeat(77));
      expect(body.data).toContain('...');
      expect(body.data).not.toContain('A'.repeat(81));
    });

    it('embeds the runnable poll-tasks command for the target', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const wi = makeWorkItem({ id: 'wi-cmd', target: 'crewly-product-quinn-47ce967d' });

      await svc.dispatchTo(wi);
      const body = mockedAxios.post.mock.calls[0][1] as { data: string };
      expect(body.data).toContain('bash $AGENT_SKILLS_PATH/core/poll-tasks/execute.sh');
      expect(body.data).toContain('"sessionName":"crewly-product-quinn-47ce967d"');
    });
  });

  describe('fresh conversation per task', () => {
    it('prepares the conversation before the write and prefixes the note when cleared', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const order: string[] = [];
      const prepareForTask = jest.fn(async () => {
        order.push('prepare');
        return { cleared: true, handoverPath: '/h/leo.md' };
      });
      mockedAxios.post.mockImplementation(async () => {
        order.push('write');
        return { status: 200, data: { success: true } };
      });
      svc.setTaskConversationPreparer({ prepareForTask });
      const wi = makeWorkItem({ id: 'wi-fresh' });

      expect(await svc.dispatchTo(wi)).toBe(true);
      expect(prepareForTask).toHaveBeenCalledWith(wi.target, wi);
      expect(order).toEqual(['prepare', 'write']);
      const body = mockedAxios.post.mock.calls[0][1] as { data: string };
      const lines = body.data.split('\n');
      expect(lines[1]).toBe('Fresh conversation for this task — your earlier work is in /h/leo.md and your wiki; read them only if this task needs it.');
      expect(lines[2]).toContain('[CREWLY-DISPATCH] WorkItem wi-fresh');
    });

    it('no note when nothing was cleared, and a failing preparer never blocks delivery', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      svc.setTaskConversationPreparer({ prepareForTask: jest.fn(async () => ({ cleared: false })) });
      await svc.dispatchTo(makeWorkItem({ id: 'wi-a' }));
      expect((mockedAxios.post.mock.calls[0][1] as { data: string }).data).not.toContain('Fresh conversation');

      svc.setTaskConversationPreparer({ prepareForTask: jest.fn(async () => { throw new Error('boom'); }) });
      expect(await svc.dispatchTo(makeWorkItem({ id: 'wi-b' }))).toBe(true);
    });

    it('batch reminders do not prepare (they cover already-delivered work)', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const prepareForTask = jest.fn(async () => ({ cleared: false }));
      svc.setTaskConversationPreparer({ prepareForTask });
      await svc.redispatchMany([makeWorkItem({ id: 'wi-1' }), makeWorkItem({ id: 'wi-2' })]);
      expect(prepareForTask).not.toHaveBeenCalled();
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('worktree hint in the FIRST dispatch brief (#829 review)', () => {
    /**
     * `git worktree add` can take seconds — long enough that the old design
     * (a separate "worktree ready" terminal message once creation finished)
     * arrived after the agent had already started work in the shared
     * checkout, reading only the workdir-less first brief. The hint is
     * computed synchronously (no git I/O beyond WorkItemWorktreeService's
     * own eligibility lookup) so it can be in the FIRST brief instead.
     */
    it('names the workdir in the first dispatch brief when a resolver is wired and resolves a hint', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      const resolveHint = jest.fn(async () => ({ workdir: '/repo/.crewly/worktrees/wi-1', branch: 'wi/wi-1' }));
      svc.setWorktreeHintResolver({ resolveHint });
      const wi = makeWorkItem({ id: 'wi-1' });

      expect(await svc.dispatchTo(wi)).toBe(true);
      expect(resolveHint).toHaveBeenCalledWith(wi);
      const body = (mockedAxios.post.mock.calls[0][1] as { data: string }).data;
      expect(body).toContain('This WorkItem has its own git worktree. Work ONLY in:');
      expect(body).toContain('/repo/.crewly/worktrees/wi-1');
      expect(body).toContain('(branch wi/wi-1)');
    });

    it('no hint line when the resolver returns null (WorkItem gets no worktree)', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      svc.setWorktreeHintResolver({ resolveHint: jest.fn(async () => null) });
      await svc.dispatchTo(makeWorkItem({ id: 'wi-2' }));
      expect((mockedAxios.post.mock.calls[0][1] as { data: string }).data).not.toContain('git worktree');
    });

    it('no hint line, and dispatch still proceeds, when no resolver is wired (default)', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      expect(await svc.dispatchTo(makeWorkItem({ id: 'wi-3' }))).toBe(true);
      expect((mockedAxios.post.mock.calls[0][1] as { data: string }).data).not.toContain('git worktree');
    });

    it('a throwing resolver never blocks delivery', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      svc.setWorktreeHintResolver({ resolveHint: jest.fn(async () => { throw new Error('boom'); }) });
      expect(await svc.dispatchTo(makeWorkItem({ id: 'wi-4' }))).toBe(true);
    });

    it('setWorktreeHintResolver(null) restores the no-hint default', async () => {
      const svc = WorkItemDispatchSubscriber.getInstance();
      svc.setWorktreeHintResolver({ resolveHint: jest.fn(async () => ({ workdir: '/x', branch: 'wi/x' })) });
      svc.setWorktreeHintResolver(null);
      await svc.dispatchTo(makeWorkItem({ id: 'wi-5' }));
      expect((mockedAxios.post.mock.calls[0][1] as { data: string }).data).not.toContain('git worktree');
    });
  });
});
