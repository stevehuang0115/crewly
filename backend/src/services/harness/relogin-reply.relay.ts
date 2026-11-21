/**
 * Carries the owner's `login` reply to the machine that is signed out, over
 * the Cloud relay queue.
 *
 * The owner's DM with the Crewly bot is shared by every machine of the
 * account, and Cloud delivers a message there (thread replies included) to
 * the primary machine only. A machine that asked "reply `login`" but is not
 * the primary never heard the reply, and the primary, with nothing signed
 * out, asked "which one should I sign in?" (2026-11-20). Now the machine
 * that hears it asks the others first; the one that is signed out starts
 * its sign-in, answers in the same thread, and confirms. A login code the
 * owner then writes in that thread is passed on the same way.
 *
 * Same shape as runtime-consent.relay.ts.
 *
 * @module services/harness/relogin-reply.relay
 */

import { randomUUID } from 'crypto';
import { RELOGIN_RELAY_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { isHarnessId, type HarnessId } from './harness.types.js';
import type { HarnessReloginService, ReloginReplyTarget } from './harness-relogin.service.js';

/** What travels on the relay. */
export type ReloginWireMessage =
	| { v: number; kind: 'ask'; id: string; harnessId: HarnessId | null; target: ReloginReplyTarget | null; fromInstanceId: string }
	| { v: number; kind: 'ack'; id: string; fromInstanceId: string }
	/** A login code the owner wrote in the thread a machine is signing in from. Never logged. */
	| { v: number; kind: 'code'; id: string; text: string; target: ReloginReplyTarget; fromInstanceId: string };

/** What the relogin service forwards through. */
export interface ReloginSiblingRelay {
	/** Whether the account is known to have another machine (cheap, synchronous) */
	hasSiblings(): boolean;
	/**
	 * Ask the other machines to sign in.
	 *
	 * @param harnessId - Harness the owner named, or null for "whatever is signed out"
	 * @param target - Conversation the owner wrote in
	 * @returns True when another machine took it before the wait ran out
	 */
	ask(harnessId: HarnessId | null, target: ReloginReplyTarget | null): Promise<boolean>;
	/**
	 * Pass a login code to the other machines; the one signing in from that
	 * thread types it in.
	 *
	 * @param text - What the owner wrote (never logged)
	 * @param target - The thread it was written in
	 * @returns How many machines it was sent to
	 */
	passCode(text: string, target: ReloginReplyTarget): Promise<number>;
}

/** What the relay needs from the rest of the backend (injectable). */
export interface ReloginRelayDeps {
	/** This machine's instance id */
	selfId: () => Promise<string>;
	/** The account's machines: instance id → relay queue id */
	accountInstances: () => Promise<Map<string, string>>;
	/** Whether the account is known to have another machine */
	hasOtherMachines: () => boolean;
	/** Put a message on another machine's relay queue */
	send: (queueId: string, message: ReloginWireMessage) => Promise<void>;
	/** How long to wait for a confirmation (ms); defaults to the constant */
	ackWaitMs?: number;
	logger?: { info: (message: string, meta?: Record<string, unknown>) => void; warn: (message: string, meta?: Record<string, unknown>) => void };
}

/**
 * Read a relay payload as a relogin message.
 *
 * @param payload - The relay payload (`data`)
 * @returns The message, or null when it is not a valid one
 *
 * @example
 * ```ts
 * parseReloginWire({ v: 1, kind: 'ack', id: 'a1', fromInstanceId: 'mini' }); // the ack
 * parseReloginWire({ v: 1, kind: 'ask', id: 'a1', harnessId: 'nope', fromInstanceId: 'mbp' }); // null
 * ```
 */
export function parseReloginWire(payload: unknown): ReloginWireMessage | null {
	if (!payload || typeof payload !== 'object') return null;
	const p = payload as Record<string, unknown>;
	const v = RELOGIN_RELAY_CONSTANTS.RELAY_WIRE_VERSION;
	if (p['v'] !== v) return null;
	const id = p['id'];
	const fromInstanceId = p['fromInstanceId'];
	if (typeof id !== 'string' || !id || typeof fromInstanceId !== 'string' || !fromInstanceId) return null;
	if (p['kind'] === 'ack') return { v, kind: 'ack', id, fromInstanceId };
	if (p['kind'] === 'code') {
		const text = p['text'];
		const target = parseTarget(p['target']);
		if (typeof text !== 'string' || !text || text.length > RELOGIN_RELAY_CONSTANTS.CODE_MAX_LENGTH || !target) return null;
		return { v, kind: 'code', id, text, target, fromInstanceId };
	}
	if (p['kind'] !== 'ask') return null;
	const harness = p['harnessId'];
	if (harness !== null && harness !== undefined && !(typeof harness === 'string' && isHarnessId(harness))) return null;
	return { v, kind: 'ask', id, harnessId: typeof harness === 'string' && isHarnessId(harness) ? harness : null, target: parseTarget(p['target']), fromInstanceId };
}

/**
 * Read the conversation the owner wrote in. An agent's own-bot DM is
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

/** A relay plus the hook its listener feeds confirmations into. */
export interface ReloginRelayHandle {
	relay: ReloginSiblingRelay;
	/** Record that another machine took a request. */
	acked: (id: string) => void;
}

/**
 * Build the sibling relay the relogin service asks through.
 *
 * @param deps - Dependencies
 * @returns The relay and its confirmation hook
 */
export function createReloginSiblingRelay(deps: ReloginRelayDeps): ReloginRelayHandle {
	const waiting = new Map<string, (took: boolean) => void>();
	/**
	 * Put a message on every other machine's queue.
	 *
	 * @param build - Makes the message from this machine's id
	 * @returns How many machines it was sent to
	 */
	const broadcast = async (build: (selfId: string) => ReloginWireMessage): Promise<number> => {
		const selfId = await deps.selfId();
		const instances = await deps.accountInstances();
		const message = build(selfId);
		const results = await Promise.all(
			[...instances].filter(([instanceId]) => instanceId !== selfId).map(async ([instanceId, queueId]) => {
				try {
					await deps.send(queueId, message);
					return true;
				} catch (error) {
					deps.logger?.warn('Could not pass the sign-in message to a machine', { instanceId, error: error instanceof Error ? error.message : String(error) });
					return false;
				}
			}),
		);
		return results.filter(Boolean).length;
	};
	const relay: ReloginSiblingRelay = {
		hasSiblings: () => deps.hasOtherMachines(),
		passCode: (text, target) =>
			broadcast((selfId) => ({ v: RELOGIN_RELAY_CONSTANTS.RELAY_WIRE_VERSION, kind: 'code', id: randomUUID(), text, target: { channelId: target.channelId, ...(target.threadTs ? { threadTs: target.threadTs } : {}) }, fromInstanceId: selfId })),
		ask: async (harnessId, target) => {
			const id = randomUUID();
			const forwardable = target && !target.agentSession ? target : null;
			const answered = new Promise<boolean>((resolve) => waiting.set(id, resolve));
			const sent = await broadcast((selfId) => ({ v: RELOGIN_RELAY_CONSTANTS.RELAY_WIRE_VERSION, kind: 'ask', id, harnessId, target: forwardable, fromInstanceId: selfId }));
			if (sent === 0) {
				waiting.delete(id);
				return false;
			}
			const timer = setTimeout(() => waiting.get(id)?.(false), deps.ackWaitMs ?? RELOGIN_RELAY_CONSTANTS.ACK_WAIT_MS);
			timer.unref?.();
			try {
				return await answered;
			} finally {
				clearTimeout(timer);
				waiting.delete(id);
			}
		},
	};
	return { relay, acked: (id) => waiting.get(id)?.(true) };
}

/**
 * Handle a relogin message that arrived over the relay.
 *
 * Only a machine of this account is listened to: the sender must be in the
 * account's machine list, and the confirmation goes to the queue that list
 * names, never to one the message names.
 *
 * @param payload - The relay payload (`data`)
 * @param relogin - This machine's relogin service
 * @param handle - This machine's relay (for confirmations it is waiting on)
 * @param deps - Dependencies
 * @returns What was done with it
 */
export async function receiveReloginWire(
	payload: unknown,
	relogin: Pick<HarnessReloginService, 'handleSiblingLogin' | 'handleSiblingCode'>,
	handle: Pick<ReloginRelayHandle, 'acked'>,
	deps: ReloginRelayDeps,
): Promise<'ignored' | 'nothing_signed_out' | 'taken' | 'ack' | 'code_typed' | 'code_not_mine'> {
	const message = parseReloginWire(payload);
	if (!message) return 'ignored';
	const selfId = await deps.selfId();
	if (message.fromInstanceId === selfId) return 'ignored';
	const senderQueue = (await deps.accountInstances()).get(message.fromInstanceId);
	if (!senderQueue) {
		deps.logger?.warn('Sign-in message from a machine that is not in this account; ignored', { fromInstanceId: message.fromInstanceId });
		return 'ignored';
	}
	if (message.kind === 'ack') {
		handle.acked(message.id);
		return 'ack';
	}
	if (message.kind === 'code') return relogin.handleSiblingCode(message.text, message.target) ? 'code_typed' : 'code_not_mine';
	if (!relogin.handleSiblingLogin(message.harnessId, message.target)) return 'nothing_signed_out';
	try {
		await deps.send(senderQueue, { v: RELOGIN_RELAY_CONSTANTS.RELAY_WIRE_VERSION, kind: 'ack', id: message.id, fromInstanceId: selfId });
	} catch (error) {
		deps.logger?.warn('Could not confirm the sign-in request to the machine that passed it on', { error: error instanceof Error ? error.message : String(error) });
	}
	return 'taken';
}

let listening = false;
let current: ReloginRelayHandle | null = null;

/**
 * Start passing `login` replies between this account's machines: give the
 * relogin service its sibling relay and listen for `owner_relogin_reply` on
 * the Cloud relay. Idempotent. Never throws.
 *
 * @param relogin - This machine's relogin service
 */
export async function startReloginReplyRelay(relogin: HarnessReloginService): Promise<void> {
	const logger = LoggerService.getInstance().createComponentLogger('ReloginReplyRelay');
	try {
		const [{ CloudSyncService }, { accountInstances }, { DeviceIdentityService }] = await Promise.all([
			import('../cloud/cloud-sync.service.js'),
			import('../colleague/colleague.wiring.js'),
			import('../cloud/device-identity.service.js'),
		]);
		const sync = CloudSyncService.getInstance();
		const deps: ReloginRelayDeps = {
			selfId: async () => (await DeviceIdentityService.getInstance().getOrCreateIdentity()).deviceId,
			accountInstances,
			hasOtherMachines: () => sync.isStarted() && sync.getDevices().some((d) => d.isLocal !== true),
			send: (queueId, message) => sync.sendToPeerQueueId(queueId, RELOGIN_RELAY_CONSTANTS.RELAY_MESSAGE_TYPE, message),
			logger,
		};
		// One handle for the life of the process: the listener below feeds
		// confirmations into the same relay every later call hands out.
		current ??= createReloginSiblingRelay(deps);
		const handle = current;
		relogin.setSiblings(handle.relay);
		if (listening) return;
		listening = true;
		sync.on('message', (msg: { type: string; payload: unknown }) => {
			if (msg.type !== RELOGIN_RELAY_CONSTANTS.RELAY_MESSAGE_TYPE) return;
			void receiveReloginWire(msg.payload, relogin, handle, deps)
				.then((outcome) => logger.info('Sign-in message from another machine', { outcome }))
				.catch((error: unknown) => logger.warn('Sign-in message failed', { error: error instanceof Error ? error.message : String(error) }));
		});
		logger.info('Relogin reply relay started');
	} catch (error) {
		logger.warn('Relogin reply relay not started (non-fatal)', { error: error instanceof Error ? error.message : String(error) });
	}
}
