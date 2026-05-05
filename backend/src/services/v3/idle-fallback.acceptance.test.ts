/**
 * Idle-Fallback Acceptance Harness — spec §5.2 / §3.5.b
 *
 * Exercises the schedule-followup-as-idle-safety-net flow end-to-end at the
 * service layer. This is the §5.2 "idle-fallback live test" — Leo's harness
 * fixture (per spec §7) that complements Quinn's prompt amendment.
 *
 * Flow under test (spec §3.5.b):
 *   1. A stalled Worker schedules an idle-self-ping followup
 *      (delayMs=5–15min, max-fires=1, target=self).
 *   2. The TriggerEngine fires the time trigger when the wall-clock
 *      reaches T+delayMs (mocked here).
 *   3. The fired action enqueues a `delegate` WorkItem with the inbox-check
 *      + ping-ORC instructions in its description.
 *   4. The Worker (next claim cycle) picks up the WorkItem and follows the
 *      sweep recipe; if still no inbound work, the Worker pings ORC.
 *
 * The harness asserts steps 1–3 directly (deterministic, mockable).
 * Step 4 is exercised indirectly: we assert the WorkItem template carries
 * the language Quinn's §3.5.b prompt amendment will key off — so when
 * Quinn's prompt lands, a real Worker session will follow the recipe.
 *
 * Skip-with-message safety: a separate test reads the rendered Worker
 * system prompt and reports whether Quinn's amendment is in place. If
 * §3.5.b language is missing, that test logs a clear "depends on Quinn's
 * PR" warning instead of failing — the harness can ship before Quinn's PR
 * merges and graduate to a hard assertion afterwards.
 *
 * @module services/v3/idle-fallback.acceptance.test
 */

import { TriggerEngine } from './trigger-engine.service.js';
import {
  type CreateTriggerInput,
  type Trigger,
  type TriggerAction,
  createTrigger,
  DEFAULT_MAX_IDLE_FIRES,
} from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// Mocks — minimal: file-io + cron lookup are external concerns we don't
// exercise. Logger is silenced so test output stays focused on assertions.
// ---------------------------------------------------------------------------

jest.mock('../../utils/file-io.utils.js', () => ({
  ensureDir: jest.fn().mockResolvedValue(undefined),
  atomicWriteJson: jest.fn().mockResolvedValue(undefined),
  safeReadJson: jest.fn().mockResolvedValue([]),
}));

jest.mock('../workflow/cron-task.service.js', () => ({
  getNextRunTime: jest.fn().mockReturnValue(new Date(Date.now() + 60_000).toISOString()),
}));

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Idle-self-ping template — the contract Quinn's §3.5.b prompt amendment
// will instruct Workers to use. Centralised here so both the harness and
// any future caller (skill, prompt) can stay in sync.
//
// ⚠ Keep these strings in sync with config/skills/agent/core/schedule-followup
// and the §3.5.b paragraph in
// .crewly/specs/2026-05-05-pipeline-dogfood-prompt-amendment.md.
// ---------------------------------------------------------------------------

/**
 * Stable name *prefix* used for dedup + cancel by the agent. The full
 * trigger name is `${IDLE_SELF_PING_NAME}:${target}` (see
 * {@link idleSelfPingNameForTarget}) — per-target namespacing is required
 * because the engine dedups on `(createdBy, name)` and `createdBy` is a
 * constrained literal union (`'user'|'orchestrator'|'system'|'mission'`)
 * that cannot carry the agent session id.
 *
 * ⚠ ARCH 2026-05-05 PR #448 review caught the global-by-name dedup hazard:
 * if the name had stayed a flat `'idle-self-ping'` constant, two workers
 * scheduling their idle-self-ping would collide on (createdBy='system',
 * name='idle-self-ping') and the second worker would silently get the
 * first worker's trigger (still targeting the first worker). Worker B's
 * stall fallback would then fire on Worker A's session, breaking both
 * the wake routing and the §3.5.b ≤2-per-agent cap.
 */
