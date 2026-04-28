/**
 * Tests for CloudEventForwarder (autonomy_v1.f1, Slice 5).
 *
 * Coverage:
 *   - Allow-list gating (Q1 LOCKED — opt-in via crewly.json).
 *   - Q5 LOCKED — dedicated forwarder-loop-prevention `it()` test (PR
 *     #354 N1 fence-at-test-surface pattern). Forwarder MUST short-
 *     circuit on `event.source === 'remote'`.
 *   - Fail-safe behaviour on malformed / missing config.
 *   - Stripping of cross-machine origin fields from the wire payload so
 *     the receiving bridge stamps them from the envelope.
 *   - Forward-on-broadcast happy path with allow-list override.
 *   - Lifecycle (idempotent start, clean stop).
 *
 * @module services/cloud/cloud-event-forwarder.service.test
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EventBusService } from '../event-bus/event-bus.service.js';
import {
	CloudEventForwarder,
	type CloudEventSender,
} from './cloud-event-forwarder.service.js';
import type { AgentEvent } from '../../types/event-bus.types.js';

// Match the project pattern for logger isolation.
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

/**
 * Build a minimum AgentEvent carrying enough fields for the forwarder to
 * publish + serialise. Tests override only what the assertion needs.
 */
function makeEvent(overrides?: Partial<AgentEvent>): AgentEvent {
	return {
		id: 'evt-1',
		type: 'xhs:scrape:done' as AgentEvent['type'],
		timestamp: '2026-04-28T01:44:12.345Z',
		teamId: 'team-marketing',
		teamName: 'Marketing',
		memberId: 'member-1',
		memberName: 'Iriss',
		sessionName: 'iriss-air-marketing',
		previousValue: '',
		newValue: 'done',
		changedField: 'workingStatus',
		...overrides,
	};
}

