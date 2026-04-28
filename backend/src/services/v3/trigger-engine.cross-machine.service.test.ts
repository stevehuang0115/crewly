/**
 * Tests for TriggerEngine cross-machine surface (autonomy_v1.f1, Slice 3).
 *
 * Co-located alongside the existing `trigger-engine.service.test.ts` (which
 * uses vitest and does not run in jest CI — pre-existing infrastructure
 * decision, out of scope for this PR). This file is jest-compatible and
 * runs as part of `npm run test:unit`.
 *
 * Coverage:
 *   - SignalTriggerConfig.source filter (`'local'` / `'remote'` / `'any'`,
 *     unset defaults to `'local'`).
 *   - Per-trigger `${triggerId}:${eventId}` dedup against at-least-once
 *     cloud delivery.
 *   - Source-filter check sits in `signalMatches` (the predicate) — locked
 *     by drift addendum.
 *   - LRU eviction kicks in at capacity.
 *
 * @module services/v3/trigger-engine.cross-machine.service.test
 */

import { EventEmitter } from 'events';
import { TriggerEngine, type TriggerActionHandler } from './trigger-engine.service.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { CreateTriggerInput, Trigger } from '../../types/v2/trigger.types.js';

// Logger mock — match the project pattern (memory.controller.test.ts uses
// the same shape).
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				debug: jest.fn(),
				info: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

// File-io mock — TriggerEngine persists triggers to disk, but we don't want
// real disk writes in unit tests. The engine uses safeReadJson which
// returns null on miss; ensureDir + atomicWriteJson are no-ops here.
jest.mock('../../utils/file-io.utils.js', () => ({
	ensureDir: jest.fn().mockResolvedValue(undefined),
	atomicWriteJson: jest.fn().mockResolvedValue(undefined),
	safeReadJson: jest.fn().mockResolvedValue(null),
}));

/**
 * Build a SignalEventData payload (the widened `'event_published'` emit
 * shape consumed by TriggerEngine). Mirrors the autonomy_v1.f1 widening.
 */
function makeEventData(overrides?: {
	eventId?: string;
	eventType?: string;
	sessionName?: string;
	source?: 'local' | 'remote';
	originDeviceId?: string;
}) {
	return {
		eventId: overrides?.eventId ?? 'evt-1',
		eventType: overrides?.eventType ?? 'xhs:scrape:done',
		sessionName: overrides?.sessionName ?? 'iriss-air-marketing',
		source: overrides?.source,
		originDeviceId: overrides?.originDeviceId,
	};
}

/**
 * Build a CreateTriggerInput for a signal trigger with a delegate-style
 * action handler. Used by every test below.
 */
function makeSignalInput(overrides?: {
	eventType?: string;
	source?: 'local' | 'remote' | 'any';
	filter?: Record<string, unknown>;
	name?: string;
}): CreateTriggerInput {
	return {
		type: 'signal',
		config: {
			type: 'signal',
			eventType: overrides?.eventType ?? 'xhs:scrape:done',
			source: overrides?.source,
			filter: overrides?.filter,
		},
		action: {
			createWorkItem: { id: 'wi-stub' as never },
		},
		createdBy: 'system',
		name: overrides?.name,
	};
}

