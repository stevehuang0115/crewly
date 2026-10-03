/**
 * Tests for DeferredIdleSettle.
 */

import { DeferredIdleSettle } from './deferred-idle-settle.js';

/**
 * Harness with a manual clock and timer list.
 *
 * @param state - Mutable agent state
 * @returns Service, settled list, timers and clock
 */
function harness(state: { background: boolean; midTurn: boolean }) {
	const clock = { t: 0 };
	const timers: Array<() => void> = [];
	const settled: string[] = [];
	const service = new DeferredIdleSettle({
		hasBackgroundWork: () => state.background,
		isMidTurn: () => state.midTurn,
		settle: (s) => settled.push(s),
		intervalMs: 60_000,
		maxWaitMs: 600_000,
		now: () => clock.t,
		setTimer: (fn) => {
			timers.push(fn);
			return timers.length;
		},
		clearTimer: () => undefined,
	});
	/** Advance the clock and fire the newest timer. */
	const tick = (): void => {
		clock.t += 60_000;
		timers.pop()?.();
	};
	return { service, settled, timers, clock, tick };
}

describe('DeferredIdleSettle', () => {
	it('settles once the background work is gone (placeholders do not stay up forever)', () => {
		const state = { background: true, midTurn: false };
		const h = harness(state);
		h.service.defer('eve');
		h.service.defer('eve');
		expect(h.timers).toHaveLength(1);
		h.tick();
		expect(h.settled).toEqual([]);
		state.background = false;
		h.tick();
		expect(h.settled).toEqual(['eve']);
		expect(h.service.size).toBe(0);
	});

	it('stops without settling when the work came back as a new turn', () => {
		const state = { background: false, midTurn: true };
		const h = harness(state);
		h.service.defer('eve');
		h.tick();
		expect(h.settled).toEqual([]);
		expect(h.service.size).toBe(0);
	});

	it('settles after the cap even if background work never reports back', () => {
		const state = { background: true, midTurn: false };
		const h = harness(state);
		h.service.defer('eve');
		for (let i = 0; i < 10; i++) h.tick();
		expect(h.settled).toEqual(['eve']);
	});

	it('cancel drops the re-check; a throwing check settles', () => {
		const state = { background: true, midTurn: false };
		const h = harness(state);
		h.service.defer('eve');
		h.service.cancel('eve');
		h.tick();
		expect(h.settled).toEqual([]);
		const throwing = new DeferredIdleSettle({
			hasBackgroundWork: () => {
				throw new Error('x');
			},
			isMidTurn: () => false,
			settle: (s) => h.settled.push(s),
			intervalMs: 1,
			maxWaitMs: 1,
			setTimer: () => 0,
			clearTimer: () => undefined,
		});
		throwing.defer('a');
		throwing.check('a');
		expect(h.settled).toEqual(['a']);
	});

	describe('onIdle (the agent:idle handler)', () => {
		it('defers on a turn verdict: nothing settles mid-turn (PR #1013 review)', () => {
			const state = { background: false, midTurn: true };
			const h = harness(state);
			expect(h.service.onIdle('eve')).toBe('turn');
			expect(h.settled).toEqual([]);
			expect(h.service.size).toBe(1);
			// Still mid-turn at the re-check: that turn's own end settles.
			h.tick();
			expect(h.settled).toEqual([]);
			expect(h.service.size).toBe(0);
			// The real turn end.
			state.midTurn = false;
			expect(h.service.onIdle('eve')).toBe('settled');
			expect(h.settled).toEqual(['eve']);
		});

		it('defers on a background verdict', () => {
			const h = harness({ background: true, midTurn: false });
			expect(h.service.onIdle('eve')).toBe('background');
			expect(h.settled).toEqual([]);
			expect(h.service.size).toBe(1);
		});

		it('settles now and cancels a pending re-check on a real turn end', () => {
			const state = { background: true, midTurn: false };
			const h = harness(state);
			h.service.onIdle('eve');
			state.background = false;
			expect(h.service.onIdle('eve')).toBe('settled');
			expect(h.settled).toEqual(['eve']);
			expect(h.service.size).toBe(0);
		});

		it('settles when the runtime check throws', () => {
			const settled: string[] = [];
			const s = new DeferredIdleSettle({
				hasBackgroundWork: () => {
					throw new Error('x');
				},
				isMidTurn: () => true,
				settle: (n) => settled.push(n),
				intervalMs: 1,
				maxWaitMs: 1,
				setTimer: () => 0,
				clearTimer: () => undefined,
			});
			expect(s.onIdle('a')).toBe('settled');
			expect(settled).toEqual(['a']);
		});
	});
});
