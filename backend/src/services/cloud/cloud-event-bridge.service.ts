/**
 * Cloud Event Inbound Bridge — autonomy_v1.f1
 *
 * Receives `'event'` MessageType inbound from the Cloud Relay (via the
 * existing CloudSyncService poll → `'message'` event-emitter hop) and
 * re-publishes the carried AgentEvent onto the local EventBusService with
 * `source = 'remote'` and `originDeviceId` stamped from the wire envelope.
 *
 * Compose-at-boundary discipline (per Arch verdict 2026-04-28 N1):
 *   - CloudSyncService stays a transport — it polls Cloud, dedupes by
 *     `processedMessageIds`, emits an in-process `'message'` event.
 *   - This service is the AgentEvent translator. It owns the bridge between
 *     the cloud message vocabulary (`MessageType` + `EventMessagePayload`)
 *     and the local event-bus vocabulary (`AgentEvent`). It does NOT touch
 *     the poll loop or the cloud transport.
 *
 * Mirrors the BRIDGE-1 ↔ EventBus separation pattern: CloudSync EMITS,
 * downstream LISTENS. Same shape as PR #347 (BrandOnboarding ⊥
 * OnboardingService) and PR #348 (StatusBadge ⊥ RequestStatusPill) where
 * two parallel modules share a single narrow artifact.
 *
 * Idempotency:
 *   The local LRU at CloudSyncService blocks at-least-once cloud-message-id
 *   re-delivery upstream. The recent-publish suppression in EventBusService
 *   (post-M2 fix: `${type}:${sessionName}:${event.id}`) catches any
 *   duplicate that slips through to the publish boundary. The TriggerEngine
 *   per-trigger dedup `${triggerId}:${event.id}` (Slice 3) is the third
 *   layer at the trigger fire boundary.
 *
 * Unknown peer event types (Arch Q4):
 *   The closed `EVENT_TYPES` enum stays closed. Bridge accepts any string
 *   at the wire boundary via `RemoteEventType = string` and casts to
 *   `EventType` at the local re-publish boundary so the rest of the
 *   pipeline sees a stable type. A debug log names any unrecognised type
 *   so ops can audit drift.
 *
 * @module services/cloud/cloud-event-bridge.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { formatError } from '../../utils/format-error.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type {
	AgentEvent,
	EventType,
	RemoteEventType,
} from '../../types/event-bus.types.js';
import { EVENT_TYPES } from '../../types/event-bus.types.js';
import {
	isEventMessagePayload,
	type IncomingMessage,
} from './cloud-sync.types.js';

/**
 * Minimum shape this bridge needs from the upstream cloud transport.
 * Defined locally rather than importing the full {@link CloudSyncService}
 * type so the bridge is unit-testable with a tiny mock and isn't coupled
 * to the whole transport surface.
 */
export interface CloudMessageEmitter {
	on(eventName: 'message', listener: (msg: IncomingMessage) => void): this;
	off(eventName: 'message', listener: (msg: IncomingMessage) => void): this;
}

/**
 * Constructor dependencies for the inbound bridge.
 */
export interface CloudEventInboundBridgeDeps {
	/** Cloud transport that emits 'message' events (CloudSyncService in prod). */
	cloudSync: CloudMessageEmitter;
	/** Local event bus the bridge publishes onto. */
	eventBus: EventBusService;
	/** Optional logger override (test isolation). */
	logger?: ComponentLogger;
}

/**
 * Bridges inbound cross-machine events from Cloud Relay → local EventBus.
 *
 * @example
 * ```typescript
 * const bridge = new CloudEventInboundBridge({
 *   cloudSync: CloudSyncService.getInstance(),
 *   eventBus: EventBusService.getInstance(),
 * });
 * bridge.start();
 * // ... later
 * bridge.stop();
 * ```
 */
export class CloudEventInboundBridge {
	private readonly logger: ComponentLogger;
	private readonly cloudSync: CloudMessageEmitter;
	private readonly eventBus: EventBusService;

	/**
	 * Bound listener kept so {@link stop} can detach it cleanly. Without
	 * this, repeated start/stop cycles (dev reloads, tests) would leak
	 * additional listeners.
	 */
	private listener: ((msg: IncomingMessage) => void) | null = null;