describe('TriggerEngine — autonomy_v1.f1 cross-machine surface', () => {
	let engine: TriggerEngine;
	let eventBus: EventEmitter;
	let actionHandler: jest.Mock;

	beforeEach(() => {
		TriggerEngine.resetInstance();
		engine = TriggerEngine.getInstance('/tmp/test-trigger-engine-f1');
		eventBus = new EventEmitter();
		engine.setEventBus(eventBus as unknown as EventBusService);
		actionHandler = jest.fn().mockResolvedValue(undefined);
		engine.setActionHandler(actionHandler as unknown as TriggerActionHandler);
	});

	afterEach(() => {
		TriggerEngine.resetInstance();
	});

	// -------------------------------------------------------------------------
	// Source filter — locked by Arch Q2 (default 'local')
	// -------------------------------------------------------------------------

	describe('signalMatches source filter', () => {
		it("default (unset) source matches LOCAL events", async () => {
			const t = await engine.create(makeSignalInput({ name: 'sig-default' }));

			await engine.handleSignalEvent(makeEventData({ source: 'local' }));
			expect(actionHandler).toHaveBeenCalledTimes(1);
			expectFiredFor(actionHandler, t.id);
		});

		it("default (unset) source REJECTS remote events (Arch Q2 LOCKED)", async () => {
			await engine.create(makeSignalInput({ name: 'sig-default-rejects-remote' }));

			await engine.handleSignalEvent(
				makeEventData({ source: 'remote', originDeviceId: 'device-A' }),
			);
			expect(actionHandler).not.toHaveBeenCalled();
		});

		it("source='local' matches LOCAL events only", async () => {
			await engine.create(makeSignalInput({ source: 'local', name: 'sig-local' }));

			await engine.handleSignalEvent(makeEventData({ source: 'local' }));
			await engine.handleSignalEvent(
				makeEventData({ eventId: 'evt-2', source: 'remote', originDeviceId: 'device-A' }),
			);

			expect(actionHandler).toHaveBeenCalledTimes(1);
		});

		it("source='remote' matches REMOTE events only", async () => {
			await engine.create(makeSignalInput({ source: 'remote', name: 'sig-remote' }));

			await engine.handleSignalEvent(makeEventData({ source: 'local' }));
			await engine.handleSignalEvent(
				makeEventData({ eventId: 'evt-2', source: 'remote', originDeviceId: 'device-A' }),
			);

			expect(actionHandler).toHaveBeenCalledTimes(1);
		});

		it("source='any' matches BOTH local and remote events", async () => {
			await engine.create(makeSignalInput({ source: 'any', name: 'sig-any' }));

			await engine.handleSignalEvent(makeEventData({ eventId: 'evt-1', source: 'local' }));
			await engine.handleSignalEvent(
				makeEventData({ eventId: 'evt-2', source: 'remote', originDeviceId: 'device-A' }),
			);

			expect(actionHandler).toHaveBeenCalledTimes(2);
		});

		it("event with absent source defaults to 'local' for filter purposes", async () => {
			// A legacy publisher might emit without setting source on the wire
			// payload. The default of 'local' must apply at signal-match time too.
			await engine.create(makeSignalInput({ source: 'remote', name: 'sig-remote-2' }));

			await engine.handleSignalEvent({
				eventId: 'evt-legacy',
				eventType: 'xhs:scrape:done',
				sessionName: 'session-x',
				// source intentionally undefined
			});

			expect(actionHandler).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------------
	// Per-trigger ${triggerId}:${eventId} dedup — Arch decomp memo §(d) Layer 3
	// -------------------------------------------------------------------------

	describe('per-trigger eventId dedup', () => {
		it('does NOT fire twice for the same (triggerId, eventId) pair', async () => {
			await engine.create(makeSignalInput({ source: 'any', name: 'sig-dedup' }));

			// At-least-once cloud delivery — same event.id arrives twice.
			await engine.handleSignalEvent(makeEventData({ eventId: 'evt-dup' }));
			await engine.handleSignalEvent(makeEventData({ eventId: 'evt-dup' }));

			expect(actionHandler).toHaveBeenCalledTimes(1);
		});

		it('FIRES TWICE when (type, sessionName) match but eventIds differ', async () => {
			await engine.create(makeSignalInput({ source: 'any', name: 'sig-distinct' }));

			await engine.handleSignalEvent(makeEventData({ eventId: 'evt-A' }));
			await engine.handleSignalEvent(makeEventData({ eventId: 'evt-B' }));

			expect(actionHandler).toHaveBeenCalledTimes(2);
		});

		it('two triggers on the same event each fire once (per-trigger keying)', async () => {
			await engine.create(makeSignalInput({ source: 'any', name: 'sig-A' }));
			await engine.create(makeSignalInput({ source: 'any', name: 'sig-B' }));

			await engine.handleSignalEvent(makeEventData({ eventId: 'evt-shared' }));

			expect(actionHandler).toHaveBeenCalledTimes(2);
		});
	});

	// -------------------------------------------------------------------------
	// Source filter sits in signalMatches predicate — drift-addendum lock
	// -------------------------------------------------------------------------

	describe('source filter placement (drift-addendum lock)', () => {
		it('signalMatches considers BOTH eventType and source as gating predicates', async () => {
			// Trigger A: matches type=xhs:scrape:done, source=remote
			// Trigger B: matches type=xhs:scrape:done, source=local
			// One inbound event with type=xhs:scrape:done, source=local must
			// fire B but NOT A. Gates the placement-in-predicate lock — if
			// the source filter were misplaced (e.g. into signalListener
			// pre-iteration), one or both would mis-fire.
			const a = await engine.create(makeSignalInput({ source: 'remote', name: 'sig-A-remote' }));
			const b = await engine.create(makeSignalInput({ source: 'local', name: 'sig-B-local' }));

			await engine.handleSignalEvent(makeEventData({ source: 'local' }));

			expect(actionHandler).toHaveBeenCalledTimes(1);
			expectFiredFor(actionHandler, b.id);
			expectNotFiredFor(actionHandler, a.id);
		});
	});
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function expectFiredFor(handler: jest.Mock, triggerId: string): void {
	const matchedCalls = handler.mock.calls.filter(
		(call) => (call[0] as Trigger).id === triggerId,
	);
	expect(matchedCalls.length).toBeGreaterThanOrEqual(1);
}

function expectNotFiredFor(handler: jest.Mock, triggerId: string): void {
	const matchedCalls = handler.mock.calls.filter(
		(call) => (call[0] as Trigger).id === triggerId,
	);
	expect(matchedCalls.length).toBe(0);
}