describe('CloudEventForwarder', () => {
	let eventBus: EventBusService;
	let cloudSync: CloudEventSender & { sendMessage: jest.Mock };
	let forwarder: CloudEventForwarder;

	beforeEach(() => {
		eventBus = new EventBusService();
		cloudSync = {
			sendMessage: jest.fn().mockResolvedValue(undefined),
		};
	});

	afterEach(() => {
		forwarder?.stop();
		eventBus.cleanup();
	});

	// -------------------------------------------------------------------------
	// Q5 LOCKED — dedicated forwarder-loop-prevention test
	// -------------------------------------------------------------------------

	it('Q5 LOCKED — does NOT forward events with source="remote" (loop-prevention fence)', async () => {
		// This is the dedicated `it()` per Arch verdict 2026-04-28 Q5 +
		// PR #354 N1 fence-at-test-surface pattern. Without the
		// `if (event.source === 'remote') return` short-circuit in
		// CloudEventForwarder.handle, the inbound bridge → forwarder pair
		// forms an infinite ping-pong loop. If anyone removes the fence,
		// THIS test fails immediately.
		forwarder = new CloudEventForwarder({
			cloudSync,
			eventBus,
			originDeviceId: 'device-A',
			projectPath: '/tmp/test-project-q5',
			allowListOverride: ['xhs:scrape:done'], // explicitly listed
		});
		await forwarder.start();

		// Simulate the inbound bridge re-publishing a remote event onto
		// the local bus. Even though its type is on the allow-list, the
		// forwarder MUST NOT re-broadcast it.
		eventBus.publish(makeEvent({
			source: 'remote',
			originDeviceId: 'device-B',
		}));

		// Allow microtasks to flush.
		await Promise.resolve();

		expect(cloudSync.sendMessage).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// Allow-list gating (Q1)
	// -------------------------------------------------------------------------

	describe('allow-list gating (Q1)', () => {
		it('forwards LOCAL events whose type is on the allow-list', async () => {
			forwarder = new CloudEventForwarder({
				cloudSync,
				eventBus,
				originDeviceId: 'device-A',
				originDeviceName: 'iriss-air',
				projectPath: '/tmp/test-project-allowed',
				allowListOverride: ['xhs:scrape:done'],
			});
			await forwarder.start();

			eventBus.publish(makeEvent());
			await Promise.resolve();

			expect(cloudSync.sendMessage).toHaveBeenCalledTimes(1);
			const [target, type, payload] = cloudSync.sendMessage.mock.calls[0];
			expect(target).toBe('*broadcast');
			expect(type).toBe('event');
			expect(payload.event.id).toBe('evt-1');
			expect(payload.event.type).toBe('xhs:scrape:done');
			expect(payload.originDeviceId).toBe('device-A');
			expect(payload.originDeviceName).toBe('iriss-air');
		});

		it('does NOT forward LOCAL events whose type is off the allow-list', async () => {
			forwarder = new CloudEventForwarder({
				cloudSync,
				eventBus,
				originDeviceId: 'device-A',
				projectPath: '/tmp/test-project-blocked',
				allowListOverride: ['xhs:scrape:done'], // not agent:idle
			});
			await forwarder.start();

			eventBus.publish(makeEvent({ type: 'agent:idle' as AgentEvent['type'] }));
			await Promise.resolve();

			expect(cloudSync.sendMessage).not.toHaveBeenCalled();
		});

		it('empty allow-list = no-op forwarder (no listeners attached)', async () => {
			forwarder = new CloudEventForwarder({
				cloudSync,
				eventBus,
				originDeviceId: 'device-A',
				projectPath: '/tmp/test-project-empty',
				allowListOverride: [],
			});
			await forwarder.start();

			eventBus.publish(makeEvent());
			await Promise.resolve();

			expect(cloudSync.sendMessage).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------------
	// Wire payload contract
	// -------------------------------------------------------------------------

	describe('wire payload', () => {
		it('strips source + originDeviceId off event before serialising (envelope owns those)', async () => {
			forwarder = new CloudEventForwarder({
				cloudSync,
				eventBus,
				originDeviceId: 'device-A',
				projectPath: '/tmp/test-project-strip',
				allowListOverride: ['xhs:scrape:done'],
			});
			await forwarder.start();

			// Local publish — defaults source='local' at publish.
			eventBus.publish(makeEvent());
			await Promise.resolve();

			const payload = cloudSync.sendMessage.mock.calls[0][2];
			expect(payload.event.source).toBeUndefined();
			expect(payload.event.originDeviceId).toBeUndefined();
			// Per-event metadata is preserved.
			expect(payload.event.timestamp).toBe('2026-04-28T01:44:12.345Z');
			expect(payload.event.sessionName).toBe('iriss-air-marketing');
		});

		it('passes through extra event fields the publisher sets (workItemId / missionId / requestId)', async () => {
			forwarder = new CloudEventForwarder({
				cloudSync,
				eventBus,
				originDeviceId: 'device-A',
				projectPath: '/tmp/test-project-passthrough',
				allowListOverride: ['xhs:scrape:done'],
			});
			await forwarder.start();

			eventBus.publish(
				makeEvent({
					workItemId: 'wi-77',
					missionId: 'mission-X',
					requestId: 'req-42',
				}),
			);
			await Promise.resolve();

			const payload = cloudSync.sendMessage.mock.calls[0][2];
			expect(payload.event.workItemId).toBe('wi-77');
			expect(payload.event.missionId).toBe('mission-X');
			expect(payload.event.requestId).toBe('req-42');
		});
	});

	// -------------------------------------------------------------------------
	// Allow-list resolution from crewly.json
	// -------------------------------------------------------------------------

	describe('crewly.json allow-list resolution', () => {
		let tmpDir: string;

		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forwarder-cfg-'));
		});

		afterEach(async () => {
			try {
				await fs.rm(tmpDir, { recursive: true, force: true });
			} catch {
				/* best-effort cleanup */
			}
		});

		it('reads `crossMachineEvents` array from crewly.json', async () => {
			await fs.writeFile(
				path.join(tmpDir, 'crewly.json'),
				JSON.stringify({ crossMachineEvents: ['xhs:scrape:done', 'agent:idle'] }),
			);

			forwarder = new CloudEventForwarder({
				cloudSync,
				eventBus,
				originDeviceId: 'device-A',
				projectPath: tmpDir,
			});
			await forwarder.start();

			eventBus.publish(makeEvent({ type: 'xhs:scrape:done' as AgentEvent['type'] }));
			eventBus.publish(makeEvent({
				id: 'evt-2',
				sessionName: 'agent-other', // avoid recent-publish suppression
				type: 'agent:idle' as AgentEvent['type'],
			}));
			await Promise.resolve();

			expect(cloudSync.sendMessage).toHaveBeenCalledTimes(2);
		});

		it('missing crewly.json → empty allow-list → no-op', async () => {
			forwarder = new CloudEventForwarder({
				cloudSync,
				eventBus,
				originDeviceId: 'device-A',
				projectPath: tmpDir, // no crewly.json written
			});
			await forwarder.start();

			eventBus.publish(makeEvent());
			await Promise.resolve();

			expect(cloudSync.sendMessage).not.toHaveBeenCalled();
		});

		it('malformed crewly.json (non-JSON) → empty allow-list → no-op (fail-safe)', async () => {
			await fs.writeFile(path.join(tmpDir, 'crewly.json'), 'not json {');

			forwarder = new CloudEventForwarder({
				cloudSync,
				eventBus,
				originDeviceId: 'device-A',
				projectPath: tmpDir,
			});
			await forwarder.start();

			eventBus.publish(makeEvent());
			await Promise.resolve();

			expect(cloudSync.sendMessage).not.toHaveBeenCalled();
		});

		it('crossMachineEvents present but not an array → empty allow-list → no-op (fail-safe)', async () => {
			await fs.writeFile(
				path.join(tmpDir, 'crewly.json'),
				JSON.stringify({ crossMachineEvents: 'xhs:scrape:done' }), // string not array
			);

			forwarder = new CloudEventForwarder({
				cloudSync,
				eventBus,
				originDeviceId: 'device-A',
				projectPath: tmpDir,
			});
			await forwarder.start();

			eventBus.publish(makeEvent());
			await Promise.resolve();

			expect(cloudSync.sendMessage).not.toHaveBeenCalled();
		});

		it('drops non-string entries from crossMachineEvents (forwarder still works for valid entries)', async () => {
			await fs.writeFile(
				path.join(tmpDir, 'crewly.json'),
				JSON.stringify({ crossMachineEvents: ['xhs:scrape:done', 42, null, ''] }),
			);

			forwarder = new CloudEventForwarder({
				cloudSync,
				eventBus,
				originDeviceId: 'device-A',
				projectPath: tmpDir,
			});
			await forwarder.start();

			eventBus.publish(makeEvent());
			await Promise.resolve();

			expect(cloudSync.sendMessage).toHaveBeenCalledTimes(1);
		});
	});

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	describe('lifecycle', () => {
		it('start() is idempotent — no double subscription', async () => {
			forwarder = new CloudEventForwarder({
				cloudSync,
				eventBus,
				originDeviceId: 'device-A',
				projectPath: '/tmp/test-idempotent',
				allowListOverride: ['xhs:scrape:done'],
			});
			await forwarder.start();
			await forwarder.start();
			await forwarder.start();

			eventBus.publish(makeEvent());
			await Promise.resolve();

			// Single subscription means single forward.
			expect(cloudSync.sendMessage).toHaveBeenCalledTimes(1);
		});

		it('stop() detaches all listeners — subsequent publishes do not forward', async () => {
			forwarder = new CloudEventForwarder({
				cloudSync,
				eventBus,
				originDeviceId: 'device-A',
				projectPath: '/tmp/test-stop',
				allowListOverride: ['xhs:scrape:done'],
			});
			await forwarder.start();
			forwarder.stop();

			eventBus.publish(makeEvent());
			await Promise.resolve();

			expect(cloudSync.sendMessage).not.toHaveBeenCalled();
		});

		it('isolates a sendMessage rejection — does not throw out of the event-bus dispatch', async () => {
			cloudSync.sendMessage.mockRejectedValueOnce(new Error('cloud outage'));
			forwarder = new CloudEventForwarder({
				cloudSync,
				eventBus,
				originDeviceId: 'device-A',
				projectPath: '/tmp/test-rejection',
				allowListOverride: ['xhs:scrape:done'],
			});
			await forwarder.start();

			expect(() => eventBus.publish(makeEvent())).not.toThrow();
			await Promise.resolve();
			await Promise.resolve(); // flush microtask for the awaited reject
		});
	});
});
