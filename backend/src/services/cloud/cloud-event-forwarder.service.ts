/**
 * Cloud Event Outbound Forwarder — autonomy_v1.f1
 *
 * Closes the bidirectional cross-machine event loop. Subscribes to the
 * local EventBusService for events whose type is on an OPT-IN allow-list
 * (read from `crewly.json` at project root, key `crossMachineEvents`) and
 * forwards each via `cloudSync.sendMessage(broadcast, 'event', payload)`
 * so paired devices receive them at their inbound bridge.
 *
 * Forwarder discipline (per Arch verdict 2026-04-28):
 *   - **Q1 LOCKED — OPT-IN allow-list.** v1 forwards ONLY events whose
 *     type is explicitly listed in `crewly.json` `crossMachineEvents`.
 *     Reasons: privacy (avoid leaking internal events to peers), payload
 *     bloat, per-paired-device DoS-source containment. Empty allow-list
 *     → forwarder is a no-op.
 *   - **Q5 LOCKED — Loop-prevention fence.** The forwarder MUST short-
 *     circuit on `event.source === 'remote'`. Otherwise the inbound
 *     bridge re-publishes a remote event onto the local EventBus, the
 *     forwarder picks it up, ships it back to cloud, cloud fans it out
 *     again, etc. The fence is locked at the test surface via a
 *     dedicated `it()` (PR #354 N1 fence-at-test-surface pattern).
 *   - **Fail-safe on config.** Malformed `crewly.json`, missing file, or
 *     non-array `crossMachineEvents` → forwarder defaults to no-op (NOT
 *     "forward everything"). Surfaces an error log so ops can spot the
 *     misconfiguration without leaking events accidentally.
 *
 * Compose-at-boundary discipline (Arch N1, mirrors the inbound bridge):
 *   - CloudSyncService stays a transport — the forwarder calls
 *     `sendMessage` and that's the only coupling point.
 *   - This forwarder is a NEW file at the same boundary level as
 *     `cloud-event-bridge.service.ts`. Inbound and outbound bridges are
 *     symmetric.
 *
 * @module services/cloud/cloud-event-forwarder.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { formatError } from '../../utils/format-error.js';
import type { EventBusService, InProcessUnsubscribe } from '../event-bus/event-bus.service.js';
import type {
	AgentEvent,
	EventType,
} from '../../types/event-bus.types.js';
import type { EventMessagePayload } from './cloud-sync.types.js';

/**
 * Minimum cloud transport surface needed for outbound. Defined locally
 * (mirrors `CloudMessageEmitter` in the inbound bridge) so the test mock
 * is tiny and the forwarder is not coupled to the entire CloudSyncService.
 */
export interface CloudEventSender {
	/**
	 * Broadcast an `'event'` MessageType to all paired devices in the same
	 * tenant. Cloud Relay handles the fan-out (web/ ticket).
	 *
	 * For v1 we use a sentinel deviceId `'*broadcast'` per the cloud
	 * contract spec §(c). Future v2 may add per-event subscription
	 * routing, in which case the call site here changes; the contract
	 * field shape is forward-compatible.
	 */
	sendMessage(toDeviceId: string, type: 'event', payload: EventMessagePayload): Promise<void>;
}

/**
 * Constructor dependencies for the outbound forwarder.
 */
export interface CloudEventForwarderDeps {
	/** Cloud transport for `sendMessage` (CloudSyncService in prod). */
	cloudSync: CloudEventSender;
	/** Local event bus the forwarder subscribes to. */
	eventBus: EventBusService;
	/** Origin device identity stamped onto every outbound payload. */
	originDeviceId: string;
	/** Optional human-readable origin device name (for log lines on the peer). */
	originDeviceName?: string;
	/** Project root used to resolve `crewly.json`. */
	projectPath: string;
	/**
	 * Optional override for the allow-list. When provided, the forwarder
	 * uses this instead of reading `crewly.json`. Test injection only.
	 */
	allowListOverride?: ReadonlyArray<string>;
	/** Optional logger override (test isolation). */
	logger?: ComponentLogger;
}

/** Sentinel for "fan out to every paired device in the tenant". */
const BROADCAST_TARGET = '*broadcast';

/**
 * Forwards local AgentEvents to paired devices via Cloud Relay when their
 * type is on the configured allow-list.
 */
export class CloudEventForwarder {
	private readonly logger: ComponentLogger;
	private readonly cloudSync: CloudEventSender;
	private readonly eventBus: EventBusService;
	private readonly originDeviceId: string;
	private readonly originDeviceName?: string;
	private readonly projectPath: string;
	private readonly allowListOverride?: ReadonlyArray<string>;

	/** Resolved allow-list of event types. Empty = forwarder is a no-op. */
	private allowList: ReadonlySet<string> = new Set();

	/** Detach functions returned by EventBusService.onInProcess(). */
	private unsubscribers: InProcessUnsubscribe[] = [];

	/** Whether the forwarder is currently subscribed. */
	private running = false;

	constructor(deps: CloudEventForwarderDeps) {
		this.cloudSync = deps.cloudSync;
		this.eventBus = deps.eventBus;
		this.originDeviceId = deps.originDeviceId;
		this.originDeviceName = deps.originDeviceName;
		this.projectPath = deps.projectPath;
		this.allowListOverride = deps.allowListOverride;
		this.logger =
			deps.logger ??
			LoggerService.getInstance().createComponentLogger('CloudEventForwarder');
	}

