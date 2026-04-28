/**
 * Tests for CloudEventInboundBridge (autonomy_v1.f1, Arch N1 file separation).
 *
 * Verifies that inbound `'event'` MessageType messages on the cloud transport
 * are translated into local AgentEvents stamped with `source: 'remote'` +
 * `originDeviceId` and re-published onto the EventBus, while:
 *   - non-`event` MessageTypes are ignored,
 *   - malformed `EventMessagePayload` is dropped with a warn log,
 *   - unknown-to-local peer event types are accepted via the
 *     `RemoteEventType = string` boundary cast (Arch Q4) without widening
 *     the closed `EVENT_TYPES` enum,
 *   - start/stop is idempotent and detaches the cloud listener cleanly.
 *
 * @module services/cloud/cloud-event-bridge.service.test
 */

import { EventEmitter } from 'events';
import {
	CloudEventInboundBridge,
	type CloudMessageEmitter,
} from './cloud-event-bridge.service.js';
import type { IncomingMessage } from './cloud-sync.types.js';
import type { AgentEvent } from '../../types/event-bus.types.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';

// Mock the logger module so the bridge constructor can fall back to its
// default logger without booting the full LoggerService singleton.
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
 * Build a minimum IncomingMessage with an EventMessagePayload body.
 */
function makeEventMessage(overrides?: {
	id?: string;
	from?: string;
	event?: Partial<AgentEvent>;
	originDeviceId?: string;
	originDeviceName?: string;
}): IncomingMessage {
	const event = {
		id: 'evt-uuid-1',
		type: 'xhs:scrape:done',
		sessionName: 'iriss-air-marketing',
		timestamp: '2026-04-28T01:44:12.345Z',
		teamId: 'team-marketing',
		teamName: 'Marketing',
		memberId: 'member-1',
		memberName: 'Iriss',
		previousValue: '',
		newValue: 'done',
		changedField: 'workingStatus',
		...(overrides?.event ?? {}),
	};

	return {
		id: overrides?.id ?? 'cloud-msg-1',
		from: overrides?.from ?? 'device-A',
		fromDeviceName: overrides?.originDeviceName ?? 'iriss-air',
		type: 'event',
		payload: {
			event,
			originDeviceId: overrides?.originDeviceId ?? 'device-A',
			originDeviceName: overrides?.originDeviceName ?? 'iriss-air',
		},
		encrypted: false,
		sentAt: '2026-04-28T01:44:12.345Z',
	};
}