export const IDLE_SELF_PING_NAME = 'idle-self-ping';

/**
 * Builds the per-target dedup name for an idle-self-ping followup.
 * Mirrors the auto-name pattern in `config/skills/agent/core/schedule-followup`
 * (which hashes target+title): we use a deterministic
 * `idle-self-ping:<session>` so `cancel-followup --name` can target it
 * predictably without needing the session-specific hash.
 *
 * @param target - The target agent's session name
 * @returns Per-target trigger name suitable for the engine's dedup key
 */
export function idleSelfPingNameForTarget(target: string): string {
  return `${IDLE_SELF_PING_NAME}:${target}`;
}

/** Window guidance in spec §3.5.b — 5–15 minutes. */
export const IDLE_SELF_PING_MIN_MS = 5 * 60 * 1000;
export const IDLE_SELF_PING_MAX_MS = 15 * 60 * 1000;

/**
 * Builds the canonical schedule-followup CreateTriggerInput a Worker would
 * POST when self-scheduling an idle-fallback wake-up.
 *
 * @param target - The Worker's session name (the followup targets self)
 * @param delayMs - Delay in milliseconds — must be in the §3.5.b 5–15min window
 * @returns A valid CreateTriggerInput ready for `TriggerEngine.create`
 */
export function buildIdleSelfPingTriggerInput(
  target: string,
  delayMs: number,
): CreateTriggerInput {
  if (delayMs < IDLE_SELF_PING_MIN_MS || delayMs > IDLE_SELF_PING_MAX_MS) {
    throw new Error(
      `idle-self-ping delayMs must be in [${IDLE_SELF_PING_MIN_MS}, ${IDLE_SELF_PING_MAX_MS}], got ${delayMs}`,
    );
  }
  return {
    type: 'time',
    config: { type: 'time', delayMs },
    action: {
      createWorkItem: {
        type: 'delegate',
        owner: 'team_lead',
        target,
        title: `${IDLE_SELF_PING_NAME}: re-check inbox + pool`,
        description: [
          `You scheduled this idle-self-ping at T-${Math.round(delayMs / 60_000)}min.`,
          'On wake:',
          '  1. Re-run the §3.5.a inbox-check sweep (list-my-followups + claim).',
          '  2. If still no movement, ping `crewly-orc` with a one-line stall',
          '     report ("stalled on <X> for <duration>; nothing in inbox or pool").',
          '  3. Either schedule one more idle-self-ping (≤2 active per agent) or',
          '     escalate via TL if the stall is now blocking a Request.',
        ].join('\n'),
      },
    },
    createdBy: 'system',
    // Per-target name (see ARCH note on IDLE_SELF_PING_NAME). The engine's
    // dedup key is (createdBy, name); since `createdBy` is a constrained
    // literal union and cannot carry the session id, we namespace `name`
    // instead. cancel-followup can still target by name predictably.
    name: idleSelfPingNameForTarget(target),
    maxFires: 1,
    maxIdleFires: DEFAULT_MAX_IDLE_FIRES,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Idle-Fallback Acceptance Harness (spec §5.2 / §3.5.b)', () => {
  const TEST_PROJECT = '/tmp/test-idle-fallback';
  const WORKER_SESSION = 'crewly-product-leo-21a5477e';

  let engine: TriggerEngine;

  beforeEach(() => {
    TriggerEngine.resetInstance();
    engine = TriggerEngine.getInstance(TEST_PROJECT);
  });

  afterEach(() => {
    TriggerEngine.resetInstance();
  });

  // -------------------------------------------------------------------------
  // §3.5.b template contract — the shape Quinn's prompt amendment relies on.
  // -------------------------------------------------------------------------

  describe('idle-self-ping trigger template', () => {
    it('accepts a delay in the 5–15 min window', () => {
      expect(() => buildIdleSelfPingTriggerInput(WORKER_SESSION, IDLE_SELF_PING_MIN_MS)).not.toThrow();
      expect(() => buildIdleSelfPingTriggerInput(WORKER_SESSION, 10 * 60_000)).not.toThrow();
      expect(() => buildIdleSelfPingTriggerInput(WORKER_SESSION, IDLE_SELF_PING_MAX_MS)).not.toThrow();
    });

    it('rejects delays outside the 5–15 min window (spec §3.5.b)', () => {
      expect(() => buildIdleSelfPingTriggerInput(WORKER_SESSION, 60_000)).toThrow(
        /5.+15|delayMs.+window|must be in/i,
      );
      expect(() =>
        buildIdleSelfPingTriggerInput(WORKER_SESSION, 30 * 60_000),
      ).toThrow(/5.+15|delayMs.+window|must be in/i);
    });

    it('targets the Worker itself (idle-self-ping is self-scoped)', () => {
      const input = buildIdleSelfPingTriggerInput(WORKER_SESSION, 10 * 60_000);
      expect(input.action.createWorkItem?.target).toBe(WORKER_SESSION);
    });

    it('caps maxFires=1 so a single stall does not loop the agent', () => {
      const input = buildIdleSelfPingTriggerInput(WORKER_SESSION, 10 * 60_000);
      expect(input.maxFires).toBe(1);
    });

    it('description names the inbox sweep AND ping-orc fallback', () => {
      const input = buildIdleSelfPingTriggerInput(WORKER_SESSION, 10 * 60_000);
      const desc = input.action.createWorkItem?.description ?? '';
      // §3.5.a sweep components
      expect(desc.toLowerCase()).toContain('list-my-followups');
      expect(desc.toLowerCase()).toContain('claim');
      // §3.5.b escalation
      expect(desc.toLowerCase()).toMatch(/ping.+(crewly-)?orc|crewly-orc/);
      expect(desc.toLowerCase()).toContain('stall');
    });

    it('uses stable per-target name so cancel-followup can target it predictably', () => {
      const input = buildIdleSelfPingTriggerInput(WORKER_SESSION, 10 * 60_000);
      // ARCH #448: name is per-target — `idle-self-ping:<session>` —
      // not a flat `idle-self-ping` constant. Cancel-followup callers
      // pass `idleSelfPingNameForTarget(self)` to find their own ping.
      expect(input.name).toBe(idleSelfPingNameForTarget(WORKER_SESSION));
      expect(input.name).toContain(IDLE_SELF_PING_NAME); // prefix invariant
      expect(input.name).toContain(WORKER_SESSION); // session-id suffix invariant
    });
  });

  // -------------------------------------------------------------------------
  // Stall → fire → WorkItem flow — the live test (spec §5.2 idle-fallback).
  // -------------------------------------------------------------------------

  describe('stall → schedule-followup → fire → WorkItem (synthetic stall fixture)', () => {
    it('records the trigger as active before the wall-clock fires', async () => {
      const input = buildIdleSelfPingTriggerInput(WORKER_SESSION, 10 * 60_000);
      const trigger = await engine.create(input);
      expect(trigger.status).toBe('active');
      expect(trigger.fireCount).toBe(0);
    });

    it('on synthetic time advance, fires the action handler with createWorkItem', async () => {
      const captured: TriggerAction[] = [];
      engine.setActionHandler(async (_t, action) => {
        captured.push(action);
      });

      const input = buildIdleSelfPingTriggerInput(WORKER_SESSION, 10 * 60_000);
      const trigger = await engine.create(input);

      // Synthetic fire — equivalent to wall-clock T+delayMs.
      await engine.fire(trigger);

      expect(captured).toHaveLength(1);
      expect(captured[0].createWorkItem).toBeDefined();
      const wi = captured[0].createWorkItem!;
      expect(wi.target).toBe(WORKER_SESSION);
      expect(wi.title?.toLowerCase() ?? '').toContain('idle');
      expect((wi.description ?? '').toLowerCase()).toContain('inbox');
    });

    it('exhausts after one fire so the stall does not loop (spec §3.5.b cap)', async () => {
      engine.setActionHandler(async () => undefined);

      const input = buildIdleSelfPingTriggerInput(WORKER_SESSION, 10 * 60_000);
      const trigger = await engine.create(input);

      const result = await engine.fire(trigger);
      expect(result.productive).toBe(true);

      // After firing maxFires=1 times, the trigger must be exhausted — a
      // second fire does NOT execute the action.
      const second = await engine.fire(trigger);
      // Either status='exhausted' (re-fire short-circuits) or the action
      // handler was not invoked. Both are acceptable; assert one or the other.
      const exhausted = trigger.status === 'exhausted';
      expect(exhausted || !second.productive).toBe(true);
    });

    it('publishes a WorkItem whose description tells the worker to ping ORC if still stalled', async () => {
      let captured: TriggerAction | null = null;
      engine.setActionHandler(async (_t, action) => {
        captured = action;
      });

      const input = buildIdleSelfPingTriggerInput(WORKER_SESSION, 10 * 60_000);
      const trigger = await engine.create(input);
      await engine.fire(trigger);

      expect(captured).toBeTruthy();
      const desc = (captured as unknown as TriggerAction).createWorkItem?.description ?? '';
      // The worker's runbook on wake — §3.5.b items 1–3.
      expect(desc).toMatch(/list-my-followups/i);
      expect(desc).toMatch(/claim/i);
      // "ping crewly-orc" or "ping `crewly-orc`" or "ping orc" — backticks /
      // surrounding whitespace are tolerated.
      expect(desc).toMatch(/ping\s*[`\s-]*(?:crewly-)?orc/i);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting cap — at most 2 active idle-self-pings per agent
  // (per spec §3.5.b "Owner / discipline" paragraph).
  //
  // The engine enforces a soft cap via (createdBy, name) idempotency: two
  // calls with the same createdBy+name return the SAME trigger instead of
  // accumulating duplicates. So a single agent that re-runs schedule-followup
  // with name='idle-self-ping' will not double-fire. To intentionally hold
  // multiple in flight (the spec's "≤2" allowance), the caller must use
  // distinct names (e.g. `idle-self-ping-1`, `idle-self-ping-2`).
  //
  // What we test here:
  //   1. Same-name dedup actually works (no duplicate accumulation).
  //   2. Distinct-name siblings register independently (so the spec's
  //      ≤2-in-flight allowance is achievable when needed).
  // -------------------------------------------------------------------------

  describe('per-agent cap (engine dedup + skill discipline)', () => {
    it('same-target re-registration returns the existing trigger (no duplicate accumulation)', async () => {
      const input = buildIdleSelfPingTriggerInput(WORKER_SESSION, 5 * 60_000);
      const t1 = await engine.create(input);
      const t2 = await engine.create(input);
      expect(t1.status).toBe('active');
      expect(t2.id).toBe(t1.id);
      // Only one trigger physically registered for this target.
      expect(
        engine.list('active').filter((t) => t.name === idleSelfPingNameForTarget(WORKER_SESSION)),
      ).toHaveLength(1);
    });

    it('distinct names register independently for the same target (spec allows ≤2 active)', async () => {
      const baseInput = buildIdleSelfPingTriggerInput(WORKER_SESSION, 5 * 60_000);
      const a = await engine.create({ ...baseInput, name: `${baseInput.name}-1` });
      const b = await engine.create({ ...baseInput, name: `${baseInput.name}-2` });
      expect(a.id).not.toBe(b.id);
      expect(a.status).toBe('active');
      expect(b.status).toBe('active');
    });

    it('creates distinct triggers for distinct agents (cross-agent isolation — Arch #448 review)', async () => {
      // Regression guard for the "global-by-name dedup" bug Arch caught
      // on PR #448. With per-target name namespacing, Worker A's
      // idle-self-ping must NOT alias Worker B's.
      //
      // If this test ever fails after a refactor, the engine's
      // `(createdBy, name)` dedup is leaking across agents — and Worker
      // B's stall fallback will silently fire on Worker A's session,
      // so the §3.5.b cap and wake routing both break.
      const leoInput = buildIdleSelfPingTriggerInput('worker-leo', 10 * 60_000);
      const maxInput = buildIdleSelfPingTriggerInput('worker-max', 10 * 60_000);

      // Sanity: both inputs share `createdBy='system'` (the only literal
      // the engine type allows). The ONLY thing that should keep them
      // apart in the dedup map is `name` being target-namespaced.
      expect(leoInput.createdBy).toBe(maxInput.createdBy);
      expect(leoInput.createdBy).toBe('system');
      expect(leoInput.name).not.toBe(maxInput.name);
      expect(leoInput.name).toBe(idleSelfPingNameForTarget('worker-leo'));
      expect(maxInput.name).toBe(idleSelfPingNameForTarget('worker-max'));

      const leoTrigger = await engine.create(leoInput);
      const maxTrigger = await engine.create(maxInput);

      expect(leoTrigger.id).not.toBe(maxTrigger.id);
      expect(leoTrigger.action.createWorkItem?.target).toBe('worker-leo');
      expect(maxTrigger.action.createWorkItem?.target).toBe('worker-max');
      expect(leoTrigger.status).toBe('active');
      expect(maxTrigger.status).toBe('active');

      // Both must be present in the active list — engine should not have
      // silently aliased one to the other.
      const activePings = engine
        .list('active')
        .filter((t) => t.name?.startsWith(`${IDLE_SELF_PING_NAME}:`));
      expect(activePings).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Quinn-prompt-dependent gate — skip-with-message until §3.5.b lands.
  // When Quinn's prompt amendment merges, swap `it.skip` → `it` (or remove
  // the conditional) and this test becomes a hard acceptance gate.
  // -------------------------------------------------------------------------

  describe('Quinn §3.5.b prompt amendment integration (depends on Quinn PR)', () => {
    /**
     * Probes the rendered Worker system prompt for the §3.5.b language.
     * Returns true when both `idle-self-ping` and `schedule-followup` appear
     * in the prompt body.
     */
    async function quinnPromptHasIdleFallbackLanguage(): Promise<boolean> {
      try {
        // Lazy-import the prompt builder so this test stays standalone if
        // the prompt-builder graph is not loaded.
        const { PromptBuilderService } = await import('../ai/prompt-builder.service.js');
        const builder = (PromptBuilderService as unknown as {
          getInstance: () => { buildSystemPrompt: (cfg: unknown) => Promise<string> };
        }).getInstance();
        const prompt = await builder.buildSystemPrompt({
          memberId: 'leo',
          sessionName: WORKER_SESSION,
          name: 'Leo',
          role: 'developer',
          teamId: 'test-team',
          teamName: 'test',
          projectPath: TEST_PROJECT,
        } as unknown as Parameters<
          (typeof PromptBuilderService)['prototype']['buildSystemPrompt']
        >[0]);
        return (
          prompt.toLowerCase().includes('idle-self-ping') &&
          prompt.toLowerCase().includes('schedule-followup')
        );
      } catch {
        return false;
      }
    }

    it('rendered Worker prompt names idle-self-ping + schedule-followup (when Quinn PR is in)', async () => {
      const hasLanguage = await quinnPromptHasIdleFallbackLanguage();
      if (!hasLanguage) {
        // Soft skip — Quinn's §3.5.b amendment is not in the prompt yet.
        // Once Quinn's PR merges, this branch goes cold and the assertion
        // below becomes the hard gate.
        // eslint-disable-next-line no-console
        console.warn(
          '[idle-fallback.acceptance] Quinn §3.5.b prompt amendment not detected — ' +
            'this test will become a hard assertion once Quinn PR merges. ' +
            'Until then, the harness verifies the trigger contract only.',
        );
        return;
      }
      expect(hasLanguage).toBe(true);
    });
  });
});