	/** Whether the bridge is currently subscribed. */
	private running = false;

	/**
	 * Construct the bridge. Subscription does NOT start until
	 * {@link start} is called explicitly so callers control lifecycle.
	 */
	constructor(deps: CloudEventInboundBridgeDeps) {
		this.cloudSync = deps.cloudSync;
		this.eventBus = deps.eventBus;
		this.logger =
			deps.logger ??
			LoggerService.getInstance().createComponentLogger('CloudEventInboundBridge');
	}

	/**
	 * Subscribe to the cloud transport's `'message'` event. Idempotent — a
	 * second `start()` call is a no-op.
	 */
	start(): void {
		if (this.running) return;
		this.listener = (msg: IncomingMessage) => {
			try {
				this.handle(msg);
			} catch (err) {
				// Defensive — handle() already swallows known failure modes,
				// but a thrown error here MUST NOT poison other 'message'
				// listeners on the cloud transport.
				this.logger.error('CloudEventInboundBridge handler threw', {
					error: formatError(err),
					messageId: msg?.id,
				});
			}
		};
		this.cloudSync.on('message', this.listener);
		this.running = true;
		this.logger.info('CloudEventInboundBridge started — listening for `event` MessageType');
	}

	/**
	 * Detach the cloud transport listener. Safe to call when not running.
	 */
	stop(): void {
		if (this.listener) {
			this.cloudSync.off('message', this.listener);
			this.listener = null;
		}
		this.running = false;
	}

	/**
	 * Process a single inbound cloud message. Filters on `type === 'event'`,
	 * validates the payload shape, then re-publishes the carried AgentEvent
	 * onto the local EventBus with `source = 'remote'` + `originDeviceId`.
	 *
	 * Public for unit tests only; production code should drive the bridge
	 * via the cloud transport's `'message'` event.
	 */
	public handle(msg: IncomingMessage): void {
		// Wrong type — leave it for the consumer that actually owns it
		// (CrossMachineMessageRouter, browser command handler, etc).
		if (msg.type !== 'event') {
			return;
		}

		if (!isEventMessagePayload(msg.payload)) {
			this.logger.warn('Dropping malformed cross-machine event payload', {
				messageId: msg.id,
				from: msg.from,
			});
			return;
		}

		const { event: wireEvent, originDeviceId, originDeviceName } = msg.payload;
		const remoteType: RemoteEventType = wireEvent.type;

		// Per Arch Q4: log when a peer ships a type we don't know locally.
		// We still re-publish — closed-enum sync would create a deployment-
		// ordering constraint we explicitly rejected.
		if (!isKnownEventType(remoteType)) {
			this.logger.debug(
				'Cross-machine event with unknown-to-local event type — accepting via RemoteEventType boundary',
				{
					messageId: msg.id,
					eventId: wireEvent.id,
					unknownType: remoteType,
					originDeviceId,
				},
			);
		}

		// Build the AgentEvent. Wire payload may carry extra fields the
		// origin device knew about (e.g. workItemId, missionId, requestId)
		// — pass them through unchanged. Our bridge only stamps the two
		// origin-tag fields.
		const agentEvent: AgentEvent = {
			...(wireEvent as unknown as AgentEvent),
			// Cast at the boundary per Arch Q4. Closed `EVENT_TYPES` enum
			// stays closed; downstream consumers see a stable EventType.
			type: remoteType as EventType,
			source: 'remote',
			originDeviceId,
		};

		this.logger.info('Re-publishing cross-machine event onto local EventBus', {
			messageId: msg.id,
			eventId: agentEvent.id,
			eventType: agentEvent.type,
			originDeviceId,
			originDeviceName,
		});

		this.eventBus.publish(agentEvent);
	}
}

/**
 * Internal helper — true when the wire event-type matches the closed
 * `EVENT_TYPES` enum. Used only for the debug-log breadcrumb; does NOT
 * gate re-publish (per Arch Q4).
 */
function isKnownEventType(value: string): boolean {
	return (EVENT_TYPES as readonly string[]).includes(value);
}
