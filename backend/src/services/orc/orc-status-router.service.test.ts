import { OrcStatusRouterService, type OrcStatusReport } from './orc-status-router.service.js';
import { OrcWakeCounter } from './orc-wake-counter.js';
import { ORC_WAKE_CONSTANTS } from '../../constants.js';
import type { EnqueueMessageInput } from '../../types/messaging.types.js';
import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');

/** One team: Owen leads, Vera and Nova report to him. */
const TEAMS = [
  {
    id: 'team-ce',
    name: 'CE',
    leaderIds: ['m-owen'],
    members: [
      { id: 'm-owen', name: 'Owen', sessionName: 'owen', role: 'team-leader' },
      { id: 'm-vera', name: 'Vera', sessionName: 'vera', role: 'developer' },
      { id: 'm-nova', name: 'Nova', sessionName: 'nova', role: 'developer' },
    ],
  },
] as unknown as Team[];

function wi(over: Partial<WorkItem>): WorkItem {
  return {
    id: 'wi-1', type: 'delegate', owner: 'team_lead', target: 'vera', title: 'Draft', status: 'running',
    createdAt: new Date(NOW - 60_000).toISOString(), startedAt: new Date(NOW - 30_000).toISOString(),
    retryCount: 0, maxRetries: 3, inputTokens: 0, outputTokens: 0, cost: 0, ...over,
  } as WorkItem;
}

function setup(items: WorkItem[] = []) {
  const queued: EnqueueMessageInput[] = [];
  const counter = new OrcWakeCounter(() => NOW);
  const router = new OrcStatusRouterService({
    enqueue: (input) => queued.push(input),
    poolItems: async () => items,
    teams: async () => TEAMS,
    isOrchestrator: (n) => n === 'crewly-orc',
    now: () => NOW,
    counter,
  });
  const report = (content: string, sender = 'vera', extra: Partial<OrcStatusReport> = {}): Promise<unknown> =>
    router.route({ content, sender, conversationId: 'conv-1', deliveryOwed: false, orcText: content, ...extra });
  return { router, queued, counter, report };
}