	/**
	 * Load the allow-list and subscribe to the event bus. Idempotent.
	 *
	 * The forwarder uses {@link EventBusService.onInProcess} per
	 * registered allow-list type so it receives FULL `AgentEvent` payloads
	 * (including the `source` field needed for the loop-prevention fence).
	 * The widened `'event_published'` emit payload would also work but is
	 * stripped of optional fields the wire payload needs (e.g. workItemId,
	 * missionId).
	 */
	async start(): Promise<void> {
		if (this.running) return;

		this.allowList = await this.resolveAllowList();
		if (this.allowList.size === 0) {
			this.logger.info(
				'CloudEventForwarder allow-list is empty — forwarder will be a no-op until configured',
				{ projectPath: this.projectPath },
			);
			this.running = true;
			return;
		}

		for (const eventType of this.allowList) {
			const unsub = this.eventBus.onInProcess(
				[eventType as EventType],
				(event) => this.handle(event),
			);
			this.unsubscribers.push(unsub);
		}

		this.running = true;
		this.logger.info('CloudEventForwarder started', {
			allowList: Array.from(this.allowList),
			originDeviceId: this.originDeviceId,
		});
	}

	/**
	 * Detach all event-bus listeners. Safe to call when not running.
	 */
	stop(): void {
		for (const unsub of this.unsubscribers) {
			try {
				unsub();
			} catch (err) {
				this.logger.warn('CloudEventForwarder unsubscribe threw', { error: formatError(err) });
			}
		}
		this.unsubscribers = [];
		this.running = false;
	}

	/**
	 * Process a single local event — forward to cloud if eligible.
	 *
	 * Public for unit tests only; production drives this via the
	 * EventBusService.onInProcess subscription installed in {@link start}.
	 */
	public async handle(event: AgentEvent): Promise<void> {
		// Q5 LOCKED — loop-prevention fence. NEVER forward an event that
		// itself arrived from cloud. Without this, the inbound bridge ↔
		// forwarder pair would form an infinite ping-pong loop.
		if (event.source === 'remote') {
			return;
		}

		// Allow-list gate (Q1 LOCKED).
		if (!this.allowList.has(event.type)) {
			return;
		}

		const payload: EventMessagePayload = {
			event: {
				id: event.id,
				type: event.type,
				sessionName: event.sessionName,
				timestamp: event.timestamp,
				// Pass through the rest of the AgentEvent so the inbound
				// bridge on the peer device sees the full picture (workItemId,
				// missionId, requestId, etc.). `source` and `originDeviceId`
				// are NOT included — the receiving bridge stamps those from
				// the message envelope so the contract stays symmetric.
				...stripCrossMachineFields(event),
			},
			originDeviceId: this.originDeviceId,
			originDeviceName: this.originDeviceName,
		};

		try {
			await this.cloudSync.sendMessage(BROADCAST_TARGET, 'event', payload);
			this.logger.debug('CloudEventForwarder broadcast', {
				eventId: event.id,
				eventType: event.type,
			});
		} catch (err) {
			// Failure is non-fatal — local processing already happened. We
			// log + drop. A future enhancement could buffer + retry, but v1
			// trusts the cloud queue's TTL semantics (see decomp §(c)
			// errors table).
			this.logger.warn('CloudEventForwarder broadcast failed', {
				eventId: event.id,
				eventType: event.type,
				error: formatError(err),
			});
		}
	}

	/**
	 * Resolve the allow-list. Order:
	 *   1. `allowListOverride` (test injection).
	 *   2. `<projectPath>/crewly.json` `crossMachineEvents` array.
	 *   3. Empty (no-op forwarder) — fail-safe default.
	 *
	 * Malformed JSON or non-array `crossMachineEvents` → empty + error log.
	 * NEVER defaults to "forward everything" — privacy + DoS containment.
	 */
	private async resolveAllowList(): Promise<ReadonlySet<string>> {
		if (this.allowListOverride) {
			return new Set(this.allowListOverride);
		}

		const configPath = path.join(this.projectPath, 'crewly.json');
		try {
			const raw = await fs.readFile(configPath, 'utf-8');
			const parsed = JSON.parse(raw) as { crossMachineEvents?: unknown };
			const value = parsed.crossMachineEvents;
			if (value === undefined || value === null) return new Set();
			if (!Array.isArray(value)) {
				this.logger.error(
					'crewly.json `crossMachineEvents` must be an array — falling back to empty allow-list (no events will forward)',
					{ configPath, actualType: typeof value },
				);
				return new Set();
			}
			const cleaned = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
			if (cleaned.length !== value.length) {
				this.logger.warn(
					'crewly.json `crossMachineEvents` contains non-string entries — dropped',
					{ configPath, kept: cleaned, droppedCount: value.length - cleaned.length },
				);
			}
			return new Set(cleaned);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') {
				// File simply doesn't exist — silent default to empty.
				return new Set();
			}
			this.logger.error(
				'Failed to read crewly.json — falling back to empty allow-list (no events will forward)',
				{ configPath, error: formatError(err) },
			);
			return new Set();
		}
	}
}

/**
 * Strip the cross-machine origin fields off an event before serialising
 * onto the wire. The receiving bridge stamps `source` + `originDeviceId`
 * from the message envelope — including them in the payload would let
 * the wire mutate them mid-flight.
 */
function stripCrossMachineFields(event: AgentEvent): Record<string, unknown> {
	// Shallow copy + drop the two fields. `id`, `type`, `sessionName`,
	// `timestamp` are added back explicitly by the caller (above) so we
	// don't double-spread them.
	const out: Record<string, unknown> = { ...(event as unknown as Record<string, unknown>) };
	delete out.source;
	delete out.originDeviceId;
	delete out.id;
	delete out.type;
	delete out.sessionName;
	delete out.timestamp;
	return out;
}