describe('CloudEventInboundBridge', () => {
	let cloudSync: EventEmitter;
	let eventBus: { publish: jest.Mock };
	let bridge: CloudEventInboundBridge;

	beforeEach(() => {
		cloudSync = new EventEmitter();
		eventBus = { publish: jest.fn() };
		bridge = new CloudEventInboundBridge({
			cloudSync: cloudSync as unknown as CloudMessageEmitter,
			eventBus: eventBus as unknown as EventBusService,
		});
	});

	afterEach(() => {
		bridge.stop();
		cloudSync.removeAllListeners();
	});

	describe('start / stop lifecycle', () => {
		it('subscribes to the cloud transport on start', () => {
			expect(cloudSync.listenerCount('message')).toBe(0);
			bridge.start();
			expect(cloudSync.listenerCount('message')).toBe(1);
		});

		it('start() is idempotent (no listener leak)', () => {
			bridge.start();
			bridge.start();
			bridge.start();
			expect(cloudSync.listenerCount('message')).toBe(1);
		});

		it('stop() detaches the listener', () => {
			bridge.start();
			bridge.stop();
			expect(cloudSync.listenerCount('message')).toBe(0);
		});

		it('stop() before start() is a no-op', () => {
			expect(() => bridge.stop()).not.toThrow();
		});
	});

	describe('inbound event re-publishing', () => {
		beforeEach(() => bridge.start());

		it("re-publishes an 'event' MessageType onto EventBus with source='remote' + originDeviceId", () => {
			cloudSync.emit('message', makeEventMessage());

			expect(eventBus.publish).toHaveBeenCalledTimes(1);
			const published = eventBus.publish.mock.calls[0][0] as AgentEvent;
			expect(published.id).toBe('evt-uuid-1');
			expect(published.type).toBe('xhs:scrape:done');
			expect(published.sessionName).toBe('iriss-air-marketing');
			expect(published.source).toBe('remote');
			expect(published.originDeviceId).toBe('device-A');
		});

		it('passes through extra event fields the origin device set (e.g. workItemId, missionId)', () => {
			cloudSync.emit(
				'message',
				makeEventMessage({
					event: {
						workItemId: 'wi-123',
						missionId: 'mission-A',
						requestId: 'req-77',
					},
				}),
			);

			const published = eventBus.publish.mock.calls[0][0] as AgentEvent;
			expect(published.workItemId).toBe('wi-123');
			expect(published.missionId).toBe('mission-A');
			expect(published.requestId).toBe('req-77');
		});

		it('preserves origin sessionName (does NOT prepend deviceId per Arch Q3)', () => {
			cloudSync.emit(
				'message',
				makeEventMessage({
					originDeviceId: 'device-A',
					event: { sessionName: 'pristine-session-name' },
				}),
			);

			const published = eventBus.publish.mock.calls[0][0] as AgentEvent;
			// sessionName is the bare origin value — disambiguation by origin
			// device is via EventFilter.originDeviceId, not by mutating
			// sessionName.
			expect(published.sessionName).toBe('pristine-session-name');
			expect(published.originDeviceId).toBe('device-A');
		});

		it('accepts unknown-to-local event types via RemoteEventType boundary cast (Arch Q4)', () => {
			cloudSync.emit(
				'message',
				makeEventMessage({
					event: { type: 'peer:future:event:type' as unknown as AgentEvent['type'] },
				}),
			);

			expect(eventBus.publish).toHaveBeenCalledTimes(1);
			const published = eventBus.publish.mock.calls[0][0] as AgentEvent;
			expect(published.type).toBe('peer:future:event:type');
		});

		it('ignores non-event MessageTypes (no publish)', () => {
			const otherMsg: IncomingMessage = {
				id: 'cloud-msg-2',
				from: 'device-B',
				fromDeviceName: 'other',
				type: 'agent_message',
				payload: { targetSession: 'agent-x', message: 'hi', fromDevice: 'device-B', fromDeviceName: 'other' },
				encrypted: false,
				sentAt: '2026-04-28T01:44:12.345Z',
			};
			cloudSync.emit('message', otherMsg);

			expect(eventBus.publish).not.toHaveBeenCalled();
		});

		it('drops malformed EventMessagePayload without throwing or publishing', () => {
			const badMsg: IncomingMessage = {
				id: 'cloud-msg-3',
				from: 'device-A',
				fromDeviceName: 'iriss-air',
				type: 'event',
				payload: {
					// missing originDeviceId
					event: { id: 'evt-9', type: 't', sessionName: 's', timestamp: 'now' },
				},
				encrypted: false,
				sentAt: 'now',
			};
			expect(() => cloudSync.emit('message', badMsg)).not.toThrow();
			expect(eventBus.publish).not.toHaveBeenCalled();
		});

		it('drops payload whose event lacks a non-empty id', () => {
			const badMsg: IncomingMessage = {
				id: 'cloud-msg-4',
				from: 'device-A',
				fromDeviceName: 'iriss-air',
				type: 'event',
				payload: {
					event: { id: '', type: 'xhs:scrape:done', sessionName: 's', timestamp: 'now' },
					originDeviceId: 'device-A',
				},
				encrypted: false,
				sentAt: 'now',
			};
			cloudSync.emit('message', badMsg);
			expect(eventBus.publish).not.toHaveBeenCalled();
		});

		it('isolates a thrown publish error from the cloud listener (does not leak)', () => {
			eventBus.publish.mockImplementationOnce(() => {
				throw new Error('publish blew up');
			});
			expect(() => cloudSync.emit('message', makeEventMessage())).not.toThrow();
		});

		it('is idempotent across start cycles — second start re-uses the same single listener', () => {
			bridge.stop();
			bridge.start();
			bridge.start();
			cloudSync.emit('message', makeEventMessage({ id: 'cloud-msg-cycle' }));
			// Exactly one publish — listener didn't double-up.
			expect(eventBus.publish).toHaveBeenCalledTimes(1);
		});
	});
});