describe('OrcStatusRouterService', () => {
  afterEach(() => jest.useRealTimers());

  it('member [DONE] on TL-owned work: nothing queued, nothing counted', async () => {
    const { queued, counter, report } = setup([wi({ owner: 'team_lead', metadata: { delegatedBy: 'owen' } })]);
    await report('[DONE] Agent vera: drafted');
    expect(queued).toEqual([]);
    expect(counter.snapshot().delegatedDone).toBe(0);
  });

  it('[DONE] on orchestrator-delegated work wakes the orchestrator and is counted', async () => {
    const { queued, counter, report } = setup([wi({ owner: 'orchestrator', metadata: { delegatedBy: 'crewly-orc' } })]);
    await report('[DONE] Agent vera: drafted');
    expect(queued).toEqual([
      expect.objectContaining({ content: 'Agent status: [DONE] Agent vera: drafted', conversationId: 'conv-1', source: 'system_event', sourceMetadata: { orcWakeCategory: 'delegated-done', authorAgentSession: 'vera' } }),
    ]);
    expect(queued[0].targetSession).toBeUndefined();
    expect(counter.snapshot().delegatedDone).toBe(1);
  });

  it('[BLOCKED] from a member goes to its team lead, not the orchestrator', async () => {
    const { queued, counter, report } = setup();
    await report('[BLOCKED] Agent vera: need the API key');
    expect(queued).toEqual([
      expect.objectContaining({ targetSession: 'owen', conversationId: ORC_WAKE_CONSTANTS.TEAM_LEAD_CONVERSATION_ID, content: expect.stringContaining('[BLOCKED] Agent vera') }),
    ]);
    expect(counter.snapshot().escalations).toBe(0);
  });

  it('[BLOCKED] from the team lead escalates to the orchestrator', async () => {
    const { queued, counter, report } = setup();
    await report('[BLOCKED] Agent owen: no access', 'owen');
    expect(queued).toHaveLength(1);
    expect(queued[0].targetSession).toBeUndefined();
    expect(queued[0].sourceMetadata).toMatchObject({ orcWakeCategory: 'escalation' });
    expect(counter.snapshot().escalations).toBe(1);
  });

  it('[BLOCKED] from an agent in no team escalates to the orchestrator', async () => {
    const { queued, report } = setup();
    await report('[BLOCKED] Agent loner: stuck', 'loner');
    expect(queued[0].targetSession).toBeUndefined();
  });

  it('a delivery the owner waits on wakes the orchestrator even for TL-owned work', async () => {
    const { queued, report } = setup([wi({})]);
    await report('[DONE] Agent vera: drafted', 'vera', { deliveryOwed: true });
    expect(queued).toHaveLength(1);
  });

  it('progress markers are recorded only', async () => {
    const { queued, router, report } = setup();
    for (const m of ['[IN_PROGRESS]', '[ACTIVE]', '[READY]', '[WORKING]', '[IDLE]']) await report(`${m} Agent vera: …`);
    expect(queued).toEqual([]);
    expect(router.pendingDigest()).toEqual([]);
  });

  describe('digest cadence', () => {
    it('batches reports into one orchestrator turn per 30-minute window, only with actionable items', async () => {
      jest.useFakeTimers({ now: NOW });
      const { queued, counter, report, router } = setup();
      await report('[DONE] Agent owen: daily check ran', 'owen'); // lead, no work item → actionable
      await report('[DONE] Agent vera: drafted'); // member, no work item → recorded for the lead
      await report('[DONE] Agent loner: posted', 'loner'); // no team → actionable

      jest.advanceTimersByTime(ORC_WAKE_CONSTANTS.DIGEST_INTERVAL_MS - 1);
      expect(queued).toEqual([]);
      jest.advanceTimersByTime(1);

      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ conversationId: ORC_WAKE_CONSTANTS.DIGEST_CONVERSATION_ID, source: 'system_event' });
      expect(queued[0].content).toContain('[STATUS DIGEST] 2 agent report(s)');
      expect(queued[0].content).toContain('- owen: [DONE] Agent owen: daily check ran');
      expect(queued[0].content).toContain('- loner: [DONE] Agent loner: posted');
      expect(queued[0].content).not.toContain('vera');
      expect(queued[0].content).toContain('1 other report(s)');
      expect(counter.snapshot().digest).toBe(1);
      expect(router.pendingDigest()).toEqual([]);

      // The next report opens a new window: no second digest before 30 more minutes.
      await report('[DONE] Agent owen: second check', 'owen');
      jest.advanceTimersByTime(ORC_WAKE_CONSTANTS.DIGEST_INTERVAL_MS / 2);
      expect(queued).toHaveLength(1);
      jest.advanceTimersByTime(ORC_WAKE_CONSTANTS.DIGEST_INTERVAL_MS / 2);
      expect(queued).toHaveLength(2);
      router.stop();
    });

    it('a window with nothing actionable is dropped, not sent', async () => {
      jest.useFakeTimers({ now: NOW });
      const { queued, counter, report } = setup();
      await report('[DONE] Agent vera: drafted');
      await report('[DONE] Agent nova: reviewed', 'nova');
      jest.advanceTimersByTime(ORC_WAKE_CONSTANTS.DIGEST_INTERVAL_MS);
      expect(queued).toEqual([]);
      expect(counter.snapshot().digest).toBe(0);
    });

    it('caps the listed lines', () => {
      const { router, queued } = setup();
      const anyRouter = router as unknown as { addToDigest(e: { sender: string; text: string; actionable: boolean; at: number }): void };
      for (let i = 0; i < ORC_WAKE_CONSTANTS.DIGEST_MAX_LINES + 3; i++) anyRouter.addToDigest({ sender: `a${i}`, text: `[DONE] ${i}`, actionable: true, at: NOW });
      router.flushDigest();
      expect(queued[0].content).toContain('…and 3 more');
      router.stop();
    });
  });

  it('without a queue nothing is counted and nothing throws', async () => {
    const counter = new OrcWakeCounter(() => NOW);
    const router = new OrcStatusRouterService({ enqueue: null, poolItems: async () => [], teams: async () => [], isOrchestrator: () => false, now: () => NOW, counter });
    await router.route({ content: '[BLOCKED] x', sender: 'loner', conversationId: 'c', deliveryOwed: false, orcText: 'x' });
    expect(counter.snapshot().escalations).toBe(0);
  });
});
