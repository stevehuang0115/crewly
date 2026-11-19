/**
 * Carries the owner's answer to the Bypass Permissions question between the
 * machines of one account, over the Cloud relay queue.
 *
 * The owner's DM with the Crewly bot is shared by every machine of the
 * account, and Cloud delivers a message there to the primary machine only. A
 * machine that asked the question (runtime-consent.service.ts) but is not the
 * primary would never hear the answer. The machine that does hear it sends an
 * `owner_consent_reply` to the others; the one that is waiting applies it and
 * sends a confirmation back.
 *
 * @module services/harness/runtime-consent.relay
 */

import { RUNTIME_CONSENT_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import type { ReloginReplyTarget } from './harness-relogin.service.js';
import type { ConsentReply, ConsentSiblingRelay, RuntimeConsentService } from './runtime-consent.service.js';

/** What travels on the relay. */
export type ConsentWireMessage =
	| { v: number; kind: 'reply'; id: string; reply: ConsentReply; target: ReloginReplyTarget | null; fromInstanceId: string }
	| { v: number; kind: 'ack'; id: string; fromInstanceId: string };

/** What the relay needs from the rest of the backend (injectable). */
export interface ConsentRelayDeps {
	/** This machine's instance id */
	selfId: () => Promise<string>;
	/** The account's machines: instance id → relay queue id (fresh enough to trust) */
	accountInstances: () => Promise<Map<string, string>>;
	/** Whether the account is known to have another machine (cheap, synchronous) */
	hasOtherMachines: () => boolean;
	/** Put a message on another machine's relay queue */
	send: (queueId: string, message: ConsentWireMessage) => Promise<void>;
	logger?: { info: (message: string, meta?: Record<string, unknown>) => void; warn: (message: string, meta?: Record<string, unknown>) => void };
}

/**
 * Read a relay payload as a consent message.
 *
 * @param payload - The relay payload (`data`)
 * @returns The message, or null when it is not a valid one
 *
 * @example
 * ```ts
 * parseConsentWire({ v: 1, kind: 'ack', id: 'a1', fromInstanceId: 'mbp' }); // the ack
 * parseConsentWire({ kind: 'reply', reply: 'maybe' }); // null
 * ```
 */
export function parseConsentWire(payload: unknown): ConsentWireMessage | null {
	if (!payload || typeof payload !== 'object') return null;
	const p = payload as Record<string, unknown>;
	if (p['v'] !== RUNTIME_CONSENT_CONSTANTS.RELAY_WIRE_VERSION) return null;
	const id = p['id'];
	const fromInstanceId = p['fromInstanceId'];
	if (typeof id !== 'string' || !id || typeof fromInstanceId !== 'string' || !fromInstanceId) return null;
	if (p['kind'] === 'ack') return { v: RUNTIME_CONSENT_CONSTANTS.RELAY_WIRE_VERSION, kind: 'ack', id, fromInstanceId };
	if (p['kind'] !== 'reply') return null;
	const reply = p['reply'];
	if (reply !== 'accept' && reply !== 'decline') return null;
	return { v: RUNTIME_CONSENT_CONSTANTS.RELAY_WIRE_VERSION, kind: 'reply', id, reply, target: parseTarget(p['target']), fromInstanceId };
}

/**
 * Read the conversation an answer was written in. An agent's own-bot DM is
 * dropped: only the machine that runs that agent can post there.
 *
 * @param value - Wire value
 * @returns The target, or null
 */
function parseTarget(value: unknown): ReloginReplyTarget | null {
	if (!value || typeof value !== 'object') return null;
	const t = value as Record<string, unknown>;
	if (typeof t['channelId'] !== 'string' || !t['channelId'] || typeof t['agentSession'] === 'string') return null;
	return { channelId: t['channelId'], ...(typeof t['threadTs'] === 'string' && t['threadTs'] ? { threadTs: t['threadTs'] } : {}) };
}

/**
 * Build the sibling relay the consent service forwards through.
 *
 * @param deps - Dependencies
 * @returns The relay
 */
export function createConsentSiblingRelay(deps: ConsentRelayDeps): ConsentSiblingRelay {
	return {
		hasSiblings: () => deps.hasOtherMachines(),
		forward: async ({ id, reply, target }) => {
			const selfId = await deps.selfId();
			const instances = await deps.accountInstances();
			const message: ConsentWireMessage = { v: RUNTIME_CONSENT_CONSTANTS.RELAY_WIRE_VERSION, kind: 'reply', id, reply, target, fromInstanceId: selfId };
			let sent = 0;
			for (const [instanceId, queueId] of instances) {
				if (instanceId === selfId) continue;
				try {
					await deps.send(queueId, message);
					sent++;
				} catch (error) {
					deps.logger?.warn('Could not pass the consent answer to a machine', { instanceId, error: error instanceof Error ? error.message : String(error) });
				}
			}
			return sent;
		},
	};
}

/**
 * Handle a consent message that arrived over the relay.
 *
 * Only a machine of this account is listened to: the sender must be in the
 * account's machine list, and the confirmation goes to the queue that list
 * names, never to one the message names.
 *
 * @param payload - The relay payload (`data`)
 * @param consent - This machine's consent service
 * @param deps - Dependencies
 * @returns What was done with it
 */
export async function receiveConsentWire(
	payload: unknown,
	consent: Pick<RuntimeConsentService, 'handleSiblingReply' | 'handleSiblingAck'>,
	deps: ConsentRelayDeps,
): Promise<'ignored' | 'not_waiting' | 'taken' | 'ack'> {
	const message = parseConsentWire(payload);
	if (!message) return 'ignored';
	const selfId = await deps.selfId();
	if (message.fromInstanceId === selfId) return 'ignored';
	const senderQueue = (await deps.accountInstances()).get(message.fromInstanceId);
	if (!senderQueue) {
		deps.logger?.warn('Consent message from a machine that is not in this account; ignored', { fromInstanceId: message.fromInstanceId });
		return 'ignored';
	}
	if (message.kind === 'ack') {
		consent.handleSiblingAck(message.id);
		return 'ack';
	}
	if (!consent.handleSiblingReply(message.reply, message.target)) return 'not_waiting';
	try {
		await deps.send(senderQueue, { v: RUNTIME_CONSENT_CONSTANTS.RELAY_WIRE_VERSION, kind: 'ack', id: message.id, fromInstanceId: selfId });
	} catch (error) {
		deps.logger?.warn('Could not confirm the consent answer to the machine that passed it on', { error: error instanceof Error ? error.message : String(error) });
	}
	return 'taken';
}

let listening = false;

/**
 * Start passing consent answers between this account's machines: give the
 * consent service its sibling relay and listen for `owner_consent_reply` on
 * the Cloud relay. Idempotent. Never throws.
 *
 * @param consent - This machine's consent service
 */
export async function startRuntimeConsentRelay(consent: RuntimeConsentService): Promise<void> {
	const logger = LoggerService.getInstance().createComponentLogger('RuntimeConsentRelay');
	try {
		const [{ CloudSyncService }, { accountInstances }, { DeviceIdentityService }] = await Promise.all([
			import('../cloud/cloud-sync.service.js'),
			import('../colleague/colleague.wiring.js'),
			import('../cloud/device-identity.service.js'),
		]);
		const sync = CloudSyncService.getInstance();
		const deps: ConsentRelayDeps = {
			selfId: async () => (await DeviceIdentityService.getInstance().getOrCreateIdentity()).deviceId,
			accountInstances,
			hasOtherMachines: () => sync.isStarted() && sync.getDevices().some((d) => d.isLocal !== true),
			send: (queueId, message) => sync.sendToPeerQueueId(queueId, RUNTIME_CONSENT_CONSTANTS.RELAY_MESSAGE_TYPE, message),
			logger,
		};
		consent.setSiblings(createConsentSiblingRelay(deps));
		if (listening) return;
		listening = true;
		sync.on('message', (msg: { type: string; payload: unknown }) => {
			if (msg.type !== RUNTIME_CONSENT_CONSTANTS.RELAY_MESSAGE_TYPE) return;
			void receiveConsentWire(msg.payload, consent, deps)
				.then((outcome) => logger.info('Consent message from another machine', { outcome }))
				.catch((error: unknown) => logger.warn('Consent message failed', { error: error instanceof Error ? error.message : String(error) }));
		});
		logger.info('Runtime consent relay started');
	} catch (error) {
		logger.warn('Runtime consent relay not started (non-fatal)', { error: error instanceof Error ? error.message : String(error) });
	}
}
